// ═══════════════════════════════════════════════
//  模块间契约 —— 所有跨文件类型集中在此
//  形状依据 docs/wire-reference.md，改动前先看夹具
// ═══════════════════════════════════════════════

// ---------- token / auth ----------

export interface TokenEntry {
  name: string;
  accessToken: string;
  refreshToken: string;
  /** loadCodeAssist 返回的 cloudaicompanionProject；空则运行时补 */
  projectId?: string;
  /** epoch ms；0/缺失 = 未知，首次 401 后再刷新 */
  expiresAt?: number;
  machineId?: string;
}

export interface TokenFile {
  tokens: TokenEntry[];
}

// ---------- 上游 wire 形状（Antigravity → cloudcode-pa） ----------

/** wire-reference §1.3：FC 与 FR 都是 role:"model" */
export type NativeRole = 'user' | 'model';

export interface FunctionCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface FunctionResponse {
  id: string;
  name: string;
  /** 只有 output 一个键，值是字符串 */
  response: { output: string };
}

/**
 * thoughtSignature 是 part 的**兄弟键**，不在 functionCall 内。
 * 缺失 → 400 INVALID_ARGUMENT，必须原样回放。
 */
export interface NativePart {
  text?: string;
  thought?: boolean;
  thoughtSignature?: string;
  functionCall?: FunctionCall;
  functionResponse?: FunctionResponse;
}

export interface NativeContent {
  role: NativeRole;
  parts: NativePart[];
}

export interface FunctionDeclaration {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/** tools 是 14 项，每项恰好 1 个声明 —— 不是 1 项 14 声明 */
export interface ToolEntry {
  functionDeclarations: [FunctionDeclaration];
}

export interface AgentEnvelope {
  project: string;
  /** agent/<cascadeUuid>/<epochMs>/<trajectoryUuid>/<step> */
  requestId: string;
  model: string;
  userAgent: 'antigravity';
  requestType: 'agent';
  request: {
    contents: NativeContent[];
    systemInstruction: { role: 'user'; parts: [{ text: string }] };
    tools: ToolEntry[];
    toolConfig: { functionCallingConfig: { mode: 'VALIDATED' } };
    labels: Record<string, string>;
    generationConfig: {
      maxOutputTokens: number;
      thinkingConfig: { includeThoughts: boolean; thinkingBudget: number };
    };
    /** 负 int64 字符串 */
    sessionId: string;
  };
}

/** SSE 帧：data: {"response":{...},"traceId":...} */
export interface SseFrame {
  response?: {
    candidates?: Array<{
      content?: { role?: string; parts?: NativePart[] };
      finishReason?: string | null;
    }>;
    usageMetadata?: {
      promptTokenCount?: number;
      candidatesTokenCount?: number;
      totalTokenCount?: number;
      thoughtsTokenCount?: number;
      cachedContentTokenCount?: number;
    };
    modelVersion?: string;
    responseId?: string;
  };
  traceId?: string;
  error?: { code?: number; message?: string; status?: string };
}

/** antigravity-client 把一次 SSE 归并成这个 */
export interface StreamTurnResult {
  /** 拼接后的正文（不含 thought 分片） */
  text: string;
  /** 思考文本，仅日志用 */
  thoughtText: string;
  /**
   * 本轮所有 FC parts，**原样保留**（含 thoughtSignature）。
   * 回放时必须整组塞进同一个 role:"model" content，不可拆。
   */
  fcParts: NativePart[];
  finishReason: string | null;
  usage: {
    promptTokens: number;
    completionTokens: number;
    thoughtsTokens: number;
    cachedTokens: number;
  };
}

// ---------- 下游 wire 形状（Claude Code → 本服务） ----------

export interface AnthropicContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  content?: string | AnthropicContentBlock[];
  tool_use_id?: string;
  is_error?: boolean;
  json?: unknown;
  source?: { type?: string; data?: string; media_type?: string };
}

export interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string | AnthropicContentBlock[];
}

export interface AnthropicMessagesRequest {
  model?: string;
  messages?: AnthropicMessage[];
  /** 一律丢弃正文，只抽 4 值 —— 见 wire-reference §3 */
  system?: string | AnthropicContentBlock[];
  max_tokens?: number;
  stream?: boolean;
  /** **禁止上传**，仅用于识别 */
  tools?: unknown[];
  metadata?: Record<string, unknown>;
}

export interface ParsedToolResult {
  toolUseId: string;
  content: string;
  isError: boolean;
}

// ---------- system-prompt ----------

/** 一条规则 → 上游一个 <RULE[tag]> 块 */
export interface ExtractedRule {
  /** 方括号内的标签：全局固定 user_global，项目固定 project.md */
  tag: string;
  body: string;
}

/** 一条 skill → 上游 <skills> 的 Available skills 一行 */
export interface ExtractedSkill {
  name: string;
  description: string;
  /**
   * SKILL.md 伪路径（始终非空）：`~/.gemini/config/skills/<safeName>/SKILL.md`。
   * 磁盘上不存在；view_file 命中后桥接为 CC Skill 工具（见 tool-bridge）。
   */
  skillMdPath: string;
}

/** 唯一允许穿越 CC→上游边界的值 */
export interface ExtractedEnv {
  cwd: string;
  /** darwin | win32 | linux（原值，映射在 system-prompt 内做） */
  platform: string;
  isGitRepo: boolean;
  additionalDirs: string[];
  /** CLAUDE.md 正文，已剥掉 CC 包装头；只在首轮出现，必须缓存 */
  userRules: string;
  /** 按 global/project 拆分后的规则；空数组则不出 <user_rules> */
  rules: ExtractedRule[];
  /** messages[role=system] 里的 skill 清单；空数组则不出 <skills> */
  skills: ExtractedSkill[];
}

// ---------- tool-bridge ----------

/** 原生 FC → CC tool_use 的翻译结果 */
export interface BridgedToolUse {
  /** CC 侧 tool_use id，与原生 FC id 双向映射 */
  toolUseId: string;
  /** CC 实际持有的工具名：Read/Bash/Write/Edit/Skill */
  claudeName: string;
  input: Record<string, unknown>;
  /** 原生侧信息，回填 FR 时要用 */
  native: { id: string; name: string; args: Record<string, unknown> };
}

/** 桥接不了的原生工具 → 直接给 FR error output */
export interface BridgeRejection {
  native: { id: string; name: string; args: Record<string, unknown> };
  reason: string;
}

export type BridgeOutcome =
  | { kind: 'tool_use'; value: BridgedToolUse }
  | { kind: 'reject'; value: BridgeRejection };

// ---------- pending ----------

export interface PendingAgentSession {
  /** key：本轮任一 tool_use id 都能索引到同一 session */
  sessionKey: string;
  /** 本轮等待客户端回结果的全部 tool_use id */
  claudeToolIds: string[];
  /** toolUseId → 桥接记录 */
  bridged: Map<string, BridgedToolUse>;
  /** 本轮 SSE 的原样 FC parts；缺 thoughtSignature 会 400 */
  pendingFcParts: NativePart[];
  /** 已发生的原生历史（不含本轮 FC，resume 时才 push） */
  contents: NativeContent[];

  sessionId: string;
  cascadeUuid: string;
  trajectoryUuid: string;
  stepIndex: number;

  projectId: string;
  model: string;
  tokenName: string;
  /** 首轮抽出的 CLAUDE.md，续轮 CC 不再发 */
  systemInstruction: string;

  createdAt: number;
  timer: NodeJS.Timeout | null;
}
