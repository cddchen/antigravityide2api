// T5 —— 多轮状态机（400 陷阱回归）
// pendingTimeout 必须在 import config 之前注入
process.env.PENDING_TIMEOUT = '50';

import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

// 清模块缓存风险：用动态 import（首次加载）
const pending = await import(path.join(root, 'dist/pending-session.js'));
const {
  registerPending,
  getPendingByToolId,
  removePending,
  appendToolRound,
  cleanupAll,
  pendingCount,
} = pending;

// 确保干净
cleanupAll();

function makeSession(ids) {
  return {
    sessionKey: 'sk-test',
    claudeToolIds: ids,
    bridged: new Map(),
    pendingFcParts: [],
    contents: [],
    sessionId: '-1',
    cascadeUuid: 'c',
    trajectoryUuid: 't',
    stepIndex: 0,
    projectId: 'p',
    model: 'm',
    tokenName: 'n',
    systemInstruction: '',
    createdAt: Date.now(),
    timer: null,
  };
}

// 5.1 一个 session 注册 3 个 tool id，任一都能 get 到同一对象
{
  const s = makeSession(['t1', 't2', 't3']);
  registerPending(s);
  assert.strictEqual(getPendingByToolId('t1'), s);
  assert.strictEqual(getPendingByToolId('t2'), s);
  assert.strictEqual(getPendingByToolId('t3'), s);
  // 5.2 remove 后全部 miss
  removePending(s);
  assert.equal(getPendingByToolId('t1'), undefined);
  assert.equal(getPendingByToolId('t2'), undefined);
  assert.equal(getPendingByToolId('t3'), undefined);
}

// 5.3 appendToolRound 恰好 push 2 条 content（§1.3）
// 5.4 两条 role 都是 'model'
// 5.5 contents[n].parts 与传入 fcParts 引用相同
{
  const fcParts = [
    {
      functionCall: { id: 'fc1', name: 'list_dir', args: {} },
      thoughtSignature: 'sig-raw',
    },
  ];
  const frParts = [
    {
      functionResponse: {
        id: 'fc1',
        name: 'list_dir',
        response: { output: 'Created At: x\nCompleted At: x\nok' },
      },
    },
  ];
  const contents = [];
  appendToolRound(contents, fcParts, frParts);
  assert.equal(contents.length, 2);
  assert.equal(contents[0].role, 'model');
  assert.equal(contents[1].role, 'model');
  assert.strictEqual(contents[0].parts, fcParts);
  assert.strictEqual(contents[1].parts, frParts);
}

// 5.6 2 个 FC（仅第一个带 sig）经一轮 append 后在同一个 content 的 parts 里，且第一个 sig 未丢
{
  const fcParts = [
    {
      functionCall: { id: 'a', name: 'list_dir', args: {} },
      thoughtSignature: 'keep-me',
    },
    {
      functionCall: { id: 'b', name: 'view_file', args: {} },
    },
  ];
  const frParts = [
    {
      functionResponse: {
        id: 'a',
        name: 'list_dir',
        response: { output: 'ok' },
      },
    },
    {
      functionResponse: {
        id: 'b',
        name: 'view_file',
        response: { output: 'ok' },
      },
    },
  ];
  const contents = [];
  appendToolRound(contents, fcParts, frParts);
  assert.equal(contents[0].parts.length, 2);
  assert.strictEqual(contents[0].parts, fcParts);
  assert.equal(contents[0].parts[0].thoughtSignature, 'keep-me');
  assert.equal(contents[0].parts[1].functionCall.id, 'b');
}

// 5.7 序列化整个 contents，thoughtSignature 出现次数 === 输入里的次数
{
  const fcParts = [
    {
      functionCall: { id: 'a', name: 'list_dir', args: {} },
      thoughtSignature: 'sig-A',
    },
    {
      functionCall: { id: 'b', name: 'view_file', args: {} },
      thoughtSignature: 'sig-B',
    },
  ];
  const frParts = [
    {
      functionResponse: {
        id: 'a',
        name: 'list_dir',
        response: { output: 'x' },
      },
    },
  ];
  const contents = [{ role: 'user', parts: [{ text: 'hi' }] }];
  appendToolRound(contents, fcParts, frParts);
  const json = JSON.stringify(contents);
  const inputCount = (JSON.stringify(fcParts).match(/thoughtSignature/g) || []).length;
  const outCount = (json.match(/thoughtSignature/g) || []).length;
  assert.equal(outCount, inputCount);
  assert.equal(outCount, 2);
}

// 5.8 pendingTimeout=50ms 时 60ms 后自动清空
// （本文件顶部在 import 前设了 PENDING_TIMEOUT=50；CJS→ESM  dual default 不在此再验）
{
  cleanupAll();
  const s = makeSession(['to1', 'to2']);
  registerPending(s);
  assert.ok(getPendingByToolId('to1'));
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(getPendingByToolId('to1'), undefined, '超时后应被清空');
  assert.equal(getPendingByToolId('to2'), undefined);
  assert.equal(pendingCount(), 0);
}

cleanupAll();
console.log('PASS test-pending.mjs (8 assertion groups)');
