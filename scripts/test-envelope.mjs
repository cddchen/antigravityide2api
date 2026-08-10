// T1 —— 上游信封形状（对照 docs/ag-envelope.capture.json）
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const capture = JSON.parse(
  fs.readFileSync(path.join(root, 'docs/ag-envelope.capture.json'), 'utf8'),
);

const client = await import(path.join(root, 'dist/antigravity-client.js'));
const { buildEnvelope, newSessionId } = client;
const native = await import(path.join(root, 'dist/native-tools.js'));
const { getNativeTools, NATIVE_TOOL_NAMES } = native;

const tools = getNativeTools();
const envelope = buildEnvelope({
  projectId: 'proj',
  model: 'gemini-3.6-flash-high',
  contents: [],
  systemInstruction: 'sys',
  tools,
  sessionId: newSessionId(),
  cascadeUuid: 'cascade-uuid',
  trajectoryUuid: 'traj-uuid',
  stepIndex: 34,
});

// 1.1
assert.equal(envelope.userAgent, 'antigravity');
// 1.2
assert.equal(envelope.requestType, 'agent');
// 1.3 requestId 形状（capture: agent/<uuid>/<13digit>/<uuid>/<n>）
assert.match(
  envelope.requestId,
  /^agent\/[^/]+\/\d{13}\/[^/]+\/\d+$/,
  `requestId shape: ${envelope.requestId}`,
);
// 1.4 systemInstruction.role 必须是 user（§1.2 / capture）
assert.equal(envelope.request.systemInstruction.role, 'user');
// 1.5
assert.equal(
  envelope.request.toolConfig.functionCallingConfig.mode,
  'VALIDATED',
);
// 1.6
assert.equal(envelope.request.generationConfig.maxOutputTokens, 65536);
// 1.7
assert.deepEqual(envelope.request.generationConfig.thinkingConfig, {
  includeThoughts: true,
  thinkingBudget: -1,
});
// 1.8 sessionId 负 int64 字符串
{
  const sid = envelope.request.sessionId;
  assert.match(sid, /^-\d+$/, `sessionId regex: ${sid}`);
  const n = BigInt(sid);
  assert.ok(n < 0n, `sessionId BigInt < 0: ${sid}`);
}
// 1.9 连续 20 次
for (let i = 0; i < 20; i++) {
  const sid = newSessionId();
  assert.match(sid, /^-\d+$/, `newSessionId[${i}] regex: ${sid}`);
  assert.ok(BigInt(sid) < 0n, `newSessionId[${i}] < 0: ${sid}`);
}
// 1.10 14 项且每项 1 个 functionDeclaration
assert.equal(envelope.request.tools.length, 14);
for (let i = 0; i < 14; i++) {
  assert.equal(
    envelope.request.tools[i].functionDeclarations.length,
    1,
    `tools[${i}].functionDeclarations.length`,
  );
}
// 1.11 有序等于 capture 0..13
assert.deepEqual(
  envelope.request.tools.map((t) => t.functionDeclarations[0].name),
  NATIVE_TOOL_NAMES,
);
// 1.12 顶层键集合 === capture
assert.deepEqual(
  Object.keys(envelope).sort(),
  Object.keys(capture.envelope).sort(),
);
// 1.13 request 键集合 === capture.request
assert.deepEqual(
  Object.keys(envelope.request).sort(),
  Object.keys(capture.envelope.request).sort(),
);
// 1.14 labels 最小集（§1.2 P0）
{
  const lab = envelope.request.labels;
  assert.ok('trajectory_id' in lab, 'labels.trajectory_id');
  assert.ok('last_step_index' in lab, 'labels.last_step_index');
  assert.ok('used_claude' in lab, 'labels.used_claude');
  assert.equal(lab.used_claude, 'false');
}
// 1.15 序列化后不含 CC 独有工具名（wire-reference / BLACK 独有词，10 个代表）
{
  const json = JSON.stringify(envelope);
  // 依据 docs/wire-reference.md + leakcheck 黑名单独有工具（非 Read/Write 等短词）
  const exclusive = [
    'CronCreate',
    'CronDelete',
    'CronList',
    'DesignSync',
    'EnterWorktree',
    'ExitWorktree',
    'NotebookEdit',
    'ReportFindings',
    'ScheduleWakeup',
    'SendMessage',
  ];
  for (const w of exclusive) {
    assert.ok(!json.includes(w), `envelope JSON 不得含 CC 独有词: ${w}`);
  }
}

console.log('PASS test-envelope.mjs (15 assertions groups)');
