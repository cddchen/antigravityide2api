// T10 —— OAuth client 不入库，运行时从本机 IDE 提取
//
// 起因：硬编码 client_id/secret 被 GitHub secret scanning GH013 拦 push。
// 这里同时守两条：仓库里扫不到凭证 + 提取路径真能拿到值。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// 1. 仓库正文里不得出现 client secret / 具体 client id
{
  const files = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' })
    .split('\n')
    .filter((f) => f && !f.startsWith('node_modules/'));
  const hits = [];
  for (const f of files) {
    const p = path.join(root, f);
    if (!fs.existsSync(p) || fs.statSync(p).isDirectory()) continue;
    const s = fs.readFileSync(p, 'latin1');
    // 正则字面量本身含 GOCSPX- 前缀，只判后面真跟了值的
    if (/GOCSPX-[A-Za-z0-9_]{15,}/.test(s)) hits.push(`${f}: secret`);
    if (/[0-9]{9,}-[a-z0-9]{20,}\.apps\.googleusercontent\.com/.test(s)) hits.push(`${f}: id`);
  }
  assert.deepEqual(hits, [], `已跟踪文件中残留 OAuth 凭证:\n${hits.join('\n')}`);
}

// 2. env 覆盖优先，且不触发文件扫描
{
  process.env.ANTIGRAVITY_CLIENT_ID = 'test-id';
  process.env.ANTIGRAVITY_CLIENT_SECRET = 'test-secret';
  const auth = await import(path.join(root, 'dist/auth.js'));
  // refreshAccessToken 会走网络，这里只验 body 组装 —— 用假 fetch 截住
  const orig = globalThis.fetch;
  let sent = '';
  globalThis.fetch = async (_u, init) => {
    sent = init.body;
    return { ok: true, status: 200, text: async () => JSON.stringify({ access_token: 'ya29.x', expires_in: 3599 }) };
  };
  await auth.refreshAccessToken({ name: 'a', accessToken: '', refreshToken: '1//r' });
  globalThis.fetch = orig;
  assert.ok(sent.includes('client_id=test-id'), `env client_id 未生效: ${sent}`);
  assert.ok(sent.includes('client_secret=test-secret'), `env client_secret 未生效: ${sent}`);
  delete process.env.ANTIGRAVITY_CLIENT_ID;
  delete process.env.ANTIGRAVITY_CLIENT_SECRET;
}

// 3. 本机装了 IDE 就必须能提取出成对的 id/secret（没装则跳过）
{
  const { extractOAuthClient } = await import(path.join(root, 'dist/extract-token.js'));
  let got;
  try {
    got = extractOAuthClient();
  } catch (e) {
    console.log(`SKIP 本机无 Antigravity IDE: ${e.message.split('\n')[0]}`);
  }
  if (got) {
    assert.match(got.id, /^[0-9]{6,}-[a-z0-9]{16,}\.apps\.googleusercontent\.com$/, 'client id 形状');
    assert.match(got.secret, /^GOCSPX-[A-Za-z0-9_-]{20,}$/, 'client secret 形状');
    console.log(`  提取成功: ${got.id.slice(0, 8)}… / ${got.secret.slice(0, 10)}…`);
  }
}

// 4. ideVersion 从 product.json 读，不读 VS Code 内核 version
{
  const { extractIdeVersion } = await import(path.join(root, 'dist/extract-token.js'));
  let ver;
  try {
    ver = extractIdeVersion();
  } catch (e) {
    console.log(`SKIP 本机无 product.json: ${e.message.split('\n')[0]}`);
  }
  if (ver) {
    assert.match(ver, /^\d+\.\d+\.\d+$/, `ideVersion 形状: ${ver}`);
    assert.notEqual(ver, '1.107.0', '不能把 VS Code 内核 version 当成 ideVersion');
    console.log(`  ideVersion=${ver}`);
  }
}

console.log('PASS test-oauth-client.mjs (4 assertion groups)');
