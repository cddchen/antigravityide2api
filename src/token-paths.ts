import fs from 'fs';
import os from 'os';
import path from 'path';

export const CONFIG_DIR_NAME = '.antigravityide2api';
export const TOKEN_FILE_NAME = 'token.json';

/** TOKEN_FILE 环境变量 > ~/.antigravityide2api/token.json */
export function getDefaultTokenPath(): string {
  if (process.env.TOKEN_FILE?.trim()) {
    return path.resolve(process.env.TOKEN_FILE.trim());
  }
  return path.join(os.homedir(), CONFIG_DIR_NAME, TOKEN_FILE_NAME);
}

export function getConfigDir(tokenPath = getDefaultTokenPath()): string {
  return path.dirname(tokenPath);
}

export function ensureConfigDir(tokenPath = getDefaultTokenPath()): void {
  fs.mkdirSync(path.dirname(tokenPath), { recursive: true, mode: 0o700 });
}

export function tokenFileExists(tokenPath = getDefaultTokenPath()): boolean {
  try {
    return fs.existsSync(tokenPath) && fs.statSync(tokenPath).isFile();
  } catch {
    return false;
  }
}

/** 日志脱敏：ya29.abcd…wxyz */
export function maskToken(t: string | undefined): string {
  if (!t) return '<none>';
  return t.length <= 14 ? '<redacted>' : `${t.slice(0, 8)}…${t.slice(-4)}`;
}
