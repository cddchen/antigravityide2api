// ═══════════════════════════════════════════════
//  Antigravity 上游客户端：信封构造 + SSE 流式生成
//  形状依据 docs/wire-reference.md §1.1–§1.4 与 ag-envelope.capture.json
// ═══════════════════════════════════════════════

import crypto from 'crypto';
import http from 'http';
import https from 'https';
import { StringDecoder } from 'string_decoder';
import { URL } from 'url';
import config from './config';
import type {
  AgentEnvelope,
  AvailableModelsResponse,
  NativeContent,
  NativePart,
  SseFrame,
  StreamTurnResult,
  ToolEntry,
} from './types';

// ---------- 错误 ----------

/** 上游 HTTP / SSE 错误；status===401 供 withAuth 触发 refresh */
export class AntigravityError extends Error {
  status: number;
  upstreamStatus?: string;
  body?: string;

  constructor(message: string, status: number, upstreamStatus?: string, body?: string) {
    super(message);
    this.name = 'AntigravityError';
    this.status = status;
    this.upstreamStatus = upstreamStatus;
    this.body = body;
  }
}

// ---------- 信封 ----------

export interface BuildEnvelopeOpts {
  projectId: string;
  model: string;
  contents: NativeContent[];
  systemInstruction: string;
  tools: ToolEntry[];
  sessionId: string;
  cascadeUuid: string;
  trajectoryUuid: string;
  stepIndex: number;
}

/**
 * 构造 agent 请求信封。
 * labels 用 P0 最小集（trajectory_id / last_step_index / used_claude），已实证 200。
 * systemInstruction.role 必须是 'user'（不是 system）。
 */
export function buildEnvelope(opts: BuildEnvelopeOpts): AgentEnvelope {
  return {
    project: opts.projectId,
    requestId: `agent/${opts.cascadeUuid}/${Date.now()}/${opts.trajectoryUuid}/${opts.stepIndex}`,
    model: opts.model,
    userAgent: 'antigravity',
    requestType: 'agent',
    request: {
      contents: opts.contents,
      systemInstruction: {
        role: 'user',
        parts: [{ text: opts.systemInstruction }],
      },
      tools: opts.tools,
      toolConfig: { functionCallingConfig: { mode: 'VALIDATED' } },
      labels: {
        trajectory_id: opts.trajectoryUuid,
        last_step_index: String(opts.stepIndex - 1),
        used_claude: 'false',
      },
      generationConfig: {
        maxOutputTokens: config.antigravity.maxOutputTokens,
        thinkingConfig: {
          includeThoughts: true,
          thinkingBudget: -1,
        },
      },
      sessionId: opts.sessionId,
    },
  };
}

/**
 * 稳定负 int64 字符串（实录 "-3750763034362895579"）。
 * randomBytes(8) → BigInt → asIntN(64) → 取负绝对值。
 */
export function newSessionId(): string {
  const buf = crypto.randomBytes(8);
  const x = buf.readBigUInt64BE(0);
  const signed = BigInt.asIntN(64, x);
  const abs = signed < 0n ? -signed : signed;
  // 0 极罕见；强制非零负数
  const neg = abs === 0n ? -1n : -abs;
  return String(neg);
}

// ---------- SSE 纯函数（可单测） ----------

/** 解析单行 SSE。空行 / 非 data / [DONE] → null */
export function parseSseLine(line: string): SseFrame | null {
  // 去掉可能的 \r
  const raw = line.endsWith('\r') ? line.slice(0, -1) : line;
  if (!raw || raw.startsWith(':')) return null;
  if (!raw.startsWith('data:')) return null;
  const payload = raw.slice(5).trimStart();
  if (!payload || payload === '[DONE]') return null;
  return JSON.parse(payload) as SseFrame;
}

/** 是否为 data:[DONE] 终止行 */
export function isSseDoneLine(line: string): boolean {
  const raw = line.endsWith('\r') ? line.slice(0, -1) : line;
  if (!raw.startsWith('data:')) return false;
  return raw.slice(5).trimStart() === '[DONE]';
}

/**
 * 跨 TCP/gunzip chunk 解码 UTF-8，再按 `\n` 切 SSE 行。
 * 禁止对每个 Buffer 单独 `toString('utf8')`：3 字节汉字/制表符（质=\xe8\xb4\xa8、─=\xe2\x94\x80）
 * 若被切在第 1/2 字节，Node 会按 replacement 策略插入 U+FFFD，JSON.parse 仍成功但正文乱码。
 */
export class SseLineReader {
  private readonly decoder = new StringDecoder('utf8');
  private buffer = '';

  push(chunk: Buffer): string[] {
    this.buffer += this.decoder.write(chunk);
    const lines: string[] = [];
    let nl: number;
    while ((nl = this.buffer.indexOf('\n')) !== -1) {
      lines.push(this.buffer.slice(0, nl));
      this.buffer = this.buffer.slice(nl + 1);
    }
    return lines;
  }

  /** 刷新 decoder 内部残留，返回最后一行（可能没有尾随 `\n`） */
  end(): string {
    this.buffer += this.decoder.end();
    const rest = this.buffer;
    this.buffer = '';
    return rest;
  }
}

/** 完整响应体：先拼 Buffer 再解码，避免 chunk 边界切断多字节字符 */
export function readStreamUtf8(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  return new Promise((resolve) => {
    stream.on('data', (c: Buffer | string) => {
      chunks.push(typeof c === 'string' ? Buffer.from(c, 'utf8') : c);
    });
    stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    stream.on('error', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

/** 流式归并累加器 */
export interface StreamAcc {
  text: string;
  thoughtText: string;
  fcParts: NativePart[];
  finishReason: string | null;
  usage: {
    promptTokens: number;
    completionTokens: number;
    thoughtsTokens: number;
    cachedTokens: number;
  };
}

export function createStreamAcc(): StreamAcc {
  return {
    text: '',
    thoughtText: '',
    fcParts: [],
    finishReason: null,
    usage: {
      promptTokens: 0,
      completionTokens: 0,
      thoughtsTokens: 0,
      cachedTokens: 0,
    },
  };
}

export interface AccumulateCbs {
  onText?: (delta: string) => void;
  onThought?: (delta: string) => void;
}

/**
 * 把一帧归并进 acc。
 * - usageMetadata 是累计值 → 直接覆盖
 * - thought===true 的 text → thoughtText
 * - 普通 text 增量拼接
 * - functionCall part 原样 push（含 thoughtSignature 兄弟键）
 * - 末帧 text:"" + 独立 thoughtSignature 且无 functionCall → 跳过
 * - frame.error → 抛 AntigravityError
 */
export function accumulateFrame(
  acc: StreamAcc,
  frame: SseFrame,
  cbs?: AccumulateCbs,
): void {
  if (frame.error) {
    const code = frame.error.code ?? 500;
    let msg = frame.error.message ?? 'upstream SSE error';
    if (/thought_signature/i.test(msg)) {
      msg = `thoughtSignature 丢失，会话不可恢复，需重开: ${msg}`;
    }
    throw new AntigravityError(msg, code, frame.error.status);
  }

  const resp = frame.response;
  if (!resp) return;

  // 累计 usage → 覆盖
  if (resp.usageMetadata) {
    const u = resp.usageMetadata;
    acc.usage = {
      promptTokens: u.promptTokenCount ?? acc.usage.promptTokens,
      completionTokens: u.candidatesTokenCount ?? acc.usage.completionTokens,
      thoughtsTokens: u.thoughtsTokenCount ?? acc.usage.thoughtsTokens,
      cachedTokens: u.cachedContentTokenCount ?? acc.usage.cachedTokens,
    };
  }

  const cand = resp.candidates?.[0];
  if (!cand) return;

  if (cand.finishReason != null) {
    acc.finishReason = cand.finishReason;
  }

  const parts = cand.content?.parts;
  if (!parts) return;

  for (const part of parts) {
    // 末帧：无 FC + text:"" + 独立 thoughtSignature → 跳过（既不进 text 也不进 fcParts）
    if (
      !part.functionCall &&
      part.text === '' &&
      typeof part.thoughtSignature === 'string'
    ) {
      continue;
    }

    // FC：整 part 原样保留（含 thoughtSignature 兄弟键）
    if (part.functionCall) {
      acc.fcParts.push(part);
      continue;
    }

    // 思考分片
    if (part.thought === true && typeof part.text === 'string') {
      acc.thoughtText += part.text;
      cbs?.onThought?.(part.text);
      continue;
    }

    // 正文增量
    if (typeof part.text === 'string' && part.text.length > 0) {
      acc.text += part.text;
      cbs?.onText?.(part.text);
    }
  }
}

// ---------- 传输层：逐字对齐 IDE 出站头 ----------

/**
 * IDE 真实出站头（Surge 2026-08-08 抓包，13/13 条 streamGenerateContent 完全一致）：
 *
 *   POST /v1internal:streamGenerateContent?alt=sse HTTP/1.1
 *   Host: daily-cloudcode-pa.googleapis.com
 *   User-Agent: antigravity/ide/{product.json ideVersion} darwin/arm64
 *   Transfer-Encoding: chunked      ← 流式端点；非流式（recordCodeAssistMetrics）用 Content-Length
 *   Authorization: Bearer ya29.…
 *   Content-Type: application/json
 *   Accept-Encoding: gzip
 *
 * 六个头，顺序固定。抓包里没有 Connection —— 那是 Surge 剥逐跳头的结果
 * （同一份抓包 42/42 条请求全无 Connection，含 Chromium 系客户端），不是客户端没发。
 * 但 Node 默认发 `Connection: close`，Go 默认不发（HTTP/1.1 隐含 keep-alive），
 * 所以仍要 removeHeader 抹掉。
 *
 * 不能用 undici(fetch)：它无条件注入 `accept: *\/*`、`accept-language: *`、
 * `sec-fetch-mode: cors`，且 `sec-fetch-mode` 无法通过 headers 覆盖（实测置空串仍为 cors）。
 * node:http 只发我们给的头，逐字可控。
 *
 * ponytail: 只做 HTTP 层对齐。发这些请求的不是 Electron，是
 * extensions/antigravity/bin/language_server_macos_arm —— Mach-O arm64，
 * strings 命中 go1.27 + 1194 处 crypto/tls，无 utls。故基线是 **Go crypto/tls**：
 *   Go      JA3 03117a8e… 13 ciphers exts[0,11,65281,23,18,5,10,13,50,16,43,51]
 *   Node    JA3 d67b0948… 52 ciphers exts[65281,0,11,10,35,16,22,23,13,43,45,51]
 *   Node 尽力逼近后 13 ciphers，但仍差 ext 18(SCT)/50(sig_algs_cert) 编不出、
 *   45(psk_modes) 去不掉、扩展顺序 OpenSSL 写死 → JA3 必不同。
 * 要对齐须换网络栈（用 Go 写 transport / curl-impersonate）。
 */
export function postStream(
  url: string,
  accessToken: string,
  bodyJson: string,
  signal?: AbortSignal,
  /**
   * 抓包实证的两种成帧：流式端点 chunked，非流式端点 Content-Length。
   *   13x streamGenerateContent  → Host|UA|Transfer-Encoding|Auth|CT|AE
   *   13x recordCodeAssistMetrics → Host|UA|Content-Length|Auth|CT|AE
   *    4x listExperiments         → 同上
   * 其余五个头名、顺序、值完全一致。
   */
  chunked = true,
): Promise<http.IncomingMessage> {
  const u = new URL(url);
  const mod = u.protocol === 'http:' ? http : https;

  return new Promise((resolve, reject) => {
    const req = mod.request(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || (u.protocol === 'http:' ? 80 : 443),
        path: `${u.pathname}${u.search}`,
        method: 'POST',
        // 顺序即抓包顺序。Host 必须显式写在首位：node:http 只在你不给时才自动
        // 补 Host，而自动补的会排到最后（实测），与抓包的首位不符。
        headers: {
          Host: u.host,
          'User-Agent': config.antigravity.userAgent,
          ...(chunked
            ? { 'Transfer-Encoding': 'chunked' }
            : { 'Content-Length': String(Buffer.byteLength(bodyJson)) }),
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          'Accept-Encoding': 'gzip',
        },
        signal,
      },
      resolve,
    );
    // Node 默认追加 `Connection: close`（agent 关 keepAlive 时）或 `keep-alive`；
    // Go net/http 两者都不发。抹掉以对齐。
    req.removeHeader('connection');
    req.on('error', reject);
    // 显式 chunked：不设 Content-Length，与抓包一致
    req.write(bodyJson);
    req.end();
  });
}

/** gzip 响应要解压；SSE 一般不压，但 Accept-Encoding: gzip 声明了就得能处理 */
export function decodeBody(res: http.IncomingMessage): NodeJS.ReadableStream {
  if ((res.headers['content-encoding'] || '').toLowerCase() === 'gzip') {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return res.pipe(require('zlib').createGunzip() as NodeJS.ReadWriteStream);
  }
  return res;
}

export interface FetchAvailableModelsOpts {
  accessToken: string;
  projectId: string;
  signal?: AbortSignal;
}

/**
 * POST fetchAvailableModels，获取当前 project/账号实际可见的模型目录。
 * 抓包请求使用 Content-Length（不是请求 chunked）；响应是 gzip 压缩 JSON，不是 SSE。
 */
export async function fetchAvailableModels(
  opts: FetchAvailableModelsOpts,
): Promise<AvailableModelsResponse> {
  const url = `${config.antigravity.baseUrl}/v1internal:fetchAvailableModels`;
  const payload = JSON.stringify({ project: opts.projectId });
  const signals: AbortSignal[] = [AbortSignal.timeout(config.antigravity.requestTimeout)];
  if (opts.signal) signals.push(opts.signal);
  const signal = AbortSignal.any(signals);

  let res: http.IncomingMessage;
  try {
    res = await postStream(url, opts.accessToken, payload, signal, false);
  } catch (e) {
    if (e instanceof Error && (e.name === 'AbortError' || e.name === 'TimeoutError')) {
      throw new AntigravityError(`request aborted/timeout: ${e.message}`, 408);
    }
    throw e;
  }

  const status = res.statusCode ?? 0;
  const stream = decodeBody(res);
  const body = await readStreamUtf8(stream);

  if (status < 200 || status >= 300) {
    let message = `HTTP ${status}`;
    try {
      const json = JSON.parse(body) as { error?: { message?: string; status?: string } };
      if (json.error?.message) message = json.error.message;
    } catch {
      if (body) message = body.slice(0, 500);
    }
    throw new AntigravityError(message, status, undefined, body);
  }

  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch (e) {
    throw new AntigravityError(
      `fetchAvailableModels 响应非 JSON (HTTP ${status}): ${e instanceof Error ? e.message : String(e)}`,
      502,
      undefined,
      body.slice(0, 500),
    );
  }

  if (
    !json ||
    typeof json !== 'object' ||
    Array.isArray(json) ||
    !('models' in json) ||
    !json.models ||
    typeof json.models !== 'object' ||
    Array.isArray(json.models)
  ) {
    throw new AntigravityError(
      'fetchAvailableModels 响应缺少对象类型的 models 字段',
      502,
      undefined,
      body.slice(0, 500),
    );
  }

  return json as AvailableModelsResponse;
}

// ---------- 流式生成 ----------

export interface StreamGenerateOpts extends BuildEnvelopeOpts {
  accessToken: string;
  /** 增量文本回调，用于 SSE 转发 */
  onText?: (delta: string) => void;
  onThought?: (delta: string) => void;
  signal?: AbortSignal;
}

/**
 * POST streamGenerateContent?alt=sse，按行缓冲解析 SSE，归并为一轮 StreamTurnResult。
 */
export async function streamGenerate(opts: StreamGenerateOpts): Promise<StreamTurnResult> {
  const envelope = buildEnvelope(opts);
  const url = `${config.antigravity.baseUrl}/v1internal:streamGenerateContent?alt=sse`;

  // 超时 + 调用方 signal 合并
  const signals: AbortSignal[] = [AbortSignal.timeout(config.antigravity.requestTimeout)];
  if (opts.signal) signals.push(opts.signal);
  const signal = AbortSignal.any(signals);

  let res: http.IncomingMessage;
  try {
    res = await postStream(url, opts.accessToken, JSON.stringify(envelope), signal);
  } catch (e) {
    if (e instanceof Error && (e.name === 'AbortError' || e.name === 'TimeoutError')) {
      throw new AntigravityError(`request aborted/timeout: ${e.message}`, 408);
    }
    throw e;
  }

  const status = res.statusCode ?? 0;
  const stream = decodeBody(res);

  if (status < 200 || status >= 300) {
    const body = await readStreamUtf8(stream);
    let msg = `HTTP ${status}`;
    if (body) {
      try {
        const j = JSON.parse(body) as { error?: { message?: string; status?: string } };
        if (j.error?.message) msg = j.error.message;
      } catch {
        msg = body.slice(0, 500);
      }
    }
    if (status === 400 && /thought_signature/i.test(msg)) {
      msg = `thoughtSignature 丢失，会话不可恢复，需重开: ${msg}`;
    }
    // 401 原样透出 status，供 withAuth refresh
    throw new AntigravityError(msg, status, undefined, body);
  }

  const acc = createStreamAcc();
  const cbs: AccumulateCbs = { onText: opts.onText, onThought: opts.onThought };

  // 按行缓冲：chunk 边界会切断 SSE 行，也会切断 UTF-8 多字节字符
  const reader = new SseLineReader();
  let earlyDone = false;

  await new Promise<void>((resolve, reject) => {
    const finish = (): void => {
      earlyDone = true;
      res.destroy();
      resolve();
    };

    const handleLine = (line: string): boolean => {
      if (isSseDoneLine(line)) {
        finish();
        return true;
      }

      let frame: SseFrame | null;
      try {
        frame = parseSseLine(line);
      } catch (e) {
        reject(
          new AntigravityError(
            `SSE JSON parse failed: ${e instanceof Error ? e.message : String(e)}`,
            502,
            undefined,
            line.slice(0, 300),
          ),
        );
        return true;
      }
      if (frame) accumulateFrame(acc, frame, cbs);
      return false;
    };

    stream.on('data', (chunk: Buffer) => {
      if (earlyDone) return;
      for (const line of reader.push(chunk)) {
        if (handleLine(line)) return;
      }
    });

    stream.on('end', () => {
      if (earlyDone) return;
      const rest = reader.end();
      if (rest.trim() && !isSseDoneLine(rest)) {
        try {
          const frame = parseSseLine(rest);
          if (frame) accumulateFrame(acc, frame, cbs);
        } catch {
          // 半截残渣忽略
        }
      }
      resolve();
    });

    stream.on('error', (e: Error) => {
      if (earlyDone) return;
      if (e.name === 'AbortError' || e.name === 'TimeoutError') {
        reject(new AntigravityError(`stream aborted/timeout: ${e.message}`, 408));
        return;
      }
      reject(e);
    });
  });

  return accToResult(acc);
}

function accToResult(acc: StreamAcc): StreamTurnResult {
  return {
    text: acc.text,
    thoughtText: acc.thoughtText,
    fcParts: acc.fcParts,
    finishReason: acc.finishReason,
    usage: acc.usage,
  };
}

// ---------- 自检（不发网络） ----------

if (require.main === module) {
  const assert = (cond: unknown, msg: string): void => {
    if (!cond) {
      console.error('FAIL:', msg);
      process.exit(1);
    }
  };

  // 1. requestId 格式
  const env = buildEnvelope({
    projectId: 'proj',
    model: 'gemini-3.6-flash-high',
    contents: [],
    systemInstruction: 'sys',
    tools: [],
    sessionId: '-1',
    cascadeUuid: 'cascade-uuid',
    trajectoryUuid: 'traj-uuid',
    stepIndex: 3,
  });
  assert(
    /^agent\/[^/]+\/\d+\/[^/]+\/\d+$/.test(env.requestId),
    `requestId shape: ${env.requestId}`,
  );

  // 2. systemInstruction.role === 'user'
  assert(env.request.systemInstruction.role === 'user', 'systemInstruction.role');

  // 3. toolConfig VALIDATED
  assert(
    env.request.toolConfig.functionCallingConfig.mode === 'VALIDATED',
    'toolConfig mode',
  );

  // 4. generationConfig 三值
  assert(env.request.generationConfig.maxOutputTokens === 65536, 'maxOutputTokens');
  assert(env.request.generationConfig.thinkingConfig.includeThoughts === true, 'includeThoughts');
  assert(env.request.generationConfig.thinkingConfig.thinkingBudget === -1, 'thinkingBudget');

  // labels 最小集
  assert(env.request.labels.trajectory_id === 'traj-uuid', 'labels.trajectory_id');
  assert(env.request.labels.last_step_index === '2', 'labels.last_step_index');
  assert(env.request.labels.used_claude === 'false', 'labels.used_claude');
  assert(env.userAgent === 'antigravity', 'userAgent');
  assert(env.requestType === 'agent', 'requestType');

  // 5. newSessionId 负数可 BigInt
  for (let i = 0; i < 20; i++) {
    const sid = newSessionId();
    assert(sid.startsWith('-'), `sessionId negative: ${sid}`);
    const n = BigInt(sid);
    assert(n < 0n, `sessionId BigInt < 0: ${sid}`);
    // 19 位量级（含负号 2–20 字符，绝对值通常 18–19 位）
    assert(sid.length >= 2 && sid.length <= 20, `sessionId length: ${sid}`);
  }

  // 6. SSE 归并：text 拼接 / FC 原样 / 末帧跳过 / usage 覆盖
  const acc = createStreamAcc();

  // 帧1：思考 + 正文增量 + usage 小
  accumulateFrame(acc, {
    response: {
      candidates: [
        {
          content: {
            role: 'model',
            parts: [
              { thought: true, text: 'thinking...' },
              { text: 'Hello' },
            ],
          },
          finishReason: null,
        },
      ],
      usageMetadata: {
        promptTokenCount: 100,
        candidatesTokenCount: 5,
        totalTokenCount: 110,
        thoughtsTokenCount: 5,
        cachedContentTokenCount: 50,
      },
    },
  });
  assert(acc.text === 'Hello', `text after f1: ${acc.text}`);
  assert(acc.thoughtText === 'thinking...', `thought after f1: ${acc.thoughtText}`);
  assert(acc.usage.promptTokens === 100, 'usage overwrite f1');

  // 帧2：正文续片 + FC 带 thoughtSignature + usage 更大（覆盖）
  const fcPart: NativePart = {
    functionCall: {
      id: 'tAyN1Fx2',
      name: 'list_dir',
      args: { DirectoryPath: '/tmp' },
    },
    thoughtSignature: 'EuULCuILARFNMg/sig-must-keep',
  };
  accumulateFrame(acc, {
    response: {
      candidates: [
        {
          content: {
            role: 'model',
            parts: [{ text: ' world' }, fcPart],
          },
          finishReason: null,
        },
      ],
      usageMetadata: {
        promptTokenCount: 100,
        candidatesTokenCount: 20,
        totalTokenCount: 130,
        thoughtsTokenCount: 10,
        cachedContentTokenCount: 50,
      },
    },
  });
  assert(acc.text === 'Hello world', `text after f2: ${acc.text}`);
  assert(acc.fcParts.length === 1, `fcParts len: ${acc.fcParts.length}`);
  assert(
    acc.fcParts[0].thoughtSignature === 'EuULCuILARFNMg/sig-must-keep',
    'thoughtSignature preserved',
  );
  assert(acc.fcParts[0].functionCall?.id === 'tAyN1Fx2', 'fc id');
  // 引用相等或深等：原样 push
  assert(acc.fcParts[0] === fcPart, 'fc part identity (raw push)');
  assert(acc.usage.completionTokens === 20, 'usage overwrite not add');
  assert(acc.usage.thoughtsTokens === 10, 'thoughtsTokens overwrite');

  // 帧3：末帧 text:"" + 独立签名 + STOP —— 不得进 fcParts / text
  accumulateFrame(acc, {
    response: {
      candidates: [
        {
          content: {
            role: 'model',
            parts: [{ thoughtSignature: 'EvQBCvEB-end-frame-only', text: '' }],
          },
          finishReason: 'STOP',
        },
      ],
      usageMetadata: {
        promptTokenCount: 100,
        candidatesTokenCount: 21,
        totalTokenCount: 131,
        thoughtsTokenCount: 10,
        cachedContentTokenCount: 50,
      },
    },
  });
  assert(acc.text === 'Hello world', `text after end frame unchanged: ${acc.text}`);
  assert(acc.fcParts.length === 1, 'end-frame sig not pushed to fcParts');
  assert(acc.finishReason === 'STOP', `finishReason: ${acc.finishReason}`);
  assert(acc.usage.completionTokens === 21, 'final usage overwrite');

  // parseSseLine
  assert(parseSseLine('') === null, 'empty line');
  assert(parseSseLine('data: [DONE]') === null, '[DONE] → null');
  assert(isSseDoneLine('data: [DONE]'), 'isSseDoneLine');
  const parsed = parseSseLine(
    'data: {"response":{"candidates":[{"finishReason":null}]},"traceId":"abc"}',
  );
  assert(parsed?.traceId === 'abc', 'parseSseLine json');

  // frame.error → AntigravityError，400+thought_signature 有提示
  let threw = false;
  try {
    accumulateFrame(createStreamAcc(), {
      error: {
        code: 400,
        message: 'Function call is missing a thought_signature in functionCall parts',
        status: 'INVALID_ARGUMENT',
      },
    });
  } catch (e) {
    threw = true;
    assert(e instanceof AntigravityError, 'is AntigravityError');
    assert((e as AntigravityError).status === 400, 'error status 400');
    assert(
      /thoughtSignature 丢失/.test((e as AntigravityError).message),
      'thoughtSignature hint',
    );
  }
  assert(threw, 'frame.error must throw');

  // 7. UTF-8 跨 chunk：3 字节汉字/制表符切在中间不得变成 U+FFFD
  {
    const feed = (bytes: Buffer, size: number): string[] => {
      const r = new SseLineReader();
      const out: string[] = [];
      for (let i = 0; i < bytes.length; i += size) {
        out.push(...r.push(bytes.subarray(i, i + size)));
      }
      const rest = r.end();
      if (rest) out.push(rest);
      return out;
    };

    const text = '质结拟功付─┬';
    const sse = Buffer.from(
      `data: {"response":{"candidates":[{"content":{"parts":[{"text":${JSON.stringify(text)}}]}}]}}\n`,
      'utf8',
    );
    const idx = sse.indexOf(Buffer.from('质'));
    assert(idx >= 0, '质 must be in sse bytes');
    const r = new SseLineReader();
    const first = r.push(sse.subarray(0, idx + 2));
    assert(first.length === 0, 'incomplete UTF-8 must not emit a line');
    const second = r.push(sse.subarray(idx + 2));
    assert(second.length === 1, `expected 1 line, got ${second.length}`);
    const frame = parseSseLine(second[0]);
    assert(
      frame?.response?.candidates?.[0]?.content?.parts?.[0]?.text === text,
      `split-质 text: ${JSON.stringify(frame?.response?.candidates?.[0]?.content?.parts?.[0]?.text)}`,
    );

    const contents = `${'质'.repeat(4000)}结拟功付${'─'.repeat(80)}┬`;
    const fcLine = Buffer.from(
      `data: ${JSON.stringify({
        response: {
          candidates: [
            {
              content: {
                parts: [
                  {
                    functionCall: {
                      id: 'w1',
                      name: 'write_to_file',
                      args: { Contents: contents },
                    },
                  },
                ],
              },
            },
          ],
        },
      })}\n`,
      'utf8',
    );
    for (const size of [1, 2, 7, 4096]) {
      const lines = feed(fcLine, size);
      assert(lines.length === 1, `chunk ${size}: lines=${lines.length}`);
      const parsed = parseSseLine(lines[0]);
      const got = parsed?.response?.candidates?.[0]?.content?.parts?.[0]?.functionCall?.args
        ?.Contents as string | undefined;
      assert(got === contents, `chunk ${size} Contents mismatch (FFFD=${got?.includes('�')})`);
    }
  }

  // 静默 exit 0
  process.exit(0);
}
