// ═══════════════════════════════════════════════
//  DEBUG=1 时的入站会话可视化：GET /logcat
//  只观测 CC → 本服务的 messages，不改分支语义
// ═══════════════════════════════════════════════

import assert from 'assert';
import type { Express, Request, Response } from 'express';
import { parseToolResults } from './anthropic';
import type {
AnthropicContentBlock,
AnthropicMessagesRequest,
ParsedToolResult,
} from './types';

const MAX_FRAMES = 20;
const PREVIEW_MAX = 160;
const DETAIL_MAX = 12_000;

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

function clip(s: string, max = DETAIL_MAX): { text: string; bytes: number; truncated: boolean } {
const bytes = Buffer.byteLength(s, 'utf8');
if (s.length <= max) return { text: s, bytes, truncated: false };
return { text: `${s.slice(0, max)}\n…(truncated ${bytes}B)`, bytes, truncated: true };
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
  branch: toolResultCount > 0 ? 'B' : 'A',
  toolResultCount,
  pending: meta.pendingHits.join(',') || '—',
  last: lastSummary(messages),
  tailRole,
  tailBlocksParse: parseTailRole !== '' && parseTailRole !== 'user',
  messages,
};
frames.push(frame);
while (frames.length > MAX_FRAMES) frames.shift();
for (const cb of listeners) {
  try {
    cb(frame);
  } catch {
    /* SSE 客户端断开时忽略 */
  }
}
return frame;
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
details.block { border-color:var(--a); }
summary { cursor:pointer; padding:8px 10px; list-style:none; display:flex; gap:8px; align-items:baseline; }
summary::-webkit-details-marker { display:none; }
summary .idx { color:var(--dim); min-width:3ch; }
summary .role.user { color:var(--user); }
summary .role.assistant { color:var(--asst); }
summary .role.system { color:var(--sys); }
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
  return '<div class="frame' + on + '" data-id="' + f.id + '">'
    + '<div><span class="badge ' + f.branch + '">分支' + f.branch + '</span> #' + f.id
    + ' <span class="t">' + time(f.ts) + '</span></div>'
    + '<div class="t">n=' + f.n + ' tool_result=' + f.toolResultCount + ' pending=' + esc(f.pending) + '</div>'
    + warn
    + '</div>';
}).reverse().join('') || '<div class="empty">无帧</div>';
}

function renderMsgs() {
 const f = frames.find(x => x.id === selected);
if (!f) { $msgs.innerHTML = '<div class="empty">等待 /v1/messages 入站</div>'; return; }
const head = '<p class="meta">model=' + esc(f.model) + ' stream=' + f.stream
  + ' last=[' + esc(f.last) + ']</p>';
const rows = f.messages.map(m => {
  const cls = m.role === 'system' ? ' sys' : (f.tailBlocksParse && m.idx === f.n - 1 ? ' block' : '');
  const blocks = m.blocks.map(b => {
    const h = b.type === 'tool_use'
      ? b.type + ' name=' + (b.name || '') + ' id=' + (b.id || '')
      : b.type === 'tool_result'
        ? b.type + ' id=' + (b.toolUseId || '') + ' err=' + b.isError
        : b.type + ' ' + b.bytes + 'B';
    return '<div class="blk"><div class="h">' + esc(h) + (b.truncated ? ' truncated' : '')
      + '</div><pre>' + esc(b.text) + '</pre></div>';
  }).join('');
  return '<details class="' + cls.trim() + '"><summary>'
    + '<span class="idx">' + m.idx + '</span>'
    + '<span class="role ' + esc(m.role) + '">' + esc(m.role) + '</span>'
    + '<span class="kinds">(' + esc(m.kinds) + ')</span>'
    + '<span class="preview">' + esc(m.preview) + '</span>'
    + '</summary><div class="body">' + (blocks || '<div class="empty">empty</div>') + '</div></details>';
}).join('');
$msgs.innerHTML = head + rows;
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
assert.strictEqual(getSnapshot().frames.length, 1);
console.log('logcat self-test ok');
}
