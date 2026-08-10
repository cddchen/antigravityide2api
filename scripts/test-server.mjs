// T6 —— 端到端（mock 上游，不打真实 Google）
// 规格：scripts/TEST-PLAN.md T6 + 用户追加断言
// 纯 node:assert + 内建 fetch/http/child_process

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

// ---------- 常量（追夹具 / 实现） ----------
// thoughtSignature 是 FC part 的兄弟键（wire-reference §1.3）
const THOUGHT_SIG = 'EuULCuILARFNMg/test-sig-must-replay-verbatim';
const TEXT_REPLY = 'hello from mock upstream';
const API_KEY = 'test-key';
// 2030-01-01T00:00:00Z；withAuth 实际只在 401 时 refresh，设远未来仅防后续改动
const EXPIRES_AT = 1893456000000;
// 用户必测：整个 body JSON 子串扫这些 CC 独有工具名
const CC_TOOL_SUBSTRINGS = [
  'CronCreate',
  'DesignSync',
  'EnterWorktree',
  'ScheduleWakeup',
  'NotebookEdit',
  'TaskCreate',
  'SendMessage',
  'WebFetch',
];
const OK_TOOL_NAMES = new Set(['Read', 'Bash', 'Write', 'Edit']);

// 高位端口，避开常用服务
const MOCK_PORT = 34111;
const SERVER_PORT = 34112;

// ---------- 结果收集 ----------
/** @type {{id:string, ok:boolean, detail?:string}[]} */
const results = [];
function check(id, fn) {
  try {
    fn();
    results.push({ id, ok: true });
    console.log(`  PASS  ${id}`);
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    results.push({ id, ok: false, detail });
    console.error(`  FAIL  ${id}`);
    console.error(`        ${detail}`);
  }
}
async function checkAsync(id, fn) {
  try {
    await fn();
    results.push({ id, ok: true });
    console.log(`  PASS  ${id}`);
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    results.push({ id, ok: false, detail });
    console.error(`  FAIL  ${id}`);
    console.error(`        ${detail}`);
  }
}

// ---------- SSE 假帧（形状照 wire-reference §1.4 + accumulateFrame） ----------
function usage(n = 10) {
  return {
    promptTokenCount: 100,
    candidatesTokenCount: n,
    totalTokenCount: 100 + n,
    thoughtsTokenCount: 5,
    cachedContentTokenCount: 0,
  };
}

/** 一帧 SSE JSON（无 event: 前缀，上游 alt=sse 风格） */
function frame(parts, finishReason = null, n = 10) {
  return {
    response: {
      candidates: [
        {
          content: { role: 'model', parts },
          finishReason,
        },
      ],
      usageMetadata: usage(n),
      modelVersion: 'gemini-3.6-flash',
      responseId: 'mock-resp',
    },
    traceId: 'mock-trace',
  };
}

/** 末帧：空 text + 独立 thoughtSignature + STOP（§1.4） */
function endFrame() {
  return frame([{ thoughtSignature: 'EvQBCvEB-end-frame-only', text: '' }], 'STOP', 21);
}

function encodeSse(frames) {
  let out = '';
  for (const f of frames) {
    out += `data: ${JSON.stringify(f)}\n\n`;
  }
  out += 'data: [DONE]\n\n';
  return out;
}

/** 纯文本一轮 */
function sseText(text) {
  return encodeSse([frame([{ text }], null, 5), endFrame()]);
}

/**
 * 2 个 FC 在同一 content.parts 里：
 * 第一个带 thoughtSignature，第二个不带（复刻真实 SSE 并行行为，§1.3 硬规则 3）
 */
function sseTwoFc() {
  return encodeSse([
    frame(
      [
        {
          functionCall: {
            id: 'fcA_list',
            name: 'list_dir',
            args: {
              DirectoryPath: '/tmp/ws',
              toolAction: 'Listing directory',
              toolSummary: 'List',
            },
          },
          thoughtSignature: THOUGHT_SIG,
        },
        {
          functionCall: {
            id: 'fcB_view',
            name: 'view_file',
            args: {
              AbsolutePath: '/tmp/ws/a.txt',
              toolAction: 'Reading file',
              toolSummary: 'Read',
            },
          },
          // 故意不带 thoughtSignature
        },
      ],
      null,
      15,
    ),
    endFrame(),
  ]);
}

/** 单 FC → 桥成 Bash（list_dir） */
function sseOneFc() {
  return encodeSse([
    frame(
      [
        {
          functionCall: {
            id: 'fc1_list',
            name: 'list_dir',
            args: {
              DirectoryPath: '/tmp/ws',
              toolAction: 'Listing directory',
              toolSummary: 'List',
            },
          },
          thoughtSignature: 'sig-one-fc',
        },
      ],
      null,
      12,
    ),
    endFrame(),
  ]);
}

// ---------- mock 上游 ----------
/** @type {object[]} */
const receivedBodies = [];
/** @type {((body:object, req:http.IncomingMessage) => {status:number, headers?:Record<string,string>, body:string})[]} */
const responseQueue = [];

function nextResponse(body, req) {
  if (responseQueue.length === 0) {
    // 默认纯文本，避免挂死
    return {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
      body: sseText(TEXT_REPLY),
    };
  }
  const fn = responseQueue.shift();
  return fn(body, req);
}

function startMockUpstream() {
  const server = http.createServer(async (req, res) => {
    const url = req.url || '/';
    const pathname = url.split('?')[0];

    // 读 body
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString('utf8');
    let parsed = null;
    try {
      parsed = raw ? JSON.parse(raw) : null;
    } catch {
      parsed = null;
    }

    if (pathname === '/v1internal:loadCodeAssist') {
      receivedBodies.push({ path: pathname, body: parsed, raw });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ cloudaicompanionProject: 'fake-project' }));
      return;
    }

    if (pathname === '/v1internal:streamGenerateContent') {
      receivedBodies.push({ path: pathname, body: parsed, raw });
      const out = nextResponse(parsed || {}, req);
      res.writeHead(out.status, {
        'content-type': 'text/event-stream',
        ...(out.headers || {}),
      });
      res.end(out.body);
      return;
    }

    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: `mock: unknown path ${pathname}` }));
  });

  return new Promise((resolve, reject) => {
    server.listen(MOCK_PORT, '127.0.0.1', () => resolve(server));
    server.on('error', reject);
  });
}

// ---------- 被测 server 生命周期 ----------
/** @type {import('node:child_process').ChildProcess | null} */
let child = null;
let tokenPath = '';
let workspaceDir = '';

function writeTokenFile() {
  tokenPath = path.join(os.tmpdir(), `ag2api-t6-token-${process.pid}.json`);
  // 预填 projectId → 跳过 loadCodeAssist（auth.ts ensureProjectId 短路）
  const tf = {
    tokens: [
      {
        name: 'account-test',
        accessToken: 'ya29.fake-access-token-for-t6-test-do-not-leak',
        refreshToken: '1//fake-refresh-token-for-t6',
        projectId: 'fake-project-prefilled',
        expiresAt: EXPIRES_AT,
        machineId: 'fake-machine',
      },
    ],
  };
  fs.writeFileSync(tokenPath, JSON.stringify(tf, null, 2), { mode: 0o600 });
  return tokenPath;
}

function startServerProcess() {
  workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag2api-ws-'));
  const env = {
    ...process.env,
    TOKEN_FILE: tokenPath,
    PORT: String(SERVER_PORT),
    HOST: '127.0.0.1',
    ANTIGRAVITY_BASE: `http://127.0.0.1:${MOCK_PORT}`,
    API_KEY: API_KEY,
    WORKSPACE_ROOT: workspaceDir,
    // 防 pending 超时干扰续轮
    PENDING_TIMEOUT: '600000',
    // 测试期间不希望外泄
    NODE_ENV: 'test',
  };
  child = spawn(process.execPath, [path.join(root, 'dist/server.js')], {
    env,
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let bootLog = '';
  child.stdout.on('data', (d) => {
    bootLog += d.toString();
  });
  child.stderr.on('data', (d) => {
    bootLog += d.toString();
  });
  child._bootLog = () => bootLog;
  return child;
}

async function waitHealthy(timeoutMs = 8000) {
  const start = Date.now();
  let lastErr = '';
  while (Date.now() - start < timeoutMs) {
    if (child && child.exitCode != null) {
      throw new Error(
        `server 提前退出 code=${child.exitCode}\n${child._bootLog?.() || ''}`,
      );
    }
    try {
      const r = await fetch(`http://127.0.0.1:${SERVER_PORT}/health`);
      if (r.ok) return;
      lastErr = `status ${r.status}`;
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`server 未在 ${timeoutMs}ms 内就绪: ${lastErr}\n${child?._bootLog?.() || ''}`);
}

function killChild() {
  if (!child || child.killed || child.exitCode != null) return;
  try {
    child.kill('SIGTERM');
  } catch {
    /* ignore */
  }
  // 兜底
  setTimeout(() => {
    try {
      if (child && child.exitCode == null) child.kill('SIGKILL');
    } catch {
      /* ignore */
    }
  }, 1000).unref?.();
}

// ---------- HTTP 客户端 ----------
function baseUrl() {
  return `http://127.0.0.1:${SERVER_PORT}`;
}

async function api(pathname, { method = 'GET', headers = {}, body, key } = {}) {
  const h = { ...headers };
  if (key !== null) {
    // key === undefined → 默认带正确 key；null → 不带；string → 指定
    const k = key === undefined ? API_KEY : key;
    if (k) h['x-api-key'] = k;
  }
  if (body !== undefined) h['content-type'] = 'application/json';
  const res = await fetch(`${baseUrl()}${pathname}`, {
    method,
    headers: h,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* 流式或非 JSON */
  }
  return { status: res.status, text, json, headers: res.headers };
}

/** 最小 Anthropic body；system 满足 extractEnv 正则 */
function msgBody(overrides = {}) {
  return {
    model: 'gemini-3.6-flash-high',
    stream: false,
    system:
      ' - Primary working directory: /tmp/ws\n' +
      ' - Platform: darwin\n' +
      ' - Is a git repository: false\n',
    messages: [{ role: 'user', content: 'hello test' }],
    ...overrides,
  };
}

/** 解析 Anthropic SSE 事件序列 */
function parseAnthropicSse(text) {
  /** @type {{event:string, data:any}[]} */
  const events = [];
  for (const block of text.split('\n\n')) {
    if (!block.trim()) continue;
    const em = block.match(/^event:\s*(.+)$/m);
    const dm = block.match(/^data:\s*(.+)$/m);
    if (em && dm) {
      let data = dm[1];
      try {
        data = JSON.parse(dm[1]);
      } catch {
        /* keep string */
      }
      events.push({ event: em[1].trim(), data });
    }
  }
  return events;
}

// ---------- 断言 helpers ----------
function lastStreamBody() {
  const hits = receivedBodies.filter((b) => b.path === '/v1internal:streamGenerateContent');
  assert.ok(hits.length > 0, 'mock 未收到 streamGenerateContent');
  return hits[hits.length - 1];
}

function assertNoCcToolsInBody(rawOrObj) {
  const s = typeof rawOrObj === 'string' ? rawOrObj : JSON.stringify(rawOrObj);
  for (const name of CC_TOOL_SUBSTRINGS) {
    assert.ok(!s.includes(name), `上游 body 不得含 CC 工具名子串: ${name}`);
  }
  assert.ok(!s.includes('<system-reminder'), '上游 body 不得含 <system-reminder');
}

// ================================================================
//  主流程
// ================================================================
let mockServer = null;

async function main() {
  console.log('T6 test-server (mock 上游 e2e)');

  writeTokenFile();
  mockServer = await startMockUpstream();
  startServerProcess();
  await waitHealthy();

  // ── 6.1 /health 无 key ──
  await checkAsync('6.1 GET /health 无 key → {ok:true} 且无 ya29', async () => {
    const r = await api('/health', { key: null });
    assert.equal(r.status, 200);
    assert.equal(r.json?.ok, true);
    assert.equal(typeof r.json?.tokens, 'number');
    assert.ok(r.json.tokens >= 1, `tokens 计数应 ≥1，实际 ${r.json.tokens}`);
    assert.ok(!r.text.includes('ya29'), 'health 响应不得含 token 明文 ya29');
    assert.ok(!r.text.includes('fake-access-token'), 'health 不得回 accessToken');
    assert.ok(!r.text.includes('fake-refresh'), 'health 不得回 refreshToken');
  });

  // ── 6.2 /v1/models ──
  await checkAsync('6.2 GET /v1/models → data[] 非空', async () => {
    const r = await api('/v1/models');
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.json?.data), 'data 应为数组');
    assert.ok(r.json.data.length > 0, 'data[] 非空');
    assert.ok(r.json.data[0].id, 'data[0].id 存在');
  });

  // ── 6.3 鉴权 ──
  await checkAsync('6.3a 无 key 打 /v1/messages → 401', async () => {
    const r = await api('/v1/messages', {
      method: 'POST',
      key: null,
      body: msgBody(),
    });
    assert.equal(r.status, 401);
  });

  await checkAsync('6.3b 错 key 打 /v1/messages → 401', async () => {
    const r = await api('/v1/messages', {
      method: 'POST',
      key: 'wrong-key',
      body: msgBody(),
    });
    assert.equal(r.status, 401);
  });

  // ── 6.4 首轮纯文本 ──
  await checkAsync('6.4 首轮纯文本 → 200 end_turn + 正确 text', async () => {
    const before = receivedBodies.length;
    responseQueue.push(() => ({
      status: 200,
      body: sseText(TEXT_REPLY),
    }));
    const r = await api('/v1/messages', { method: 'POST', body: msgBody() });
    assert.equal(r.status, 200, `status ${r.status} body=${r.text.slice(0, 300)}`);
    assert.equal(r.json?.stop_reason, 'end_turn');
    assert.equal(r.json?.content?.[0]?.type, 'text');
    assert.equal(r.json?.content?.[0]?.text, TEXT_REPLY);
    assert.ok(receivedBodies.length > before, 'mock 应收到上游请求');
  });

  // ── 6.6 风控核心（借 6.4 之后最新 body；再打一次纯文本保证） ──
  await checkAsync(
    '6.6 mock body: tools=14, systemInstruction.role=user, 无 CC 工具名/system-reminder',
    async () => {
      responseQueue.push(() => ({ status: 200, body: sseText('ok') }));
      const r = await api('/v1/messages', {
        method: 'POST',
        body: msgBody({
          messages: [
            {
              role: 'user',
              content: [
                {
                  type: 'text',
                  text:
                    '<system-reminder>\n# claudeMd\nshould be stripped\n</system-reminder>\n\npayload-hi',
                },
              ],
            },
          ],
        }),
      });
      assert.equal(r.status, 200, r.text.slice(0, 300));
      const hit = lastStreamBody();
      const env = hit.body;
      assert.ok(env?.request?.tools, 'envelope.request.tools');
      assert.equal(env.request.tools.length, 14, `tools.length=${env.request.tools.length}`);
      assert.equal(env.request.systemInstruction?.role, 'user');
      assertNoCcToolsInBody(hit.raw || env);
      // tools 项名也不得是 CC 独有
      const names = env.request.tools.map((t) => t.functionDeclarations?.[0]?.name);
      for (const n of CC_TOOL_SUBSTRINGS) {
        assert.ok(!names.includes(n), `tools 不得含 ${n}`);
      }
    },
  );

  // ── 6.5 单 FC ──
  await checkAsync('6.5 mock 回 1 个 FC → tool_use 且 name∈{Read,Bash,Write,Edit}', async () => {
    responseQueue.push(() => ({ status: 200, body: sseOneFc() }));
    const r = await api('/v1/messages', { method: 'POST', body: msgBody() });
    assert.equal(r.status, 200, r.text.slice(0, 400));
    assert.equal(r.json?.stop_reason, 'tool_use');
    const uses = (r.json?.content || []).filter((c) => c.type === 'tool_use');
    assert.equal(uses.length, 1, `tool_use 数=${uses.length}`);
    assert.ok(OK_TOOL_NAMES.has(uses[0].name), `name=${uses[0].name}`);
    // list_dir → Bash
    assert.equal(uses[0].name, 'Bash');
    assert.equal(uses[0].id, 'fc1_list');
  });

  // 上面 6.5 留下了 pending；用 unknown id 会 400，先清掉：带正确 tool_result 走完一轮文本
  await checkAsync('cleanup-after-6.5 用 tool_result 收尾', async () => {
    responseQueue.push(() => ({ status: 200, body: sseText('after-one-fc') }));
    const r = await api('/v1/messages', {
      method: 'POST',
      body: msgBody({
        messages: [
          { role: 'user', content: 'hello test' },
          {
            role: 'assistant',
            content: [
              {
                type: 'tool_use',
                id: 'fc1_list',
                name: 'Bash',
                input: { command: 'true' },
              },
            ],
          },
          {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'fc1_list',
                content: '{"name":"a","sizeBytes":"1"}',
              },
            ],
          },
        ],
      }),
    });
    assert.equal(r.status, 200, r.text.slice(0, 400));
    assert.equal(r.json?.stop_reason, 'end_turn');
  });

  // ── 双 FC 非流式 + 续轮 ──
  let twoFcResp = null;
  await checkAsync('双 FC 首轮 → stop_reason=tool_use 且 2 个 tool_use 块', async () => {
    responseQueue.push(() => ({ status: 200, body: sseTwoFc() }));
    const r = await api('/v1/messages', { method: 'POST', body: msgBody() });
    assert.equal(r.status, 200, r.text.slice(0, 400));
    assert.equal(r.json?.stop_reason, 'tool_use');
    const uses = (r.json?.content || []).filter((c) => c.type === 'tool_use');
    assert.equal(uses.length, 2, `tool_use 数=${uses.length}`);
    for (const u of uses) {
      assert.ok(OK_TOOL_NAMES.has(u.name), `name=${u.name}`);
    }
    // list_dir→Bash, view_file→Read；id 原样
    const byId = Object.fromEntries(uses.map((u) => [u.id, u]));
    assert.ok(byId.fcA_list, 'fcA_list');
    assert.ok(byId.fcB_view, 'fcB_view');
    assert.equal(byId.fcA_list.name, 'Bash');
    assert.equal(byId.fcB_view.name, 'Read');
    twoFcResp = r.json;
  });

  // 记录双 FC 首轮后 mock 收到的 contents 长度，供续轮 diff
  const afterTwoFcFirst = lastStreamBody();
  const contentsLenBeforeResume = afterTwoFcFirst.body?.request?.contents?.length ?? 0;

  // ── 续轮缺 1 个 tool_result → 400 ──
  await checkAsync('续轮只带 1 个 tool_result（缺一个）→ 400', async () => {
    assert.ok(twoFcResp, '前置双 FC 失败');
    // 不入队 mock：应在本地 400，不打上游
    const before = receivedBodies.length;
    const r = await api('/v1/messages', {
      method: 'POST',
      body: msgBody({
        messages: [
          { role: 'user', content: 'hello test' },
          {
            role: 'assistant',
            content: twoFcResp.content,
          },
          {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'fcA_list',
                content: 'only-one',
              },
              // 故意缺 fcB_view
            ],
          },
        ],
      }),
    });
    assert.equal(r.status, 400, `期望 400 实际 ${r.status} ${r.text.slice(0, 300)}`);
    assert.equal(receivedBodies.length, before, '缺 tool_result 不得打上游');
  });

  // ── 未知 tool_use_id → 400 ──
  await checkAsync('未知 tool_use_id → 400（非 500）', async () => {
    const before = receivedBodies.length;
    const r = await api('/v1/messages', {
      method: 'POST',
      body: msgBody({
        messages: [
          { role: 'user', content: 'hello test' },
          {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'totally-unknown-id-xyz',
                content: 'x',
              },
            ],
          },
        ],
      }),
    });
    assert.equal(r.status, 400, `期望 400 实际 ${r.status} ${r.text.slice(0, 300)}`);
    assert.notEqual(r.status, 500);
    assert.equal(receivedBodies.length, before, '未知 id 不得打上游');
  });

  // ── 6.7 / 6.8 续轮带齐 2 个 tool_result ──
  await checkAsync(
    '6.7/6.8 续轮 2 tool_result：contents +2 条 model、FC 合并+sig 原样、FR output 字符串 Created At:',
    async () => {
      assert.ok(twoFcResp, '前置双 FC 失败');
      responseQueue.push(() => ({ status: 200, body: sseText('resumed-done') }));
      const r = await api('/v1/messages', {
        method: 'POST',
        body: msgBody({
          messages: [
            { role: 'user', content: 'hello test' },
            { role: 'assistant', content: twoFcResp.content },
            {
              role: 'user',
              content: [
                {
                  type: 'tool_result',
                  tool_use_id: 'fcA_list',
                  content: '{"name":"a","sizeBytes":"1"}',
                },
                {
                  type: 'tool_result',
                  tool_use_id: 'fcB_view',
                  content: 'file-body-line1\nline2',
                },
              ],
            },
          ],
        }),
      });
      assert.equal(r.status, 200, r.text.slice(0, 400));
      assert.equal(r.json?.stop_reason, 'end_turn');

      const hit = lastStreamBody();
      const contents = hit.body?.request?.contents;
      assert.ok(Array.isArray(contents), 'contents 应为数组');

      // 新增恰好 2 条
      const added = contents.length - contentsLenBeforeResume;
      assert.equal(
        added,
        2,
        `新增 contents 条数期望 2 实际 ${added} (before=${contentsLenBeforeResume} after=${contents.length})`,
      );

      const last2 = contents.slice(-2);
      assert.equal(last2[0].role, 'model', '倒数第二条 role');
      assert.equal(last2[1].role, 'model', '最后一条 role');

      // 倒数第二条：2 个 FC 合并在同一 content，parts[0].thoughtSignature 原样
      assert.equal(
        last2[0].parts.length,
        2,
        `FC content parts.length 期望 2 实际 ${last2[0].parts.length}`,
      );
      assert.ok(last2[0].parts[0].functionCall, 'parts[0] 应是 functionCall');
      assert.ok(last2[0].parts[1].functionCall, 'parts[1] 应是 functionCall');
      assert.equal(
        last2[0].parts[0].thoughtSignature,
        THOUGHT_SIG,
        `thoughtSignature 期望原样回放\n  expect: ${THOUGHT_SIG}\n  actual: ${last2[0].parts[0].thoughtSignature}`,
      );
      // 第二个 FC 无 sig（或 undefined）
      assert.equal(
        last2[0].parts[1].thoughtSignature,
        undefined,
        '第二个 FC 不应凭空带 sig',
      );

      // 最后一条：全是 functionResponse，response 只有 output 且为 string
      assert.ok(last2[1].parts.length >= 2, 'FR parts 至少 2');
      for (const p of last2[1].parts) {
        assert.ok(p.functionResponse, `期望 functionResponse，实际键=${Object.keys(p)}`);
        const resp = p.functionResponse.response;
        assert.ok(resp && typeof resp === 'object', 'response 对象');
        const keys = Object.keys(resp);
        assert.deepEqual(keys, ['output'], `response 键应仅 output，实际 ${JSON.stringify(keys)}`);
        assert.equal(typeof resp.output, 'string', 'output 必须是 string');
        // 6.8 Created At: 前缀（tool-bridge successOutput / §1.3.1）
        assert.ok(
          resp.output.startsWith('Created At:'),
          `output 应以 Created At: 开头，实际 head=${resp.output.slice(0, 40)}`,
        );
      }

      // 续轮 body 仍 14 tools、无 CC 泄漏
      assert.equal(hit.body.request.tools.length, 14);
      assertNoCcToolsInBody(hit.raw || hit.body);
    },
  );

  // ── 6.9 / 6.11 流式双 FC ──
  await checkAsync(
    '6.9/6.11 stream:true 双 FC → 2 tool_use + message_start/stop 合法序列',
    async () => {
      responseQueue.push(() => ({ status: 200, body: sseTwoFc() }));
      const r = await api('/v1/messages', {
        method: 'POST',
        body: msgBody({ stream: true }),
      });
      assert.equal(r.status, 200, r.text.slice(0, 200));
      assert.ok(r.text.includes('event: message_start'), '应含 event: message_start');
      assert.ok(r.text.includes('event: message_stop'), '应含 event: message_stop');

      const events = parseAnthropicSse(r.text);
      assert.ok(events.length > 0, '应解析到 SSE 事件');

      // message_start 唯一且第一
      const starts = events.filter((e) => e.event === 'message_start');
      const stops = events.filter((e) => e.event === 'message_stop');
      assert.equal(starts.length, 1, `message_start 应唯一，实际 ${starts.length}`);
      assert.equal(stops.length, 1, `message_stop 应唯一，实际 ${stops.length}`);
      assert.equal(events[0].event, 'message_start');
      assert.equal(events[events.length - 1].event, 'message_stop');

      // content_block_start / stop 配对
      const blockStarts = events.filter((e) => e.event === 'content_block_start');
      const blockStops = events.filter((e) => e.event === 'content_block_stop');
      assert.equal(
        blockStarts.length,
        blockStops.length,
        `content_block_start(${blockStarts.length}) 与 stop(${blockStops.length}) 应对齐`,
      );

      // 2 个 tool_use 块
      const toolBlocks = blockStarts.filter(
        (e) => e.data?.content_block?.type === 'tool_use',
      );
      assert.equal(toolBlocks.length, 2, `流式 tool_use 块数=${toolBlocks.length}`);

      // stop_reason tool_use 在 message_delta
      const deltas = events.filter((e) => e.event === 'message_delta');
      assert.ok(deltas.length >= 1, '应有 message_delta');
      const lastDelta = deltas[deltas.length - 1];
      assert.equal(lastDelta.data?.delta?.stop_reason, 'tool_use');

      // 风控：本轮上游 body
      const hit = lastStreamBody();
      assert.equal(hit.body.request.tools.length, 14);
      assertNoCcToolsInBody(hit.raw || hit.body);
    },
  );

  // 流式留下 pending，收尾避免僵尸 session（可选）
  // 直接 kill 进程即可

  // ── 汇总 ──
  const failed = results.filter((r) => !r.ok);
  const passed = results.filter((r) => r.ok);
  console.log('\n========== T6 汇总 ==========');
  for (const r of results) {
    console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.id}${r.detail ? '  ← ' + r.detail.split('\n')[0] : ''}`);
  }
  console.log(`--------------------------`);
  console.log(`通过 ${passed.length} / 失败 ${failed.length} / 合计 ${results.length}`);

  // 把 mock SSE 样例打到 stdout 末尾，便于报告
  console.log('\n========== mock SSE 帧样例 ==========');
  console.log('--- 纯文本 ---');
  console.log(sseText(TEXT_REPLY).trimEnd());
  console.log('--- 双 FC（首 part 带 thoughtSignature） ---');
  console.log(sseTwoFc().trimEnd());

  if (failed.length > 0) {
    process.exitCode = 1;
  }
}

async function cleanup() {
  killChild();
  if (mockServer) {
    await new Promise((resolve) => mockServer.close(() => resolve()));
    mockServer = null;
  }
  if (tokenPath) {
    try {
      fs.unlinkSync(tokenPath);
    } catch {
      /* ignore */
    }
  }
  if (workspaceDir) {
    try {
      fs.rmSync(workspaceDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

main()
  .catch((e) => {
    console.error('T6 致命错误:', e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await cleanup();
    // 给 SIGTERM 一点时间
    await new Promise((r) => setTimeout(r, 200));
    process.exit(process.exitCode || 0);
  });
