// ═══════════════════════════════════════════════
//  Anthropic Messages 协议：请求解析 / 响应构建 / SSE
// ═══════════════════════════════════════════════

import assert from 'assert';
import type { Response } from 'express';
import type {
AnthropicContentBlock,
AnthropicMessagesRequest,
BridgedToolUse,
NativeContent,
ParsedToolResult,
} from './types';

export interface AnthropicUsage {
input_tokens: number;
output_tokens: number;
}

// ---------- 请求侧 ----------

function toolResultToString(content: string | AnthropicContentBlock[] | undefined): string {
if (!content) return '';
if (typeof content === 'string') return content;
const text = content
 .map((b) => {
   if (b.type === 'text') return b.text ?? '';
   if (b.type === 'json' && b.json !== undefined) {
     return typeof b.json === 'string' ? b.json : JSON.stringify(b.json);
   }
   if (b.type === 'document' && b.source?.data) return b.source.data;
   if (typeof b.content === 'string') return b.content;
   if (Array.isArray(b.content)) return toolResultToString(b.content);
   return '';
 })
 .filter(Boolean)
 .join('\n');
if (text) return text;
if (content.length > 0) {
 try {
   return JSON.stringify(content);
 } catch {
   /* ignore */
 }
}
return '';
}

/**
* Skill 的 tool_result 只是 "Launching skill: X"；真正正文是同条或紧随的
* user text（isMeta "Base directory for this skill: …"）。只转发 tool_result
* 上游拿到空壳。仅当 content 含 Launching skill 时合并 trailing text，
* 普通 tool_result + trailing 不合并（保持旧断言）。
*/
function attachTrailingText(
hits: ParsedToolResult[],
messages: NonNullable<AnthropicMessagesRequest['messages']>,
hitIndex: number,
): ParsedToolResult[] {
if (!hits.length) return hits;
const hasSkill = hits.some((h) => /^Launching skill:/m.test(h.content));
if (!hasSkill) return hits;

const texts: string[] = [];
for (let i = hitIndex; i < messages.length; i++) {
  const msg = messages[i];
  // CC 会在 tool_result 后塞 mid-conversation role:system（Task 提醒等），跳过不截断
  if ((msg.role as string) === 'system') continue;
  if (msg.role !== 'user') break;
 if (typeof msg.content === 'string') {
   const t = msg.content.trim();
   if (t && !t.startsWith('<system-reminder')) texts.push(t);
   continue;
 }
 for (const b of msg.content) {
   const text = b.type === 'text' ? b.text?.trim() : '';
   if (text && !text.startsWith('<system-reminder')) texts.push(text);
 }
}
const extra = texts.join('\n');
if (!extra) return hits;

// 只并到 Launching skill 那几条
return hits.map((h) =>
 /^Launching skill:/m.test(h.content)
   ? { ...h, content: h.content ? `${h.content}\n\n${extra}` : extra }
   : h,
);
}

/**
 * 尾部连续 user 里第一条含 tool_result 的 message。
 * 跳过 mid-conversation role:system；碰到 assistant 停。
 */
function findTrailingToolResultHit(
  messages: NonNullable<AnthropicMessagesRequest['messages']>,
): { index: number; blocks: AnthropicContentBlock[] } | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if ((msg.role as string) === 'system') continue;
    if (msg.role !== 'user') break;
    if (typeof msg.content === 'string') continue;
    const found = msg.content.filter((b) => b.type === 'tool_result' && b.tool_use_id);
    if (found.length) return { index: i, blocks: found };
  }
  return null;
}

/** 提取本轮所有 tool_result；无则返回空数组（= 首轮） */
export function parseToolResults(body: AnthropicMessagesRequest): ParsedToolResult[] {
  const messages = body.messages;
  if (!messages?.length) return [];

  // 并行 tool_use 时 CC 把全部 tool_result 放在同一条 user message 里（实测）。
  // 从尾部扫连续 user 消息：tool_result 可能被 attachment 挤到倒数第二。
  // 本段内无 tool_result → 首轮/新提问。
  const hit = findTrailingToolResultHit(messages);
  if (!hit) return [];
  const parsed = hit.blocks.map((b) => ({
    toolUseId: b.tool_use_id!,
    content: toolResultToString(b.content),
    isError: b.is_error === true,
  }));
  return attachTrailingText(parsed, messages, hit.index);
}

/** 本地时间带偏移：2026-08-08T17:01:03+08:00（不加依赖） */
export function formatLocalIso(d: Date = new Date()): string {
const pad = (n: number, w = 2) => String(n).padStart(w, '0');
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
* 只取最后一条 user 纯文本。有旁路正文时整块丢掉 <system-reminder>；
* 若剥完为空（会话末尾总结等）则改用 reminder 内文。包 <USER_REQUEST>。
*/
export function buildUserContent(body: AnthropicMessagesRequest): NativeContent | null {
const messages = body.messages;
if (!messages?.length) return null;

let raw = '';
for (let i = messages.length - 1; i >= 0; i--) {
 const msg = messages[i];
 if (msg.role !== 'user') continue;
 raw = contentRawText(msg.content);
 break;
}

const text = wrapUserRequest(userPlainTextFromRaw(raw));
if (!text) return null;
return { role: 'user', parts: [{ text }] };
}

/**
* 首轮的完整 contents：历史文本 + 最后一条包 <USER_REQUEST>。
*
* 只搬**文本**。历史里的 tool_use / tool_result 一律丢弃 —— 回放 FC 需要
* thoughtSignature，而 CC 的 transcript 里没有，硬塞会 400（wire-reference §1.3）。
* 影响：工具轮结束后用户再提问，模型看不到上一轮工具细节，只看到文本结论。
*/
export function buildContents(body: AnthropicMessagesRequest): NativeContent[] {
const messages = body.messages ?? [];
const contents: NativeContent[] = [];

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
 if (msg.role !== 'user' && msg.role !== 'assistant') continue;

 const raw = contentRawText(msg.content);
 // user：有旁路正文则丢掉 reminder 整块；剥完为空才用内文（末尾总结）。
 // assistant 只剥不展开，避免把 reminder 噪声写进 model 轮。
 const text =
   msg.role === 'user' ? userPlainTextFromRaw(raw) : stripReminderBlocks(raw);
 if (i === lastUserIdx) {
   const wrapped = wrapUserRequest(text);
   if (wrapped) contents.push({ role: 'user', parts: [{ text: wrapped }] });
   continue;
 }
 if (!text) continue;
 contents.push({ role: msg.role === 'user' ? 'user' : 'model', parts: [{ text }] });
}
return contents;
}

function contentRawText(content: string | AnthropicContentBlock[] | undefined): string {
return typeof content === 'string'
 ? content
 : (content ?? [])
     .filter((b) => b.type === 'text')
     .map((b) => b.text ?? '')
     .join('\n');
}

/** 整块丢掉 <system-reminder>。sibling extra / compact 检测必须走这条，reminder-only 才不算新请求。 */
function stripReminderBlocks(raw: string): string {
return raw.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();
}

/** 去掉标签、保留内文。仅当剥完为空时作为 user 正文，避免 contents 以 model 结尾。 */
function unwrapReminderBlocks(raw: string): string {
return raw.replace(/<system-reminder>([\s\S]*?)<\/system-reminder>/g, '$1').trim();
}

function userPlainTextFromRaw(raw: string): string {
const stripped = stripReminderBlocks(raw);
return stripped || unwrapReminderBlocks(raw);
}

function plainText(content: string | AnthropicContentBlock[] | undefined): string {
return stripReminderBlocks(contentRawText(content));
}

function wrapUserRequest(stripped: string): string {
  if (!stripped) return '';
  return (
    `<USER_REQUEST>\n${stripped}\n</USER_REQUEST>\n` +
    `<ADDITIONAL_METADATA>\n` +
    `The current local time is: ${formatLocalIso()}.\n` +
    `</ADDITIONAL_METADATA>`
  );
}

/**
 * 含 tool_result 的那条 user message 上的同条纯文本（剥 reminder）。
 * compact 形状是一条 `tool_result+text`；Skill 正文在下一条 user，这里返回 ''。
 */
export function extractToolResultSiblingText(body: AnthropicMessagesRequest): string {
  const messages = body.messages;
  if (!messages?.length) return '';
  const hit = findTrailingToolResultHit(messages);
  if (!hit) return '';
  return plainText(messages[hit.index].content);
}

/** 把已剥 reminder 的用户文本包成上游 user content；空串 → null */
export function buildWrappedUserContent(stripped: string): NativeContent | null {
  const text = wrapUserRequest(stripped);
  if (!text) return null;
  return { role: 'user', parts: [{ text }] };
}

// ---------- 响应侧：非流式 ----------

function msgId(): string {
return `msg_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

export function buildMessageResponse(
model: string,
text: string,
usage: AnthropicUsage,
): object {
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

export function buildToolUseResponse(
model: string,
text: string,
uses: BridgedToolUse[],
usage: AnthropicUsage,
): object {
const content: Array<Record<string, unknown>> = [];
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

export function buildErrorResponse(message: string, type = 'api_error'): object {
return {
 type: 'error',
 error: { type, message },
};
}

// ---------- 响应侧：流式 ----------

function sse(event: string, data: Record<string, unknown>): string {
return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
* Anthropic SSE 状态机。
* 序列：message_start → (content_block_start/delta/stop)* → message_delta → message_stop
* 去掉 token-usage 依赖，usage 由调用方直接传入。
*/
export class AnthropicSseWriter {
private blockIndex = 0;
private blockOpen = false;
private textStarted = false;
private toolUseEnded = false;
private toolUseCount = 0;

constructor(private readonly res: Response, model: string) {
 res.setHeader('Content-Type', 'text/event-stream');
 res.setHeader('Cache-Control', 'no-cache');
 res.setHeader('Connection', 'keep-alive');
 res.setHeader('X-Accel-Buffering', 'no');
 if (typeof res.flushHeaders === 'function') res.flushHeaders();
 res.write(
   sse('message_start', {
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
   }),
 );
}

get ended(): boolean {
 return this.res.writableEnded || this.toolUseEnded;
}

textDelta(text: string): void {
 if (this.ended) return;
 this.openTextBlock();
 this.res.write(
   sse('content_block_delta', {
     type: 'content_block_delta',
     index: this.blockIndex,
     delta: { type: 'text_delta', text },
   }),
 );
}

/** 追加 tool_use 块，不收流 */
toolUse(id: string, name: string, input: Record<string, unknown>): void {
 if (this.ended) return;
 if (this.blockOpen) {
   this.res.write(
     sse('content_block_stop', { type: 'content_block_stop', index: this.blockIndex }),
   );
   this.blockIndex += 1;
   this.blockOpen = false;
 }
 this.res.write(
   sse('content_block_start', {
     type: 'content_block_start',
     index: this.blockIndex,
     content_block: { type: 'tool_use', id, name, input: {} },
   }),
 );
 // input_json_delta：partial_json 一次性给完整 JSON 串
 this.res.write(
   sse('content_block_delta', {
     type: 'content_block_delta',
     index: this.blockIndex,
     delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) },
   }),
 );
 this.res.write(
   sse('content_block_stop', { type: 'content_block_stop', index: this.blockIndex }),
 );
 this.blockIndex += 1;
 this.toolUseCount += 1;
}

/** 一批 tool_use 写完才收流 */
endToolUseBatch(usage: AnthropicUsage): void {
 if (this.ended || this.toolUseCount === 0) return;
 this.res.write(
   sse('message_delta', {
     type: 'message_delta',
     delta: { stop_reason: 'tool_use', stop_sequence: null },
     usage,
   }),
 );
 this.res.write(sse('message_stop', { type: 'message_stop' }));
 this.res.end();
 this.toolUseEnded = true;
}

end(usage: AnthropicUsage, stopReason: 'end_turn' | 'tool_use' = 'end_turn'): void {
 if (this.ended) return;
 // 没开过块时补一个空 text block，避免孤立 stop
 this.openTextBlock();
 this.res.write(
   sse('content_block_stop', { type: 'content_block_stop', index: this.blockIndex }),
 );
 this.res.write(
   sse('message_delta', {
     type: 'message_delta',
     delta: { stop_reason: stopReason, stop_sequence: null },
     usage,
   }),
 );
 this.res.write(sse('message_stop', { type: 'message_stop' }));
 this.res.end();
}

private openTextBlock(): void {
 if (this.blockOpen) return;
 this.res.write(
   sse('content_block_start', {
     type: 'content_block_start',
     index: this.blockIndex,
     content_block: { type: 'text', text: '' },
   }),
 );
 this.blockOpen = true;
 this.textStarted = true;
}
}

// ---------- 自检 ----------

if (require.main === module) {
// 1. <system-reminder> 被剥干净 + <USER_REQUEST> 包装 + 本地时间带偏移
{
 const body: AnthropicMessagesRequest = {
   messages: [
     {
       role: 'user',
       content: [
         {
           type: 'text',
           text:
             '<system-reminder>\n# claudeMd\nsecret\n</system-reminder>\n' +
             'hello world\n' +
             '<system-reminder>\nother</system-reminder>',
         },
       ],
     },
   ],
 };
 const uc = buildUserContent(body);
 assert.ok(uc, 'buildUserContent should return content');
 const t = uc!.parts[0].text!;
 assert.ok(!t.includes('<system-reminder'), 'system-reminder must be stripped');
 assert.ok(!t.includes('claudeMd'), 'claudeMd inside reminder must be stripped');
 assert.ok(t.includes('<USER_REQUEST>\nhello world\n</USER_REQUEST>'), 'USER_REQUEST wrap');
 assert.ok(
   /The current local time is: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}/.test(t),
   'local time must have +HH:MM or -HH:MM offset',
 );
 assert.ok(!t.includes('Z\n'), 'must not use Z suffix');
}

// 剥完为空 → 用 reminder 内文，避免 contents 以 model 结尾
{
 const body: AnthropicMessagesRequest = {
   messages: [
     {
       role: 'user',
       content: [{ type: 'text', text: '<system-reminder>only</system-reminder>' }],
     },
   ],
 };
 const uc = buildUserContent(body);
 assert.ok(uc, 'reminder-only last user 须展开内文');
 const t = uc!.parts[0].text!;
 assert.ok(!t.includes('<system-reminder'), '标签不得上传');
 assert.ok(t.includes('<USER_REQUEST>\nonly\n</USER_REQUEST>'), '内文须进 USER_REQUEST');
}

// 2. parseToolResults 从多块 content 抽出全部；普通 trailing 不合并
{
 const body: AnthropicMessagesRequest = {
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
 assert.strictEqual(results.length, 2);
 assert.strictEqual(results[0].toolUseId, 'a');
 assert.strictEqual(results[0].content, 'file-a');
 assert.strictEqual(results[0].isError, false);
 assert.strictEqual(results[1].toolUseId, 'b');
 assert.strictEqual(results[1].content, 'file-b');
 assert.strictEqual(results[1].isError, true);
 assert.strictEqual(
   extractToolResultSiblingText(body),
   'trailing',
   '同条 text 须抽出，且不得并进 tool_result content',
 );
}

// 首轮无 tool_result → []
{
 assert.deepStrictEqual(
   parseToolResults({ messages: [{ role: 'user', content: 'hi' }] }),
   [],
 );
}

// 工具轮结束后的新提问：只看尾部连续 user，不能跨 assistant 命中历史 tool_result
{
 const body: AnthropicMessagesRequest = {
   messages: [
     { role: 'user', content: 'first' },
     { role: 'assistant', content: [{ type: 'tool_use', id: 'a', name: 'Read', input: {} }] },
     { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: 'x' }] },
     { role: 'assistant', content: 'done' },
     { role: 'user', content: 'second question' },
   ],
 };
    assert.deepStrictEqual(parseToolResults(body), [], '新提问不能被判为 resume');
  }

  // 尾随 role:system（CC Task 提醒）不得截断扫描，否则误走分支 A
  {
    const body: AnthropicMessagesRequest = {
      messages: [
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'call_1', name: 'Bash', input: {} }],
        },
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'ok' }],
        },
        {
          role: 'system' as 'user',
          content: "The task tools haven't been used recently.",
        },
      ],
    };
    const results = parseToolResults(body);
    assert.strictEqual(results.length, 1, '尾随 system 须跳过');
    assert.strictEqual(results[0].toolUseId, 'call_1');
    assert.strictEqual(results[0].content, 'ok');
  }

// Skill：Launching skill + 尾随 Base directory 合并
{
 const body: AnthropicMessagesRequest = {
   messages: [
     {
       role: 'assistant',
       content: [{ type: 'tool_use', id: 'live', name: 'Skill', input: { skill: 'demo' } }],
     },
     {
       role: 'user',
       content: [
         { type: 'tool_result', tool_use_id: 'live', content: 'Launching skill: demo' },
       ],
     },
     {
       role: 'user',
       content: [{ type: 'text', text: 'Base directory for this skill: /x\n# Demo' }],
     },
   ],
 };
 const results = parseToolResults(body);
 assert.strictEqual(results.length, 1);
 assert.strictEqual(
   results[0].content,
   'Launching skill: demo\n\nBase directory for this skill: /x\n# Demo',
 );
 assert.strictEqual(
   extractToolResultSiblingText(body),
   '',
   'Skill 正文在下一条 user，同条 sibling 必须为空',
 );
}

{
  assert.strictEqual(
    extractToolResultSiblingText({ messages: [{ role: 'user', content: 'hi' }] }),
    '',
  );
  assert.strictEqual(
    extractToolResultSiblingText({
      messages: [
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'a', content: 'x' }],
        },
      ],
    }),
    '',
  );
}

{
  const body: AnthropicMessagesRequest = {
    messages: [
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'c', name: 'Bash', input: {} }],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'c', content: 'ok' },
          { type: 'text', text: '<system-reminder>only</system-reminder>' },
        ],
      },
    ],
  };
  assert.strictEqual(extractToolResultSiblingText(body), '');
}

{
  const body: AnthropicMessagesRequest = {
    messages: [
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'c', content: 'ok' },
          {
            type: 'text',
            text: '<system-reminder>meta</system-reminder>\nhello compact',
          },
        ],
      },
      {
        role: 'system' as 'user',
        content: 'trailing system must not hide sibling text',
      },
    ],
  };
  assert.strictEqual(extractToolResultSiblingText(body), 'hello compact');
}

{
  const wrapped = buildWrappedUserContent('hello compact');
  assert.ok(wrapped);
  assert.strictEqual(wrapped.role, 'user');
  assert.ok(
    wrapped.parts[0].text!.includes('<USER_REQUEST>\nhello compact\n</USER_REQUEST>'),
  );
  assert.strictEqual(buildWrappedUserContent(''), null);
}

// 2b. buildContents：历史文本保留、role 映射、tool 块与 role:'system' 丢弃
{
 const body: AnthropicMessagesRequest = {
   messages: [
     { role: 'user', content: 'q1' },
     { role: 'assistant', content: 'a1' },
     // CC 实发过 role:'system'（mid-conversation beta），类型里没有，故断言用 cast
     { role: 'system' as 'user', content: 'mid-conversation system' },
     { role: 'assistant', content: [{ type: 'tool_use', id: 'a', name: 'Read', input: {} }] },
     { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: 'x' }] },
     { role: 'user', content: 'q2' },
   ],
 };
 const cs = buildContents(body);
 // q1 / a1 / q2 —— system 丢，纯 tool_use 与纯 tool_result 无文本也丢
 assert.strictEqual(cs.length, 3, JSON.stringify(cs));
 assert.strictEqual(cs[0].role, 'user');
 assert.strictEqual(cs[0].parts[0].text, 'q1');
 assert.strictEqual(cs[1].role, 'model'); // assistant → model，不是 assistant
 assert.strictEqual(cs[1].parts[0].text, 'a1');
 assert.strictEqual(cs[2].role, 'user');
 // 只有最后一条 user 包 <USER_REQUEST>
 assert.ok(cs[2].parts[0].text!.includes('<USER_REQUEST>\nq2\n</USER_REQUEST>'));
 assert.ok(!cs[0].parts[0].text!.includes('<USER_REQUEST>'));
 const all = JSON.stringify(cs);
 assert.ok(!all.includes('mid-conversation system'), 'role:system 必须丢弃');
 assert.ok(!all.includes('tool_use'), 'tool 块不得进 contents（无 thoughtSignature 会 400）');
}

// 尾条 user 只有 reminder（CC 会话末总结）：展开内文，contents 不得以 model 结尾
{
 const body: AnthropicMessagesRequest = {
   messages: [
     { role: 'user', content: 'q1' },
     { role: 'assistant', content: 'a1' },
     { role: 'assistant', content: [{ type: 'tool_use', id: 'a', name: 'Read', input: {} }] },
     { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: 'x' }] },
     { role: 'assistant', content: 'done' },
     {
       role: 'user',
       content: [
         {
           type: 'text',
           text: '<system-reminder>\nPlease summarize the conversation.\n</system-reminder>',
         },
       ],
     },
   ],
 };
 const cs = buildContents(body);
 assert.strictEqual(cs[cs.length - 1].role, 'user', '不得以 model 结尾');
 const last = cs[cs.length - 1].parts[0].text!;
 assert.ok(
   last.includes('<USER_REQUEST>\nPlease summarize the conversation.\n</USER_REQUEST>'),
   'reminder 内文须作为最后一条 user',
 );
 assert.ok(!last.includes('<system-reminder'), '标签不得上传');
 assert.strictEqual(cs[cs.length - 2].role, 'model');
 assert.strictEqual(cs[cs.length - 2].parts[0].text, 'done');
}

// 3. 非流式响应形状
{
 const m = buildMessageResponse('m', 'hi', { input_tokens: 1, output_tokens: 2 }) as {
   stop_reason: string;
   content: Array<{ type: string }>;
 };
 assert.strictEqual(m.stop_reason, 'end_turn');
 assert.strictEqual(m.content[0].type, 'text');

 const tu = buildToolUseResponse(
   'm',
   'thinking',
   [
     {
       toolUseId: 't1',
       claudeName: 'Read',
       input: { file_path: '/x' },
       native: { id: 'n1', name: 'view_file', args: {} },
     },
   ],
   { input_tokens: 1, output_tokens: 3 },
 ) as { stop_reason: string; content: Array<{ type: string; id?: string }> };
 assert.strictEqual(tu.stop_reason, 'tool_use');
 assert.strictEqual(tu.content[0].type, 'text');
 assert.strictEqual(tu.content[1].type, 'tool_use');
 assert.strictEqual(tu.content[1].id, 't1');
}

// 4. SSE writer 事件序列合法
{
 const writes: string[] = [];
 const fakeRes = {
   writableEnded: false,
   setHeader() {},
   flushHeaders() {},
   write(chunk: string) {
     writes.push(chunk);
     return true;
   },
   end() {
     (this as { writableEnded: boolean }).writableEnded = true;
   },
 } as unknown as Response;

 const w = new AnthropicSseWriter(fakeRes, 'test-model');
 w.textDelta('hello');
 w.toolUse('tu1', 'Read', { file_path: '/a' });
 w.toolUse('tu2', 'Bash', { command: 'ls' });
 w.endToolUseBatch({ input_tokens: 10, output_tokens: 5 });
 assert.strictEqual(w.ended, true);

 const joined = writes.join('');
 const events = [...joined.matchAll(/^event: (\w+)/gm)].map((m) => m[1]);

 // 合法序列：message_start → blocks → message_delta → message_stop
 assert.strictEqual(events[0], 'message_start');
 assert.strictEqual(events[events.length - 2], 'message_delta');
 assert.strictEqual(events[events.length - 1], 'message_stop');

 // text block + 2 tool_use blocks
 const starts = events.filter((e) => e === 'content_block_start');
 const stops = events.filter((e) => e === 'content_block_stop');
 assert.strictEqual(starts.length, 3); // text + 2 tools
 assert.strictEqual(stops.length, 3);
 assert.ok(joined.includes('"type":"text_delta"'));
 assert.ok(joined.includes('"type":"input_json_delta"'));
 assert.ok(joined.includes('"stop_reason":"tool_use"'));
 // index 递增
 assert.ok(joined.includes('"index":0'));
 assert.ok(joined.includes('"index":1'));
 assert.ok(joined.includes('"index":2'));
}

// end_turn 路径
{
 const writes: string[] = [];
 const fakeRes = {
   writableEnded: false,
   setHeader() {},
   flushHeaders() {},
   write(chunk: string) {
     writes.push(chunk);
     return true;
   },
   end() {
     (this as { writableEnded: boolean }).writableEnded = true;
   },
 } as unknown as Response;
 const w = new AnthropicSseWriter(fakeRes, 'm');
 w.textDelta('done');
 w.end({ input_tokens: 1, output_tokens: 1 });
 const joined = writes.join('');
 assert.ok(joined.includes('"stop_reason":"end_turn"'));
 assert.ok(joined.includes('event: message_stop'));
}

// formatLocalIso 偏移
{
 const iso = formatLocalIso(new Date('2026-08-08T09:01:03.000Z'));
 assert.ok(/[+-]\d{2}:\d{2}$/.test(iso), `offset missing: ${iso}`);
}

// error response
{
 const e = buildErrorResponse('boom') as { type: string; error: { message: string } };
 assert.strictEqual(e.type, 'error');
 assert.strictEqual(e.error.message, 'boom');
}
}
