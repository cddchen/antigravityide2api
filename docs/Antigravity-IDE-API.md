# Antigravity IDE API 文档

> 调研日期：2026-08-08  
> **抓包校准**：`Surge Catpure/2026-08-08-170054`（本机 agent 会话）  
> 目标：`antigravityide2api` — 将 Antigravity **IDE 原生 agent harness** 导出为 Anthropic `POST /v1/messages`，对标 **`cursoride2api`**  
> 证据：`/Applications/Antigravity IDE.app`（ideVersion 2.1.1）、`language_server_macos_arm`、`state.vscdb`、上述 Surge 抓包

---

## 0. 一句话结论

| 项 | 结论 |
|----|------|
| 对标产品 | **`cursoride2api`**（语义桥 + 本地/客户端执行），**不是** CLIProxyAPI 的「上传 Claude tools[]」 |
| 上游（本抓包） | `https://daily-cloudcode-pa.googleapis.com/v1internal:*` |
| 工具模型 | **14 个原生 harness tools**（`view_file` / `run_command` / …，PascalCase + 必填 `toolAction`/`toolSummary`） |
| Proxy 职责 | 原生 `functionCall` ↔ Claude `tool_use`（字段语义桥）+ 原生 `functionResponse` |
| 鉴权 | Google OAuth Bearer；token 从 IDE `state.vscdb` 提取 |
| 明确禁止 | Claude Code `tools[]` / schema **原样**塞给上游 |

```
上游 agent 决策 → 下发原生 tool → 客户端/本地执行 → functionResponse 塞回 → 上游继续
```

线协议：Antigravity = **短连接 SSE + Gemini functionCall**；Cursor = HTTP/2 BiDi `execServerMessage`。

---

## 1. 为什么不用 CLIProxyAPI 逻辑

| | CLIProxyAPI（CC→AG） | **本项目（对标 cursoride2api）** |
|--|---------------------|----------------------------------|
| 上游看到的 tools | **Claude Code** Read/Bash schema | **IDE harness** `view_file`/`run_command`… |
| 行为像谁 | 第三方代理特征 | **Antigravity IDE agent 会话** |
| 工具执行 | Claude 本地（schema 自洽） | Claude 本地，**参数经语义桥** |
| 风控 | 易被识别/封号 | 对齐 IDE 请求面 |
| 复杂度 | 低（格式映射） | 高（tool-bridge + pending） |

传输层（OAuth / envelope / SSE）可参考 CLIProxy **事实规格**；**工具语义必须以 IDE 为准**。

---

## 2. 目标架构（路径 B）

```
Claude Code
  │  Anthropic /v1/messages
  │  tools[] = Claude 自己的（仅给 CC 用，不上传上游）
  ▼
antigravityide2api
  │  1) 忽略客户端 tools[]
  │  2) 组装 IDE 形请求：14 原生 functionDeclarations + envelope
  │  3) 上游 functionCall(view_file,…) → Claude tool_use(Read,…)
  │  4) 客户端 tool_result → 原生 functionResponse{output}
  │  5) pending 多轮直到 end_turn
  ▼
daily-cloudcode-pa  /v1internal:streamGenerateContent?alt=sse
```

### 2.1 模块对齐 cursoride2api

| cursoride2api | antigravityide2api |
|---------------|-------------------|
| `cursor-client` BiDi | `antigravity-client` SSE + multi-turn HTTP |
| `execServerMessage` | Gemini `functionCall`（原生名） |
| `tool-bridge` | 原生 ↔ Claude schema |
| `pending-session` | tool 轮次 |
| `execClientMessage` | 下一轮 `contents` + `functionResponse` |
| `extract-token` Cursor DB | IDE `state.vscdb` |

### 2.2 IDE 真实链路

```
Antigravity IDE
  → google.antigravity extension
  → language_server_macos_arm（注入 harness tools + system ~35k）
  → CodeAssistClient → {daily-|prod}cloudcode-pa.googleapis.com
```

---

## 3. 接口清单（上游）— 抓包确认

### 3.1 Base URL

| 环境 | URL | 抓包 |
|------|-----|------|
| **Daily** | `https://daily-cloudcode-pa.googleapis.com` | **本会话全部 generate 走 daily** |
| Prod | `https://cloudcode-pa.googleapis.com` | LS 启动参数可见；本抓包未出现 |

实现：默认跟随本机实际流量（本环境 **daily**）；可配置 `ANTIGRAVITY_BASE`；prod 作回退。

### 3.2 本抓包出现的 method

| method | 次数级 | 用途 |
|--------|--------|------|
| `streamGenerateContent?alt=sse` | ~13 | agent / checkpoint / tab 生成 **P0** |
| `recordCodeAssistMetrics` | ~13 | 伴生指标 **P1 指纹** |
| `listExperiments` | ~4 | 伴生实验配置 **P1 指纹** |
| `fetchAvailableModels` | 3（20:49:33 / 20:49:49 / 20:49:59） | 当前 project 的实际模型目录；请求体 `{project}`，响应 gzip JSON |
| `loadCodeAssist` / `onboardUser` | — | `loadCodeAssist` 为 project 的已有前置路径；`onboardUser` 本包未确认 |

路径：`POST {base}/v1internal:{method}`。

### 3.3 请求头（generate，抓包原文）

```http
POST /v1internal:streamGenerateContent?alt=sse HTTP/1.1
Host: daily-cloudcode-pa.googleapis.com
User-Agent: antigravity/ide/2.1.1 darwin/arm64
Transfer-Encoding: chunked
Authorization: Bearer ya29.…
Content-Type: application/json
Accept-Encoding: gzip
```

| 字段 | 抓包值 |
|------|--------|
| HTTP UA | `antigravity/ide/{ideVersion} {os}/{arch}` → `antigravity/ide/2.1.1 darwin/arm64` |
| HTTP 版本 | 抓包侧 **HTTP/1.1**（MITM 观察；TLS/ALPN 未独立验证） |
| Transfer-Encoding | **chunked**（body） |
| Accept | 未强制 `text/event-stream`（仅 `Accept-Encoding: gzip`） |

**勿用** CLIProxy 的 `antigravity/hub/2.2.1`。

---

## 4. OAuth 与 extract-token

### 4.1 OAuth（与 IDE 同源 client）

```
ClientID/Secret: 不入库（GitHub GH013），运行时从本机 IDE 主包现取：
           /Applications/Antigravity IDE.app/Contents/Resources/app/out/main.js
           /([0-9]{6,}-[a-z0-9]{16,}\.apps\.googleusercontent\.com)[\s\S]{0,64}?(GOCSPX-[A-Za-z0-9_-]{20,})/
           实现见 src/extract-token.ts extractOAuthClient()
Token:     https://oauth2.googleapis.com/token
Scopes:    cloud-platform, userinfo.email, userinfo.profile, cclog, experimentsandconfigs
```

主路径：**extract 已登录会话**；独立 OAuth 仅 fallback（redirect 不同是识别点）。

### 4.2 extract-token

| 项 | 值 |
|----|-----|
| DB | `~/Library/Application Support/Antigravity IDE/User/globalStorage/state.vscdb` |
| Key | `antigravityUnifiedStateSync.oauthToken` |
| 内容 | base64 嵌套 protobuf：access `ya29…`、refresh `1//…` |
| project | 本地常空 → `loadCodeAssist` / `onboardUser`（本抓包 project=`fluent-falcon-nrl9f`） |
| machineId | 同目录 `storage.json` → `telemetry.machineId` |

输出：`~/.antigravityide2api/token.json`（0600）。日志掩码 token。

---

## 5. 请求 Envelope（抓包校准）

### 5.1 Agent 生成（P0）

```json
{
  "project": "fluent-falcon-nrl9f",
  "requestId": "agent/{cascadeUuid}/{ms}/{trajectoryUuid}/{stepIndex}",
  "model": "gemini-3.6-flash-high",
  "userAgent": "antigravity",
  "requestType": "agent",
  "request": {
    "contents": [ /* 见 §5.4 */ ],
    "systemInstruction": { "parts": [{ "text": "…" }] },
    "tools": [
      { "functionDeclarations": [ /* 单个 tool */ ] },
      { "functionDeclarations": [ /* …共 14 项，每项一个 tool */ ] }
    ],
    "toolConfig": { "functionCallingConfig": { "mode": "VALIDATED" } },
    "labels": {
      "last_execution_id": "uuid",
      "last_step_index": "27",
      "model_enum": "MODEL_PLACEHOLDER_M71",
      "trajectory_id": "uuid",
      "used_claude": "false",
      "used_claude_conservative": "false"
    },
    "generationConfig": {
      "maxOutputTokens": 65536,
      "thinkingConfig": { "includeThoughts": true, "thinkingBudget": -1 }
    },
    "sessionId": "-3750763034362895579"
  }
}
```

### 5.2 字段规则（抓包）

| 字段 | 规则 |
|------|------|
| `userAgent`（body） | **`"antigravity"`**（固定） |
| HTTP `User-Agent` | **`antigravity/ide/2.1.1 darwin/arm64`** |
| `requestType` | **`agent`**（主）；另见 checkpoint / tab |
| `requestId` | **`agent/{cascadeUuid}/{unixMs}/{trajectoryUuid}/{seq}`**，seq 递增整数 |
| `sessionId` | **稳定负整数字符串**，整段 agent 轨迹不变（例 `"-3750763034362895579"`） |
| `tools` | **14 个数组元素**，每个元素 `functionDeclarations` 仅 **1** 个 tool（不是合并成 1 个 declaration 列表） |
| `toolConfig.mode` | agent：**`VALIDATED`**（IDE 原生如此，**不是** CLIProxy 独有指纹） |
| `generationConfig` | agent：`maxOutputTokens=65536`，`thinkingBudget=-1`，`includeThoughts=true` |
| `labels` | 含 `trajectory_id`、`last_step_index`、`model_enum`、`used_claude=false` 等 |
| `systemInstruction` | ~**35570** 字符，Antigravity harness 身份 + 约束（非 Claude Code system） |

### 5.3 其他 requestType（本包）

| requestType | model | requestId 形 | tools | toolConfig | maxOutputTokens |
|-------------|-------|--------------|-------|------------|-----------------|
| `agent` | `gemini-3.6-flash-high` | `agent/{uuid}/{ms}/{uuid}/{n}` | 14 | VALIDATED | 65536 |
| `checkpoint` | 同 | `checkpoint/{uuid}` | 14 | **NONE** | 16384 |
| `tab` | `tab_flash_lite_preview` | `tab/{uuid}` | **无** | 无 | 2048（thinkingBudget=0） |

Proxy 主路径只实现 **agent**。

### 5.4 contents 历史布局（关键！）

抓包中 **functionCall 与 functionResponse 均在 `role: "model"` 轮**，成对交错，**不是** Gemini 文档常见的 user 侧 FR：

```
user   text <USER_REQUEST>…
user   text # Conversation History …
model  functionCall  list_dir   + thoughtSignature
model  functionResponse list_dir  response.output
model  functionCall  view_file  + thoughtSignature
model  functionResponse view_file response.output
…
model  thought + text          （最终回答）
user   text <USER_REQUEST>…    （下一轮用户）
```

| 要点 | 证据 |
|------|------|
| FR role | **`model`**，不是 `user` |
| FC 附带 | 常有 `thoughtSignature`（长 base64） |
| FR 形 | **仅** `{ "output": "<string>" }`（本包未见 exitCode 等结构化字段） |
| output 前缀 | 常含 `Created At:` / `Completed At:` 时间戳行，再接正文 |
| user 消息包装 | `<USER_REQUEST>\n…\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nThe current local time is: …` |

续轮必须回放完整原生 FC/FR 轨迹 + signature，不能只回 Claude 形历史。

---

## 6. 原生 harness 工具（抓包完整 14）

完整 JSON：[`docs/native-tools.capture.json`](./native-tools.capture.json)（从 agent 请求原样导出）。

结构：`tools: [ { functionDeclarations: [tool1] }, … ×14 ]`。

每个 tool 的 `parameters.properties` **一律**含：

- `toolAction` (STRING) — 必填：2–5 词，句子式大写开头  
- `toolSummary` (STRING) — 必填：2–5 词名词短语  

`required` 至少含 `toolSummary`, `toolAction`（再加业务字段）。

### 6.1 工具表 + Claude 桥接

| 原生 | 关键参数（PascalCase，除 search_web） | → Claude | P0? |
|------|--------------------------------------|----------|-----|
| `view_file` | `AbsolutePath`, `StartLine?`, `EndLine?`, `IsSkillFile?` | **Read** | **P0** |
| `write_to_file` | `TargetFile`, `Overwrite`, `CodeContent`, `Description`, `ArtifactMetadata?` | **Write** | **P0** |
| `replace_file_content` | `TargetFile`, `Instruction`, `Description`, `AllowMultiple`, `TargetContent`, `ReplacementContent`, `StartLine`, `EndLine`, … | **Edit** | **P0** |
| `multi_replace_file_content` | `TargetFile`, `Instruction`, `Description`, `ReplacementChunks[]`, … | 多次 Edit | P1 |
| `run_command` | `CommandLine`, `Cwd`, `WaitMsBeforeAsync` | **Bash** | **P0** |
| `list_dir` | `DirectoryPath` | **Bash**（CC 无 `LS`，见 `wire-reference.md` §3.1） | **P0** |
| `grep_search` | `SearchPath`, `Query`, `CaseInsensitive?`, `IsRegex?`, `MatchPerLine?`, `Includes?` | **Bash + rg**（CC 无 `Grep`） | **P0** |
| `read_url_content` | `Url` | **WebFetch** | P1 |
| `search_web` | `query`, `domain?`（**小写**） | WebSearch | P1 |
| `ask_question` | `questions[]` | 映射/拒绝 | P2 |
| `manage_task` | `Action`, `TaskId?`, `Input?` | 后台任务 | P2 |
| `browser_subagent` | `TaskName`, `Task`, `TaskSummary`, `RecordingName`, … | 拒绝/降级 | P2 |
| `generate_image` | `Prompt`, `ImageName`, `ImagePaths?` | 拒绝/降级 | P2 |
| `schedule` | `CronExpression?` / `DurationSeconds?`, `Prompt?` | 拒绝/降级 | P2 |

本抓包 **实际调用过**：`list_dir`, `view_file`, `write_to_file`, `run_command`。

### 6.2 参数细节（实现必对）

**view_file** required: `AbsolutePath`, `toolSummary`, `toolAction`  
可选：`StartLine`/`EndLine`（1-indexed inclusive）。

**write_to_file** required: `TargetFile`, `Overwrite`, `CodeContent`, `Description`, `toolSummary`, `toolAction`  
新建默认；覆盖必须 `Overwrite=true`。

**run_command** required: `Cwd`, `WaitMsBeforeAsync`, `CommandLine`, `toolSummary`, `toolAction`  
抓包例：`WaitMsBeforeAsync=10000`。desc 写明 OS=mac Shell=zsh；**禁止提议 cd**。

**replace_file_content** required: `TargetFile`, `Instruction`, `Description`, `AllowMultiple`, `TargetContent`, `ReplacementContent`, `StartLine`, `EndLine`, `toolSummary`, `toolAction`。

**grep_search** required: `SearchPath`, `Query`, `toolSummary`, `toolAction`。

### 6.3 functionResponse（抓包）

统一：

```json
{
  "role": "model",
  "parts": [{
    "functionResponse": {
      "name": "view_file",
      "id": "<与 FC 相同 id>",
      "response": {
        "output": "Created At: 2026-08-08T09:01:11Z\nCompleted At: 2026-08-08T09:01:11Z\n…"
      }
    }
  }]
}
```

| tool | output 形态（样本） |
|------|---------------------|
| `list_dir` | 时间戳 + 每行 JSON 文件元数据 + `Summary: This directory contains N…` |
| `view_file` | 时间戳 + `File Path: file:///…` + Total Lines/Bytes + 带行号正文 `N: line` |
| `write_to_file` | 时间戳 + `Created file file:///… with requested content.` + 可选后续提示 |
| `run_command` | 时间戳 + success/fail 叙述 + `Output:` + 可能 `<truncated N lines>` |
| 错误 | 时间戳 + `Error invalid tool call: …`（仍走 `output` 字符串） |

### 6.4 system 约束（注入时对齐，摘录）

- 读文件用 `view_file`，不要靠 shell cat/head  
- 相关 skill 先 `view_file` SKILL.md  
- 不要对未读权威源做猜测  
- `run_command` 异步后须跟进 manage_task / 日志  
- 完整 system ~35k，实现可裁剪但应保留 harness 身份句 + 工具纪律

---

## 7. SSE 响应

```
data: {"response":{…},"traceId":"…","metadata":{…}}
```

`response.candidates[0]`：

- `content.parts`：`thought`+`text` / `text` / `functionCall`（可带 `thoughtSignature`）
- `finishReason`：抓包见 **`STOP`**
- `usageMetadata`：`promptTokenCount`, `candidatesTokenCount`, `totalTokenCount`, `cachedContentTokenCount`, `thoughtsTokenCount`

Proxy → Claude SSE：把原生 FC 映射为 Claude `tool_use`（名+input schema），**不要**把 `AbsolutePath` 原样甩给 CC。

---

## 8. tool-bridge 规格

### 8.1 原则

1. 上游 **只**见 14 原生 tools  
2. 双向映射 call 参数 + result→`{output}`  
3. Write 路径限制在 `WORKSPACE_ROOT`  
4. 一轮可多 FC → 多 tool_use；等齐 result 再请求  
5. 历史用 **原生** FC/FR + model role 布局 + 保留 thoughtSignature  

### 8.2 最小映射（P0）

| 方向 | 规则 |
|------|------|
| `view_file` → Read | `AbsolutePath`→`file_path`；Start/EndLine→offset/limit 近似 |
| Read result → FR | 组装带行号/路径的 `output` 文本（对齐 IDE 风格，至少可读） |
| `run_command` → Bash | `CommandLine`→`command`；尊重 `Cwd` |
| Bash result → FR | stdout/stderr/exit 合成 `output` |
| `write_to_file` → Write | `TargetFile`/`CodeContent`；强制路径护栏；`Overwrite` 语义 |
| `list_dir` → **Bash** | 一行 `python3 -c` 复刻 IDE 的 JSON 行输出 |
| `grep_search` → **Bash** | `rg -nH --no-heading [-F][-i][-g …] -- <Query> <SearchPath> \| head -50`；Query 必须 shell 引用 |
| `replace_file_content` → Edit | `TargetContent`→`old_string`，`ReplacementContent`→`new_string` |
| 未知 / P2 tool | 明确 error `output` 或 headless 拒绝 |

`toolAction` / `toolSummary`：桥接时由 proxy **生成**（短英文），不要依赖 Claude 填原生字段。

### 8.3 多轮状态机

```
POST streamGenerateContent
  → SSE：text / thinking / functionCall*
  → 有 FC：映射 tool_use，本 HTTP 结束 stop_reason=tool_use，登记 pending
  → 客户端 tool_result
  → contents += model FR{output}（及必要 FC 历史）
  → 再 POST
  → 直到无 FC 且 end_turn
```

---

## 9. 伴生 RPC（指纹，P1）

### 9.1 `recordCodeAssistMetrics`

```json
{
  "project": "…",
  "requestId": "uuid",
  "metadata": {
    "ideType": "ANTIGRAVITY",
    "ideVersion": "2.1.1",
    "platform": "DARWIN_ARM64"
  },
  "metrics": [{
    "timestamp": "RFC3339",
    "conversationOffered": {
      "status": "ACTION_STATUS_NO_ERROR",
      "traceId": "…",
      "streamingLatency": { "firstMessageLatency": "…s", "totalLatency": "…s" },
      "isAgentic": true,
      "initiationMethod": "AGENT",
      "trajectoryId": "…",
      "language": "unspecified"
    }
  }]
}
```

### 9.2 `listExperiments`

本包 body 为 **`{}`**，仍带同一套 Bearer + UA。

实现：最小可先不做；防识别增强时按 IDE 节奏补发。

---

## 10. 模型

上游模型目录以 `POST /v1internal:fetchAvailableModels` 为准，事实记录见 [`fetch-available-models.md`](./fetch-available-models.md)，完整 014741 响应见 [`fetch-available-models.capture.json`](./fetch-available-models.capture.json)。该响应按 project/账号变化，不能把本次 28 个 id 写成永久常量。

014741 的关键目录字段：

- `defaultAgentModelId = gemini-3.7-flash-high`
- `models` 有 28 个键；每个模型有 `model` enum、`apiProvider`、`modelProvider`、`quotaInfo`
- agent 推荐排序有 14 个 id；`tabModelIds` 为 `chat_20706` / `chat_23310`
- `deprecatedModelIds` 将 `gemini-3.1-pro-high` 指向 `gemini-pro-agent`

对外 `/v1/models` 每次用当前 token 的 project 调用该 RPC，再把 `models` 对象键映射为 `data[].id`；不再使用固定模型列表。`DEFAULT_MODEL` 仍只作为 `/v1/messages` 未指定 model 时的默认值。

---

## 11. 错误 / Token

- Base 回退 daily↔prod  
- 429 分类；缺 project → loadCodeAssist  
- Token 刷新写独立 `token.json`，避免与 IDE 抢 refresh  
- 无效 `thoughtSignature`：丢弃，勿伪造  

---

## 12. 对外 HTTP API

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/v1/messages` | Anthropic；tool 多轮 |
| GET | `/v1/models` | 模型列表 |
| GET | `/health` | 健康检查 |

环境变量草案：`PORT` / `HOST` / `API_KEY` / `TOKEN_FILE` / `DEFAULT_MODEL` / `WORKSPACE_ROOT` / `REQUEST_TIMEOUT` / `ANTIGRAVITY_BASE` / `IDE_VERSION`

CLI：`extract-token` / 前台 / `start|status|stop`

---

## 13. 实现 Checklist

### P0

- [ ] `extract-token` + refresh + `project_id`
- [ ] Envelope：daily base、UA `antigravity/ide/2.1.1 darwin/arm64`、`requestId` 格式、`sessionId`、`requestType=agent`
- [ ] 注入 14 原生 tools（见 `native-tools.capture.json`）+ `VALIDATED`
- [ ] `generationConfig` thinkingBudget=-1 / maxOutputTokens=65536
- [ ] system 对齐 harness（短版可接受，须含工具纪律）
- [ ] SSE 客户端
- [ ] tool-bridge：view_file / run_command / write / replace / list_dir / grep_search
- [ ] FR 一律 `{output}` + **model role** 历史
- [ ] pending-session
- [ ] `POST /v1/messages` + `/health`
- [ ] Write 路径护栏

### P1

- [ ] labels / trajectory 元数据
- [ ] recordCodeAssistMetrics / listExperiments
- [ ] thoughtSignature 原样回放
- [ ] multi_replace / read_url / search_web
- [x] 动态模型列表（`fetchAvailableModels` → `/v1/models`）、429

### P2

- [ ] browser / image / schedule / manage_task / ask_question
- [ ] tab / checkpoint

### 禁止

- [ ] Claude `tools[]` 原样上传  
- [ ] args 不映射  
- [ ] UA `hub/2.2.1` 或 schema `reason` placeholder  

---

## 14. 抓包前后文档 diff（本次校准）

| 旧文档假设 | 抓包事实 |
|------------|----------|
| 默认 base 优先 prod | 本会话 **全部 daily** |
| toolConfig 倾向 AUTO | agent = **VALIDATED**；checkpoint = NONE |
| requestId `agent-<uuid>` | `agent/{uuid}/{ms}/{uuid}/{n}` |
| FR 在 user 轮 | FR 在 **model** 轮 |
| FR schema 未定 | **`{output: string}`** |
| UA 模糊 | **`antigravity/ide/2.1.1 darwin/arm64`** |
| tools 列表不完整 | **固定 14**，见 JSON 导出 |
| VALIDATED=CLIProxy 指纹 | **IDE agent 也用 VALIDATED** |
| 缺伴生 RPC 列表 | **metrics + listExperiments** 高频 |

### 仍开放

1. prod 流量何时出现（设置/账号/渠道）  
2. TLS/JA3 是否与 Node/Go 可区分  
3. 全量 system 是否必须一字不差  
4. labels.model_enum 与 wire model 映射表  
5. 更丰富 FR（非 output-only）是否在其他 tool 出现  

---

## 附录 A — 路径

```
IDE:     /Applications/Antigravity IDE.app
LS:      …/extensions/antigravity/bin/language_server_macos_arm
DB:      ~/Library/Application Support/Antigravity IDE/User/globalStorage/state.vscdb
Capture: …/Surge Catpure/2026-08-08-170054
Tools:   docs/native-tools.capture.json
cursor:  /Users/cddchen/Documents/cursoride2api/src/
CLIProxy: envelope/OAuth/SSE 事实 only
```

## 附录 B — 废弃

~~路径 A：Claude tools[] 透传~~ **废弃**（封号风险 + 与 cursoride2api 目标冲突）。

---

**总判：** `antigravityide2api` = **抓包对齐的 IDE agent envelope + 14 原生 tools + tool 语义桥 + pending 多轮 + extract-token**。
