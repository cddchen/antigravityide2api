"use strict";
// ═══════════════════════════════════════════════
//  Pending Session 管理（进程内 Map）
//  与 cursor 关键差异：无长连接，pending 存完整原生 contents 历史
// ═══════════════════════════════════════════════
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerPending = registerPending;
exports.getPendingByToolId = getPendingByToolId;
exports.removePending = removePending;
exports.cleanupAll = cleanupAll;
exports.pendingCount = pendingCount;
exports.appendToolRound = appendToolRound;
const assert_1 = __importDefault(require("assert"));
const config_1 = __importDefault(require("./config"));
/** tool_use id → session；同一 session 的全部 claudeToolIds 都指向同一对象 */
const pendingByToolId = new Map();
function registerPending(s) {
    if (s.claudeToolIds.length === 0) {
        throw new Error('registerPending: claudeToolIds 为空');
    }
    for (const id of s.claudeToolIds) {
        if (pendingByToolId.has(id)) {
            throw new Error(`Duplicate pending tool_use id: ${id}`);
        }
    }
    // pendingTimeout <= 0 表示不超时
    if (config_1.default.antigravity.pendingTimeout > 0) {
        s.timer = setTimeout(() => {
            removePending(s);
        }, config_1.default.antigravity.pendingTimeout);
    }
    else {
        s.timer = null;
    }
    for (const id of s.claudeToolIds) {
        pendingByToolId.set(id, s);
    }
}
function getPendingByToolId(toolUseId) {
    return pendingByToolId.get(toolUseId);
}
function removePending(s) {
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
function cleanupAll() {
    // 先收集唯一 session，避免边遍历边删
    const sessions = new Set(pendingByToolId.values());
    for (const s of sessions) {
        removePending(s);
    }
}
function pendingCount() {
    return pendingByToolId.size;
}
/**
 * resume 时把上一轮的 FC 与本轮 FR 追加进 contents。
 * 硬规则（wire-reference §1.3）：
 *  - FC 与 FR 都是 role:"model"
 *  - 一次 SSE 的**所有** FC parts 必须在**同一个** content 里，不可拆
 *  - FC parts 必须原样（含 thoughtSignature），不可重建
 */
function appendToolRound(contents, fcParts, frParts) {
    // 原样引用，不拷贝/重建 parts 数组
    contents.push({ role: 'model', parts: fcParts });
    contents.push({ role: 'model', parts: frParts });
}
// ---------- 自检 ----------
if (require.main === module) {
    // 1. 注册 3 个 tool id 指向同一 session
    const session = {
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
    assert_1.default.strictEqual(pendingCount(), 3);
    // 2. 任一 id 能取回同一对象
    assert_1.default.strictEqual(getPendingByToolId('t1'), session);
    assert_1.default.strictEqual(getPendingByToolId('t2'), session);
    assert_1.default.strictEqual(getPendingByToolId('t3'), session);
    assert_1.default.strictEqual(getPendingByToolId('missing'), undefined);
    // 3. remove 后全部消失
    removePending(session);
    assert_1.default.strictEqual(pendingCount(), 0);
    assert_1.default.strictEqual(getPendingByToolId('t1'), undefined);
    assert_1.default.strictEqual(getPendingByToolId('t2'), undefined);
    assert_1.default.strictEqual(getPendingByToolId('t3'), undefined);
    // 4. appendToolRound push 恰好 2 条且 fcParts 是同一引用
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
                response: { output: 'ok' },
            },
        },
    ];
    const contents = [];
    appendToolRound(contents, fcParts, frParts);
    assert_1.default.strictEqual(contents.length, 2);
    assert_1.default.strictEqual(contents[0].role, 'model');
    assert_1.default.strictEqual(contents[1].role, 'model');
    assert_1.default.strictEqual(contents[0].parts, fcParts); // 同一引用，未拷贝
    assert_1.default.strictEqual(contents[1].parts, frParts);
    assert_1.default.strictEqual(contents[0].parts[0].thoughtSignature, 'sig-raw');
    // 5. cleanupAll
    registerPending({
        ...session,
        claudeToolIds: ['a', 'b'],
        timer: null,
    });
    assert_1.default.strictEqual(pendingCount(), 2);
    cleanupAll();
    assert_1.default.strictEqual(pendingCount(), 0);
}
//# sourceMappingURL=pending-session.js.map