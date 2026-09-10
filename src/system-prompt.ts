// ═══════════════════════════════════════════════
//  CC system / system-reminder → Antigravity systemInstruction
//  逻辑产品化自 docs/leakcheck.prototype.mjs（正则一字不改）
// ═══════════════════════════════════════════════

import fs from 'fs';
import os from 'os';
import path from 'path';
import { maskTrimWords, resolveTrimWords } from './trim-words';
import {
AnthropicContentBlock,
AnthropicMessagesRequest,
ExtractedEnv,
ExtractedRule,
ExtractedSkill,
} from './types';

// ---------- 夹具定位（dist/ 与 src/ 均可） ----------

function resolveDocs(...parts: string[]): string {
const candidates = [
  path.join(__dirname, '..', 'docs', ...parts),
  path.join(__dirname, '..', '..', 'docs', ...parts),
];
for (const p of candidates) {
  if (fs.existsSync(p)) return p;
}
throw new Error(`docs/${parts.join('/')} 未找到；尝试过: ${candidates.join(', ')}`);
}

interface SectionIndex {
name: string;
offset: number;
chars: number;
}

let _capture: string | null = null;
let _sections: Map<string, SectionIndex> | null = null;

function loadCapture(): string {
if (_capture === null) {
  _capture = fs.readFileSync(resolveDocs('ag-system.capture.txt'), 'utf8');
}
return _capture;
}

function loadSections(): Map<string, SectionIndex> {
if (_sections === null) {
  const raw = JSON.parse(
    fs.readFileSync(resolveDocs('ag-system.sections.json'), 'utf8'),
  ) as { sections: SectionIndex[] };
  _sections = new Map(raw.sections.map((s) => [s.name, s]));
}
return _sections;
}

/** 按 sections.json 的 offset/chars 从 capture 切出整段（含标签） */
function section(name: string): string {
const s = loadSections().get(name);
if (!s) throw new Error(`ag-system.sections.json 无段: ${name}`);
return loadCapture().slice(s.offset, s.offset + s.chars);
}

// ---------- 泄漏黑名单（44 词，照抄原型） ----------

export const LEAK_BLACKLIST: readonly string[] = [
'Claude Code',
'Anthropic',
'Claude Agent SDK',
'claude-cli',
'cc_version',
'cc_entrypoint',
'# Harness',
'# Session-specific guidance',
'# Memory',
'# Environment',
'# Context management',
'<system-reminder',
'claudeMd',
'cache_control',
'anthropic-beta',
'anthropic-version',
'.claude/projects',
'/.claude',
'x-anthropic-billing-header',
'CronCreate',
'CronDelete',
'CronList',
'DesignSync',
'EnterWorktree',
'ExitWorktree',
'NotebookEdit',
'ReportFindings',
'ScheduleWakeup',
'SendMessage',
'TaskCreate',
'TaskGet',
'TaskList',
'TaskOutput',
'TaskStop',
'TaskUpdate',
'WebFetch',
'WebSearch',
'subagent_type',
'Github-flavored markdown',
'permission mode',
'tool_use',
'opus',
'haiku',
'sonnet',
];

/**
* 用户/项目 md 正文会进 `<RULE[path]>`，模板句常带 `Claude Code`、
* 文档路径常带 `/.claude`。那是用户内容不是 harness 泄漏，扫描前整块剥掉
*（含开闭标签，避免 tag 里的 `.claude/CLAUDE.md` 误杀）。
*/
function withoutRuleBlocks(text: string): string {
return text.replace(/<RULE\[[^\]]*\]>[\s\S]*?<\/RULE\[[^\]]*\]>/g, '');
}

export function scanLeaks(
text: string,
): Array<{ word: string; index: number; context: string }> {
const haystack = withoutRuleBlocks(text);
const hits: Array<{ word: string; index: number; context: string }> = [];
for (const word of LEAK_BLACKLIST) {
  let i = -1;
  while ((i = haystack.indexOf(word, i + 1)) !== -1) {
    hits.push({
      word,
      index: i,
      context: haystack
        .slice(Math.max(0, i - 60), i + word.length + 60)
        .replace(/\n/g, '\\n'),
    });
  }
}
return hits;
}

// ---------- extractEnv ----------

function systemToText(
system: string | AnthropicContentBlock[] | undefined,
): string {
if (!system) return '';
if (typeof system === 'string') return system;
return system.map((s) => s.text || '').join('\n');
}

/**
* `Contents of <abs> (...)` → 出站 `<RULE[tag]>` 的 tag。
* home 下用相对路径（`Documents/IOS/CLAUDE.md`）；否则去掉开头 `/`。
* 不用 basename：多份 CLAUDE.md 会撞名。
*/
export function ruleTagFromPath(raw: string): string {
const n = path.normalize(raw.trim()).replace(/\\/g, '/');
if (!n) return 'unknown.md';
const home = os.homedir().replace(/\\/g, '/');
if (n === home) return path.basename(n);
if (n.startsWith(home + '/')) return n.slice(home.length + 1);
return n.replace(/^\//, '');
}

/**
* claudeMd 段 → 按 `Contents of <path> (<label>):` 切成多条规则。
* tag 用 md 路径（home 相对），不再用 user_global / project.md。
*/
function parseRules(claudeMd: string): ExtractedRule[] {
const rules: ExtractedRule[] = [];
const re = /^Contents of (.+?) \([^)]*\):\n/gm;
const heads: Array<{ filePath: string; start: number; end: number }> = [];
let m: RegExpExecArray | null;
while ((m = re.exec(claudeMd)) !== null) {
  heads.push({ filePath: m[1]!, start: m.index, end: m.index + m[0].length });
}
for (let i = 0; i < heads.length; i++) {
  const body = claudeMd
    .slice(heads[i]!.end, i + 1 < heads.length ? heads[i + 1]!.start : undefined)
    .trim();
  if (!body) continue;
  rules.push({
    tag: ruleTagFromPath(heads[i]!.filePath),
    body,
  });
}
return rules;
}

/**
* skill 名 → 伪路径安全段。插件 skill 含 `:`（如 `plugin:skill`），
* 路径里 `:` 在 Windows 非法，统一换成 `__`。
*/
export function skillSafeName(name: string): string {
return name.replace(/:/g, '__');
}

/**
* 始终伪造 `~/.gemini/config/skills/<safeName>/SKILL.md`。
* 抓包里 AG 真 skill 就落在这个根下；CC skill 不存在于磁盘，
* view_file 命中后由 tool-bridge 改路由到 Skill 工具，不读盘。
*/
export function skillPseudoPath(name: string): string {
return path.join(
  os.homedir(),
  '.gemini',
  'config',
  'skills',
  skillSafeName(name),
  'SKILL.md',
);
}

/** 伪路径 → skill 名；非本前缀返回 null。`__` 还原为 `:`。 */
export function parseSkillPseudoPath(rawPath: string): string | null {
if (!rawPath) return null;
// 必须 …/.gemini/config/skills/<safe>/SKILL.md（abs 或 ~ 均可）
const m = rawPath
  .replace(/^file:\/\//, '')
  .replace(/\\/g, '/')
  .match(/(?:^|\/)\.gemini\/config\/skills\/([^/]+)\/SKILL\.md$/);
if (!m?.[1]) return null;
return m[1].replace(/__/g, ':');
}

// CC 每进程只发一次 skill_listing（binary pxd Set）。后续 /v1/messages 无清单。
// 按 cwd 缓存，续轮 extractEnv 时回填，避免 <skills> 段消失。
const skillsCacheByCwd = new Map<string, ExtractedSkill[]>();

/**
* skill 清单 → <skills> 的 Available skills 行。
*
 * 位置实证：**不在 messages[0]**，在初始化阶段 `messages[i].role === 'system'`
 * 的第二个 <system-reminder>（第一个是 agent types，丢）。只扫首条 assistant
 * 之前的 role:system；对话中途的 system（Task 提醒）不进上游。
* 行形态两种：`- name` 与 `- name: description`；description 可能折行，续行不以
* `- ` 开头（实测 deep-research 的 TRIGGER/SKIP 两行），并进上一条。
* 空行结束清单（cursoride2api 同款）—— 否则会把 system-reminder 后噪声并进描述。
*/
function parseSkills(body: AnthropicMessagesRequest): ExtractedSkill[] {
 // 只吃「初始化」阶段的 role:system（首条 assistant 之前）。
 // 对话中途的 system（Task 提醒等）不进 systemInstruction，也不当 skill 源。
 const initSystemTexts: string[] = [];
 for (const msg of body.messages || []) {
   const role = (msg as { role: string }).role;
   if (role === 'assistant') break;
   if (role !== 'system') continue;
   const c = (msg as { content?: unknown }).content;
   if (typeof c === 'string') initSystemTexts.push(c);
   else {
     initSystemTexts.push(
       (Array.isArray(c) ? (c as AnthropicContentBlock[]) : [])
         .map((b) => b?.text || '')
         .join('\n'),
     );
   }
 }
 const all = initSystemTexts.join('\n');

const m = all.match(
  /The following skills are available for use with the Skill tool:\n([\s\S]*?)(?:<\/system-reminder>|$)/,
);
if (!m) return [];

const skills: ExtractedSkill[] = [];
for (const line of m[1]!.split('\n')) {
  // 空行：清单已开始则结束（防噪声并入 description）
  if (!line.trim()) {
    if (skills.length) break;
    continue;
  }
  if (line.startsWith('- ')) {
    const rest = line.slice(2);
    const i = rest.indexOf(': ');
    const name = (i >= 0 ? rest.slice(0, i) : rest).trim();
    if (!name) continue;
    skills.push({
      name,
      // 无描述项用名字兜底 —— 上游 Available skills 每行都是 `name (path): desc`
      description: i >= 0 ? rest.slice(i + 2) : name,
      skillMdPath: skillPseudoPath(name),
    });
  } else if (skills.length > 0) {
    skills[skills.length - 1]!.description += '\n' + line.trim();
  }
}
// 描述自带 CC 特征的直接丢：实测 update-config→'Claude Code'、
// keybindings-help→'~/.claude/keybindings.json'、claude-api→'Anthropic'、
// init→'CLAUDE.md'、fewer-permission-prompts→'.claude/settings.json'。
// 这些本来就是操作 CC 自身的 skill，对上游无意义，丢掉零损失；
// 留着则 assertSafeToSend 抛错 → 整个请求 500。
//
// 比 LEAK_BLACKLIST 更严（多查 CLAUDE.md / .claude）：黑名单不能加这两条
// —— 用户 CLAUDE.md 正文首行常就是 `# CLAUDE.md`，会误杀 <user_rules>。
// skill 描述是 CC 自己的元数据、不含用户正文，这里收紧无副作用。
const ccTell = /CLAUDE\.md|\.claude\b/i;
return skills.filter(
  (s) =>
    scanLeaks(`${s.name}\n${s.description}`).length === 0 &&
    !ccTell.test(`${s.name}\n${s.description}`),
);
}

/**
* 从 CC /v1/messages body 抽出可穿越边界的值。
* 正则逐字符照抄 docs/leakcheck.prototype.mjs（四个已实测的坑）。
*/
export function extractEnv(body: AnthropicMessagesRequest): ExtractedEnv {
const sysText = systemToText(body.system);
const pick = (r: RegExp): string => (sysText.match(r) || [, ''])[1] as string;

// 原型 L17-21：5 正则（Additional working directories 锚定 2 空格字面量）
const cwd = pick(/^ - Primary working directory:\s*(\S+)$/m);
const platform = pick(/^ - Platform:\s*(\S+)$/m);
const git = pick(/^ - Is a git repository:\s*(\S+)$/m);
let addl = (
  sysText.match(/^ - Additional working directories:\n((?:  - .+\n)+)/m)?.[1] ||
  ''
)
  .split('\n')
  .map((s) => s.replace(/^\s*-\s*/, '').trim())
  .filter(Boolean);

// 原型 L23-28：claudeMd，前瞻只匹配已知节名白名单
const firstUser = (body.messages || []).find((m) => m.role === 'user');
const content = firstUser?.content;
const reminders = (
  Array.isArray(content) ? content : []
)
  .map((b) => (typeof b === 'object' && b ? b.text || '' : ''))
  .join('\n');
const KNOWN =
  'currentDate|userEmail|attachedProject|gitStatus|directoryStructure';
const claudeMd = (
  reminders.match(
    new RegExp(
      `# claudeMd\\n([\\s\\S]*?)(?=\\n# (?:${KNOWN})\\n|\\n\\s+IMPORTANT: this context)`,
    ),
  ) || [, '']
)[1]!.trim();

// 原型 L30-33：realpath 去重 cwd 与 additionalDirs
const real = (p: string): string => {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
};
const seen = new Set<string>([real(cwd)]);
addl = addl.filter((p) => {
  const r = real(p);
  if (seen.has(r)) return false;
  seen.add(r);
  return true;
});

// 原型 L50-54：剥 CC 两行包装头；ExtractedEnv.userRules 已是正文
// 顺序不能反：parseRules 要靠 `Contents of <path> (label):` 抽路径当 tag，
// 先 replace 掉头就没了。userRules 保留是为了兼容旧断言与 short 模式。
const stripped = claudeMd.replace(
  /^Codebase and user instructions are shown below[^\n]*\n+/,
  '',
);
const rules = parseRules(stripped);
const userRules = stripped.replace(/^Contents of [^\n]*:\n+/gm, '').trim();

// skill_listing 每进程只发一次：有则写缓存，无则按 cwd 回填
let skills = parseSkills(body);
if (skills.length > 0) {
  if (cwd) skillsCacheByCwd.set(cwd, skills);
} else if (cwd && skillsCacheByCwd.has(cwd)) {
  skills = skillsCacheByCwd.get(cwd)!;
}

return {
  cwd,
  platform,
  isGitRepo: git === 'true',
  additionalDirs: addl,
  userRules,
  rules,
  skills,
};
}

/** 测试用：清 cwd→skills 缓存 */
export function clearSkillsCache(): void {
skillsCacheByCwd.clear();
}

// ---------- 解剖日志（DUMP_SYSTEM 非空时开） ----------

const bytes = (s: string): number => Buffer.byteLength(s, 'utf8');
const head = (s: string, n = 72): string =>
s.replace(/\s+/g, ' ').trim().slice(0, n);

/**
* 打印「CC 入站 system 由哪些部分组成」+「出站 systemInstruction 由哪些部分组成」。
* DUMP_SYSTEM=1 打 stdout；DUMP_SYSTEM=<path> 另存整份原文（含 CC 关键词，
* 只落本地磁盘，不进上游）。默认关闭，零开销。
*/
export function dumpSystemAnatomy(
body: AnthropicMessagesRequest,
env: ExtractedEnv,
systemInstruction: string,
): void {
const dest = process.env.DUMP_SYSTEM;
if (!dest) return;

const L: string[] = [];
L.push('════ CC 入站 ════');

const sys = body.system;
const sysArr = typeof sys === 'string' ? [{ type: 'text', text: sys }] : sys || [];
sysArr.forEach((b, i) => {
  const t = b.text || '';
  L.push(`system[${i}] ${bytes(t)}B  ${head(t)}`);
  // system[2] 是正文，列出它的 markdown 一级标题
  for (const m of t.matchAll(/^# (.+)$/gm)) L.push(`         └ # ${m[1]}`);
});

const msgs = body.messages || [];
msgs.forEach((m, i) => {
  const c = m.content;
  if (typeof c === 'string') return;
  (Array.isArray(c) ? c : []).forEach((b) => {
    const t = b.text || '';
    for (const r of t.matchAll(/<system-reminder>([\s\S]*?)<\/system-reminder>/g)) {
      const inner = r[1] || '';
      const secs = [...inner.matchAll(/^# (\w+)$/gm)].map((x) => x[1]).join(',');
      L.push(
        `messages[${i}].system-reminder ${bytes(inner)}B  ${secs ? `节:[${secs}]  ` : ''}${head(inner, 60)}`,
      );
    }
  });
  if ((m as { role: string }).role === 'system') {
    L.push(`messages[${i}] role=system ${bytes(JSON.stringify(c))}B  （丢弃：上游 contents 只认 user/model）`);
  }
});

const tools = (body.tools || []) as Array<{ name?: string }>;
L.push(
  `tools[] ${tools.length} 个 ${bytes(JSON.stringify(body.tools || []))}B  （全丢，换 14 原生）  ${tools.map((t) => t.name).join(' ')}`,
);

L.push('════ 抽出的 5 值（唯一穿越边界的） ════');
L.push(`cwd=${env.cwd}`);
L.push(`platform=${env.platform}  isGitRepo=${env.isGitRepo}`);
L.push(`additionalDirs=[${env.additionalDirs.join(', ')}]`);
for (const r of env.rules) L.push(`RULE[${r.tag}] ${bytes(r.body)}B  ${head(r.body)}`);
L.push(
  `skills ${env.skills.length} 个（${env.skills.filter((s) => s.skillMdPath).length} 个有 SKILL.md 路径）  ${env.skills.map((s) => s.name).join(' ')}`,
);

L.push(`════ 出站 systemInstruction (mode=${process.env.ANTIGRAVITY_SYSTEM || 'trimmed'}) ${bytes(systemInstruction)}B ════`);
for (const m of systemInstruction.matchAll(/^<(\w+)>$/gm)) {
  const name = m[1]!;
  // user_information 在 sections.json 里有条目，但出站这段是按 5 值重建的，
  // 不能因为查得到就标成「capture 原样」。
  const s =
    name === 'user_information' || name === 'user_rules' || name === 'skills'
      ? null
      : loadSections().get(name);
  L.push(`  <${name}>${s ? ` (capture 原样 ${s.chars} 字符)` : ' (重建)'}`);
}

console.log(L.join('\n'));
if (dest !== '1') {
  fs.writeFileSync(
    dest,
    JSON.stringify({ inbound: body, extracted: env, outbound: systemInstruction }, null, 2),
    { mode: 0o600 },
  );
  console.log(`[dump] 全文 → ${dest}`);
}
}

// ---------- buildUserInformation / buildSystemInstruction ----------

/** basename(dirname)/basename —— 上游只当标签 */
function corpusName(p: string): string {
return path.basename(path.dirname(p)) + '/' + path.basename(p);
}

/** 照抄原型 L37-43；platform: darwin→mac / win32→windows / linux→linux */
export function buildUserInformation(env: ExtractedEnv): string {
const osName =
  ({ darwin: 'mac', win32: 'windows', linux: 'linux' } as Record<
    string,
    string
  >)[env.platform] || env.platform;
// 用户把 ~/.claude 加成工作目录时（本机实测），路径进这个列表会撞上
// LEAK_BLACKLIST 的 '/.claude' → 整个请求 500 中止。它是真实目录不是泄漏，
// 但 .claude 路径进上游确实是 CC 特征，所以在这里丢掉而不是放宽黑名单。
// cwd 也过滤；全被滤光则退回 home，不能把 .claude 路径漏出去。
const isCc = (p: string): boolean => /(^|\/)\.claude(\/|$)/.test(p);
const paths = [env.cwd, ...env.additionalDirs].filter((p) => !isCc(p));
if (paths.length === 0) paths.push(os.homedir());
return `<user_information>
The USER's OS version is ${osName}.
The user has ${paths.length} active workspaces, each defined by a URI and a CorpusName. Multiple URIs potentially map to the same CorpusName. The mapping is shown as follows in the format [URI] -> [CorpusName]:
${paths.map((p) => `${p} -> ${corpusName(p)}`).join('\n')}
Code relating to the user's requests should be written in the locations listed above.
The primary workspace is${env.isGitRepo ? '' : ' not'} a git repository.
</user_information>`;
}

/**
* <user_rules> —— 前言逐字来自 surge-conversation.json 的真实 system（offset 8759,401）。
* capture 夹具抓的时候用户还没配规则，没有这一段，只能内联。
*/
const USER_RULES_PREAMBLE =
'The following are user-defined rules that you MUST ALWAYS FOLLOW WITHOUT ANY EXCEPTION. These rules take precedence over any following instructions.\n' +
'Review them carefully and always take them into account when you generate responses and code:';

function buildUserRules(rules: ExtractedRule[]): string {
if (rules.length === 0) return '';
const blocks = rules
  .map((r) => `<RULE[${r.tag}]>\n${r.body}\n</RULE[${r.tag}]>`)
  .join('\n');
return `<user_rules>\n${USER_RULES_PREAMBLE}\n${blocks}\n</user_rules>`;
}

/**
* <skills> —— 前言取 capture 原样，只换 Available skills 列表。
* 每条都带伪路径括号，模型用 view_file 打开；桥接层改路由到 Skill。
*/
function buildSkills(skills: ExtractedSkill[]): string {
if (skills.length === 0) return '';
const raw = section('skills');
const head = raw.slice(0, raw.indexOf('Available skills:'));
const lines = skills
  .map((s) => `- ${s.name} (${s.skillMdPath || skillPseudoPath(s.name)}): ${s.description}`)
  .join('\n');
return `${head}Available skills:\n${lines}\n</skills>`;
}

/**
* 组装上游 systemInstruction 文本。
* - trimmed（默认）：identity + user_information + ephemeral + user_rules + skills + guidelines + communication_style
*   communication_style 不再删行；过滤词（默认 ∪ 文件 ∪ env）命中处换等长 U+200B
* - full：capture 原文，但 user_information 段仍替换为重建版；只遮文件/env 额外词
* - short：identity + user_information；只遮文件/env 额外词
*
* user_rules/skills 的**位置**照抓包：ephemeral(5559) < customizations(5872) <
* user_rules(8759) < skills(9161) < … < guidelines(29286) < communication_style(34871)。
* 原实现把 user_rules 缀在最末，与 IDE 不符。
*/
export function buildSystemInstruction(
env: ExtractedEnv,
mode: 'full' | 'trimmed' | 'short' = 'trimmed',
trimWords?: readonly string[],
): string {
const userInfo = buildUserInformation(env);
// rules 为空但 userRules 非空 = 旧形态 body（无 Contents of 头），退回单块
const userRules =
  buildUserRules(env.rules ?? []) ||
  (env.userRules ? `<user_rules>\n${env.userRules}\n</user_rules>` : '');
const skills = buildSkills(env.skills ?? []);

let out: string;
if (mode === 'short') {
  out = [section('identity'), userInfo].filter(Boolean).join('\n');
} else if (mode === 'full') {
  // 保留全文，只替换 user_information 段（offset/chars 来自 sections.json）
  const capture = loadCapture();
  const ui = loadSections().get('user_information')!;
  out =
    capture.slice(0, ui.offset) + userInfo + capture.slice(ui.offset + ui.chars);
} else {
  out = [
    section('identity'),
    userInfo,
    section('ephemeral_message'),
    userRules,
    skills,
    section('guidelines'),
    section('communication_style'),
  ]
    .filter(Boolean)
    .join('\n');
}

const words =
  trimWords ?? resolveTrimWords({ includeDefaults: mode === 'trimmed' });
return maskTrimWords(out, words);
}
