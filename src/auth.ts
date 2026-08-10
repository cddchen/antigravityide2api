import fs from 'fs';
import config from './config';
import type { TokenEntry, TokenFile } from './types';
import { ensureConfigDir, getDefaultTokenPath } from './token-paths';
import { postStream, decodeBody } from './antigravity-client';

/**
 * IDE 同源 OAuth client（docs/Antigravity-IDE-API.md §4.1 ClientID；
 * secret 与 CLIProxy/IDE 同源，活体 refresh 已验证，见 implementation-notes）。
 * 可用 ANTIGRAVITY_CLIENT_ID / ANTIGRAVITY_CLIENT_SECRET 覆盖。
 */
const DEFAULT_CLIENT_ID =
  '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com';
const DEFAULT_CLIENT_SECRET = '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';

function clientId(): string {
  return process.env.ANTIGRAVITY_CLIENT_ID?.trim() || DEFAULT_CLIENT_ID;
}

function clientSecret(): string {
  return process.env.ANTIGRAVITY_CLIENT_SECRET?.trim() || DEFAULT_CLIENT_SECRET;
}

/** 读 token.json；无文件 / 非法结构抛错 */
export function loadTokenFile(tokenPath = getDefaultTokenPath()): TokenFile {
  if (!fs.existsSync(tokenPath)) {
    throw new Error(`token 文件不存在: ${tokenPath}\n请先运行 extract-token`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(tokenPath, 'utf8'));
  } catch (e) {
    throw new Error(`token 文件 JSON 解析失败: ${tokenPath}: ${(e as Error).message}`);
  }
  if (!raw || typeof raw !== 'object') {
    throw new Error(`token 文件格式错误（期望对象）: ${tokenPath}`);
  }
  const tokens = (raw as { tokens?: unknown }).tokens;
  if (!Array.isArray(tokens) || tokens.length === 0) {
    throw new Error(`token 文件无有效 tokens[]: ${tokenPath}`);
  }
  // 容错：只要求 access/refresh 字符串
  const cleaned: TokenEntry[] = [];
  for (const t of tokens) {
    if (!t || typeof t !== 'object') continue;
    const o = t as Record<string, unknown>;
    if (typeof o.accessToken !== 'string' || typeof o.refreshToken !== 'string') continue;
    cleaned.push({
      name: typeof o.name === 'string' ? o.name : 'account-1',
      accessToken: o.accessToken,
      refreshToken: o.refreshToken,
      projectId: typeof o.projectId === 'string' ? o.projectId : undefined,
      expiresAt: typeof o.expiresAt === 'number' ? o.expiresAt : undefined,
      machineId: typeof o.machineId === 'string' ? o.machineId : undefined,
    });
  }
  if (cleaned.length === 0) {
    throw new Error(`token 文件 tokens[] 无可用条目: ${tokenPath}`);
  }
  return { tokens: cleaned };
}

/** 写 token 文件，强制 0600 */
export function saveTokenFile(tf: TokenFile, tokenPath = getDefaultTokenPath()): void {
  ensureConfigDir(tokenPath);
  fs.writeFileSync(tokenPath, `${JSON.stringify(tf, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.chmodSync(tokenPath, 0o600);
}

/** Google OAuth refresh；返回新对象，不写 IDE vscdb */
export async function refreshAccessToken(entry: TokenEntry): Promise<TokenEntry> {
  const body = new URLSearchParams({
    client_id: clientId(),
    client_secret: clientSecret(),
    refresh_token: entry.refreshToken,
    grant_type: 'refresh_token',
  });

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  const text = await res.text();
  let data: { access_token?: string; expires_in?: number; error?: string; error_description?: string };
  try {
    data = JSON.parse(text) as typeof data;
  } catch {
    throw new Error(`OAuth refresh 响应非 JSON (HTTP ${res.status}): ${text.slice(0, 200)}`);
  }

  if (!res.ok || !data.access_token) {
    throw new Error(
      `OAuth refresh 失败 (HTTP ${res.status}): ${data.error || ''} ${data.error_description || text.slice(0, 200)}`,
    );
  }

  const expiresIn = typeof data.expires_in === 'number' ? data.expires_in : 3600;
  return {
    ...entry,
    accessToken: data.access_token,
    // 提前 60s 过期，避免边界 401
    expiresAt: Date.now() + expiresIn * 1000 - 60_000,
  };
}

function pickProjectId(obj: unknown): string | undefined {
  if (obj == null) return undefined;
  if (typeof obj === 'string' && obj) return obj;
  if (typeof obj === 'object' && obj !== null) {
    const id = (obj as { id?: unknown }).id;
    if (typeof id === 'string' && id) return id;
  }
  return undefined;
}

/**
 * 有 projectId 直接返回；否则 loadCodeAssist 多路径解析。
 * 取不到时错误消息只含响应键名，不含值。
 */
export async function ensureProjectId(entry: TokenEntry): Promise<string> {
  if (entry.projectId) return entry.projectId;

  const url = `${config.antigravity.baseUrl}/v1internal:loadCodeAssist`;
  const payload = JSON.stringify({
    metadata: {
      ideType: 'ANTIGRAVITY',
      ideVersion: config.antigravity.ideVersion,
      platform: config.antigravity.platformEnum,
    },
  });
  // 与 streamGenerateContent 同栈：fetch(undici) 会注入 accept/accept-language/
  // sec-fetch-mode 三个浏览器头，上游是 Go 客户端不可能发。chunked=false —— 抓包里
  // 非流式 cloudcode-pa 端点（recordCodeAssistMetrics 13x / listExperiments 4x）
  // 一律 Content-Length。
  const res = await postStream(url, entry.accessToken, payload, undefined, false);

  const text = await new Promise<string>((resolve) => {
    let s = '';
    const body = decodeBody(res);
    body.on('data', (c: Buffer) => (s += c.toString('utf8')));
    body.on('end', () => resolve(s));
    body.on('error', () => resolve(s));
  });
  const status = res.statusCode ?? 0;
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error(`loadCodeAssist 响应非 JSON (HTTP ${status}): ${text.slice(0, 200)}`);
  }

  if (status < 200 || status >= 300) {
    const keys = Object.keys(json).join(',');
    // 必须挂 .status —— withAuthRetry 按 `err.status === 401` 判是否 refresh，
    // 裸 Error 会让 accessToken 过期时永远刷不动（实测 401 直接返回给客户端）。
    const err = Object.assign(
      new Error(`loadCodeAssist 失败 (HTTP ${status})，响应键: [${keys}]`),
      { status },
    );
    throw err;
  }

  // 多路径：顶层 / response 嵌套；值可能是 string 或 {id}
  const candidates = [
    json.cloudaicompanionProject,
    json.project,
    json.projectId,
    (json.response as Record<string, unknown> | undefined)?.cloudaicompanionProject,
    (json.response as Record<string, unknown> | undefined)?.project,
    (json.response as Record<string, unknown> | undefined)?.projectId,
  ];

  for (const c of candidates) {
    const id = pickProjectId(c);
    if (id) {
      entry.projectId = id;
      return id;
    }
  }

  const topKeys = Object.keys(json);
  const respKeys =
    json.response && typeof json.response === 'object'
      ? Object.keys(json.response as object).map((k) => `response.${k}`)
      : [];
  throw new Error(
    `loadCodeAssist 未返回 projectId，响应键: [${[...topKeys, ...respKeys].join(', ')}]`,
  );
}

/** 写回 token 文件，保留同名条目的其余字段 */
function writeBack(next: TokenEntry, name: string, tokenPath: string): void {
  try {
    const tf = loadTokenFile(tokenPath);
    const idx = tf.tokens.findIndex((t) => t.name === name);
    if (idx >= 0) tf.tokens[idx] = { ...tf.tokens[idx], ...next };
    else tf.tokens.push(next);
    saveTokenFile(tf, tokenPath);
  } catch {
    saveTokenFile({ tokens: [next] }, tokenPath);
  }
}

/**
 * 调 fn；若抛出 .status === 401，refresh 一次后重试一次，并把新 token 写回文件。
 * 只重试 1 次。
 */
export async function withAuth<T>(
  entry: TokenEntry,
  fn: (accessToken: string, projectId: string) => Promise<T>,
  tokenPath = getDefaultTokenPath(),
): Promise<T> {
  try {
    // ensureProjectId 必须在 try 内：它自己就会打上游、自己就会 401。
    // 放在 try 外时，accessToken 过期 → loadCodeAssist 401 → 直接冒泡，
    // 永远走不到下面的 refresh（实测：真机首次请求返回 500 而非自愈）。
    const hadPid = !!entry.projectId;
    const projectId = await ensureProjectId(entry);
    // 首次解析出的 projectId 也要落盘，否则进程重启 / 缓存失效后又要打一次
    // loadCodeAssist（只在新拿到时写，避免每请求一次磁盘 IO）。
    if (!hadPid) writeBack({ ...entry, projectId }, entry.name, tokenPath);
    return await fn(entry.accessToken, projectId);
  } catch (e) {
    const err = e as { status?: number };
    if (err?.status !== 401) throw e;

    const refreshed = await refreshAccessToken(entry);

    // 同步内存 entry，便于调用方继续用
    entry.accessToken = refreshed.accessToken;
    entry.expiresAt = refreshed.expiresAt;

    // 先拿 projectId 再落盘：refresh 改文件 mtime 会让 server 的 entry 缓存失效
    // 重新读盘，盘上若无 projectId 则每次 refresh 后都要多打一次 loadCodeAssist。
    const pid = await ensureProjectId(entry);
    refreshed.projectId = pid;
    writeBack(refreshed, entry.name, tokenPath);

    return await fn(entry.accessToken, pid);
  }
}
