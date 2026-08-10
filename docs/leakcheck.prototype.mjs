import fs from 'node:fs';
import path from 'node:path';

// 夹具随本文件同目录入库，不依赖 /tmp
const here = path.dirname(new URL(import.meta.url).pathname);
const cc = JSON.parse(fs.readFileSync(path.join(here, 'cc-request.capture.json'),'utf8')).body;
const ag = fs.readFileSync(path.join(here, 'ag-system.capture.txt'),'utf8');

// --- 分段 AG harness
const seg = {};
const re = /<([a-z_]+)>\n([\s\S]*?)\n<\/\1>/g;
for (let m; (m = re.exec(ag)); ) seg[m[1]] = m[0];

// --- 抽 5 值
const sysText = cc.system.map(s => s.text).join('\n');
const pick = r => (sysText.match(r) || [,''])[1];
const cwd  = pick(/^ - Primary working directory:\s*(\S+)$/m);
const plat = pick(/^ - Platform:\s*(\S+)$/m);
const git  = pick(/^ - Is a git repository:\s*(\S+)$/m);
let addl = (sysText.match(/^ - Additional working directories:\n((?:  - .+\n)+)/m)?.[1] || '')
  .split('\n').map(s => s.replace(/^\s*-\s*/,'').trim()).filter(Boolean);

const firstUser = cc.messages.find(m => m.role === 'user');
const reminders = (Array.isArray(firstUser.content) ? firstUser.content : [])
  .map(b => b.text || '').join('\n');
// 只在「顶格 # + 已知节名」处切断，避免被 CLAUDE.md 正文自身的 # 标题截断
const KNOWN = 'currentDate|userEmail|attachedProject|gitStatus|directoryStructure';
const claudeMd = (reminders.match(new RegExp(`# claudeMd\\n([\\s\\S]*?)(?=\\n# (?:${KNOWN})\\n|\\n\\s+IMPORTANT: this context)`)) || [,''])[1].trim();

// /private/tmp 与 /tmp 是同一目录，按 realpath 去重
const real = p => { try { return fs.realpathSync(p); } catch { return p; } };
const seen = new Set([real(cwd)]);
addl = addl.filter(p => { const r = real(p); if (seen.has(r)) return false; seen.add(r); return true; });
const corpus = p => path.basename(path.dirname(p)) + '/' + path.basename(p);
const osName = {darwin:'mac', win32:'windows', linux:'linux'}[plat] || plat;

const userInfo = `<user_information>
The USER's OS version is ${osName}.
The user has ${1 + addl.length} active workspaces, each defined by a URI and a CorpusName. Multiple URIs potentially map to the same CorpusName. The mapping is shown as follows in the format [URI] -> [CorpusName]:
${[cwd, ...addl].map(p => `${p} -> ${corpus(p)}`).join('\n')}
Code relating to the user's requests should be written in the locations listed above.
The primary workspace is${git === 'true' ? '' : ' not'} a git repository.
</user_information>`;

const commStyle = seg.communication_style
  .split('\n')
  .filter(l => !/file:\/\/|clickable links|background task such as|task-20|DO NOTHING ELSE|^A\) |^B\) /.test(l))
  .join('\n');

// 剥掉 CC 自己的包装头（"Codebase and user instructions…" + "Contents of <path> (…):"），只留用户正文
const rulesBody = claudeMd
  .replace(/^Codebase and user instructions are shown below[^\n]*\n+/, '')
  .replace(/^Contents of [^\n]*:\n+/gm, '')
  .trim();
const userRules = rulesBody ? `<user_rules>\n${rulesBody}\n</user_rules>` : '';

const out = [seg.identity, userInfo, seg.ephemeral_message, seg.guidelines, commStyle, userRules]
  .filter(Boolean).join('\n');
if (process.env.LEAKCHECK_OUT) fs.writeFileSync(process.env.LEAKCHECK_OUT, out);

// --- 黑名单
const BLACK = [
  'Claude Code','Anthropic',"Claude Agent SDK",'claude-cli','cc_version','cc_entrypoint',
  '# Harness','# Session-specific guidance','# Memory','# Environment','# Context management',
  '<system-reminder','claudeMd','cache_control','anthropic-beta','anthropic-version',
  '.claude/projects','/.claude','x-anthropic-billing-header',
  'CronCreate','CronDelete','CronList','DesignSync','EnterWorktree','ExitWorktree',
  'NotebookEdit','ReportFindings','ScheduleWakeup','SendMessage','TaskCreate','TaskGet',
  'TaskList','TaskOutput','TaskStop','TaskUpdate','WebFetch','WebSearch','subagent_type',
  'Github-flavored markdown','permission mode','tool_use','opus','haiku','sonnet',
];
const hits = [];
for (const w of BLACK) {
  let i = -1;
  while ((i = out.indexOf(w, i + 1)) !== -1) hits.push({w, i, ctx: out.slice(Math.max(0,i-60), i+w.length+60).replace(/\n/g,'\\n')});
}

console.log('=== converted system chars:', out.length, '(CC system was', sysText.length, ')');
console.log('=== extracted:', JSON.stringify({cwd, plat, git, addl, claudeMdLen: claudeMd.length}));
console.log('=== blacklist hits:', hits.length);
for (const h of hits) console.log(`  [${h.w}] @${h.i}\n      …${h.ctx}…`);
process.exit(hits.length ? 1 : 0);
