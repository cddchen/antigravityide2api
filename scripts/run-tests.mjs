// T8 —— 串跑 T1–T7 + 模块自检；任一非 0 整体非 0
// 注意：不要在这里调 npm run build（package.json 的 test 已先 build）
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

/** @type {{name:string, cmd:string[], optional?:boolean}[]} */
const suite = [
 { name: 'T1 test-envelope', cmd: [process.execPath, path.join(root, 'scripts/test-envelope.mjs')] },
 { name: 'T2 test-sse', cmd: [process.execPath, path.join(root, 'scripts/test-sse.mjs')] },
 { name: 'T3 test-bridge', cmd: [process.execPath, path.join(root, 'scripts/test-bridge.mjs')] },
 { name: 'T4 test-system', cmd: [process.execPath, path.join(root, 'scripts/test-system.mjs')] },
 { name: 'T5 test-pending', cmd: [process.execPath, path.join(root, 'scripts/test-pending.mjs')] },
 {
   name: 'T6 test-server',
   cmd: [process.execPath, path.join(root, 'scripts/test-server.mjs')],
   optional: true,
   file: path.join(root, 'scripts/test-server.mjs'),
 },
 {
   name: 'T7 assert-no-cc-leak',
   cmd: [process.execPath, path.join(root, 'scripts/assert-no-cc-leak.mjs'), '--fixture'],
 },
 { name: 'T9 test-headers', cmd: [process.execPath, path.join(root, 'scripts/test-headers.mjs')] },
 {
   name: 'T10 test-oauth-client',
   cmd: [process.execPath, path.join(root, 'scripts/test-oauth-client.mjs')],
 },
 // 模块自检（require.main === module）
 { name: 'self antigravity-client', cmd: [process.execPath, path.join(root, 'dist/antigravity-client.js')] },
 { name: 'self tool-bridge', cmd: [process.execPath, path.join(root, 'dist/tool-bridge.js')] },
  { name: 'self pending-session', cmd: [process.execPath, path.join(root, 'dist/pending-session.js')] },
  { name: 'self anthropic', cmd: [process.execPath, path.join(root, 'dist/anthropic.js')] },
  { name: 'self logcat', cmd: [process.execPath, path.join(root, 'dist/logcat.js')] },
  { name: 'self trim-words', cmd: [process.execPath, path.join(root, 'dist/trim-words.js')] },
];

const rows = [];
let failed = 0;
let passed = 0;
let skipped = 0;

for (const t of suite) {
 if (t.optional && t.file && !fs.existsSync(t.file)) {
   console.log(`SKIP ${t.name}（文件不存在）`);
   rows.push({ name: t.name, status: 'SKIP' });
   skipped++;
   continue;
 }
 process.stdout.write(`RUN  ${t.name} ... `);
 const r = spawnSync(t.cmd[0], t.cmd.slice(1), {
   cwd: root,
   encoding: 'utf8',
   env: process.env,
 });
 if (r.status === 0) {
   console.log('PASS');
   if (r.stdout?.trim()) {
     // 缩进打印末行摘要
     const last = r.stdout.trim().split('\n').pop();
     console.log(`     ${last}`);
   }
   rows.push({ name: t.name, status: 'PASS' });
   passed++;
 } else {
   console.log('FAIL');
   if (r.stdout) process.stdout.write(r.stdout);
   if (r.stderr) process.stderr.write(r.stderr);
   rows.push({ name: t.name, status: 'FAIL', code: r.status });
   failed++;
 }
}

console.log('\n========== 汇总 ==========');
for (const r of rows) {
 const mark = r.status === 'PASS' ? 'PASS' : r.status === 'SKIP' ? 'SKIP' : 'FAIL';
 console.log(`${mark.padEnd(4)}  ${r.name}`);
}
console.log(`--------------------------`);
console.log(`通过 ${passed} / 失败 ${failed} / 跳过 ${skipped} / 合计 ${rows.length}`);

process.exit(failed > 0 ? 1 : 0);
