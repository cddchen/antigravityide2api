// ═══════════════════════════════════════════════
//  运行期配置（全部可 env 覆盖）
// ═══════════════════════════════════════════════

import os from 'os';
import { extractIdeVersion } from './extract-token';

/**
 * HTTP UA / loadCodeAssist.metadata.ideVersion。
 * 默认每次启动从本机 product.json 读；IDE_VERSION 覆盖。
 * 读不到且无 env 时回退 2.1.1，避免无 IDE 的单测/CI 直接崩。
 */
function resolveIdeVersion(): string {
  const fromEnv = process.env.IDE_VERSION?.trim();
  if (fromEnv) return fromEnv;
  try {
    return extractIdeVersion();
  } catch {
    return '2.1.1';
  }
}

const IDE_VERSION = resolveIdeVersion();

/** UA: antigravity/ide/{ideVersion} darwin/arm64。版本必须跟 product.json，格式新旧都能 200。 */
function buildUserAgent(): string {
  return `antigravity/ide/${IDE_VERSION} ${process.platform}/${process.arch}`;
}

/** loadCodeAssist 的 platform 枚举：DARWIN_ARM64 / LINUX_X64 / WINDOWS_X64 */
function buildPlatformEnum(): string {
  const osPart = { darwin: 'DARWIN', win32: 'WINDOWS', linux: 'LINUX' }[process.platform as string] || 'LINUX';
  const archPart = process.arch === 'arm64' ? 'ARM64' : 'X64';
  return `${osPart}_${archPart}`;
}

const config = {
  antigravity: {
    baseUrl: process.env.ANTIGRAVITY_BASE || 'https://daily-cloudcode-pa.googleapis.com',
    ideVersion: IDE_VERSION,
    userAgent: buildUserAgent(),
    platformEnum: buildPlatformEnum(),
    defaultModel: process.env.DEFAULT_MODEL || 'gemini-3.6-flash-high',
    requestTimeout: parseInt(process.env.REQUEST_TIMEOUT || '300000', 10),
    pendingTimeout: parseInt(process.env.PENDING_TIMEOUT || '600000', 10),
    maxOutputTokens: 65536,
  },
  /** Write/Edit 落盘边界；空 = 用 CC 抽出的 cwd */
  workspaceRoot: process.env.WORKSPACE_ROOT || '',
  /** full | trimmed | short —— 见 wire-reference §1.5。trimmed 过滤词见 ANTIGRAVITY_TRIM_WORDS / trim-words.json */
  systemMode: (process.env.ANTIGRAVITY_SYSTEM || 'trimmed') as 'full' | 'trimmed' | 'short',
  server: {
    port: parseInt(process.env.PORT || '3000', 10),
    host: process.env.HOST || '127.0.0.1',
    apiKey: process.env.API_KEY || '',
  },
  homedir: os.homedir(),
};

export default config;
