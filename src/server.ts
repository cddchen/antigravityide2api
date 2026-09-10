// ═══════════════════════════════════════════════
//  HTTP 服务：/health /v1/models /v1/messages；DEBUG=1 时另挂 /logcat
//  把已有模块串成 Anthropic 多轮闭环（不改其它 src 文件）
// ═══════════════════════════════════════════════

import cors from 'cors';
import express, { type NextFunction, type Request, type Response } from 'express';
import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import {
AnthropicSseWriter,
buildErrorResponse,
buildMessageResponse,
buildToolUseResponse,
buildContents,
extractToolResultSiblingText,
parseToolResults,
type AnthropicUsage,
} from './anthropic';
import {
AntigravityError,
fetchAvailableModels,
newSessionId,
streamGenerate,
} from './antigravity-client';
import { loadTokenFile, withAuth } from './auth';
import config from './config';
import {
captureError,
captureInbound,
captureOutbound,
debugEnabled,
mountLogcat,
} from './logcat';
import { getNativeTools, isNativeTool, NATIVE_TOOL_NAMES } from './native-tools';
import {
appendToolRound,
cleanupAll,
getPendingByToolId,
pendingCount,
registerPending,
removePending,
} from './pending-session';
import {
buildSystemInstruction,
dumpSystemAnatomy,
extractEnv,
scanLeaks,
} from './system-prompt';
import { getDefaultTokenPath } from './token-paths';
import {
bridgeFunctionCall,
buildFunctionResponse,
describeToolUse,
rejectionOutput,
} from './tool-bridge';
import type {
AnthropicMessagesRequest,
BridgedToolUse,
NativeContent,
NativePart,
PendingAgentSession,
StreamTurnResult,
TokenEntry,
ToolEntry,
} from './types';

// ---------- 风控：发出前自检 ----------

/** LEAKCHECK_OFF 非空则跳过；默认开 */
function assertSafeToSend(tools: ToolEntry[], systemInstruction: string): void {
if (process.env.LEAKCHECK_OFF) return;

if (tools.length !== 14) {
throw new Error(`leakcheck: tools.length=${tools.length}，期望 14`);
}
for (let i = 0; i < tools.length; i++) {
const name = tools[i]?.functionDeclarations?.[0]?.name;
if (!name || !isNativeTool(name)) {
throw new Error(
 `leakcheck: tools[${i}].name=${String(name)} 不在 NATIVE_TOOL_NAMES（共 ${NATIVE_TOOL_NAMES.length}）`,
);
}
}

const hits = scanLeaks(systemInstruction);
if (hits.length > 0) {
// 只打命中词，不打上下文全文
const words = [...new Set(hits.map((h) => h.word))];
console.error(`[leakcheck] 命中词: ${words.join(', ')}`);
throw new Error(`leakcheck: systemInstruction 命中 ${words.length} 类黑名单词`);
}
}

// ---------- 工具 ----------

function toUsage(u: StreamTurnResult['usage']): AnthropicUsage {
return {
input_tokens: u.promptTokens,
output_tokens: u.completionTokens,
};
}

function workspaceRootOf(body: AnthropicMessagesRequest): string {
if (config.workspaceRoot) return config.workspaceRoot;
try {
return extractEnv(body).cwd || '';
} catch {
return '';
}
}

/**
* token 热加载：按文件 mtime 判失效。
* 必须缓存 entry 对象本身 —— ensureProjectId 把 projectId 写在 entry 上，
* 每次重新 loadTokenFile 会丢掉它，导致每个请求都多打一次 loadCodeAssist。
*/
let cachedEntry: TokenEntry | null = null;
let cachedMtime = 0;

function firstTokenEntry(): TokenEntry {
const p = getDefaultTokenPath();
let mtime = 0;
try {
mtime = fs.statSync(p).mtimeMs;
} catch {
/* 文件不在 → 让 loadTokenFile 抛出可读错误 */
}
if (cachedEntry && mtime === cachedMtime) return cachedEntry;
cachedEntry = loadTokenFile(p).tokens[0];
cachedMtime = mtime;
return cachedEntry;
}

/** 日志用：空白折叠后截断，避免把整份 grep 打进 stdout */
function omitText(s: string, max = 160): string {
const t = s.replace(/\s+/g, ' ').trim();
if (t.length <= max) return t;
return `${t.slice(0, max)}…(${Buffer.byteLength(t, 'utf8')}B)`;
}

function summarizeMessages(body: AnthropicMessagesRequest): string {
const msgs = (body.messages ?? []) as Array<{
role: string;
content?: string | Array<{ type?: string }>;
}>;
const tail = msgs.slice(-6);
const start = msgs.length - tail.length;
const parts = tail.map((m, i) => {
const c = m.content;
let kinds: string;
if (typeof c === 'string') kinds = `text:${c.length}`;
else if (!Array.isArray(c) || c.length === 0) kinds = 'empty';
else kinds = c.map((b) => b.type || '?').join('+');
return `${start + i}:${m.role}(${kinds})`;
});
return `n=${msgs.length} last=[${parts.join(' ')}]`;
}

function logIncomingToolResults(
  body: AnthropicMessagesRequest,
  toolResults: ReturnType<typeof parseToolResults>,
  opts: { pendingHits: string[]; extra: boolean; branch: 'A' | 'B' },
): void {
  const shape = summarizeMessages(body);
  if (toolResults.length === 0) {
    console.log(`[in] ${shape} tool_result=0 → 分支A`);
    return;
  }
  const extraTag = opts.extra ? 'extra=text' : 'extra=none';
  console.log(
    `[in] ${shape} tool_result=${toolResults.length} pending=[${opts.pendingHits.join(',')}] ${extraTag} → 分支${opts.branch}`,
  );
  for (const r of toolResults) {
    console.log(
      `  [tr] id=${r.toolUseId} err=${r.isError} ${omitText(r.content)}`,
    );
  }
}

function logTurn(
model: string,
stepIndex: number,
result: StreamTurnResult,
): void {
const descs = result.fcParts
.map((p) => (p.functionCall ? describeToolUse(p.functionCall) : '?'))
.join(' | ');
console.log(
`[turn] model=${model} step=${stepIndex} fc=${result.fcParts.length}` +
(descs ? ` [${descs}]` : '') +
` usage={prompt:${result.usage.promptTokens}, completion:${result.usage.completionTokens}, thoughts:${result.usage.thoughtsTokens}, cached:${result.usage.cachedTokens}}`,
);
}

/** 鉴权：API_KEY 非空时校验 x-api-key 或 Bearer */
function checkApiKey(req: Request, res: Response, next: NextFunction): void {
const key = config.server.apiKey;
if (!key) {
next();
return;
}
const xApiKey = req.header('x-api-key');
const auth = req.header('authorization') || '';
const bearer = auth.toLowerCase().startsWith('bearer ')
? auth.slice(7).trim()
: '';
if (xApiKey === key || bearer === key) {
next();
return;
}
res.status(401).json(buildErrorResponse('invalid api key', 'authentication_error'));
}

function headersSent(res: Response): boolean {
return res.headersSent || res.writableEnded;
}

function sendErr(
res: Response,
sse: AnthropicSseWriter | null,
err: unknown,
): void {
const isAg = err instanceof AntigravityError;
const status = isAg ? (err as AntigravityError).status : 500;
const message =
err instanceof Error ? err.message : typeof err === 'string' ? err : 'internal error';
console.error(`[error] status=${status} ${message}`);
if (debugEnabled()) captureError(status, message);

if (sse && !sse.ended) {
// 流已开始：不能改 status，写错误文本到流并收尾
try {
sse.textDelta(`\n\n[error] ${message}`);
sse.end({ input_tokens: 0, output_tokens: 0 }, 'end_turn');
} catch (e) {
console.error('[error] sse end failed:', e instanceof Error ? e.message : e);
if (!res.writableEnded) res.end();
}
return;
}
if (headersSent(res)) {
if (!res.writableEnded) res.end();
return;
}
res.status(status).json(buildErrorResponse(message));
}

// ---------- 一轮上游 + 桥接分流（含「全部 reject 就地续轮」） ----------

interface LoopOkText {
kind: 'text';
result: StreamTurnResult;
stepIndex: number;
projectId: string;
}

interface LoopOkTools {
kind: 'tool_use';
result: StreamTurnResult;
toolUses: BridgedToolUse[];
/** 本轮原样 FC parts（含 reject 的），resume 时整组回放 */
fcParts: NativePart[];
stepIndex: number;
projectId: string;
}

type LoopOutcome = LoopOkText | LoopOkTools;

const MAX_REJECT_LOOPS = 3;

async function runGenerateLoop(opts: {
entry: TokenEntry;
model: string;
contents: NativeContent[];
systemInstruction: string;
tools: ToolEntry[];
sessionId: string;
cascadeUuid: string;
trajectoryUuid: string;
stepIndex: number;
workspaceRoot: string;
onText?: (delta: string) => void;
}): Promise<LoopOutcome> {
let stepIndex = opts.stepIndex;
let projectId = '';
let rejectLoops = 0;

while (true) {
assertSafeToSend(opts.tools, opts.systemInstruction);
if (debugEnabled()) {
 captureOutbound({
   model: opts.model,
   stepIndex,
   sessionId: opts.sessionId,
   contents: opts.contents,
   systemInstruction: opts.systemInstruction,
   tools: opts.tools,
 });
}

const result = await withAuth(opts.entry, async (accessToken, pid) => {
projectId = pid;
return streamGenerate({
 accessToken,
 projectId: pid,
 model: opts.model,
 contents: opts.contents,
 systemInstruction: opts.systemInstruction,
 tools: opts.tools,
 sessionId: opts.sessionId,
 cascadeUuid: opts.cascadeUuid,
 trajectoryUuid: opts.trajectoryUuid,
 stepIndex,
 onText: opts.onText,
});
});

logTurn(opts.model, stepIndex, result);

if (result.fcParts.length === 0) {
return { kind: 'text', result, stepIndex, projectId };
}

const toolUses: BridgedToolUse[] = [];
const rejectFrParts: NativePart[] = [];
for (const part of result.fcParts) {
const fc = part.functionCall;
if (!fc) continue;
const outcome = bridgeFunctionCall(fc, opts.workspaceRoot || undefined);
if (outcome.kind === 'tool_use') {
 toolUses.push(outcome.value);
} else {
 // reject：不写 tool_use，只记 FR
 rejectFrParts.push({ functionResponse: rejectionOutput(outcome.value) });
}
}

if (toolUses.length === 0) {
// 全部被 reject：不能挂起等客户端，就地 append + 再发
rejectLoops += 1;
if (rejectLoops > MAX_REJECT_LOOPS) {
 throw new Error(
   `全部 functionCall 被 bridge 拒绝，连续 ${MAX_REJECT_LOOPS} 次就地续轮仍无 tool_use，停止防打转`,
 );
}
console.log(
 `[reject-all] step=${stepIndex} fc=${result.fcParts.length} loop=${rejectLoops}/${MAX_REJECT_LOOPS}`,
);
appendToolRound(opts.contents, result.fcParts, rejectFrParts);
stepIndex += 1;
continue;
}

// 至少一个 tool_use → 挂起（mixed reject 的 FR 在 resume 时按 pendingFcParts 顺序补）
return {
kind: 'tool_use',
result,
toolUses,
fcParts: result.fcParts,
stepIndex,
projectId,
};
}
}

function registerToolPending(args: {
toolUses: BridgedToolUse[];
fcParts: NativePart[];
contents: NativeContent[];
sessionId: string;
cascadeUuid: string;
trajectoryUuid: string;
stepIndex: number;
projectId: string;
model: string;
tokenName: string;
systemInstruction: string;
}): void {
const bridged = new Map<string, BridgedToolUse>();
const claudeToolIds: string[] = [];
for (const u of args.toolUses) {
bridged.set(u.toolUseId, u);
claudeToolIds.push(u.toolUseId);
}
const session: PendingAgentSession = {
sessionKey: args.cascadeUuid,
claudeToolIds,
bridged,
// 契约：contents 此时不含本轮 FC；resume 时才 append
pendingFcParts: args.fcParts,
contents: args.contents,
sessionId: args.sessionId,
cascadeUuid: args.cascadeUuid,
trajectoryUuid: args.trajectoryUuid,
stepIndex: args.stepIndex,
projectId: args.projectId,
model: args.model,
tokenName: args.tokenName,
systemInstruction: args.systemInstruction,
createdAt: Date.now(),
timer: null,
};
registerPending(session);
}

/** 按 pendingFcParts 顺序组 FR：bridged 用 client 结果，其余 re-bridge 出 reject FR */
function buildFrPartsForResume(
pending: PendingAgentSession,
resultsById: Map<string, { content: string; isError: boolean }>,
workspaceRoot: string,
): NativePart[] {
const frParts: NativePart[] = [];
for (const part of pending.pendingFcParts) {
const fc = part.functionCall;
if (!fc) continue;
const b = pending.bridged.get(fc.id);
if (b) {
const tr = resultsById.get(b.toolUseId);
if (!tr) {
 // 等齐校验已过，理论上不应到这
 frParts.push({
   functionResponse: rejectionOutput({
     native: b.native,
     reason: `missing tool_result for ${b.toolUseId}`,
   }),
 });
 continue;
}
frParts.push({
 functionResponse: buildFunctionResponse(b.native, tr.content, tr.isError),
});
continue;
}
// 首轮被 reject 的 FC：不进客户端，resume 时补 FR（顺序对齐 FC）
const outcome = bridgeFunctionCall(fc, workspaceRoot || undefined);
if (outcome.kind === 'reject') {
frParts.push({ functionResponse: rejectionOutput(outcome.value) });
} else {
// 非预期：首轮应是 reject；兜底 error FR，避免缺 part
frParts.push({
 functionResponse: rejectionOutput({
   native: { id: fc.id, name: fc.name, args: fc.args },
   reason: 'resume: expected reject FC but bridge returned tool_use',
 }),
});
}
}
return frParts;
}

// ---------- Express ----------

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));
if (debugEnabled()) mountLogcat(app);

app.get('/health', (_req, res) => {
let tokens = 0;
try {
tokens = loadTokenFile().tokens.length;
} catch {
tokens = 0;
}
res.json({ ok: true, tokens, pending: pendingCount() });
});

function toModelList(
  catalog: Awaited<ReturnType<typeof fetchAvailableModels>>,
): Array<Record<string, unknown>> {
  return Object.entries(catalog.models).map(([id, metadata]) => ({
    ...metadata,
    id,
    type: 'model',
    display_name:
      typeof metadata.displayName === 'string' ? metadata.displayName : id,
  }));
}

app.get('/v1/models', checkApiKey, async (_req, res) => {
try {
const entry = firstTokenEntry();
const catalog = await withAuth(entry, (accessToken, projectId) =>
  fetchAvailableModels({ accessToken, projectId }),
);
res.json({ data: toModelList(catalog) });
} catch (err) {
sendErr(res, null, err);
}
});

app.post('/v1/messages', checkApiKey, async (req, res) => {
const body = (req.body || {}) as AnthropicMessagesRequest;
const stream = body.stream === true;
const model = body.model || config.antigravity.defaultModel;
const tools = getNativeTools();
const workspaceRoot = workspaceRootOf(body);
let sse: AnthropicSseWriter | null = null;

try {
  const toolResults = parseToolResults(body);
  const extraText = extractToolResultSiblingText(body);
  const pendingHits = toolResults.map((r) =>
    getPendingByToolId(r.toolUseId) ? 'hit' : 'miss',
  );
  const pending =
    toolResults.length > 0
      ? getPendingByToolId(toolResults[0].toolUseId)
      : undefined;
  const extra = extraText.length > 0;
  const skillLaunch = toolResults.some((r) => /^Launching skill:/m.test(r.content));
  // 同条非 reminder 文本 = 新用户请求（/compact、打断）。不得续轮：
  // 续进旧 cascade 会把截图等大 FR 再送上游，usage 爆掉后 autocompact 打转。
  const extraAsNewRequest = extra && !skillLaunch;
  const branch: 'A' | 'B' =
    toolResults.length === 0 || extraAsNewRequest ? 'A' : 'B';
  logIncomingToolResults(body, toolResults, { pendingHits, extra, branch });
  if (debugEnabled()) {
    captureInbound(body, {
      model,
      stream,
      toolResults,
      pendingHits,
      branch,
    });
  }
const entry = firstTokenEntry();

if (extraAsNewRequest && pending) {
  // 丢掉未完成工具轮，后续同 id 纯 tool_result 不得再续进旧 cascade
  removePending(pending);
}

// ── 分支 B：续轮（有 tool_result 且 pending 命中，且同条没有新用户文本） ──
if (toolResults.length > 0 && pending && !extraAsNewRequest) {
const resultsById = new Map(
 toolResults.map((r) => [r.toolUseId, { content: r.content, isError: r.isError }]),
);
// 必须等齐：pending.claudeToolIds 每个都要出现（FC parts 只能整组回放）
const missing = pending.claudeToolIds.filter((id) => !resultsById.has(id));
if (missing.length > 0) {
 const msg = `tool_result 未等齐，缺少: ${missing.join(', ')}（需要: ${pending.claudeToolIds.join(', ')}）`;
 if (debugEnabled()) captureError(400, msg);
 res
   .status(400)
   .json(
     buildErrorResponse(
       msg,
       'invalid_request_error',
     ),
   );
 return;
}

const frParts = buildFrPartsForResume(pending, resultsById, workspaceRoot);
appendToolRound(pending.contents, pending.pendingFcParts, frParts);

const contents = pending.contents;
const systemInstruction = pending.systemInstruction;
const sessionId = pending.sessionId;
const cascadeUuid = pending.cascadeUuid;
const trajectoryUuid = pending.trajectoryUuid;
const stepIndex = pending.stepIndex + 1;
const tokenName = pending.tokenName;
// 续轮复用首轮 systemInstruction（CLAUDE.md），不再从 body 重建
removePending(pending);

// 风控前置：必须在开流之前，否则命中泄漏只能写进 SSE，返不了 500
assertSafeToSend(tools, systemInstruction);
if (stream) sse = new AnthropicSseWriter(res, model);

const outcome = await runGenerateLoop({
 entry,
 model,
 contents,
 systemInstruction,
 tools,
 sessionId,
 cascadeUuid,
 trajectoryUuid,
 stepIndex,
 workspaceRoot,
 onText: stream ? (d) => sse!.textDelta(d) : undefined,
});

if (outcome.kind === 'text') {
 const usage = toUsage(outcome.result.usage);
 if (stream) {
   sse!.end(usage, 'end_turn');
 } else {
   res.json(buildMessageResponse(model, outcome.result.text, usage));
 }
 return;
}

registerToolPending({
 toolUses: outcome.toolUses,
 fcParts: outcome.fcParts,
 contents,
 sessionId,
 cascadeUuid,
 trajectoryUuid,
 stepIndex: outcome.stepIndex,
 projectId: outcome.projectId || pending.projectId,
 model,
 tokenName,
 systemInstruction,
});

const usage = toUsage(outcome.result.usage);
if (stream) {
 for (const u of outcome.toolUses) {
   sse!.toolUse(u.toolUseId, u.claudeName, u.input);
 }
 sse!.endToolUseBatch(usage);
} else {
 res.json(
   buildToolUseResponse(model, outcome.result.text, outcome.toolUses, usage),
 );
}
return;
}

if (toolResults.length > 0 && !extraAsNewRequest) {
  const msg = `unknown or expired tool_use_id: ${toolResults[0].toolUseId}（session 已过期或 id 未知）`;
  if (debugEnabled()) captureError(400, msg);
  res
    .status(400)
    .json(
      buildErrorResponse(
        msg,
        'invalid_request_error',
      ),
    );
  return;
}

// ── 分支 A：首轮，或同条带新用户文本（compact / 打断；pending 已丢） ──
const env = extractEnv(body);
const systemInstruction = buildSystemInstruction(env, config.systemMode);
dumpSystemAnatomy(body, env, systemInstruction);
// 带上历史文本轮：CC 每次回传全量 messages，只取最后一条会丢多轮上下文
const contents = buildContents(body);
if (contents.length === 0) {
if (debugEnabled()) {
 captureOutbound({
   model,
   stepIndex: 0,
   sessionId: '—',
   contents,
   systemInstruction,
   tools,
 });
 captureError(400, 'empty user content');
}
res
 .status(400)
 .json(buildErrorResponse('empty user content', 'invalid_request_error'));
return;
}
const sessionId = newSessionId();
const cascadeUuid = uuidv4();
const trajectoryUuid = uuidv4();
const stepIndex = 0;

// 风控前置：必须在开流之前
assertSafeToSend(tools, systemInstruction);
if (stream) sse = new AnthropicSseWriter(res, model);

const outcome = await runGenerateLoop({
entry,
model,
contents,
systemInstruction,
tools,
sessionId,
cascadeUuid,
trajectoryUuid,
stepIndex,
workspaceRoot,
onText: stream ? (d) => sse!.textDelta(d) : undefined,
});

if (outcome.kind === 'text') {
const usage = toUsage(outcome.result.usage);
if (stream) {
 sse!.end(usage, 'end_turn');
} else {
 res.json(buildMessageResponse(model, outcome.result.text, usage));
}
return;
}

registerToolPending({
toolUses: outcome.toolUses,
fcParts: outcome.fcParts,
contents,
sessionId,
cascadeUuid,
trajectoryUuid,
stepIndex: outcome.stepIndex,
projectId: outcome.projectId,
model,
tokenName: entry.name,
systemInstruction,
});

const usage = toUsage(outcome.result.usage);
if (stream) {
for (const u of outcome.toolUses) {
 sse!.toolUse(u.toolUseId, u.claudeName, u.input);
}
sse!.endToolUseBatch(usage);
} else {
res.json(
 buildToolUseResponse(model, outcome.result.text, outcome.toolUses, usage),
);
}
} catch (err) {
sendErr(res, sse, err);
}
});

// ---------- 启动 ----------

export function startServer(): Promise<void> {
// 无 token 文件时优雅退出，不要栈式崩
try {
const tf = loadTokenFile();
console.log(`[boot] tokens=${tf.tokens.length} (names only: ${tf.tokens.map((t) => t.name).join(', ')})`);
} catch (e) {
console.error(`[boot] ${e instanceof Error ? e.message : String(e)}`);
process.exit(1);
}

const { host, port } = config.server;
return new Promise((resolve, reject) => {
const server = app.listen(port, host, () => {
    console.log(`[boot] listening http://${host}:${port}`);
    console.log(
      `[boot] model=${config.antigravity.defaultModel} systemMode=${config.systemMode} ideVersion=${config.antigravity.ideVersion} ua=${config.antigravity.userAgent}`,
    );
    if (debugEnabled()) {
      console.log(`[boot] DEBUG=1 logcat http://${host}:${port}/logcat`);
    }
resolve();
});
server.on('error', (err) => {
console.error(`[boot] listen error: ${err.message}`);
reject(err);
});
});
}

function onSignal(sig: string): void {
console.log(`[boot] ${sig} → cleanupAll + exit`);
cleanupAll();
process.exit(0);
}

process.on('SIGINT', () => onSignal('SIGINT'));
process.on('SIGTERM', () => onSignal('SIGTERM'));

if (require.main === module) {
startServer().catch((e) => {
console.error(`[boot] ${e instanceof Error ? e.message : String(e)}`);
process.exit(1);
});
}
