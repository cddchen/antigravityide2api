// ═══════════════════════════════════════════════
//  DEBUG=1 时的入站/出站可视化：GET /logcat
//  观测 CC → 本服务 messages、本服务 → Antigravity contents、
//  以及每轮上游 functionCall 与桥接结果（只在 DEBUG 开启时记录）
//  不改分支语义；不含 token
// ═══════════════════════════════════════════════

import assert from 'assert';
import type { Express, Request, Response } from 'express';
import { parseToolResults } from './anthropic';
import type {
AnthropicContentBlock,
AnthropicMessagesRequest,
NativeContent,
NativePart,
ParsedToolResult,
ToolEntry,
} from './types';

const MAX_FRAMES = 20;
const PREVIEW_MAX = 160;

export interface LogcatBlock {
type: string;
id?: string;
name?: string;
toolUseId?: string;
isError?: boolean;
input?: unknown;
text: string;
bytes: number;
truncated: boolean;
}

export interface LogcatMessage {
idx: number;
role: string;
kinds: string;
preview: string;
bytes: number;
blocks: LogcatBlock[];
}

export interface LogcatOutbound {
stepIndex: number;
model: string;
sessionId: string;
n: number;
lastRole: string;
lastKinds: string;
systemBytes: number;
systemPreview: string;
systemText: string;
systemTruncated: boolean;
toolCount: number;
contents: LogcatMessage[];
}

export interface LogcatCall {
nativeId: string;
nativeName: string;
argsText: string;
argsBytes: number;
sig: string;
outcome: 'tool_use' | 'reject';
preview: string;
claudeName?: string;
claudeId?: string;
claudeInputText?: string;
claudeInputBytes?: number;
rejectReason?: string;
}

export interface LogcatTurn {
stepIndex: number;
kind: 'text' | 'tool_use' | 'reject-all';
text: string;
textBytes: number;
thoughtBytes: number;
finishReason: string;
preview: string;
usage: { prompt: number; completion: number; thoughts: number; cached: number };
calls: LogcatCall[];
}

export interface LogcatFrame {
id: number;
ts: number;
model: string;
stream: boolean;
n: number;
branch: 'A' | 'B';
toolResultCount: number;
pending: string;
last: string;
/** 跳过 trailing system 后，尾条仍非 user → parseToolResults 会在此停 */
tailRole: string;
tailBlocksParse: boolean;
messages: LogcatMessage[];
/** 本入站对应的每一次上游发送（含 reject-all 续轮） */
outbound: LogcatOutbound[];
/** 每次 streamGenerate 之后的 FC / 桥接 / 文本，与 outbound 按下标对齐 */
turns: LogcatTurn[];
error?: { status: number; message: string };
}

let seq = 0;
const frames: LogcatFrame[] = [];
const listeners = new Set<(frame: LogcatFrame) => void>();

export function debugEnabled(): boolean {
const v = (process.env.DEBUG || '').trim().toLowerCase();
return v === '1' || v === 'true' || v === 'yes';
}

export function resetLogcat(): void {
seq = 0;
frames.length = 0;
listeners.clear();
}

export function getSnapshot(): { frames: LogcatFrame[] } {
return { frames: frames.slice() };
}

export function subscribe(cb: (frame: LogcatFrame) => void): () => void {
listeners.add(cb);
return () => {
  listeners.delete(cb);
};
}

function omitText(s: string, max = PREVIEW_MAX): string {
const t = s.replace(/\s+/g, ' ').trim();
if (t.length <= max) return t;
return `${t.slice(0, max)}…(${Buffer.byteLength(t, 'utf8')}B)`;
}

function clip(s: string): { text: string; bytes: number; truncated: boolean } {
const bytes = Buffer.byteLength(s, 'utf8');
return { text: s, bytes, truncated: false };
}

function stringifyUnknown(v: unknown): string {
if (typeof v === 'string') return v;
if (v === undefined) return '';
try {
  return JSON.stringify(v, null, 2);
} catch {
  return String(v);
}
}

function blockFromContent(b: AnthropicContentBlock): LogcatBlock {
const type = b.type || '?';
if (type === 'tool_use') {
  const inputText = stringifyUnknown(b.input ?? {});
  const clipped = clip(inputText);
  return {
    type,
    id: b.id,
    name: b.name,
    input: b.input,
    text: clipped.text,
    bytes: clipped.bytes,
    truncated: clipped.truncated,
  };
}
if (type === 'tool_result') {
  const raw =
    typeof b.content === 'string'
      ? b.content
      : Array.isArray(b.content)
        ? b.content
            .map((x) => (x.type === 'text' ? x.text ?? '' : stringifyUnknown(x)))
            .filter(Boolean)
            .join('\n')
        : stringifyUnknown(b.content);
  const clipped = clip(raw);
  return {
    type,
    toolUseId: b.tool_use_id,
    isError: b.is_error === true,
    text: clipped.text,
    bytes: clipped.bytes,
    truncated: clipped.truncated,
  };
}
const raw = b.text ?? stringifyUnknown(b.content ?? b);
const clipped = clip(raw);
return { type, text: clipped.text, bytes: clipped.bytes, truncated: clipped.truncated };
}

function snapshotMessage(
idx: number,
msg: { role: string; content?: string | AnthropicContentBlock[] },
): LogcatMessage {
const role = msg.role || '?';
const c = msg.content;
if (typeof c === 'string') {
  const clipped = clip(c);
  return {
    idx,
    role,
    kinds: 'text',
    preview: omitText(c),
    bytes: clipped.bytes,
    blocks: [{ type: 'text', text: clipped.text, bytes: clipped.bytes, truncated: clipped.truncated }],
  };
}
if (!Array.isArray(c) || c.length === 0) {
  return { idx, role, kinds: 'empty', preview: '', bytes: 0, blocks: [] };
}
const blocks = c.map(blockFromContent);
const kinds = blocks.map((b) => b.type).join('+');
const previews = blocks.map((b) => {
  if (b.type === 'tool_use') return `${b.name || '?'} ${omitText(b.text, 80)}`;
  if (b.type === 'tool_result') {
    return `${b.toolUseId || '?'} err=${b.isError === true} ${omitText(b.text, 80)}`;
  }
  return omitText(b.text, 80);
});
return {
  idx,
  role,
  kinds,
  preview: omitText(previews.join(' | ')),
  bytes: blocks.reduce((n, b) => n + b.bytes, 0),
  blocks,
};
}

function lastSummary(messages: LogcatMessage[]): string {
const tail = messages.slice(-6);
return tail.map((m) => `${m.idx}:${m.role}(${m.kinds})`).join(' ');
}

export function captureInbound(
body: AnthropicMessagesRequest,
meta: {
  model: string;
  stream: boolean;
  toolResults: ParsedToolResult[];
  pendingHits: string[];
  branch?: 'A' | 'B';
},
): LogcatFrame {
const raw = (body.messages ?? []) as Array<{
  role: string;
  content?: string | AnthropicContentBlock[];
}>;
const messages = raw.map((m, i) => snapshotMessage(i, m));
const toolResultCount = meta.toolResults.length;
const tailRole = messages.length ? messages[messages.length - 1].role : '';
let parseTailRole = '';
for (let i = messages.length - 1; i >= 0; i--) {
  if (messages[i].role !== 'system') {
    parseTailRole = messages[i].role;
    break;
  }
}
const frame: LogcatFrame = {
  id: ++seq,
  ts: Date.now(),
  model: meta.model,
  stream: meta.stream,
  n: messages.length,
  branch: meta.branch ?? (toolResultCount > 0 ? 'B' : 'A'),
  toolResultCount,
  pending: meta.pendingHits.join(',') || '—',
  last: lastSummary(messages),
  tailRole,
  tailBlocksParse: parseTailRole !== '' && parseTailRole !== 'user',
  messages,
  outbound: [],
  turns: [],
};
frames.push(frame);
while (frames.length > MAX_FRAMES) frames.shift();
emit(frame);
return frame;
}

function emit(frame: LogcatFrame): void {
for (const cb of listeners) {
  try {
    cb(frame);
  } catch {
    /* SSE 客户端断开时忽略 */
  }
}
}

function latestFrame(): LogcatFrame | undefined {
return frames.length ? frames[frames.length - 1] : undefined;
}

function snapshotNativePart(p: NativePart): LogcatBlock {
const sig = p.thoughtSignature
  ? `sig:${Buffer.byteLength(p.thoughtSignature, 'utf8')}B`
  : '';
if (p.functionCall) {
  const clipped = clip(stringifyUnknown(p.functionCall.args ?? {}));
  return {
    type: 'functionCall',
    id: p.functionCall.id,
    name: p.functionCall.name,
    text: sig ? `${clipped.text}\n[${sig}]` : clipped.text,
    bytes: clipped.bytes,
    truncated: clipped.truncated,
  };
}
if (p.functionResponse) {
  const clipped = clip(p.functionResponse.response?.output ?? '');
  return {
    type: 'functionResponse',
    id: p.functionResponse.id,
    name: p.functionResponse.name,
    text: clipped.text,
    bytes: clipped.bytes,
    truncated: clipped.truncated,
  };
}
const raw = p.text ?? '';
const clipped = clip(raw);
return {
  type: p.thought ? 'thought' : raw ? 'text' : sig ? 'thoughtSignature' : 'empty',
  text: raw ? clipped.text : sig,
  bytes: raw ? clipped.bytes : 0,
  truncated: clipped.truncated,
};
}

function snapshotNativeContent(idx: number, c: NativeContent): LogcatMessage {
const parts = c.parts ?? [];
const blocks = parts.map(snapshotNativePart);
const kinds = blocks.map((b) => b.type).join('+') || 'empty';
const previews = blocks.map((b) => {
  if (b.type === 'functionCall') return `${b.name || '?'} ${omitText(b.text, 80)}`;
  if (b.type === 'functionResponse') return `${b.name || '?'} ${omitText(b.text, 80)}`;
  return omitText(b.text, 80);
});
return {
  idx,
  role: c.role || '?',
  kinds,
  preview: omitText(previews.join(' | ')),
  bytes: blocks.reduce((n, b) => n + b.bytes, 0),
  blocks,
};
}

/** 把即将发往上游的 contents 挂到当前入站帧；无 token。 */
export function captureOutbound(opts: {
  model: string;
  stepIndex: number;
  sessionId: string;
  contents: NativeContent[];
  systemInstruction: string;
  tools: ToolEntry[];
}): LogcatFrame | undefined {
const frame = latestFrame();
if (!frame) return undefined;
const contents = (opts.contents ?? []).map((c, i) => snapshotNativeContent(i, c));
const last = contents.length ? contents[contents.length - 1] : undefined;
const sys = clip(opts.systemInstruction || '');
frame.outbound.push({
  stepIndex: opts.stepIndex,
  model: opts.model,
  sessionId: opts.sessionId,
  n: contents.length,
  lastRole: last?.role || '',
  lastKinds: last?.kinds || '',
  systemBytes: sys.bytes,
  systemPreview: omitText(opts.systemInstruction || ''),
  systemText: sys.text,
  systemTruncated: sys.truncated,
  toolCount: opts.tools.length,
  contents,
});
emit(frame);
return frame;
}

/** 一次上游 SSE 归并后的 FC / 桥接结果；无 token，thoughtSignature 只记长度。 */
export function captureTurn(opts: {
  stepIndex: number;
  kind: 'text' | 'tool_use' | 'reject-all';
  text: string;
  thoughtText?: string;
  finishReason: string | null;
  usage: {
    promptTokens: number;
    completionTokens: number;
    thoughtsTokens: number;
    cachedTokens: number;
  };
  calls: Array<{
    nativeId: string;
    nativeName: string;
    args: Record<string, unknown>;
    thoughtSignatureBytes: number;
    outcome: 'tool_use' | 'reject';
    claudeName?: string;
    claudeId?: string;
    claudeInput?: Record<string, unknown>;
    rejectReason?: string;
  }>;
}): LogcatFrame | undefined {
const frame = latestFrame();
if (!frame) return undefined;
const calls: LogcatCall[] = (opts.calls ?? []).map((c) => {
  const args = clip(stringifyUnknown(c.args ?? {}));
  const input = c.claudeInput ? clip(stringifyUnknown(c.claudeInput)) : undefined;
  const arrow = c.outcome === 'tool_use' ? `→${c.claudeName || '?'}` : '→reject';
  const sig = c.thoughtSignatureBytes > 0 ? `sig:${c.thoughtSignatureBytes}B` : '';
  return {
    nativeId: c.nativeId,
    nativeName: c.nativeName,
    argsText: args.text,
    argsBytes: args.bytes,
    sig,
    outcome: c.outcome,
    preview: omitText(
      `${c.nativeName} ${arrow} ${c.outcome === 'reject' ? c.rejectReason || '' : args.text}`,
    ),
    claudeName: c.claudeName,
    claudeId: c.claudeId,
    claudeInputText: input?.text,
    claudeInputBytes: input?.bytes,
    rejectReason: c.rejectReason,
  };
});
const text = clip(opts.text || '');
const callPreview = calls.map((c) => {
  if (c.outcome === 'tool_use') return `${c.nativeName}→${c.claudeName || '?'}`;
  return `${c.nativeName}→reject`;
});
frame.turns.push({
  stepIndex: opts.stepIndex,
  kind: opts.kind,
  text: text.text,
  textBytes: text.bytes,
  thoughtBytes: opts.thoughtText ? Buffer.byteLength(opts.thoughtText, 'utf8') : 0,
  finishReason: opts.finishReason || '',
  preview: omitText(callPreview.length ? callPreview.join(' | ') : opts.text || '(text)'),
  usage: {
    prompt: opts.usage.promptTokens,
    completion: opts.usage.completionTokens,
    thoughts: opts.usage.thoughtsTokens,
    cached: opts.usage.cachedTokens,
  },
  calls,
});
emit(frame);
return frame;
}

export function captureError(status: number, message: string): void {
const frame = latestFrame();
if (!frame) return;
frame.error = { status, message: omitText(message, 400) };
emit(frame);
}

const PAGE = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>logcat</title>
<style>
:root { --bg:#0f1115; --panel:#171a21; --line:#2a3140; --tx:#d7dde8; --dim:#8b95a8;
        --a:#e0a154; --b:#6ecf9a; --sys:#d67bff; --user:#7eb8ff; --asst:#9ad0ff; }
* { box-sizing: border-box; }
html, body { margin:0; height:100%; background:var(--bg); color:var(--tx);
  font: 13px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
header { display:flex; gap:12px; align-items:center; padding:10px 14px; border-bottom:1px solid var(--line); }
header h1 { font-size:14px; margin:0; letter-spacing:.04em; }
header .meta { color:var(--dim); }
header label { color:var(--dim); user-select:none; }
.layout { display:grid; grid-template-columns: 280px 1fr; height: calc(100% - 44px); }
#frames { overflow:auto; border-right:1px solid var(--line); padding:8px; }
.frame { padding:8px 10px; border:1px solid transparent; border-radius:6px; cursor:pointer; margin-bottom:6px; background:var(--panel); }
.frame:hover { border-color:var(--line); }
.frame.on { border-color:#4a6fa5; background:#1c2433; }
.frame .t { color:var(--dim); font-size:11px; }
.badge { display:inline-block; padding:0 6px; border-radius:4px; font-size:11px; }
.A { background:#3d2e12; color:var(--a); }
.B { background:#143326; color:var(--b); }
.warn { color:var(--a); }
#msgs { overflow:auto; padding:10px 14px 40px; }
details { background:var(--panel); border:1px solid var(--line); border-radius:6px; margin:0 0 8px; }
details.sys { border-color:#5a3a72; }
details.turn { border-color:#6a8a3a; }
details.block { border-color:var(--a); }
summary { cursor:pointer; padding:8px 10px; list-style:none; display:flex; gap:8px; align-items:baseline; }
summary::-webkit-details-marker { display:none; }
summary .idx { color:var(--dim); min-width:3ch; }
summary .role.user { color:var(--user); }
summary .role.assistant { color:var(--asst); }
summary .role.system { color:var(--sys); }
summary .role.model { color:var(--a); }
h2 { font-size:12px; color:var(--dim); margin:16px 0 8px; letter-spacing:.06em; text-transform:uppercase; }
summary .kinds { color:var(--dim); }
summary .preview { color:var(--tx); opacity:.85; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; flex:1; }
.body { padding:0 10px 10px; border-top:1px solid var(--line); }
.blk { margin-top:8px; }
.blk .h { color:var(--dim); font-size:11px; margin-bottom:4px; }
pre { margin:0; white-space:pre-wrap; word-break:break-word; background:#0c0e12; padding:8px; border-radius:4px; max-height:420px; overflow:auto; }
.empty { color:var(--dim); padding:24px; }
</style>
</head>
<body>
<header>
<h1>logcat</h1>
<span class="meta" id="meta">connecting…</span>
<label><input type="checkbox" id="follow" checked/> follow latest</label>
</header>
<div class="layout">
<nav id="frames"></nav>
<main id="msgs"><div class="empty">等待 /v1/messages 入站</div></main>
</div>
<script>
const frames = [];
let selected = null;
const $frames = document.getElementById('frames');
const $msgs = document.getElementById('msgs');
const $meta = document.getElementById('meta');
const $follow = document.getElementById('follow');

function esc(s) {
return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function time(ts) { return new Date(ts).toLocaleTimeString(); }

function renderNav() {
$frames.innerHTML = frames.map(f => {
  const on = selected === f.id ? ' on' : '';
  const warn = f.tailBlocksParse ? '<div class="warn">tail=' + esc(f.tailRole) + ' → 截断扫描</div>' : '';
  const lastOut = (f.outbound && f.outbound.length) ? f.outbound[f.outbound.length-1] : null;
  const outWarn = lastOut && lastOut.lastRole === 'model' ? ' warn' : '';
  const outLine = lastOut
    ? '<div class="t' + outWarn + '">out n=' + lastOut.n + ' last=' + esc(lastOut.lastRole) + '(' + esc(lastOut.lastKinds) + ') step=' + lastOut.stepIndex + '</div>'
    : '<div class="t">out —</div>';
  const lastTurn = (f.turns && f.turns.length) ? f.turns[f.turns.length-1] : null;
  const turnLine = lastTurn
    ? '<div class="t">turn ' + esc(lastTurn.kind) + ' ' + esc(lastTurn.preview) + '</div>'
    : '';
  const err = f.error ? '<div class="warn">err ' + esc(String(f.error.status)) + ' ' + esc(f.error.message) + '</div>' : '';
  return '<div class="frame' + on + '" data-id="' + f.id + '">'
    + '<div><span class="badge ' + f.branch + '">分支' + f.branch + '</span> #' + f.id
    + ' <span class="t">' + time(f.ts) + '</span></div>'
    + '<div class="t">in n=' + f.n + ' tool_result=' + f.toolResultCount + ' pending=' + esc(f.pending) + '</div>'
    + outLine
    + turnLine
    + warn
    + err
    + '</div>';
}).reverse().join('') || '<div class="empty">无帧</div>';
}

function renderBlocks(blocks) {
  return (blocks || []).map(b => {
    const h = b.type === 'tool_use' || b.type === 'functionCall'
      ? b.type + ' name=' + (b.name || '') + ' id=' + (b.id || '')
      : b.type === 'tool_result'
        ? b.type + ' id=' + (b.toolUseId || '') + ' err=' + b.isError
        : b.type === 'functionResponse'
          ? b.type + ' name=' + (b.name || '') + ' id=' + (b.id || '')
          : b.type + ' ' + b.bytes + 'B';
    return '<div class="blk"><div class="h">' + esc(h) + (b.truncated ? ' truncated' : '')
      + '</div><pre>' + esc(b.text || '') + '</pre></div>';
  }).join('');
}
function renderMessageList(f, messages, outbound) {
  return (messages || []).map(m => {
    const cls = m.role === 'system' ? ' sys'
      : (m.role === 'model' || (f.tailBlocksParse && m.idx === f.n - 1) ? ' block' : '');
    const blocks = renderBlocks(m.blocks);
    return '<details class="' + cls.trim() + '"><summary>'
      + '<span class="idx">' + m.idx + '</span>'
      + '<span class="role ' + esc(m.role) + '">' + esc(m.role) + '</span>'
      + '<span class="kinds">(' + esc(m.kinds) + ')</span>'
      + '<span class="preview">' + esc(m.preview) + '</span>'
      + '</summary><div class="body">' + (blocks || '<div class="empty">empty</div>') + '</div></details>';
  }).join('');
}
function renderOutbound(f, o, i) {
  const warn = o.lastRole === 'model' ? ' class="warn"' : '';
  const meta = '<p class="meta"' + warn + '>出站 #' + (i+1)
    + ' step=' + o.stepIndex + ' n=' + o.n
    + ' last=' + esc(o.lastRole) + '(' + esc(o.lastKinds) + ')'
    + ' tools=' + o.toolCount + ' session=' + esc(o.sessionId) + '</p>';
  const sys = '<details class="sys"><summary>'
    + '<span class="role system">systemInstruction</span>'
    + '<span class="kinds">(' + o.systemBytes + 'B)</span>'
    + '<span class="preview">' + esc(o.systemPreview) + '</span>'
    + '</summary><div class="body"><pre>' + esc(o.systemText || o.systemPreview) + '</pre></div></details>';
  return meta + sys + renderMessageList(f, o.contents);
}
function renderTurn(t, i) {
  const calls = t.calls || [];
  const u = t.usage || {};
  const meta = '<p class="meta">上游回合 #' + (i+1)
    + ' step=' + t.stepIndex
    + ' kind=' + esc(t.kind)
    + ' fc=' + calls.length
    + ' finish=' + esc(t.finishReason || '—')
    + ' usage={prompt:' + u.prompt
    + ', completion:' + u.completion
    + ', thoughts:' + u.thoughts
    + ', cached:' + u.cached + '}'
    + (t.thoughtBytes ? ' thought=' + t.thoughtBytes + 'B' : '')
    + '</p>';
  const textBlock = t.text
    ? '<details class="turn"><summary>'
      + '<span class="role model">model text</span>'
      + '<span class="kinds">(' + t.textBytes + 'B)</span>'
      + '<span class="preview">' + esc(t.preview) + '</span>'
      + '</summary><div class="body"><pre>' + esc(t.text) + '</pre></div></details>'
    : '';
  const callBlocks = calls.map(c => {
    const arrow = c.outcome === 'tool_use'
      ? ' → ' + (c.claudeName || '?')
      : ' → reject';
    const h = (c.nativeName || '?') + ' id=' + (c.nativeId || '')
      + (c.sig ? ' ' + c.sig : '') + arrow;
    let body = '<div class="blk"><div class="h">native args ' + c.argsBytes + 'B</div><pre>'
      + esc(c.argsText || '') + '</pre></div>';
    if (c.outcome === 'tool_use') {
      body += '<div class="blk"><div class="h">claude ' + esc(c.claudeName || '')
        + ' id=' + esc(c.claudeId || '') + ' ' + (c.claudeInputBytes || 0) + 'B</div><pre>'
        + esc(c.claudeInputText || '') + '</pre></div>';
    } else {
      body += '<div class="blk"><div class="h">reject</div><pre>'
        + esc(c.rejectReason || '') + '</pre></div>';
    }
    return '<details class="turn"><summary>'
      + '<span class="role model">functionCall</span>'
      + '<span class="kinds">(' + esc(h) + ')</span>'
      + '<span class="preview">' + esc(c.preview || '') + '</span>'
      + '</summary><div class="body">' + body + '</div></details>';
  }).join('');
  return meta + (t.kind === 'text' ? textBlock : (callBlocks + textBlock));
}
function renderMsgs() {
 const f = frames.find(x => x.id === selected);
if (!f) { $msgs.innerHTML = '<div class="empty">等待 /v1/messages 入站</div>'; return; }
const err = f.error ? '<p class="warn">error ' + esc(String(f.error.status)) + ' ' + esc(f.error.message) + '</p>' : '';
const head = '<p class="meta">model=' + esc(f.model) + ' stream=' + f.stream
  + ' last=[' + esc(f.last) + ']</p>' + err;
const inbound = '<h2>入站 /v1/messages</h2>' + (renderMessageList(f, f.messages) || '<div class="empty">empty</div>');
const outs = f.outbound || [];
const turns = f.turns || [];
let process = '<h2>过程 出站 → 上游回合</h2>';
if (!outs.length && !turns.length) {
  process += '<div class="empty">尚未发往上游（本地 400 或等待中）</div>';
} else {
  const n = Math.max(outs.length, turns.length);
  for (let i = 0; i < n; i++) {
    if (outs[i]) process += renderOutbound(f, outs[i], i);
    if (turns[i]) process += renderTurn(turns[i], i);
  }
}
$msgs.innerHTML = head + process + inbound;
}

$frames.addEventListener('click', e => {
const el = e.target.closest('.frame');
if (!el) return;
$follow.checked = false;
selected = Number(el.dataset.id);
renderNav();
renderMsgs();
});

function ingest(list) {
for (const f of list) {
  const i = frames.findIndex(x => x.id === f.id);
  if (i >= 0) frames[i] = f; else frames.push(f);
}
frames.sort((a,b) => a.id - b.id);
while (frames.length > 40) frames.shift();
$meta.textContent = frames.length + ' frames';
if ($follow.checked && frames.length) {
  selected = frames[frames.length - 1].id;
}
renderNav();
renderMsgs();
}

fetch('/logcat/snapshot').then(r => r.json()).then(j => ingest(j.frames || [])).catch(() => {});
const es = new EventSource('/logcat/stream');
es.onmessage = ev => {
try {
  const d = JSON.parse(ev.data);
  if (d.type === 'hello') ingest(d.frames || []);
  else if (d.type === 'frame') ingest([d.frame]);
} catch {}
};
es.onerror = () => { $meta.textContent = 'sse reconnecting…'; };
</script>
</body>
</html>
`;

export function mountLogcat(app: Express): void {
  app.get('/logcat', (_req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(PAGE);
  });
app.get('/logcat/snapshot', (_req, res) => {
  res.json(getSnapshot());
});
app.get('/logcat/stream', (req: Request, res: Response) => {
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  if (typeof res.flushHeaders === 'function') res.flushHeaders();
  res.write(`data: ${JSON.stringify({ type: 'hello', frames: getSnapshot().frames })}\n\n`);
  const unsub = subscribe((frame) => {
    if (res.writableEnded) return;
    res.write(`data: ${JSON.stringify({ type: 'frame', frame })}\n\n`);
  });
  const ping = setInterval(() => {
    if (res.writableEnded) return;
    res.write(': ping\n\n');
  }, 15000);
  req.on('close', () => {
    clearInterval(ping);
    unsub();
  });
});
}

if (require.main === module) {
resetLogcat();
const body: AnthropicMessagesRequest = {
  model: 'gemini-3.6-flash-high',
  messages: [
    { role: 'user', content: 'hi' },
    {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'call_1', name: 'Bash', input: { command: 'rg mtgsig' } }],
    },
    {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'Pods/MTRisk' }],
    },
    { role: 'system' as 'user', content: 'mid-conversation system 421B' },
  ],
};
const parsed = parseToolResults(body);
assert.strictEqual(parsed.length, 1, 'trailing system 不得截断 tool_result');
const f = captureInbound(body, {
  model: 'gemini-3.6-flash-high',
  stream: true,
  toolResults: parsed,
  pendingHits: ['miss'],
});
assert.strictEqual(f.branch, 'B');
assert.strictEqual(f.n, 4);
assert.strictEqual(f.tailRole, 'system');
assert.strictEqual(f.tailBlocksParse, false);
assert.strictEqual(f.messages[1].kinds, 'tool_use');
assert.strictEqual(f.messages[2].kinds, 'tool_result');
assert.ok(f.messages[1].preview.includes('Bash'));
assert.ok(PAGE.includes('follow latest'));
assert.ok(PAGE.includes('过程 出站 → 上游回合'));
assert.ok(PAGE.includes('上游回合'));
assert.deepStrictEqual(f.outbound, []);
assert.deepStrictEqual(f.turns, []);
const out = captureOutbound({
  model: 'gemini-3.6-flash-high',
  stepIndex: 0,
  sessionId: '-1',
  systemInstruction: 'sys-hello',
  tools: [],
  contents: [
    { role: 'user', parts: [{ text: 'hi' }] },
    {
      role: 'model',
      parts: [
        {
          functionCall: { id: 'fc1', name: 'list_dir', args: { DirectoryPath: '/tmp' } },
          thoughtSignature: 'sig-bytes',
        },
      ],
    },
  ],
});
assert.ok(out);
assert.strictEqual(out!.outbound.length, 1);
assert.strictEqual(out!.outbound[0].lastRole, 'model');
assert.strictEqual(out!.outbound[0].contents[1].kinds, 'functionCall');
assert.ok(out!.outbound[0].contents[1].blocks[0].text.includes('sig:9B'));
assert.ok(!JSON.stringify(out).includes('ya29'));
const long = 'x'.repeat(13_000);
const outLong = captureOutbound({
  model: 'gemini-3.6-flash-high',
  stepIndex: 0,
  sessionId: '-1',
  systemInstruction: long,
  tools: [],
  contents: [{ role: 'user', parts: [{ text: long }] }],
});
assert.ok(outLong);
assert.strictEqual(outLong!.outbound[1].systemTruncated, false);
assert.strictEqual(outLong!.outbound[1].systemText.length, 13_000);
assert.strictEqual(outLong!.outbound[1].contents[0].blocks[0].truncated, false);
assert.strictEqual(outLong!.outbound[1].contents[0].blocks[0].text.length, 13_000);
const q = 'y'.repeat(13_000);
const turned = captureTurn({
  stepIndex: 0,
  kind: 'tool_use',
  text: 'listing dir',
  thoughtText: 'hidden-thought',
  finishReason: null,
  usage: { promptTokens: 10, completionTokens: 2, thoughtsTokens: 1, cachedTokens: 0 },
  calls: [
    {
      nativeId: 'fc1',
      nativeName: 'list_dir',
      args: { DirectoryPath: '/tmp', Query: q },
      thoughtSignatureBytes: 9,
      outcome: 'tool_use',
      claudeName: 'Bash',
      claudeId: 'fc1',
      claudeInput: { command: 'python3 -c list' },
    },
    {
      nativeId: 'fc2',
      nativeName: 'browser_subagent',
      args: {},
      thoughtSignatureBytes: 0,
      outcome: 'reject',
      rejectReason: 'unsupported native tool',
    },
  ],
});
assert.ok(turned);
assert.strictEqual(turned!.turns.length, 1);
assert.strictEqual(turned!.turns[0].kind, 'tool_use');
assert.strictEqual(turned!.turns[0].calls[0].claudeName, 'Bash');
assert.strictEqual(turned!.turns[0].calls[0].sig, 'sig:9B');
assert.ok(turned!.turns[0].calls[0].argsText.includes(q));
assert.strictEqual(turned!.turns[0].calls[1].outcome, 'reject');
assert.ok(turned!.turns[0].calls[1].rejectReason?.includes('unsupported'));
assert.ok(!JSON.stringify(turned).includes('hidden-thought'));
assert.ok(!JSON.stringify(turned).includes('ya29'));
captureError(400, 'Requests ending with a model turn are not supported.');
assert.strictEqual(getSnapshot().frames[0].error?.status, 400);
assert.strictEqual(getSnapshot().frames.length, 1);
console.log('logcat self-test ok');
}
