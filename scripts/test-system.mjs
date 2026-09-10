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
  ruleTagFromPath,
} = sp;
const tw = await import(path.join(root, 'dist/trim-words.js'));
const { DEFAULT_TRIM_WORDS, ZWSP, parseTrimWordsSpec } = tw;

const ccBody = JSON.parse(
  fs.readFileSync(path.join(root, 'docs/cc-request.capture.json'), 'utf8'),
).body;

// 4.1 夹具只有一份 /private/tmp/ccprobe/CLAUDE.md；tag 用 md 路径钉死。
const env = extractEnv(ccBody);
const out = buildSystemInstruction(env, 'trimmed');
assert.ok(
  out.includes(`<RULE[${ruleTagFromPath('/private/tmp/ccprobe/CLAUDE.md')}]>`),
  '夹具项目规则 tag 须是 md 路径',
);

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
    // guidelines：原型把 communication_style 整行删掉，现已改为遮词，不再逐字节比 commStyle
    const after = proto.slice(proto.indexOf('</ephemeral_message>') + 21);
    const guidelines = after.slice(0, after.indexOf('<communication_style>')).trimEnd();
    assert.ok(out.includes(guidelines), 'guidelines 与原型一致');
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

// 4.12 communication_style：命中词换成零宽，整行仍在
{
  const m = out.match(/<communication_style>[\s\S]*?<\/communication_style>/);
  assert.ok(m, '应有 communication_style 段');
  assert.ok(!m[0].includes('file://'), 'commStyle 不得含 file://');
  assert.ok(
    !/background task such as|task-20|DO NOTHING ELSE/.test(m[0]),
    'commStyle 不得含后台任务规则原文',
  );
  assert.ok(m[0].includes('You MUST create'), '不得删 clickable links 整行');
  assert.ok(
    m[0].includes('either proceed to other relevant work'),
    '不得删 A) 整行',
  );
  assert.ok(m[0].includes(ZWSP), '命中词须换成零宽');
  assert.ok(
    m[0].includes(ZWSP.repeat('clickable links'.length)),
    'clickable links 须等长零宽',
  );
}

// 4.17 额外过滤词（第三参）同样遮词不删段
{
  const extra = 'Keep your responses concise';
  const si = buildSystemInstruction(env, 'trimmed', [...DEFAULT_TRIM_WORDS, extra]);
  assert.ok(!si.includes(extra), '额外过滤词原文不得出现');
  const m = si.match(/<communication_style>[\s\S]*?<\/communication_style>/);
  assert.ok(m, '应有 communication_style 段');
  assert.ok(m[0].includes(`- ${ZWSP.repeat(extra.length)}.`), '只遮词，破折号与句点仍在');
  assert.deepEqual(parseTrimWordsSpec('a, b ,c'), ['a', 'b', 'c']);
  assert.deepEqual(parseTrimWordsSpec('["x"," y "]'), ['x', 'y']);
}

// 4.18 不区分大小写；长词优先
{
  const extra = 'keep your responses concise';
  const si = buildSystemInstruction(env, 'trimmed', [...DEFAULT_TRIM_WORDS, extra]);
  assert.ok(
    !si.includes('Keep your responses concise'),
    '大小写不同也须遮住',
  );
  const m = si.match(/<communication_style>[\s\S]*?<\/communication_style>/);
  assert.ok(m, '应有 communication_style 段');
  assert.ok(
    m[0].includes(`- ${ZWSP.repeat(extra.length)}.`),
    '大小写不同仍只遮词',
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

// 4.15 CC rules/skills → Antigravity <RULE[md路径]> / <skills>
// 夹具 docs/cc-rules-skills.capture.json：全局+项目双 CLAUDE.md、15 个 skill。
{
  const body = JSON.parse(
    fs.readFileSync(path.join(root, 'docs/cc-rules-skills.capture.json'), 'utf8'),
  ).body;
  const e = extractEnv(body);

  const globalTag = ruleTagFromPath('/tmp/ccconf2/CLAUDE.md');
  const projectTag = ruleTagFromPath('/private/tmp/ccprobe2/CLAUDE.md');
  assert.deepEqual(
    e.rules.map((r) => r.tag),
    [globalTag, projectTag],
    'rules tag 须是 md 路径而非 user_global/project.md',
  );
  assert.ok(e.rules[0].body.includes('全局规则'), 'global 规则正文');
  assert.ok(e.rules[1].body.includes('项目级规则'), 'project 规则正文');
  for (const r of e.rules) {
    assert.ok(!r.body.includes('Contents of '), `RULE[${r.tag}] 不得含 CC 包装头`);
  }

  // skills 来自 messages[role=system]，不是 messages[0]
  assert.ok(e.skills.length > 0, 'skills 应非空（源在 role=system 的 message 里）');
  assert.ok(
    e.skills.some(
      (s) =>
        s.name === 'architecture-diagram' &&
        s.skillMdPath.includes('.gemini/config/skills/architecture-diagram/SKILL.md'),
    ),
    'skill 应带 ~/.gemini 伪路径',
  );
  // 每条 skill 都有伪路径（不依赖磁盘是否真有 SKILL.md）
  assert.ok(
    e.skills.every((s) => s.skillMdPath.includes('.gemini/config/skills/')),
    '全部 skill 须带伪路径',
  );
  // 操作 CC 自身的 skill 必须被丢（描述里带 Claude Code / CLAUDE.md / .claude）
  for (const n of ['update-config', 'claude-api', 'keybindings-help', 'init']) {
    assert.ok(!e.skills.some((s) => s.name === n), `带 CC 特征的 skill 必须丢: ${n}`);
  }

  const si = buildSystemInstruction(e, 'trimmed');
  assert.ok(si.includes(`<RULE[${globalTag}]>`), `应含 <RULE[${globalTag}]>`);
  assert.ok(si.includes(`<RULE[${projectTag}]>`), `应含 <RULE[${projectTag}]>`);
  assert.ok(
    si.includes('MUST ALWAYS FOLLOW WITHOUT ANY EXCEPTION'),
    'user_rules 须带抓包里的前言',
  );
  assert.ok(si.includes('Available skills:'), '应含 skills 列表');
  assert.deepEqual(scanLeaks(si), [], '组装后不得命中黑名单');
  assert.ok(!si.includes('<RULE[user_global]>'), '不得再使用 user_global');
  assert.ok(!si.includes('<RULE[project.md]>'), '不得再使用 project.md');

  // 位置：user_rules 与 skills 在 ephemeral 之后、guidelines 之前（抓包顺序）
  const at = (t) => si.indexOf(t);
  assert.ok(
    at('</ephemeral_message>') < at('<user_rules>') &&
      at('<user_rules>') < at('<skills>') &&
      at('<skills>') < at('<guidelines>'),
    'user_rules/skills 须在 ephemeral 与 guidelines 之间',
  );
}

// 4.16 RULE 正文豁免：用户 CLAUDE.md 模板句 / 文档路径不得误杀请求
{
  const homeRel = ruleTagFromPath(path.join(os.homedir(), 'Documents/IOS/CLAUDE.md'));
  assert.equal(homeRel, 'Documents/IOS/CLAUDE.md', 'home 下须相对路径');
  const si = buildSystemInstruction(
    {
      cwd: '/tmp/proj',
      platform: 'darwin',
      isGitRepo: true,
      additionalDirs: [],
      userRules: '',
      rules: [
        {
          tag: homeRel,
          body:
            'This file provides guidance to Claude Code (claude.ai/code).\n' +
            'See `/Users/cddchen/.claude/docs/CIPFoundation.md`.',
        },
      ],
      skills: [],
    },
    'trimmed',
  );
  assert.ok(si.includes(`<RULE[${homeRel}]>`));
  assert.ok(si.includes('Claude Code'));
  assert.ok(si.includes('/.claude'));
  assert.deepEqual(scanLeaks(si), [], 'RULE 正文里的黑名单词不得命中');
}

console.log('PASS test-system.mjs (18 assertion groups)');
