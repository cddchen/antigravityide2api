// ═══════════════════════════════════════════════
//  systemInstruction 过滤词：命中后换零宽，不删整段
//  词表 = 内置默认 ∪ trim-words.json ∪ ANTIGRAVITY_TRIM_WORDS
// ═══════════════════════════════════════════════

import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { getConfigDir, getDefaultTokenPath } from './token-paths';

export const TRIM_WORDS_FILE_NAME = 'trim-words.json';
export const ZWSP = '\u200B';

/**
 * 旧 trimmed 会按这些短语删掉整行（communication_style 的 file:// 与后台任务规则）。
 * 现在只遮词：等长 U+200B，行还在。
 */
export const DEFAULT_TRIM_WORDS: readonly string[] = [
  'file://',
  'clickable links',
  'background task such as',
  'task-20',
  'DO NOTHING ELSE',
  'A)',
  'B)',
];

export function getTrimWordsPath(tokenPath = getDefaultTokenPath()): string {
  return path.join(getConfigDir(tokenPath), TRIM_WORDS_FILE_NAME);
}

function normalizeWords(xs: unknown[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const x of xs) {
    if (typeof x !== 'string') continue;
    const w = x.trim();
    if (!w || seen.has(w)) continue;
    seen.add(w);
    out.push(w);
  }
  return out;
}

function mergeWords(...groups: Array<readonly string[]>): string[] {
  return normalizeWords(groups.flat());
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 逗号分隔，或 JSON 字符串数组。空 / 未设 → []。 */
export function parseTrimWordsSpec(raw: string | undefined | null): string[] {
  if (raw == null) return [];
  const s = raw.trim();
  if (!s) return [];
  if (s.startsWith('[')) {
    const parsed: unknown = JSON.parse(s);
    if (!Array.isArray(parsed)) {
      throw new Error('ANTIGRAVITY_TRIM_WORDS 须是字符串数组');
    }
    return normalizeWords(parsed);
  }
  return normalizeWords(s.split(','));
}

export function loadTrimWordsFile(
  filePath = getTrimWordsPath(),
  opts?: { strict?: boolean },
): string[] {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      throw new Error('trim-words.json 须是 JSON 字符串数组');
    }
    return normalizeWords(parsed);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    if (opts?.strict) throw e;
    console.error(`[trim-words] 读取 ${filePath} 失败: ${(e as Error).message}`);
    return [];
  }
}

export function saveTrimWordsFile(
  words: readonly string[],
  filePath = getTrimWordsPath(),
): string[] {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const list = normalizeWords([...words]);
  fs.writeFileSync(filePath, `${JSON.stringify(list, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  return list;
}

export function addTrimWords(
  words: readonly string[],
  filePath = getTrimWordsPath(),
): string[] {
  return saveTrimWordsFile(
    mergeWords(loadTrimWordsFile(filePath, { strict: true }), words),
    filePath,
  );
}

export function removeTrimWords(
  words: readonly string[],
  filePath = getTrimWordsPath(),
): string[] {
  const drop = new Set(normalizeWords([...words]));
  return saveTrimWordsFile(
    loadTrimWordsFile(filePath, { strict: true }).filter((w) => !drop.has(w)),
    filePath,
  );
}

export function clearTrimWords(filePath = getTrimWordsPath()): string[] {
  return saveTrimWordsFile([], filePath);
}

/**
 * 生效词表。`includeDefaults` 默认 true（CLI list / trimmed 组装）。
 * full/short 只吃文件 + env，避免把 IDE 原文里的 file:// 一并遮掉。
 */
export function resolveTrimWords(opts?: {
  env?: NodeJS.ProcessEnv;
  filePath?: string;
  includeDefaults?: boolean;
}): string[] {
  const env = opts?.env ?? process.env;
  const filePath = opts?.filePath ?? getTrimWordsPath();
  const fromFile = loadTrimWordsFile(filePath);
  let fromEnv: string[] = [];
  try {
    fromEnv = parseTrimWordsSpec(env.ANTIGRAVITY_TRIM_WORDS);
  } catch (e) {
    console.error(
      `[trim-words] ANTIGRAVITY_TRIM_WORDS 无效: ${(e as Error).message}`,
    );
  }
  const includeDefaults = opts?.includeDefaults !== false;
  return includeDefaults
    ? mergeWords(DEFAULT_TRIM_WORDS, fromFile, fromEnv)
    : mergeWords(fromFile, fromEnv);
}

/**
 * 每个命中换成等长 U+200B。不区分大小写；较长词优先，
 * 避免 `claude` 先吃掉 `claude code`。
 */
export function maskTrimWords(
  text: string,
  words: readonly string[],
): string {
  const list = mergeWords(words).sort((a, b) => b.length - a.length);
  if (list.length === 0) return text;
  const re = new RegExp(list.map(escapeRegExp).join('|'), 'giu');
  return text.replace(re, (m) => ZWSP.repeat(m.length));
}

if (require.main === module) {
  const zw = (s: string): string => ZWSP.repeat(s.length);

  assert.equal(
    maskTrimWords('see file://x and file://y', ['file://']),
    `see ${zw('file://')}x and ${zw('file://')}y`,
  );
  // 不删整行
  const line = '- You MUST create clickable links for files.';
  const masked = maskTrimWords(line, DEFAULT_TRIM_WORDS);
  assert.equal(masked.includes('clickable links'), false);
  assert.ok(masked.startsWith('- You MUST create '));
  assert.ok(masked.endsWith(' for files.'));
  assert.ok(masked.includes(zw('clickable links')));

  // 长词优先：abc 而不是先吃 ab
  assert.equal(maskTrimWords('xabc', ['ab', 'abc']), `x${zw('abc')}`);

  // 不区分大小写；长词仍优先
  assert.equal(
    maskTrimWords('Claude Code and CLAUDE', ['claude']),
    `${zw('Claude')} Code and ${zw('CLAUDE')}`,
  );
  assert.equal(
    maskTrimWords('Claude Code', ['claude', 'claude code']),
    zw('Claude Code'),
  );

  assert.deepEqual(parseTrimWordsSpec('a, b ,c'), ['a', 'b', 'c']);
  assert.deepEqual(parseTrimWordsSpec('["x","y"]'), ['x', 'y']);
  assert.deepEqual(parseTrimWordsSpec(''), []);
  assert.deepEqual(parseTrimWordsSpec(undefined), []);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-trim-'));
  try {
    const fp = path.join(dir, TRIM_WORDS_FILE_NAME);
    assert.deepEqual(loadTrimWordsFile(fp), []);
    assert.deepEqual(addTrimWords(['hello', 'hello', ' world '], fp), [
      'hello',
      'world',
    ]);
    assert.deepEqual(loadTrimWordsFile(fp), ['hello', 'world']);
    assert.deepEqual(removeTrimWords(['hello'], fp), ['world']);
    const merged = resolveTrimWords({
      env: { ANTIGRAVITY_TRIM_WORDS: 'env-word,world' },
      filePath: fp,
    });
    assert.ok(merged.includes('file://'));
    assert.ok(merged.includes('world'));
    assert.ok(merged.includes('env-word'));
    assert.deepEqual(
      resolveTrimWords({
        env: { ANTIGRAVITY_TRIM_WORDS: 'only-env' },
        filePath: fp,
        includeDefaults: false,
      }),
      ['world', 'only-env'],
    );
    clearTrimWords(fp);
    assert.deepEqual(loadTrimWordsFile(fp), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  console.log('trim-words self-test ok');
}
