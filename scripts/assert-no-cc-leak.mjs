// T7 —— 风控闸门（独立可跑）
// 产品化 docs/leakcheck.prototype.mjs：扫完整 envelope（systemInstruction + contents + tools）
// - 文本黑名单：44 词中的独有词（短词 Read/Write 等不在 44 里，不扫）
// - 结构断言：tools.length===14 且 name 集合 === 原生 14 白名单
// 入参：stdin JSON 或 --fixture
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const sp = await import(path.join(root, 'dist/system-prompt.js'));
const { LEAK_BLACKLIST } = sp;
const native = await import(path.join(root, 'dist/native-tools.js'));
const { NATIVE_TOOL_NAMES, getNativeTools } = native;
const client = await import(path.join(root, 'dist/antigravity-client.js'));
const { buildEnvelope, newSessionId } = client;

function collectText(envelope) {
  const chunks = [];
  const walk = (v) => {
    if (v == null) return;
    if (typeof v === 'string') {
      chunks.push(v);
      return;
    }
    if (Array.isArray(v)) {
      for (const x of v) walk(x);
      return;
    }
    if (typeof v === 'object') {
      for (const k of Object.keys(v)) walk(v[k]);
    }
  };
  // 完整 envelope：systemInstruction + contents + tools（及顶层其它）
  walk(envelope);
  return chunks.join('\n');
}

function scanText(text) {
  const hits = [];
  for (const w of LEAK_BLACKLIST) {
    let i = -1;
    while ((i = text.indexOf(w, i + 1)) !== -1) {
      hits.push({
        word: w,
        index: i,
        context: text
          .slice(Math.max(0, i - 60), i + w.length + 60)
          .replace(/\n/g, '\\n'),
      });
    }
  }
  return hits;
}

function assertToolsStructure(envelope) {
  const tools = envelope?.request?.tools ?? envelope?.tools;
  if (!Array.isArray(tools)) {
    return [{ kind: 'structure', msg: 'envelope 缺少 tools 数组' }];
  }
  const errs = [];
  if (tools.length !== 14) {
    errs.push({ kind: 'structure', msg: `tools.length===${tools.length}，期望 14` });
  }
  const names = tools.map((t) => t?.functionDeclarations?.[0]?.name).filter(Boolean);
  const got = new Set(names);
  const want = new Set(NATIVE_TOOL_NAMES);
  for (const n of got) {
    if (!want.has(n)) errs.push({ kind: 'structure', msg: `非原生 tool name: ${n}` });
  }
  for (const n of want) {
    if (!got.has(n)) errs.push({ kind: 'structure', msg: `缺失原生 tool: ${n}` });
  }
  return errs;
}

function check(envelope) {
  const textHits = scanText(collectText(envelope));
  const structHits = assertToolsStructure(envelope);
  return { textHits, structHits };
}

function printAndExit(result) {
  const { textHits, structHits } = result;
  if (textHits.length === 0 && structHits.length === 0) {
    console.log('PASS assert-no-cc-leak: 0 hits');
    process.exit(0);
  }
  for (const h of textHits) {
    console.error(`LEAK [${h.word}] @${h.index}\n  …${h.context}…`);
  }
  for (const h of structHits) {
    console.error(`STRUCT ${h.msg}`);
  }
  console.error(
    `FAIL assert-no-cc-leak: text=${textHits.length} structure=${structHits.length}`,
  );
  process.exit(1);
}

// --- CLI ---
const args = process.argv.slice(2);
if (args.includes('--fixture') || args.includes('-f')) {
  // 用夹具自证：构造一份合规 envelope（原生 14 + 干净 system）
  const env = buildEnvelope({
    projectId: 'proj',
    model: 'gemini-3.6-flash-high',
    contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
    systemInstruction: 'You are Antigravity.',
    tools: getNativeTools(),
    sessionId: newSessionId(),
    cascadeUuid: 'c',
    trajectoryUuid: 't',
    stepIndex: 1,
  });
  printAndExit(check(env));
} else if (args.includes('--help') || args.includes('-h')) {
  console.log(`用法:
  node scripts/assert-no-cc-leak.mjs --fixture   # 用合规 envelope 自证
  cat envelope.json | node scripts/assert-no-cc-leak.mjs
  node scripts/assert-no-cc-leak.mjs < envelope.json`);
  process.exit(0);
} else {
  // stdin
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) {
    console.error('stdin 为空；请 pipe envelope JSON 或使用 --fixture');
    process.exit(2);
  }
  let envelope;
  try {
    envelope = JSON.parse(raw);
  } catch (e) {
    console.error('stdin 不是合法 JSON:', e.message);
    process.exit(2);
  }
  printAndExit(check(envelope));
}
