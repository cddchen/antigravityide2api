"use strict";
// ═══════════════════════════════════════════════
//  Anthropic Messages 协议：请求解析 / 响应构建 / SSE
// ═══════════════════════════════════════════════
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AnthropicSseWriter = void 0;
exports.parseToolResults = parseToolResults;
exports.formatLocalIso = formatLocalIso;
exports.buildUserContent = buildUserContent;
exports.buildContents = buildContents;
exports.buildMessageResponse = buildMessageResponse;
exports.buildToolUseResponse = buildToolUseResponse;
exports.buildErrorResponse = buildErrorResponse;
const assert_1 = __importDefault(require("assert"));
// ---------- 请求侧 ----------
function toolResultToString(content) {
    if (!content)
        return '';
    if (typeof content === 'string')
        return content;
    const text = content
        .map((b) => {
        if (b.type === 'text')
            return b.text ?? '';
        if (b.type === 'json' && b.json !== undefined) {
            return typeof b.json === 'string' ? b.json : JSON.stringify(b.json);
        }
        if (b.type === 'document' && b.source?.data)
            return b.source.data;
        if (typeof b.content === 'string')
            return b.content;
        if (Array.isArray(b.content))
            return toolResultToString(b.content);
        return '';
    })
        .filter(Boolean)
        .join('\n');
    if (text)
        return text;
    if (content.length > 0) {
        try {
            return JSON.stringify(content);
        }
        catch {
            /* ignore */
        }
    }
    return '';
}
/** 提取本轮所有 tool_result；无则返回空数组（= 首轮） */
function parseToolResults(body) {
    const messages = body.messages;
    if (!messages?.length)
        return [];
    // 并行 tool_use 时 CC 把全部 tool_result 放在同一条 user message 里（实测）。
    // 只看**最后一条** user message：CC 每轮回传全量历史，若继续往前扫，
    // 工具轮结束后用户的新提问会命中上一轮的 tool_result，被误判成 resume。
    for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i];
        if (msg.role !== 'user')
            continue;
        if (typeof msg.content === 'string')
            return [];
        const hits = msg.content.filter((b) => b.type === 'tool_result' && b.tool_use_id);
        return hits.map((b) => ({
            toolUseId: b.tool_use_id,
            content: toolResultToString(b.content),
            isError: b.is_error === true,
        }));
    }
    return [];
}
/** 本地时间带偏移：2026-08-08T17:01:03+08:00（不加依赖） */
function formatLocalIso(d = new Date()) {
    const pad = (n, w = 2) => String(n).padStart(w, '0');
    const y = d.getFullYear();
    const mo = pad(d.getMonth() + 1);
    const day = pad(d.getDate());
    const h = pad(d.getHours());
    const mi = pad(d.getMinutes());
    const s = pad(d.getSeconds());
    const offsetMin = -d.getTimezoneOffset(); // 东区为正
    const sign = offsetMin >= 0 ? '+' : '-';
    const abs = Math.abs(offsetMin);
    const oh = pad(Math.floor(abs / 60));
    const om = pad(abs % 60);
    return `${y}-${mo}-${day}T${h}:${mi}:${s}${sign}${oh}:${om}`;
}
/**
 * 把 CC 的 messages 转成上游 user content；
 * 只取最后一条 user 纯文本，剥 <system-reminder>，包 <USER_REQUEST>
 */
function buildUserContent(body) {
    const messages = body.messages;
    if (!messages?.length)
        return null;
    // 最后一条 role:'user' 的纯文本块
    let raw = '';
    for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i];
        if (msg.role !== 'user')
            continue;
        if (typeof msg.content === 'string') {
            raw = msg.content;
        }
        else {
            raw = msg.content
                .filter((b) => b.type === 'text')
                .map((b) => b.text ?? '')
                .join('\n');
        }
        break;
    }
    // 剥掉所有 <system-reminder>…</system-reminder>
    const text = wrapUserRequest(raw.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim());
    if (!text)
        return null;
    return { role: 'user', parts: [{ text }] };
}
/**
 * 首轮的完整 contents：历史文本 + 最后一条包 <USER_REQUEST>。
 *
 * 只搬**文本**。历史里的 tool_use / tool_result 一律丢弃 —— 回放 FC 需要
 * thoughtSignature，而 CC 的 transcript 里没有，硬塞会 400（wire-reference §1.3）。
 * 影响：工具轮结束后用户再提问，模型看不到上一轮工具细节，只看到文本结论。
 */
function buildContents(body) {
    const messages = body.messages ?? [];
    const contents = [];
    // 最后一条 user 的下标；它走 <USER_REQUEST> 包装，其余原样
    let lastUserIdx = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === 'user') {
            lastUserIdx = i;
            break;
        }
    }
    for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];
        // 上游 contents 只认 user/model；mid-conversation 的 role:'system' 只能丢
        if (msg.role !== 'user' && msg.role !== 'assistant')
            continue;
        const text = plainText(msg.content);
        if (i === lastUserIdx) {
            const wrapped = wrapUserRequest(text);
            if (wrapped)
                contents.push({ role: 'user', parts: [{ text: wrapped }] });
            continue;
        }
        if (!text)
            continue;
        contents.push({ role: msg.role === 'user' ? 'user' : 'model', parts: [{ text }] });
    }
    return contents;
}
function plainText(content) {
    const raw = typeof content === 'string'
        ? content
        : (content ?? [])
            .filter((b) => b.type === 'text')
            .map((b) => b.text ?? '')
            .join('\n');
    return raw.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();
}
function wrapUserRequest(stripped) {
    if (!stripped)
        return '';
    return (`<USER_REQUEST>\n${stripped}\n</USER_REQUEST>\n` +
        `<ADDITIONAL_METADATA>\n` +
        `The current local time is: ${formatLocalIso()}.\n` +
        `</ADDITIONAL_METADATA>`);
}
// ---------- 响应侧：非流式 ----------
function msgId() {
    return `msg_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}
function buildMessageResponse(model, text, usage) {
    return {
        id: msgId(),
        type: 'message',
        role: 'assistant',
        model,
        content: [{ type: 'text', text }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage,
    };
}
function buildToolUseResponse(model, text, uses, usage) {
    const content = [];
    if (text) {
        content.push({ type: 'text', text });
    }
    for (const u of uses) {
        content.push({
            type: 'tool_use',
            id: u.toolUseId,
            name: u.claudeName,
            input: u.input,
        });
    }
    return {
        id: msgId(),
        type: 'message',
        role: 'assistant',
        model,
        content,
        stop_reason: 'tool_use',
        stop_sequence: null,
        usage,
    };
}
function buildErrorResponse(message, type = 'api_error') {
    return {
        type: 'error',
        error: { type, message },
    };
}
// ---------- 响应侧：流式 ----------
function sse(event, data) {
    return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}
/**
 * Anthropic SSE 状态机。
 * 序列：message_start → (content_block_start/delta/stop)* → message_delta → message_stop
 * 去掉 token-usage 依赖，usage 由调用方直接传入。
 */
class AnthropicSseWriter {
    constructor(res, model) {
        this.res = res;
        this.blockIndex = 0;
        this.blockOpen = false;
        this.textStarted = false;
        this.toolUseEnded = false;
        this.toolUseCount = 0;
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no');
        if (typeof res.flushHeaders === 'function')
            res.flushHeaders();
        res.write(sse('message_start', {
            type: 'message_start',
            message: {
                id: msgId(),
                type: 'message',
                role: 'assistant',
                model,
                content: [],
                stop_reason: null,
                stop_sequence: null,
                usage: { input_tokens: 0, output_tokens: 0 },
            },
        }));
    }
    get ended() {
        return this.res.writableEnded || this.toolUseEnded;
    }
    textDelta(text) {
        if (this.ended)
            return;
        this.openTextBlock();
        this.res.write(sse('content_block_delta', {
            type: 'content_block_delta',
            index: this.blockIndex,
            delta: { type: 'text_delta', text },
        }));
    }
    /** 追加 tool_use 块，不收流 */
    toolUse(id, name, input) {
        if (this.ended)
            return;
        if (this.blockOpen) {
            this.res.write(sse('content_block_stop', { type: 'content_block_stop', index: this.blockIndex }));
            this.blockIndex += 1;
            this.blockOpen = false;
        }
        this.res.write(sse('content_block_start', {
            type: 'content_block_start',
            index: this.blockIndex,
            content_block: { type: 'tool_use', id, name, input: {} },
        }));
        // input_json_delta：partial_json 一次性给完整 JSON 串
        this.res.write(sse('content_block_delta', {
            type: 'content_block_delta',
            index: this.blockIndex,
            delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) },
        }));
        this.res.write(sse('content_block_stop', { type: 'content_block_stop', index: this.blockIndex }));
        this.blockIndex += 1;
        this.toolUseCount += 1;
    }
    /** 一批 tool_use 写完才收流 */
    endToolUseBatch(usage) {
        if (this.ended || this.toolUseCount === 0)
            return;
        this.res.write(sse('message_delta', {
            type: 'message_delta',
            delta: { stop_reason: 'tool_use', stop_sequence: null },
            usage,
        }));
        this.res.write(sse('message_stop', { type: 'message_stop' }));
        this.res.end();
        this.toolUseEnded = true;
    }
    end(usage, stopReason = 'end_turn') {
        if (this.ended)
            return;
        // 没开过块时补一个空 text block，避免孤立 stop
        this.openTextBlock();
        this.res.write(sse('content_block_stop', { type: 'content_block_stop', index: this.blockIndex }));
        this.res.write(sse('message_delta', {
            type: 'message_delta',
            delta: { stop_reason: stopReason, stop_sequence: null },
            usage,
        }));
        this.res.write(sse('message_stop', { type: 'message_stop' }));
        this.res.end();
    }
    openTextBlock() {
        if (this.blockOpen)
            return;
        this.res.write(sse('content_block_start', {
            type: 'content_block_start',
            index: this.blockIndex,
            content_block: { type: 'text', text: '' },
        }));
        this.blockOpen = true;
        this.textStarted = true;
    }
}
exports.AnthropicSseWriter = AnthropicSseWriter;
// ---------- 自检 ----------
if (require.main === module) {
    // 1. <system-reminder> 被剥干净 + <USER_REQUEST> 包装 + 本地时间带偏移
    {
        const body = {
            messages: [
                {
                    role: 'user',
                    content: [
                        {
                            type: 'text',
                            text: '<system-reminder>\n# claudeMd\nsecret\n</system-reminder>\n' +
                                'hello world\n' +
                                '<system-reminder>\nother</system-reminder>',
                        },
                    ],
                },
            ],
        };
        const uc = buildUserContent(body);
        assert_1.default.ok(uc, 'buildUserContent should return content');
        const t = uc.parts[0].text;
        assert_1.default.ok(!t.includes('<system-reminder'), 'system-reminder must be stripped');
        assert_1.default.ok(!t.includes('claudeMd'), 'claudeMd inside reminder must be stripped');
        assert_1.default.ok(t.includes('<USER_REQUEST>\nhello world\n</USER_REQUEST>'), 'USER_REQUEST wrap');
        assert_1.default.ok(/The current local time is: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}/.test(t), 'local time must have +HH:MM or -HH:MM offset');
        assert_1.default.ok(!t.includes('Z\n'), 'must not use Z suffix');
    }
    // 剥完为空 → null
    {
        const body = {
            messages: [
                {
                    role: 'user',
                    content: [{ type: 'text', text: '<system-reminder>only</system-reminder>' }],
                },
            ],
        };
        assert_1.default.strictEqual(buildUserContent(body), null);
    }
    // 2. parseToolResults 从多块 content 抽出全部
    {
        const body = {
            messages: [
                { role: 'assistant', content: [{ type: 'tool_use', id: 'a', name: 'Read', input: {} }] },
                {
                    role: 'user',
                    content: [
                        { type: 'tool_result', tool_use_id: 'a', content: 'file-a' },
                        { type: 'tool_result', tool_use_id: 'b', content: 'file-b', is_error: true },
                        { type: 'text', text: 'trailing' },
                    ],
                },
            ],
        };
        const results = parseToolResults(body);
        assert_1.default.strictEqual(results.length, 2);
        assert_1.default.strictEqual(results[0].toolUseId, 'a');
        assert_1.default.strictEqual(results[0].content, 'file-a');
        assert_1.default.strictEqual(results[0].isError, false);
        assert_1.default.strictEqual(results[1].toolUseId, 'b');
        assert_1.default.strictEqual(results[1].content, 'file-b');
        assert_1.default.strictEqual(results[1].isError, true);
    }
    // 首轮无 tool_result → []
    {
        assert_1.default.deepStrictEqual(parseToolResults({ messages: [{ role: 'user', content: 'hi' }] }), []);
    }
    // 工具轮结束后的新提问：只看最后一条 user，不能命中历史 tool_result
    {
        const body = {
            messages: [
                { role: 'user', content: 'first' },
                { role: 'assistant', content: [{ type: 'tool_use', id: 'a', name: 'Read', input: {} }] },
                { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: 'x' }] },
                { role: 'assistant', content: 'done' },
                { role: 'user', content: 'second question' },
            ],
        };
        assert_1.default.deepStrictEqual(parseToolResults(body), [], '新提问不能被判为 resume');
    }
    // 2b. buildContents：历史文本保留、role 映射、tool 块与 role:'system' 丢弃
    {
        const body = {
            messages: [
                { role: 'user', content: 'q1' },
                { role: 'assistant', content: 'a1' },
                // CC 实发过 role:'system'（mid-conversation beta），类型里没有，故断言用 cast
                { role: 'system', content: 'mid-conversation system' },
                { role: 'assistant', content: [{ type: 'tool_use', id: 'a', name: 'Read', input: {} }] },
                { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: 'x' }] },
                { role: 'user', content: 'q2' },
            ],
        };
        const cs = buildContents(body);
        // q1 / a1 / q2 —— system 丢，纯 tool_use 与纯 tool_result 无文本也丢
        assert_1.default.strictEqual(cs.length, 3, JSON.stringify(cs));
        assert_1.default.strictEqual(cs[0].role, 'user');
        assert_1.default.strictEqual(cs[0].parts[0].text, 'q1');
        assert_1.default.strictEqual(cs[1].role, 'model'); // assistant → model，不是 assistant
        assert_1.default.strictEqual(cs[1].parts[0].text, 'a1');
        assert_1.default.strictEqual(cs[2].role, 'user');
        // 只有最后一条 user 包 <USER_REQUEST>
        assert_1.default.ok(cs[2].parts[0].text.includes('<USER_REQUEST>\nq2\n</USER_REQUEST>'));
        assert_1.default.ok(!cs[0].parts[0].text.includes('<USER_REQUEST>'));
        const all = JSON.stringify(cs);
        assert_1.default.ok(!all.includes('mid-conversation system'), 'role:system 必须丢弃');
        assert_1.default.ok(!all.includes('tool_use'), 'tool 块不得进 contents（无 thoughtSignature 会 400）');
    }
    // 3. 非流式响应形状
    {
        const m = buildMessageResponse('m', 'hi', { input_tokens: 1, output_tokens: 2 });
        assert_1.default.strictEqual(m.stop_reason, 'end_turn');
        assert_1.default.strictEqual(m.content[0].type, 'text');
        const tu = buildToolUseResponse('m', 'thinking', [
            {
                toolUseId: 't1',
                claudeName: 'Read',
                input: { file_path: '/x' },
                native: { id: 'n1', name: 'view_file', args: {} },
            },
        ], { input_tokens: 1, output_tokens: 3 });
        assert_1.default.strictEqual(tu.stop_reason, 'tool_use');
        assert_1.default.strictEqual(tu.content[0].type, 'text');
        assert_1.default.strictEqual(tu.content[1].type, 'tool_use');
        assert_1.default.strictEqual(tu.content[1].id, 't1');
    }
    // 4. SSE writer 事件序列合法
    {
        const writes = [];
        const fakeRes = {
            writableEnded: false,
            setHeader() { },
            flushHeaders() { },
            write(chunk) {
                writes.push(chunk);
                return true;
            },
            end() {
                this.writableEnded = true;
            },
        };
        const w = new AnthropicSseWriter(fakeRes, 'test-model');
        w.textDelta('hello');
        w.toolUse('tu1', 'Read', { file_path: '/a' });
        w.toolUse('tu2', 'Bash', { command: 'ls' });
        w.endToolUseBatch({ input_tokens: 10, output_tokens: 5 });
        assert_1.default.strictEqual(w.ended, true);
        const joined = writes.join('');
        const events = [...joined.matchAll(/^event: (\w+)/gm)].map((m) => m[1]);
        // 合法序列：message_start → blocks → message_delta → message_stop
        assert_1.default.strictEqual(events[0], 'message_start');
        assert_1.default.strictEqual(events[events.length - 2], 'message_delta');
        assert_1.default.strictEqual(events[events.length - 1], 'message_stop');
        // text block + 2 tool_use blocks
        const starts = events.filter((e) => e === 'content_block_start');
        const stops = events.filter((e) => e === 'content_block_stop');
        assert_1.default.strictEqual(starts.length, 3); // text + 2 tools
        assert_1.default.strictEqual(stops.length, 3);
        assert_1.default.ok(joined.includes('"type":"text_delta"'));
        assert_1.default.ok(joined.includes('"type":"input_json_delta"'));
        assert_1.default.ok(joined.includes('"stop_reason":"tool_use"'));
        // index 递增
        assert_1.default.ok(joined.includes('"index":0'));
        assert_1.default.ok(joined.includes('"index":1'));
        assert_1.default.ok(joined.includes('"index":2'));
    }
    // end_turn 路径
    {
        const writes = [];
        const fakeRes = {
            writableEnded: false,
            setHeader() { },
            flushHeaders() { },
            write(chunk) {
                writes.push(chunk);
                return true;
            },
            end() {
                this.writableEnded = true;
            },
        };
        const w = new AnthropicSseWriter(fakeRes, 'm');
        w.textDelta('done');
        w.end({ input_tokens: 1, output_tokens: 1 });
        const joined = writes.join('');
        assert_1.default.ok(joined.includes('"stop_reason":"end_turn"'));
        assert_1.default.ok(joined.includes('event: message_stop'));
    }
    // formatLocalIso 偏移
    {
        const iso = formatLocalIso(new Date('2026-08-08T09:01:03.000Z'));
        assert_1.default.ok(/[+-]\d{2}:\d{2}$/.test(iso), `offset missing: ${iso}`);
    }
    // error response
    {
        const e = buildErrorResponse('boom');
        assert_1.default.strictEqual(e.type, 'error');
        assert_1.default.strictEqual(e.error.message, 'boom');
    }
}
//# sourceMappingURL=anthropic.js.map