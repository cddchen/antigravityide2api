// ═══════════════════════════════════════════════
//  Pending Session 管理（进程内 Map）
//  与 cursor 关键差异：无长连接，pending 存完整原生 contents 历史
// ═══════════════════════════════════════════════

import assert from 'assert';
import config from './config';
import type { NativeContent, NativePart, PendingAgentSession } from './types';

/** tool_use id → session；同一 session 的全部 claudeToolIds 都指向同一对象 */
const pendingByToolId = new Map<string, PendingAgentSession>();

export function registerPending(s: PendingAgentSession): void {
  if (s.claudeToolIds.length === 0) {
    throw new Error('registerPending: claudeToolIds 为空');
  }
  for (const id of s.claudeToolIds) {
    if (pendingByToolId.has(id)) {
      throw new Error(`Duplicate pending tool_use id: ${id}`);
    }
  }

  // pendingTimeout <= 0 表示不超时
  if (config.antigravity.pendingTimeout > 0) {
    s.timer = setTimeout(() => {
      removePending(s);
    }, config.antigravity.pendingTimeout);
  } else {
    s.timer = null;
  }

  for (const id of s.claudeToolIds) {
    pendingByToolId.set(id, s);
  }
}

export function getPendingByToolId(toolUseId: string): PendingAgentSession | undefined {
  return pendingByToolId.get(toolUseId);
}

export function removePending(s: PendingAgentSession): void {
  if (s.timer) {
    clearTimeout(s.timer);
    s.timer = null;
  }
  for (const id of s.claudeToolIds) {
    // 只删指向本 session 的索引，防误伤后来覆盖的 id
    if (pendingByToolId.get(id) === s) {
      pendingByToolId.delete(id);
    }
  }
}

export function cleanupAll(): void {
  // 先收集唯一 session，避免边遍历边删
  const sessions = new Set(pendingByToolId.values());
  for (const s of sessions) {
    removePending(s);
  }
}

export function pendingCount(): number {
  return pendingByToolId.size;
}

/**
 * resume 时把上一轮的 FC 与本轮 FR 追加进 contents。
 * 硬规则（wire-reference §1.3）：
 *  - FC 与 FR 都是 role:"model"
 *  - 一次 SSE 的**所有** FC parts 必须在**同一个** content 里，不可拆
 *  - FC parts 必须原样（含 thoughtSignature），不可重建
 */
export function appendToolRound(
  contents: NativeContent[],
  fcParts: NativePart[],
  frParts: NativePart[],
): void {
  // 原样引用，不拷贝/重建 parts 数组
  contents.push({ role: 'model', parts: fcParts });
  contents.push({ role: 'model', parts: frParts });
}

// ---------- 自检 ----------

if (require.main === module) {
  // 1. 注册 3 个 tool id 指向同一 session
  const session: PendingAgentSession = {
    sessionKey: 'sk1',
    claudeToolIds: ['t1', 't2', 't3'],
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
  registerPending(session);
  assert.strictEqual(pendingCount(), 3);

  // 2. 任一 id 能取回同一对象
  assert.strictEqual(getPendingByToolId('t1'), session);
  assert.strictEqual(getPendingByToolId('t2'), session);
  assert.strictEqual(getPendingByToolId('t3'), session);
  assert.strictEqual(getPendingByToolId('missing'), undefined);

  // 3. remove 后全部消失
  removePending(session);
  assert.strictEqual(pendingCount(), 0);
  assert.strictEqual(getPendingByToolId('t1'), undefined);
  assert.strictEqual(getPendingByToolId('t2'), undefined);
  assert.strictEqual(getPendingByToolId('t3'), undefined);

  // 4. appendToolRound push 恰好 2 条且 fcParts 是同一引用
  const fcParts: NativePart[] = [
    {
      functionCall: { id: 'fc1', name: 'list_dir', args: {} },
      thoughtSignature: 'sig-raw',
    },
  ];
  const frParts: NativePart[] = [
    {
      functionResponse: {
        id: 'fc1',
        name: 'list_dir',
        response: { output: 'ok' },
      },
    },
  ];
  const contents: NativeContent[] = [];
  appendToolRound(contents, fcParts, frParts);
  assert.strictEqual(contents.length, 2);
  assert.strictEqual(contents[0].role, 'model');
  assert.strictEqual(contents[1].role, 'model');
  assert.strictEqual(contents[0].parts, fcParts); // 同一引用，未拷贝
  assert.strictEqual(contents[1].parts, frParts);
  assert.strictEqual(contents[0].parts[0].thoughtSignature, 'sig-raw');

  // 5. cleanupAll
  registerPending({
    ...session,
    claudeToolIds: ['a', 'b'],
    timer: null,
  });
  assert.strictEqual(pendingCount(), 2);
  cleanupAll();
  assert.strictEqual(pendingCount(), 0);
}
