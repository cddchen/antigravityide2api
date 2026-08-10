"use strict";
// ═══════════════════════════════════════════════
//  HTTP 服务：/health /v1/models /v1/messages
//  把已有模块串成 Anthropic 多轮闭环（不改其它 src 文件）
// ═══════════════════════════════════════════════
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.startServer = startServer;
const cors_1 = __importDefault(require("cors"));
const express_1 = __importDefault(require("express"));
const fs_1 = __importDefault(require("fs"));
const uuid_1 = require("uuid");
const anthropic_1 = require("./anthropic");
const antigravity_client_1 = require("./antigravity-client");
const auth_1 = require("./auth");
const config_1 = __importDefault(require("./config"));
const native_tools_1 = require("./native-tools");
const pending_session_1 = require("./pending-session");
const system_prompt_1 = require("./system-prompt");
const token_paths_1 = require("./token-paths");
const tool_bridge_1 = require("./tool-bridge");
// ---------- 风控：发出前自检 ----------
/** LEAKCHECK_OFF 非空则跳过；默认开 */
function assertSafeToSend(tools, systemInstruction) {
    if (process.env.LEAKCHECK_OFF)
        return;
    if (tools.length !== 14) {
        throw new Error(`leakcheck: tools.length=${tools.length}，期望 14`);
    }
    for (let i = 0; i < tools.length; i++) {
        const name = tools[i]?.functionDeclarations?.[0]?.name;
        if (!name || !(0, native_tools_1.isNativeTool)(name)) {
            throw new Error(`leakcheck: tools[${i}].name=${String(name)} 不在 NATIVE_TOOL_NAMES（共 ${native_tools_1.NATIVE_TOOL_NAMES.length}）`);
        }
    }
    const hits = (0, system_prompt_1.scanLeaks)(systemInstruction);
    if (hits.length > 0) {
        // 只打命中词，不打上下文全文
        const words = [...new Set(hits.map((h) => h.word))];
        console.error(`[leakcheck] 命中词: ${words.join(', ')}`);
        throw new Error(`leakcheck: systemInstruction 命中 ${words.length} 类黑名单词`);
    }
}
// ---------- 工具 ----------
function toUsage(u) {
    return {
        input_tokens: u.promptTokens,
        output_tokens: u.completionTokens,
    };
}
function workspaceRootOf(body) {
    if (config_1.default.workspaceRoot)
        return config_1.default.workspaceRoot;
    try {
        return (0, system_prompt_1.extractEnv)(body).cwd || '';
    }
    catch {
        return '';
    }
}
/**
 * token 热加载：按文件 mtime 判失效。
 * 必须缓存 entry 对象本身 —— ensureProjectId 把 projectId 写在 entry 上，
 * 每次重新 loadTokenFile 会丢掉它，导致每个请求都多打一次 loadCodeAssist。
 */
let cachedEntry = null;
let cachedMtime = 0;
function firstTokenEntry() {
    const p = (0, token_paths_1.getDefaultTokenPath)();
    let mtime = 0;
    try {
        mtime = fs_1.default.statSync(p).mtimeMs;
    }
    catch {
        /* 文件不在 → 让 loadTokenFile 抛出可读错误 */
    }
    if (cachedEntry && mtime === cachedMtime)
        return cachedEntry;
    cachedEntry = (0, auth_1.loadTokenFile)(p).tokens[0];
    cachedMtime = mtime;
    return cachedEntry;
}
function logTurn(model, stepIndex, result) {
    const descs = result.fcParts
        .map((p) => (p.functionCall ? (0, tool_bridge_1.describeToolUse)(p.functionCall) : '?'))
        .join(' | ');
    console.log(`[turn] model=${model} step=${stepIndex} fc=${result.fcParts.length}` +
        (descs ? ` [${descs}]` : '') +
        ` usage={prompt:${result.usage.promptTokens}, completion:${result.usage.completionTokens}, thoughts:${result.usage.thoughtsTokens}, cached:${result.usage.cachedTokens}}`);
}
/** 鉴权：API_KEY 非空时校验 x-api-key 或 Bearer */
function checkApiKey(req, res, next) {
    const key = config_1.default.server.apiKey;
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
    res.status(401).json((0, anthropic_1.buildErrorResponse)('invalid api key', 'authentication_error'));
}
function headersSent(res) {
    return res.headersSent || res.writableEnded;
}
function sendErr(res, sse, err) {
    const isAg = err instanceof antigravity_client_1.AntigravityError;
    const status = isAg ? err.status : 500;
    const message = err instanceof Error ? err.message : typeof err === 'string' ? err : 'internal error';
    console.error(`[error] status=${status} ${message}`);
    if (sse && !sse.ended) {
        // 流已开始：不能改 status，写错误文本到流并收尾
        try {
            sse.textDelta(`\n\n[error] ${message}`);
            sse.end({ input_tokens: 0, output_tokens: 0 }, 'end_turn');
        }
        catch (e) {
            console.error('[error] sse end failed:', e instanceof Error ? e.message : e);
            if (!res.writableEnded)
                res.end();
        }
        return;
    }
    if (headersSent(res)) {
        if (!res.writableEnded)
            res.end();
        return;
    }
    res.status(status).json((0, anthropic_1.buildErrorResponse)(message));
}
const MAX_REJECT_LOOPS = 3;
async function runGenerateLoop(opts) {
    let stepIndex = opts.stepIndex;
    let projectId = '';
    let rejectLoops = 0;
    while (true) {
        assertSafeToSend(opts.tools, opts.systemInstruction);
        const result = await (0, auth_1.withAuth)(opts.entry, async (accessToken, pid) => {
            projectId = pid;
            return (0, antigravity_client_1.streamGenerate)({
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
        const toolUses = [];
        const rejectFrParts = [];
        for (const part of result.fcParts) {
            const fc = part.functionCall;
            if (!fc)
                continue;
            const outcome = (0, tool_bridge_1.bridgeFunctionCall)(fc, opts.workspaceRoot || undefined);
            if (outcome.kind === 'tool_use') {
                toolUses.push(outcome.value);
            }
            else {
                // reject：不写 tool_use，只记 FR
                rejectFrParts.push({ functionResponse: (0, tool_bridge_1.rejectionOutput)(outcome.value) });
            }
        }
        if (toolUses.length === 0) {
            // 全部被 reject：不能挂起等客户端，就地 append + 再发
            rejectLoops += 1;
            if (rejectLoops > MAX_REJECT_LOOPS) {
                throw new Error(`全部 functionCall 被 bridge 拒绝，连续 ${MAX_REJECT_LOOPS} 次就地续轮仍无 tool_use，停止防打转`);
            }
            console.log(`[reject-all] step=${stepIndex} fc=${result.fcParts.length} loop=${rejectLoops}/${MAX_REJECT_LOOPS}`);
            (0, pending_session_1.appendToolRound)(opts.contents, result.fcParts, rejectFrParts);
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
function registerToolPending(args) {
    const bridged = new Map();
    const claudeToolIds = [];
    for (const u of args.toolUses) {
        bridged.set(u.toolUseId, u);
        claudeToolIds.push(u.toolUseId);
    }
    const session = {
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
    (0, pending_session_1.registerPending)(session);
}
/** 按 pendingFcParts 顺序组 FR：bridged 用 client 结果，其余 re-bridge 出 reject FR */
function buildFrPartsForResume(pending, resultsById, workspaceRoot) {
    const frParts = [];
    for (const part of pending.pendingFcParts) {
        const fc = part.functionCall;
        if (!fc)
            continue;
        const b = pending.bridged.get(fc.id);
        if (b) {
            const tr = resultsById.get(b.toolUseId);
            if (!tr) {
                // 等齐校验已过，理论上不应到这
                frParts.push({
                    functionResponse: (0, tool_bridge_1.rejectionOutput)({
                        native: b.native,
                        reason: `missing tool_result for ${b.toolUseId}`,
                    }),
                });
                continue;
            }
            frParts.push({
                functionResponse: (0, tool_bridge_1.buildFunctionResponse)(b.native, tr.content, tr.isError),
            });
            continue;
        }
        // 首轮被 reject 的 FC：不进客户端，resume 时补 FR（顺序对齐 FC）
        const outcome = (0, tool_bridge_1.bridgeFunctionCall)(fc, workspaceRoot || undefined);
        if (outcome.kind === 'reject') {
            frParts.push({ functionResponse: (0, tool_bridge_1.rejectionOutput)(outcome.value) });
        }
        else {
            // 非预期：首轮应是 reject；兜底 error FR，避免缺 part
            frParts.push({
                functionResponse: (0, tool_bridge_1.rejectionOutput)({
                    native: { id: fc.id, name: fc.name, args: fc.args },
                    reason: 'resume: expected reject FC but bridge returned tool_use',
                }),
            });
        }
    }
    return frParts;
}
// ---------- Express ----------
const app = (0, express_1.default)();
app.use((0, cors_1.default)());
app.use(express_1.default.json({ limit: '50mb' }));
app.get('/health', (_req, res) => {
    let tokens = 0;
    try {
        tokens = (0, auth_1.loadTokenFile)().tokens.length;
    }
    catch {
        tokens = 0;
    }
    res.json({ ok: true, tokens, pending: (0, pending_session_1.pendingCount)() });
});
app.get('/v1/models', checkApiKey, (_req, res) => {
    const id = config_1.default.antigravity.defaultModel;
    res.json({
        data: [
            {
                id,
                type: 'model',
                display_name: id,
                created_at: '2026-01-01T00:00:00Z',
            },
        ],
    });
});
app.post('/v1/messages', checkApiKey, async (req, res) => {
    const body = (req.body || {});
    const stream = body.stream === true;
    const model = body.model || config_1.default.antigravity.defaultModel;
    const tools = (0, native_tools_1.getNativeTools)();
    const workspaceRoot = workspaceRootOf(body);
    let sse = null;
    try {
        const toolResults = (0, anthropic_1.parseToolResults)(body);
        const entry = firstTokenEntry();
        // ── 分支 B：续轮（有 tool_result） ──
        if (toolResults.length > 0) {
            const pending = (0, pending_session_1.getPendingByToolId)(toolResults[0].toolUseId);
            if (!pending) {
                res
                    .status(400)
                    .json((0, anthropic_1.buildErrorResponse)(`unknown or expired tool_use_id: ${toolResults[0].toolUseId}（session 已过期或 id 未知）`, 'invalid_request_error'));
                return;
            }
            const resultsById = new Map(toolResults.map((r) => [r.toolUseId, { content: r.content, isError: r.isError }]));
            // 必须等齐：pending.claudeToolIds 每个都要出现（FC parts 只能整组回放）
            const missing = pending.claudeToolIds.filter((id) => !resultsById.has(id));
            if (missing.length > 0) {
                res
                    .status(400)
                    .json((0, anthropic_1.buildErrorResponse)(`tool_result 未等齐，缺少: ${missing.join(', ')}（需要: ${pending.claudeToolIds.join(', ')}）`, 'invalid_request_error'));
                return;
            }
            const frParts = buildFrPartsForResume(pending, resultsById, workspaceRoot);
            (0, pending_session_1.appendToolRound)(pending.contents, pending.pendingFcParts, frParts);
            const contents = pending.contents;
            const systemInstruction = pending.systemInstruction;
            const sessionId = pending.sessionId;
            const cascadeUuid = pending.cascadeUuid;
            const trajectoryUuid = pending.trajectoryUuid;
            const stepIndex = pending.stepIndex + 1;
            const tokenName = pending.tokenName;
            // 续轮复用首轮 systemInstruction（CLAUDE.md），不再从 body 重建
            (0, pending_session_1.removePending)(pending);
            // 风控前置：必须在开流之前，否则命中泄漏只能写进 SSE，返不了 500
            assertSafeToSend(tools, systemInstruction);
            if (stream)
                sse = new anthropic_1.AnthropicSseWriter(res, model);
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
                onText: stream ? (d) => sse.textDelta(d) : undefined,
            });
            if (outcome.kind === 'text') {
                const usage = toUsage(outcome.result.usage);
                if (stream) {
                    sse.end(usage, 'end_turn');
                }
                else {
                    res.json((0, anthropic_1.buildMessageResponse)(model, outcome.result.text, usage));
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
                    sse.toolUse(u.toolUseId, u.claudeName, u.input);
                }
                sse.endToolUseBatch(usage);
            }
            else {
                res.json((0, anthropic_1.buildToolUseResponse)(model, outcome.result.text, outcome.toolUses, usage));
            }
            return;
        }
        // ── 分支 A：首轮 ──
        const env = (0, system_prompt_1.extractEnv)(body);
        const systemInstruction = (0, system_prompt_1.buildSystemInstruction)(env, config_1.default.systemMode);
        (0, system_prompt_1.dumpSystemAnatomy)(body, env, systemInstruction);
        // 带上历史文本轮：CC 每次回传全量 messages，只取最后一条会丢多轮上下文
        const contents = (0, anthropic_1.buildContents)(body);
        if (contents.length === 0) {
            res
                .status(400)
                .json((0, anthropic_1.buildErrorResponse)('empty user content', 'invalid_request_error'));
            return;
        }
        const sessionId = (0, antigravity_client_1.newSessionId)();
        const cascadeUuid = (0, uuid_1.v4)();
        const trajectoryUuid = (0, uuid_1.v4)();
        const stepIndex = 0;
        // 风控前置：必须在开流之前
        assertSafeToSend(tools, systemInstruction);
        if (stream)
            sse = new anthropic_1.AnthropicSseWriter(res, model);
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
            onText: stream ? (d) => sse.textDelta(d) : undefined,
        });
        if (outcome.kind === 'text') {
            const usage = toUsage(outcome.result.usage);
            if (stream) {
                sse.end(usage, 'end_turn');
            }
            else {
                res.json((0, anthropic_1.buildMessageResponse)(model, outcome.result.text, usage));
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
                sse.toolUse(u.toolUseId, u.claudeName, u.input);
            }
            sse.endToolUseBatch(usage);
        }
        else {
            res.json((0, anthropic_1.buildToolUseResponse)(model, outcome.result.text, outcome.toolUses, usage));
        }
    }
    catch (err) {
        sendErr(res, sse, err);
    }
});
// ---------- 启动 ----------
function startServer() {
    // 无 token 文件时优雅退出，不要栈式崩
    try {
        const tf = (0, auth_1.loadTokenFile)();
        console.log(`[boot] tokens=${tf.tokens.length} (names only: ${tf.tokens.map((t) => t.name).join(', ')})`);
    }
    catch (e) {
        console.error(`[boot] ${e instanceof Error ? e.message : String(e)}`);
        process.exit(1);
    }
    const { host, port } = config_1.default.server;
    return new Promise((resolve, reject) => {
        const server = app.listen(port, host, () => {
            console.log(`[boot] listening http://${host}:${port}`);
            console.log(`[boot] model=${config_1.default.antigravity.defaultModel} systemMode=${config_1.default.systemMode}`);
            resolve();
        });
        server.on('error', (err) => {
            console.error(`[boot] listen error: ${err.message}`);
            reject(err);
        });
    });
}
function onSignal(sig) {
    console.log(`[boot] ${sig} → cleanupAll + exit`);
    (0, pending_session_1.cleanupAll)();
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
//# sourceMappingURL=server.js.map