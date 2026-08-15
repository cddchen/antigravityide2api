// T9 —— 出站 HTTP 头逐字对照 IDE 抓包
//
// 夹具 docs/ide-headers.capture.json 由 Surge 2026-08-08 抓包提取，
// 13/13 条 streamGenerateContent 完全一致，Authorization 已脱敏。
//
// 只锁 HTTP 层。TLS ClientHello(JA3) 对不齐，见 antigravity-client.ts 的注释。
import assert from 'node:assert/strict';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixture = JSON.parse(
  fs.readFileSync(path.join(root, 'docs/ide-headers.capture.json'), 'utf8'),
);

/** 起裸 TCP sink，收第一段字节就够 —— 我们只要请求行 + 头块 */
function captureRequest(port) {
  return new Promise((resolve) => {
    const srv = net.createServer((sock) => {
      sock.once('data', (buf) => {
        srv.close();
        sock.destroy();
        resolve(buf.toString('utf8').split('\r\n\r\n')[0].split('\r\n'));
      });
    });
    srv.listen(port, '127.0.0.1');
  });
}

const PORT = 8123;
const got = captureRequest(PORT);

process.env.ANTIGRAVITY_BASE = `http://127.0.0.1:${PORT}`;
const { streamGenerate } = await import(path.join(root, 'dist/antigravity-client.js'));
const { getNativeTools } = await import(path.join(root, 'dist/native-tools.js'));

streamGenerate({
  accessToken: 'ya29.REDACTED',
  projectId: 'p',
  model: 'gemini-3.6-flash-high',
  contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
  systemInstruction: 's',
  tools: getNativeTools(),
  sessionId: '-1',
  cascadeUuid: 'c',
  trajectoryUuid: 't',
  stepIndex: 0,
}).catch(() => {});

const lines = await got;

// 请求行：方法 + path + 协议版本
assert.equal(lines[0], `POST ${fixture.path} HTTP/1.1`, `请求行不符: ${lines[0]}`);

// 头名顺序必须逐字相同（Host 值本地不同，只比名字）
const names = lines.slice(1).map((l) => l.slice(0, l.indexOf(':')));
assert.deepEqual(names, fixture.headerOrder, `头顺序不符:\n实际 ${names}\n期望 ${fixture.headerOrder}`);

// 值：除 Host（本地 sink）、Authorization（token）、User-Agent（跟本机 product.json）外必须一字不差
const kv = Object.fromEntries(
  lines.slice(1).map((l) => [l.slice(0, l.indexOf(':')), l.slice(l.indexOf(':') + 2)]),
);
for (const [k, v] of Object.entries(fixture.headers)) {
  if (k === 'Host' || k === 'Authorization' || k === 'User-Agent') continue;
  assert.equal(kv[k], v, `${k} 值不符: ${kv[k]} != ${v}`);
}
assert.match(
  kv['User-Agent'],
  /^antigravity\/ide\/\S+ \S+\/\S+$/,
  `User-Agent 形状不符: ${kv['User-Agent']}`,
);
assert.match(kv.Authorization, /^Bearer /, 'Authorization 必须是 Bearer');

// Connection 是 Node 会自动追加、Go 不发的头 —— 必须已被 removeHeader 抹掉
assert.equal(kv.Connection, undefined, '不能出现 Connection 头');

// 流式端点必须 chunked，不能有 Content-Length
assert.equal(kv['Content-Length'], undefined, '流式请求不能带 Content-Length');

console.log(`PASS T9 出站头 ${names.length} 条，顺序与 IDE 抓包一致`);
