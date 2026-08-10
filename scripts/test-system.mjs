// T4 —— system 转换与泄漏（对照 leakcheck.prototype.mjs / wire-reference）
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const sp = await import(path.join(root, 'dist/system-prompt.js'));
const {
  extractEnv,
  buildSystemInstruction,
  scanLeaks,
  LEAK_BLACKLIST,
} = sp;

const ccBody = JSON.parse(
  fs.readFileSync(path.join(root, 'docs/cc-request.capture.json'), 'utf8'),
).body;

// 4.1 trimmed length === 12400
// 原型实测 7563 是加 <skills> 与 RULE 拆分之前的数；这份夹具带 9 个可用 skill。
const env = extractEnv(ccBody);
const out = buildSystemInstruction(env, 'trimmed');
assert.equal(out.length, 12400, `trimmed length: ${out.length}`);

// 4.2 与 leakcheck.prototype.mjs 的**共有部分**一致
// 原型早于 rules/skills，输出不再逐字节相同；仍校验它没覆盖的段落原样保留，
// 保住「组装未偏离原型」这条约束。
{
  const tmpOut = path.join(os.tmpdir(), `ag-leakcheck-${process.pid}.txt`);
  try {
    execFileSync(process.execPath, [path.join(root, 'docs/leakcheck.prototype.mjs')], {
      env: { ...process.env, LEAKCHECK_OUT: tmpOut },
      cwd: root,
    });
    const proto = fs.readFileSync(tmpOut, 'utf8');
    // identity + user_information + ephemeral 三段：原型开头到 </ephemeral_message>
    const upto = (s) => s.slice(0, s.indexOf('</ephemeral_message>') + 20);
    assert.equal(upto(out), upto(proto), 'identity/user_information/ephemeral 与原型一致');
    // guidelines / communication_style：原型的 </ephemeral_message> 之后即这两段
    const after = proto.slice(proto.indexOf('</ephemeral_message>') + 21);
    const tail = after.slice(0, after.indexOf('<user_rules>')).trimEnd();
    assert.ok(out.includes(tail), 'guidelines/communication_style 与原型一致');
  } finally {
    try {
      fs.unlinkSync(tmpOut);
    } catch {
      /* ignore */
    }
  }
}

// 4.3 scanLeaks() 返回 []
assert.deepEqual(scanLeaks(out), []);

// 4.4 LEAK_BLACKLIST.length === 44
assert.equal(LEAK_BLACKLIST.length, 44);

// 4.5 不含五个 CC 标题
for (const h of [
  '# Memory',
  '# Environment',
  '# Harness',
  '# Context management',
  '# Session-specific guidance',
]) {
  assert.ok(!out.includes(h), `不得含 CC 标题: ${h}`);
}

// 4.6 含六段标签
for (const tag of [
  '<identity>',
  '<user_information>',
  '<ephemeral_message>',
  '<guidelines>',
  '<communication_style>',
  '<user_rules>',
]) {
  assert.ok(out.includes(tag), `应含段: ${tag}`);
}

// 4.7 不含 9 个丢弃段的标签（§1.5 / sections.json 中非组装段）
// 组装用 identity/user_information/ephemeral/user_rules/skills/guidelines/communication_style
// 丢弃：web_application_development / customizations / messaging /
//        knowledge_items / conversation_transcript / artifacts / slash_commands /
//        planning_mode / planning_mode_artifacts
// skills 不在此列 —— CC 侧有 skill 清单时按抓包位置重建（见 4.15）
for (const tag of [
  'web_application_development',
  'artifacts',
  'planning_mode',
  'customizations',
  'messaging',
  'knowledge_items',
  'conversation_transcript',
  'slash_commands',
  'planning_mode_artifacts',
]) {
  assert.ok(!out.includes(`<${tag}>`), `不得含丢弃段标签: <${tag}>`);
}

// 4.8 extractEnv.additionalDirs 不含 Platform:/Shell:/powered by the model（坑 1）
{
  for (const d of env.additionalDirs) {
    assert.ok(!/Platform:|Shell:|powered by the model/.test(d), `addl 脏数据: ${d}`);
  }
}

// 4.9 CLAUDE.md 正文首行是 # CLAUDE.md 时 userRules 非空（坑 2）
assert.ok(env.userRules.length > 0, 'userRules 应非空');
assert.ok(env.userRules.startsWith('# CLAUDE.md') || env.userRules.includes('# CLAUDE.md'));

// 4.10 userRules 不含 "Contents of " 与 ".claude"（坑 3：包装头）
assert.ok(!env.userRules.includes('Contents of '), 'userRules 不得含 Contents of ');
assert.ok(!env.userRules.includes('.claude'), 'userRules 不得含 .claude');

// 4.11 cwd=/private/tmp/x + additional=['/tmp/x'] → 1 active workspace（坑 4 symlink 去重）
{
  // 在本机造可 realpath 的路径对
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-sys-'));
  try {
    // macOS: /tmp → /private/tmp
    const privatePath = base.startsWith('/private/')
      ? base
      : path.join('/private', base);
    // 若 base 已是 /var/folders 等，直接用 realpath 相同的两写法
    let cwdPath;
    let addlPath;
    if (fs.existsSync('/tmp') && fs.existsSync('/private/tmp')) {
      const name = `ag-ws-${process.pid}`;
      cwdPath = path.join('/private/tmp', name);
      addlPath = path.join('/tmp', name);
      fs.mkdirSync(cwdPath, { recursive: true });
    } else {
      cwdPath = base;
      addlPath = base;
    }
    const fake = {
      system: [
        {
          type: 'text',
          text:
            ` - Primary working directory: ${cwdPath}\n` +
            ` - Platform: darwin\n` +
            ` - Is a git repository: true\n` +
            ` - Additional working directories:\n` +
            `  - ${addlPath}\n`,
        },
      ],
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    };
    const e = extractEnv(fake);
    const ui = buildSystemInstruction(e, 'short');
    assert.match(
      ui,
      /The user has 1 active workspace/,
      `应去重为 1: ${ui}\naddl=${JSON.stringify(e.additionalDirs)}`,
    );
    if (cwdPath.startsWith('/private/tmp/ag-ws-')) {
      fs.rmSync(cwdPath, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
}

// 4.12 communication_style 段不含 file:// 与后台任务规则
{
  const m = out.match(/<communication_style>[\s\S]*?<\/communication_style>/);
  assert.ok(m, '应有 communication_style 段');
  assert.ok(!m[0].includes('file://'), 'commStyle 不得含 file://');
  assert.ok(
    !/background task such as|task-20|DO NOTHING ELSE/.test(m[0]),
    'commStyle 不得含后台任务规则',
  );
}

// 4.13 system 传 string 也能 extractEnv
{
  const e = extractEnv({
    system:
      ' - Primary working directory: /tmp/string-cwd\n' +
      ' - Platform: linux\n' +
      ' - Is a git repository: false\n',
    messages: [],
  });
  assert.equal(e.cwd, '/tmp/string-cwd');
  assert.equal(e.platform, 'linux');
  assert.equal(e.isGitRepo, false);
}

// 4.14 ~/.claude 作为工作目录不得进 <user_information>
// 真机复现：用户把 ~/.claude 加进 additional working directories，该路径撞上
// LEAK_BLACKLIST 的 '/.claude' → assertSafeToSend 抛错 → 请求 500 中止不发送。
{
  const cc = path.join(os.homedir(), '.claude');
  const si = buildSystemInstruction(
    extractEnv({
      system:
        ' - Primary working directory: /tmp/proj\n' +
        ' - Additional working directories:\n' +
        '  - /tmp/other\n' +
        `  - ${cc}\n` +
        ' - Platform: darwin\n' +
        ' - Is a git repository: true\n',
      messages: [{ role: 'user', content: 'hi' }],
    }),
    'short',
  );
  assert.deepEqual(scanLeaks(si), [], 'workspace 列表含 ~/.claude 时不得命中黑名单');
  assert.ok(si.includes('/tmp/proj'), '正常 cwd 仍须保留');
  assert.ok(si.includes('/tmp/other'), '其余额外目录仍须保留');

  // cwd 本身就在 .claude 下：全滤光后退回 home，不能漏路径
  const si2 = buildSystemInstruction(
    extractEnv({
      system:
        ` - Primary working directory: ${cc}\n` +
        ' - Platform: darwin\n' +
        ' - Is a git repository: false\n',
      messages: [{ role: 'user', content: 'hi' }],
    }),
    'short',
  );
  assert.deepEqual(scanLeaks(si2), [], 'cwd 为 ~/.claude 时也不得命中');
}

// 4.15 CC rules/skills → Antigravity <RULE[...]> / <skills>
// 夹具 docs/cc-rules-skills.capture.json：全局+项目双 CLAUDE.md、15 个 skill。
// 对照 surge-conversation.json 的真实 system（RULE[user_global] / RULE[code-style.md] / skills）。
{
  const body = JSON.parse(
    fs.readFileSync(path.join(root, 'docs/cc-rules-skills.capture.json'), 'utf8'),
  ).body;
  const e = extractEnv(body);

  // 两条规则，global 在前，tag 不能是真实 basename（CLAUDE.md 是明牌）
  assert.deepEqual(
    e.rules.map((r) => r.tag),
    ['user_global', 'project.md'],
    'rules 应拆成 user_global + project.md',
  );
  assert.ok(e.rules[0].body.includes('全局规则'), 'global 规则正文');
  assert.ok(e.rules[1].body.includes('项目级规则'), 'project 规则正文');
  for (const r of e.rules) {
    assert.ok(!r.body.includes('Contents of '), `RULE[${r.tag}] 不得含 CC 包装头`);
  }

  // skills 来自 messages[role=system]，不是 messages[0]
  assert.ok(e.skills.length > 0, 'skills 应非空（源在 role=system 的 message 里）');
  assert.ok(
    e.skills.some((s) => s.name === 'architecture-diagram' && s.skillMdPath),
    'IDE 全局 root 下的 skill 应带 SKILL.md 路径',
  );
  // 操作 CC 自身的 skill 必须被丢（描述里带 Claude Code / CLAUDE.md / .claude）
  for (const n of ['update-config', 'claude-api', 'keybindings-help', 'init']) {
    assert.ok(!e.skills.some((s) => s.name === n), `带 CC 特征的 skill 必须丢: ${n}`);
  }

  const si = buildSystemInstruction(e, 'trimmed');
  assert.ok(si.includes('<RULE[user_global]>'), '应含 <RULE[user_global]>');
  assert.ok(si.includes('<RULE[project.md]>'), '应含 <RULE[project.md]>');
  assert.ok(
    si.includes('MUST ALWAYS FOLLOW WITHOUT ANY EXCEPTION'),
    'user_rules 须带抓包里的前言',
  );
  assert.ok(si.includes('Available skills:'), '应含 skills 列表');
  assert.deepEqual(scanLeaks(si), [], '组装后不得命中黑名单');
  assert.ok(!si.includes('CLAUDE.md'), '不得出现 CLAUDE.md 字样');

  // 位置：user_rules 与 skills 在 ephemeral 之后、guidelines 之前（抓包顺序）
  const at = (t) => si.indexOf(t);
  assert.ok(
    at('</ephemeral_message>') < at('<user_rules>') &&
      at('<user_rules>') < at('<skills>') &&
      at('<skills>') < at('<guidelines>'),
    'user_rules/skills 须在 ephemeral 与 guidelines 之间',
  );
}

console.log('PASS test-system.mjs (15 assertion groups)');
