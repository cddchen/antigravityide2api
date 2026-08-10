# antigravityide2api P0 实现计划

## Context

要把本机 **Antigravity IDE → cloudcode-pa** 的 agent 流程导出为 Claude Code 可用的 **`POST /v1/messages`**，对标 `cursoride2api` 的产品形态（语义桥 + pending 多轮 + extract-token），**禁止** CLIProxy 式「Claude `tools[]` 透传」。

现状：仓库只有调研文档与抓包校准产物，无代码。

- **接线总纲：`docs/wire-reference.md`** ← 编码时先看这份，所有断言均对夹具校验通过
- 规格：`docs/Antigravity-IDE-API.md`
- 上游信封骨架：`docs/ag-envelope.capture.json`（22 条 contents，9 FC/9 FR）
- 上游 system：`docs/ag-system.capture.txt`（脱敏后 35528 字符 / wire 35570）+ `docs/ag-system.sections.json`（15 段 offset 索引）
- 原生 tools：`docs/native-tools.capture.json`（14 tools）
- CC 出站实录：`docs/cc-request.capture.json`（wire **87835 B**，已脱敏，落盘少 69 B）
- 转换原型：`docs/leakcheck.prototype.mjs`（转换 + 44 词扫描，读同目录夹具，exit=0）

**尺寸度量约定**：CC 侧一律 `json.dumps(o, separators=(',',':'), ensure_ascii=False)` 后取 UTF-8 字节。默认参数会虚高上千字节。
- 风控：`docs/cliproxy-vs-ide-fingerprint.md`、`implementation-notes.md`
- 产品壳参考：`/Users/cddchen/Documents/cursoride2api/src/{cli,server,pending-session,anthropic-stream,extract-token,config,token-paths}.ts`
- 传输事实参考（非工具路径）：CLIProxy `antigravity` OAuth constants / refresh / `loadCodeAssist` body 形状

## 推荐方案

**TypeScript + Express + 进程内 pending**，目录与 CLI 体验对齐 cursoride2api；上游用 **抓包对齐的 IDE agent envelope + 14 原生 tools + SSE multi-turn HTTP**（非 BiDi）。

```
Claude Code  /v1/messages
        │
        ▼
  server (express)  ── ignore client tools[]
        │
        ├─ first turn  → antigravity-client.streamGenerate
        │                    envelope + native tools + system
        │                    SSE → text / thought / functionCall*
        │
        ├─ functionCall → tool-bridge → Claude tool_use
        │                 pending 存完整原生 contents 历史
        │
        └─ tool_result  → functionResponse{output} (role=model)
                          再 POST 直到 end_turn
```

### 明确不做（P0）

- Claude tools 透传 / schema `reason` placeholder
- 独立浏览器 OAuth 主路径（`localhost:51121`）
- 多号农场 / 429 换号池（可单 token + 热更新）
- `recordCodeAssistMetrics` / `listExperiments`（P1）
- browser / image / schedule / manage_task / ask_question 真执行（统一 error `output`）
- 完整 35k system 一字不差（**裁剪版 ~8k harness** 即可，见「system 处理」）
- tab / checkpoint requestType
- 强制 HTTP/1.1 ALPN 伪装（用 Node 默认 fetch/http）

## 模块与文件

新建（对齐 cursor，但更瘦）：

| 文件 | 职责 |
|------|------|
| `package.json` / `tsconfig.json` | name `antigravityide2api`，node≥18，express+cors+uuid，scripts 同 cursor 风格 |
| `README.md` | 快速开始 / env / 免责声明 |
| `token.json.example` | tokens[] 形状 |
| `src/cli.ts` | 前台 / `start\|stop\|status` / `extract-token`（抄 cursor `cli.ts` 骨架，改文案与路径） |
| `src/token-paths.ts` | `~/.antigravityide2api/token.json`，chmod 0600 |
| `src/config.ts` | base、UA、default model、timeouts、ideVersion |
| `src/types.ts` | Token、PendingAgentSession、SSE 事件、Anthropic 最小类型 |
| `src/extract-token.ts` | sqlite3 读 `state.vscdb` key `antigravityUnifiedStateSync.oauthToken`；嵌套 base64 扫描 `ya29.*` / `1//.*`；`storage.json` machineId；写 token 文件 |
| `src/auth.ts` | Google refresh（client_id/secret 与 IDE 同源常量）；`loadCodeAssist` 取/缓存 `project_id`；401 时刷新 |
| `src/native-tools.ts` | `require('../docs/native-tools.capture.json')` 或 build 时拷贝进 dist；导出 14-entry tools 数组（`ask_question` `browser_subagent` `generate_image` `grep_search` `list_dir` `manage_task` `multi_replace_file_content` `read_url_content` `replace_file_content` `run_command` `schedule` `search_web` `view_file` `write_to_file`） |
| `src/system-prompt.ts` | **丢弃 CC system[]，抽 5 值重建 Antigravity harness**（见「system 处理」与 `docs/wire-reference.md#三转换cc--antigravity`）；原文读 `docs/ag-system.capture.txt`，分段 offset 读 `docs/ag-system.sections.json` |
| `scripts/assert-no-cc-leak.mjs` | 关键词黑名单扫描转换后的 systemInstruction + contents + tools；由 `docs/leakcheck.prototype.mjs` 产品化 |
| `src/antigravity-client.ts` | 组 envelope、SSE 解析、`streamGenerate`、错误分类 |
| `src/tool-bridge.ts` | 原生 FC ↔ Claude tool_use；tool_result → `{output}`；生成 toolAction/toolSummary |
| `src/pending-session.ts` | Map 存会话（非 BiDi 帧，存 contents+ids） |
| `src/anthropic.ts` | 请求解析、tool_result 提取、SSE writer、message JSON 响应（合并 cursor anthropic-converter + anthropic-stream 的最小子集） |
| `src/server.ts` | `/health` `/v1/models` `/v1/messages` + API_KEY + token 热加载 |
| `scripts/smoke-bridge.mjs` | 无网络：envelope/tools 形状 + bridge 映射自检 |

实现中维护 `implementation-notes.md`（偏离/权衡）。

## 关键实现细节（以抓包为准）

### Token 文件

```json
{
  "tokens": [{
    "name": "account-1",
    "accessToken": "ya29...",
    "refreshToken": "1//...",
    "projectId": "fluent-falcon-...",
    "expiresAt": 0,
    "machineId": "..."
  }]
}
```

- 写盘 `mode 0o600`；日志只打 token 前后 4 位。
- refresh：`POST https://oauth2.googleapis.com/token`（grant_type=refresh_token）；**不回写 IDE vscdb**。
- `projectId` 空则 `POST {base}/v1internal:loadCodeAssist` body `{"metadata":{"ideType":"ANTIGRAVITY","ideVersion":"2.1.1","platform":"DARWIN_ARM64"}}`（platform 按 `process.platform/arch` 映射），解析响应里 project 字段（实现时以实际 JSON 路径为准，兼容 `cloudaicompanionProject` / `project` 等）。

### extract-token

1. DB 路径：`~/Library/Application Support/Antigravity IDE/User/globalStorage/state.vscdb`（darwin；linux/win 对称探测）
2. `sqlite3 ... SELECT value FROM ItemTable WHERE key='antigravityUnifiedStateSync.oauthToken'`
3. 已验证：外层 base64 → 嵌套 base64 BFS → 可扫到 **1× ya29 + 1× 1//**
4. 无 sqlite3 / 未登录 → 清晰报错

### HTTP / Envelope

> 源：`docs/ag-envelope.capture.json`；完整解读见 `docs/wire-reference.md` §1.2

| 项 | 值 |
|----|-----|
| Base 默认 | `https://daily-cloudcode-pa.googleapis.com`（`ANTIGRAVITY_BASE` 可覆盖；失败可试 prod） |
| Path | `/v1internal:streamGenerateContent?alt=sse` |
| UA | `antigravity/ide/{IDE_VERSION} {os}/{arch}` → 默认 `2.1.1` + `darwin/arm64` |
| body.userAgent | `antigravity` |
| requestType | `agent` |
| requestId | `agent/{cascadeUuid}/{Date.now()}/{trajectoryUuid}/{step}`，step 递增 |
| sessionId | 稳定 **负 int64 字符串**（每 conversation 一次 `randomInt` 映射为负） |
| toolConfig | `VALIDATED` |
| generationConfig | `maxOutputTokens: 65536`, `thinkingConfig: {includeThoughts:true, thinkingBudget:-1}` |
| tools | **原样 14 段** `[{functionDeclarations:[one]}, …]`，来自 capture JSON |
| labels | P0 最小集 **已实证 200**：`trajectory_id`、`last_step_index`、`used_claude:"false"`；`model_enum` 可省 |
| systemInstruction | `role: "user"`（**不是** `system`）；**短版 ~300 字已实证可用**，不需要 35k 全文 |

### system 处理（已抓 CC 真实出站 body 校准）

> 源：`docs/cc-request.capture.json` + `docs/ag-system.sections.json`；可运行原型 `docs/leakcheck.prototype.mjs`；见 `docs/wire-reference.md` §2 §3

抓包方法：`~/.claude/settings.json` 的 `env` **优先级高于 shell export**，必须 `CLAUDE_CONFIG_DIR=/tmp/ccconf` 隔离，再把 `ANTHROPIC_BASE_URL` 指向本地 sink。单轮 `hi` 出站 **87835 B**。

**CC 实际发的（claude-cli/2.1.204）：**

| 位置 | 大小 | 处置 |
|------|------|------|
| `system[0]` `x-anthropic-billing-header: cc_version=…` | 74 | ✗ 丢 |
| `system[1]` `You are a Claude agent, built on Anthropic's Claude Agent SDK.`（TUI 入口则是 `You are Claude Code, Anthropic's official CLI for Claude.`） | 62 | ✗ 丢 |
| `system[2]` 正文（`# Harness` / `# Session-specific guidance` / `# Memory` / `# Environment` / `# Context management`） | 5618 | ✗ 丢正文，**只抠 4 值** |
| `tools[]` 25 个（Agent/Bash/CronCreate/DesignSync/Workflow/EnterWorktree/…） | **73476 字符 / 73847 B（占 body 84.1%）** | ✗ 丢，换 14 原生声明 |
| `messages[i].role=="system"`（`mid-conversation-system-2026-04-07` beta，agent types 清单） | 6600 | ✗ 丢（上游 contents 只认 user/model） |
| `messages[0]` `<system-reminder>` 内 `# claudeMd` | 变长 | ✓ **抽出** → `<user_rules>` |
| 其余 `<system-reminder>` | — | ✗ 每轮剥离（复用 cursor `anthropic-converter.ts:361`） |

**抽取表（唯一允许穿越边界的 5 个值）：**

| 从哪抠 | 正则 | 填到哪 |
|---|---|---|
| `system[2]` | `/^ - Primary working directory:\s*(\S+)$/m` | `<user_information>` 的 `[URI] -> [CorpusName]` |
| `system[2]` | `/^ - Platform:\s*(\S+)$/m`（`darwin→mac`/`win32→windows`/`linux→linux`） | `The USER's OS version is {x}.` |
| `system[2]` | `/^ - Is a git repository:\s*(\S+)$/m` | `<user_information>` 追加一行 |
| `system[2]` | `/^ - Additional working directories:\n((?:  - .+\n)+)/m` ← **必须 2 空格字面量，不能 `\s+`** | 追加 URI→CorpusName 行 |
| `messages[0]` | `` /# claudeMd\n([\s\S]*?)(?=\n# (?:currentDate|userEmail|attachedProject|gitStatus|directoryStructure)\n|\n\s+IMPORTANT: this context)/ `` ← **不能用裸 `\n# `** | `<user_rules>`（置于 `<guidelines>` 后） |

`CorpusName` 上游只当标签，取 `basename(dirname)+"/"+basename`（IDE 原值 `cddchen/NoteAnywhere` 即此形状）。

**三个已实测踩到的坑（首版正则全中，扫描 exit=1）：**

1. **`\s+` 吃穿缩进层级。** `# Environment` 是两级缩进（` - key:` / `  - value`），`(?:\s+- .+\n)+` 会一路吞掉后续的 ` - Platform:` ` - Shell:` ` - You are powered by the model…` ` - Claude Code is available as a CLI…` ` - Fast mode for Claude Code…`，把 CC 的模型清单和产品介绍原样塞进 `<user_information>`。→ 锚定 2 空格字面量。
2. **CLAUDE.md 正文自带 `#` 标题。** 前瞻 `(?=\n# )` 会被正文首行 `# CLAUDE.md` 截断，`<user_rules>` 抽出空串。→ 前瞻只匹配**已知节名白名单**。
3. **CC 的包装头会跟着漏。** claudeMd 段前两行是 CC 模板（`Codebase and user instructions are shown below…` + `Contents of /Users/cddchen/.claude/CLAUDE.md (user's private global instructions…):`），后者带 `.claude` 路径。→ 两条 `replace` 剥掉再包 `<user_rules>`。

另：`cwd` 是 `/private/tmp/ccprobe` 而 additional 里是 `/tmp/ccprobe`（同一目录的 symlink），需按 `fs.realpathSync` 去重，否则 `<user_information>` 报 "2 active workspaces" 指向同一处。

**组装（裁剪版 ~8k）：**

```
identity(721 原样) + buildUserInformation(4值) + ephemeral_message(312 原样)
+ guidelines(5584 原样) + communication_style(1101，改：删 file:// 链接规则与后台任务规则)
+ <user_rules>(claudeMd)
```

（字符数含首尾标签；只取内容则 698 / 271 / 5557 / 1056。）

丢掉 10 段共 **27158** 字符：`web_application_development` `customizations` `skills` `messaging` `knowledge_items` `conversation_transcript` `artifacts` `slash_commands` `planning_mode` `planning_mode_artifacts`（全部引用 IDE 侧不存在的设施）。核对：保留 8356 + 丢弃 27158 + 14 个段间换行 = 35528 ✅。`ANTIGRAVITY_SYSTEM=full|trimmed|short` 可切。

**三个必错点：**

1. `# Memory` 段必须丢 —— 2100 字符指示模型往 `~/.claude/projects/…/memory/` 写文件，泄漏则模型会用 `write_to_file` 在 `WORKSPACE_ROOT` 外产生真实副作用。
2. `messages` 中 `role:"system"` 只能丢，不能转 user。
3. claudeMd 只在**首轮**出现 —— 必须在剥 `<system-reminder>` **之前**抽走并缓存进 pending，否则续轮 `<user_rules>` 变空。

### contents 历史（易错，已用真实调用验证）

> 源：`docs/ag-envelope.capture.json` → `contentsSkeleton`（22 条实录）；见 `docs/wire-reference.md` §1.3

- 用户消息包装：`<USER_REQUEST>\n...\n</USER_REQUEST>` + 可选 local time metadata（短）
- **FC 与 FR 均 `role: "model"`**
- FR：`{ name, id, response: { output: string } }`
- **`thoughtSignature` 是硬性必填**（实证）：缺失 → `400 INVALID_ARGUMENT "Function call is missing a thought_signature in functionCall parts"`。
  必须在 pending 中持久化每个 FC part 的 signature 并**原样回放**。~~无效则丢弃~~ 会直接让会话死掉。
- **并行 FC 必须合并进同一个 `role:model` content 的 parts 数组**（实证）：
  一次 SSE 只给**第一个** FC part 带 signature；若按抓包的「一 FC 一 content」拆开，第二个 FC 无 sig → 400。
  抓包呈现成对拆分只是因为 IDE 每轮串行只发 1 个 FC。
  → 规则：**一次 SSE 的所有 FC parts 原样进一个 model content；对应所有 FR parts 进下一个 model content。**
- 客户端 Claude `tools[]`：**不上传**

### tool-bridge P0

> 原生 schema：`docs/native-tools.capture.json`；实录 FC args 与完整映射见 `docs/wire-reference.md` §1.3 / §1.3.1 / §3.1

**方向是上游→CC**：上游发原生 FC，桥接翻成 CC **实际持有**的工具。CC 25 个工具里**没有 `LS`/`Grep`/`Glob`**（已对夹具断言），故 `list_dir`/`grep_search` 只能落 `Bash`。

| 原生 | Claude | call 映射 | result → output |
|------|--------|-----------|-----------------|
| `view_file` | Read | `file_path←AbsolutePath`；`offset←StartLine`；`limit←EndLine-StartLine+1` | `File Path: \`file://…\`` + `Total Lines:` |
| `run_command` | Bash | `command← cd <sq(Cwd)> && <CommandLine>`；`timeout←WaitMsBeforeAsync`(≤10000)；`description←toolAction` | 4-tab 缩进的 `The command completed successfully.` 块 |
| `write_to_file` | Write | `file_path←TargetFile`；`content←CodeContent`。**`Overwrite` 发 boolean 跟 schema** —— 「IDE 实发字符串」无夹具支撑（skeleton 省略了参数值），报 `invalid_args` 再改字符串并存夹具 | `Created file file://… with requested content.` |
| `replace_file_content` | Edit | `old_string←TargetContent`；`new_string←ReplacementContent`；`replace_all←AllowMultiple` | 同上 |
| `list_dir` | **Bash** | 一行 `python3 -c` 复刻 IDE 的 JSON 行格式（`ls -la` 不同构） | 每行 `{"name":…,"sizeBytes":"…"}` / `{"name":…,"isDir":true}` |
| `grep_search` | **Bash** | `rg -nH --no-heading [-F] [-i] [-g …] -- <sq(Query)> <sq(SearchPath)> \| head -50` | 每行 `{Filename,LineNumber,LineContent}` |
| 其余 8 个 | — | 不主动产生；上游调用 → FR error output | |

**grep_search 三个必做点**（均已本地实测，见 §3.1）：

1. **`-H` 不能省** —— SearchPath 是单文件时 rg 默认不打文件名，FR 的 `Filename` 会丢。
2. **`| head -50` 而非 `--max-count 50`** —— 后者是 per-file，IDE 声明的是 total 50。
3. **Query/SearchPath/Includes 必须 shell 引用** —— CC 的 `Bash.command` 是字符串不是参数数组，`Query` 又直接来自上游模型输出。`sq = s => "'" + s.replace(/'/g, "'\\''") + "'"`；实测 `-- '$(id)'` 匹配到字面量而未执行。

**FR 回填**：套 §1.3.1 的两行时间戳前缀（`Created At:` / `Completed At:`）。失败样本证明 **无 `Completed At:` 行 = 失败**。`rg` 无匹配时 exit 1，须据 stdout 为空判 0 matches，别当错误。

- `toolAction` / `toolSummary`：bridge **本地生成**英文短句，不依赖 CC。
- Write/Edit：`path.resolve` 后必须在 `WORKSPACE_ROOT` 下，否则 error output。
- tool_use id：可用上游 FC `id` 或 `toolu_*`；pending 双向映射。

### pending-session（与 cursor 的差异）

Cursor pending 绑 BiDi `writeFrame`；这里 **无长连接**：

```ts
PendingAgentSession {
  claudeToolIds: string[]           // 本轮等待的 tool_use ids
  nativeByClaudeId: Map<...>        // name/id/args
  pendingFcParts: Part[]            // 本轮 SSE 原样 FC parts（含 thoughtSignature）——必存，缺则 400
  sessionId, cascadeUuid, trajectoryUuid, stepIndex
  contents: Content[]               // 已发生的原生历史（含 FC）
  projectId, model, tokenName
  createdAt, timer
}
```

流程：

1. `/v1/messages` 无 tool_result → 新 session → stream → 若有 FC：写 Claude tool_use(s)，**register pending（含原样 FC parts）**，`stop_reason=tool_use`
2. 下一请求带 tool_result(s) → `getPending` → push `{role:'model', parts: pendingFcParts}` + `{role:'model', parts: FR[]}` → 再 stream → 循环
3. 超时 / 未知 tool_use_id → 400/清理

并行多 tool_use：单次 SSE 多 FC → 一条 message 多块 tool_use；resume **必须等齐**再 POST（既对齐 cursor 批 resume，也因为 FC parts 只能整组回放，不能按 sig 拆）。

### 对外 API

| 路由 | 行为 |
|------|------|
| `GET /health` | ok + token 数量（无密钥） |
| `GET /v1/models` | 静态/配置列表（P0：`gemini-3.6-flash-high` 等）；P1 再 `fetchAvailableModels` |
| `POST /v1/messages` | Anthropic 兼容 stream/非 stream + tool 多轮 |

Env：`PORT` `HOST` `API_KEY` `TOKEN_FILE` `DEFAULT_MODEL` `WORKSPACE_ROOT` `REQUEST_TIMEOUT` `PENDING_TIMEOUT` `ANTIGRAVITY_BASE` `IDE_VERSION`

### 从 cursoride2api **复用模式**（复制改写，非依赖包）

- `cli.ts` daemon 生命周期
- `token-paths` / token 热加载
- `AnthropicSseWriter` 状态机
- `pending-session` Map + timeout
- `/v1/messages` 路由分支：resume vs first turn

**不要**复制：`cursor-client` BiDi、`exec-bridge`、`tool-bridge` 的 Cursor schema、`generated/exec-protocol`。

**不要**复制 CLIProxy：`ConvertClaudeRequestToAntigravity`、schema cleaner。

## 实现顺序

1. **脚手架**：package.json、tsconfig、config、token-paths、types、README 骨架  
2. **extract-token + auth refresh + loadCodeAssist**（可单独 CLI 验证）  
3. **native-tools + system-prompt + antigravity-client**（单轮无 tool 文本）  
4. **tool-bridge + pending + server /v1/messages**（P0 六工具闭环）  
5. **cli daemon** + smoke 脚本  
6. 更新 `implementation-notes.md`（实现偏离）

## 验证

1. `npm i && npm run build`  
2. `node dist/cli.js extract-token` → `~/.antigravityide2api/token.json` 含 access/refresh（0600）；控制台不回显完整 token  
3. `node dist/cli.js` → `curl localhost:3000/health`  
4. 无 tool 单轮：  
   `curl /v1/messages -d '{"model":"gemini-3.6-flash-high","max_tokens":256,"messages":[{"role":"user","content":"ping"}]}'`  
   期望 200 文本或明确上游错误（401/缺 project 应触发 refresh/load 路径）  
5. `node scripts/smoke-bridge.mjs`：  
   - tools 数组长度 14、每项 1 declaration、含 toolAction/toolSummary  
   - view_file↔Read、run_command↔Bash 参数往返  
   - FR role=model 且 shape=`{output}`  
   - requestId 格式正则  
   - **多 FC 合并成一个 model content**（回归上面的 400 陷阱）  
   - **resume 的 FC parts 保留 thoughtSignature**  
6. `node scripts/assert-no-cc-leak.mjs`：对**转换后**的 envelope（systemInstruction + contents + tools）做关键词黑名单扫描，命中任一即非 0 退出：
   - 身份：`Claude Code`、`Anthropic`、`Claude Agent SDK`、`claude-cli`、`cc_version`、`cc_entrypoint`
   - 标题：`# Harness`、`# Session-specific guidance`、`# Memory`、`# Environment`、`# Context management`
   - 机制：`<system-reminder`、`claudeMd`、`cache_control`、`anthropic-beta`
   - 路径：`.claude/projects`、`~/.claude`
   - CC 工具名（**全词匹配**，避开 `Read`/`Write`/`Edit`/`Agent`/`Skill` 这类会误伤自然英文的短词，见下）
   夹具：`docs/cc-request.capture.json`（wire 87835 B 真实 body，**已入库并脱敏** `metadata.user_id` 的 device_id/session_id）。原型 `docs/leakcheck.prototype.mjs` 直接读同目录夹具，`node docs/leakcheck.prototype.mjs` 任意 cwd 可跑，exit=0。
6. （可选）对本机已登录账号跑 Read 工具一轮：CC 或手写 tool_use/tool_result 续轮  

## 风险与默认策略

| 风险 | 策略 |
|------|------|
| loadCodeAssist 响应字段名漂移 | 多路径解析（`cloudaicompanionProject`/`projectId`/`project`）+ 日志（无密钥）。**已实证** daily/prod 均返回 `cloudaicompanionProject` |
| ~~上游拒绝短 system~~ | **已证伪**：~300 字短 system 正常返回 functionCall，不需要 35k |
| ~~thoughtSignature 剥离重试~~ | **已证伪**：剥离 = 必 400。必须持久化回放；signature 丢失只能重开会话 |
| 并行 FC 拆 content | 禁止；整组回放（见「contents 历史」） |
| 与 IDE 抢 refresh | 只写独立 token.json；refresh_token 复用不使 IDE 失效（实证刷新后 IDE 侧未受影响） |
| 封号 | 原生 tools only；UA/ide；不透传 CC schema |
| CC 关键词泄漏 | 每次组包后过 `assert-no-cc-leak`；**主要风险面是 `tools[]` 73847 B（system 仅 5788 B）**，丢 tools 消掉 **84.1%**，加上 mid-conv system + system[] 共消掉 **98.2%** |
| 短词黑名单误伤 | `Read`/`Write`/`Edit`/`Agent`/`Skill`/`Bash` 等在 Antigravity harness 与用户正文里天然出现 → 只对**独有词**做子串匹配（`CronCreate`/`DesignSync`/`EnterWorktree`/`ExitWorktree`/`ScheduleWakeup`/`ReportFindings`/`NotebookEdit`/`TaskCreate`/`SendMessage`/`WebFetch`），其余走 `tools[]` 结构断言（长度 14 + 名字白名单）而非文本扫 |

## 验收标准（P0 done）

- [ ] extract-token 可用  
- [ ] `/v1/messages` 文本多轮可用  
- [ ] 至少 `view_file`/`run_command`/`write_to_file`/`list_dir` 桥接闭环  
- [ ] 上游请求不含 Claude tool 名  
- [ ] README 可按 cursor 方式 `npx`/本地启动  
