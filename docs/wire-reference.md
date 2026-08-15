# Wire Reference — Antigravity 上游 / Claude Code 下游

编码时的单一事实来源。所有断言均来自本目录下的抓包夹具，**不含推测**；每条都标了源文件与定位方式。

## 夹具索引

| 文件 | 内容 | 来源 | 脱敏 |
|------|------|------|------|
| [`ag-envelope.capture.json`](./ag-envelope.capture.json) | 上游请求信封结构 + `contents[]` 骨架（22 条） | Surge `2026-08-08-170054/Requests/922280…streamGenerateContent` 的 `request.dump`（纯 chunked body，**无 HTTP 头**） | 全部 UUID → `<uuid>`；`project` → 占位 |
| [`fetch-available-models.capture.json`](./fetch-available-models.capture.json) | `fetchAvailableModels` 解压后的完整 JSON 响应（28 个模型） | Surge `2026-08-14-204936/Requests/014741…fetchAvailableModels/response.dump` | Authorization 不含；request project → `<projectId from loadCodeAssist>` |
| [`ag-system.capture.txt`](./ag-system.capture.txt) | `systemInstruction` 全文 35528 字符（脱敏后；wire 原值 **35570**） | 同上，`request.systemInstruction.parts[0].text` | 全部 UUID → `<REDACTED-uuid>`（`<user_information>` 的 Conversation ID 与 `<artifacts>` 的 Artifact Directory Path 各一处） |
| [`ag-system.sections.json`](./ag-system.sections.json) | 上文的 15 段 offset/长度索引 | 由 `ag-system.capture.txt` 正则切分生成 | — |
| [`native-tools.capture.json`](./native-tools.capture.json) | 14 个原生 `functionDeclarations` | 同上，`request.tools` | 无需 |
| [`cc-request.capture.json`](./cc-request.capture.json) | Claude Code 真实出站 body **87835 B**（= `headers.content-length`） | 本地 sink，2026-08-09 | `metadata.user_id` 的 device_id/session_id；auth 头 |
| [`leakcheck.prototype.mjs`](./leakcheck.prototype.mjs) | 转换 + 44 词扫描原型；**只读同目录夹具**，`node docs/leakcheck.prototype.mjs` 任意 cwd 可跑 | 手写，exit=0 | — |
| [`Antigravity-IDE-API.md`](./Antigravity-IDE-API.md) | 端点/OAuth/协议总览 | 早期调研 | — |
| [`cliproxy-vs-ide-fingerprint.md`](./cliproxy-vs-ide-fingerprint.md) | CLIProxy 与 IDE 的指纹差异 | 早期调研 | — |

`request.dump` 解析注意：Surge 存的是**纯 chunked body**，开头就是 `209de\r\n{`，没有 HTTP 头（头在同目录 `model.json`）。不能按 `\r\n\r\n` 切头，直接逐块解 chunk：

```python
out=b''; pos=0
while True:
    nl=body.find(b'\r\n',pos)
    n=int(body[pos:nl].split(b';')[0],16)
    if n==0: break
    out+=body[nl+2:nl+2+n]; pos=nl+2+n+2
```

**字节数复现约定。** 本文所有 CC 侧尺寸都按 **wire 序列化**度量：紧凑分隔符 + 不转义非 ASCII，取 **UTF-8 字节**。换成 `json.dumps` 默认参数会多出上千字节（曾据此写出 75549 这个错误值）。

```python
j = lambda o: json.dumps(o, separators=(',',':'), ensure_ascii=False)
len(j(body).encode())        # 87835 == headers['content-length'] ✅
len(j(body['tools']).encode())  # 73847   （字符数 73476）
```

脱敏后的 `cc-request.capture.json` 比 wire 少 **64 B**（`metadata.user_id` 内嵌 JSON 里 `<REDACTED-64hex>` 与 `<REDACTED-uuid>` 各 1 处，同时那串内嵌 JSON 被重排过空格），故直接量得 87771；`headers.content-length` 87835 才是 wire 真值。

---

## 一、上游：Antigravity → cloudcode-pa

### 1.1 HTTP

```
POST /v1internal:streamGenerateContent?alt=sse HTTP/1.1
Host: daily-cloudcode-pa.googleapis.com
Authorization: Bearer ya29.…
User-Agent: antigravity/ide/2.1.1 darwin/arm64
Content-Type: application/json
Transfer-Encoding: chunked
Accept-Encoding: gzip
```

`daily-` 与 prod（`cloudcode-pa.googleapis.com`）均可用，`loadCodeAssist` 在两边都返回同一个 `cloudaicompanionProject`。

### 1.2 信封

顶层 6 键（见 `ag-envelope.capture.json` → `envelope`）：

```jsonc
{
  "project": "<loadCodeAssist 返回的 cloudaicompanionProject>",
  "requestId": "agent/<cascadeUuid>/<epochMs>/<trajectoryUuid>/<step>",
  "model": "gemini-3.6-flash-high",
  "userAgent": "antigravity",
  "requestType": "agent",
  "request": { contents, systemInstruction, tools, toolConfig, labels, generationConfig, sessionId }
}
```

`request` 内固定值：

| 字段 | 值 | 备注 |
|---|---|---|
| `toolConfig` | `{"functionCallingConfig":{"mode":"VALIDATED"}}` | checkpoint 类请求用 `NONE`，agent 恒 `VALIDATED` |
| `generationConfig` | `{"maxOutputTokens":65536,"thinkingConfig":{"includeThoughts":true,"thinkingBudget":-1}}` | |
| `sessionId` | `"-3750763034362895579"` | **负 int64 字符串**，同一 conversation 内稳定（agent/checkpoint/tab 共用） |
| `systemInstruction.role` | `"user"` | **不是 `system`** |
| `tools` | 14 项 `{functionDeclarations:[1 decl]}` | 一项一声明，不是一项 14 声明 |

`labels` 抓包全量 6 键；P0 最小集（`trajectory_id` / `last_step_index` / `used_claude:"false"`）已实证返回 200：

```json
{"last_execution_id":"<uuid>","last_step_index":"33","model_enum":"MODEL_PLACEHOLDER_M71",
 "trajectory_id":"<uuid>","used_claude":"false","used_claude_conservative":"false"}
```

### 1.3 contents[] — 22 条实录骨架

完整骨架见 `ag-envelope.capture.json` → `contentsSkeleton`。形态：

```
[ 0] user   text(430)   <USER_REQUEST>…</USER_REQUEST> + <ADDITIONAL_METADATA> + <USER_SETTINGS_CHANGE>
[ 1] user   text(449)   # Conversation History + <conversation_summaries>
[ 2] model  FC list_dir/tAyN1Fx2      sig=2016
[ 3] model  FR list_dir/tAyN1Fx2      out=549
[ 4] model  FC list_dir/qmOPJWqG      sig=312
[ 5] model  FR list_dir/qmOPJWqG      out=686
…
[12] model  text(556) + text(1506)    第一块是思考文本，第二块是回复正文
[13] user   text(143)                 第二轮用户输入
[14] model  FC view_file/rtP0i2an     sig=3720
…
[18] model  FC write_to_file/loQDNaF7 sig=6848
[19] model  FR write_to_file/loQDNaF7 out=267
[20] model  FC run_command/pHwS2QWh   sig=376
[21] model  FR run_command/pHwS2QWh   out=6425
```

**四条硬规则**（前两条为实证 400 换来）：

1. **FC 与 FR 都是 `role:"model"`**，FR 不是 `role:"user"`/`"function"`。
2. **`thoughtSignature` 必填**。缺失 → `400 INVALID_ARGUMENT: Function call is missing a thought_signature in functionCall parts … position N`。签名长度 244–6848 字符不等，必须持久化后**原样回放**，不可伪造、不可省略。
3. **一次 SSE 的所有 FC parts 必须合并进同一个 `role:"model"` content 的 `parts[]`**。一次 SSE 只有**第一个** FC part 带签名，若按上表的「一 FC 一 content」拆开，第二个 FC 无签名即 400。上表呈现为成对拆分，只是因为 IDE 每轮串行只发 1 个 FC。
4. `thoughtSignature` 是 FC part 的**兄弟键**，不在 `functionCall` 对象内：
   ```jsonc
   { "functionCall": {"id":"tAyN1Fx2","name":"list_dir","args":{…}},
     "thoughtSignature": "EuULCuILARFNMg/…" }
   ```

**part 形状：**

```jsonc
// FC
{"functionCall":{"id":"tAyN1Fx2","name":"list_dir",
  "args":{"DirectoryPath":"…","toolAction":"Listing project directory","toolSummary":"List project contents"}},
 "thoughtSignature":"…"}

// FR
{"functionResponse":{"id":"tAyN1Fx2","name":"list_dir",
  "response":{"output":"Created At: 2026-08-08T09:01:05Z\nCompleted At: 2026-08-08T09:01:05Z\n{json lines}\n\nSummary: …"}}}
```

`response` 只有 `output` 一个键，值是**字符串**，惯例前缀 `Created At:` / `Completed At:` 两行时间戳。

**实录 FC args 键（每个都含 `toolAction`+`toolSummary`）：**

| tool | args |
|---|---|
| `list_dir` | `DirectoryPath` |
| `view_file` | `AbsolutePath`, `StartLine?`, `EndLine?` |
| `write_to_file` | `TargetFile`, `CodeContent`, `Description`, `Overwrite` ← 见下方存疑标注 |
| `run_command` | `CommandLine`, `Cwd`, `WaitMsBeforeAsync` |

`toolSummary` / `toolAction` 在全部 14 个声明的 `required` 里（已断言），桥接侧必须本地生成。

> ⚠️ **`Overwrite` 发字符串 `"False"` 这条无夹具支撑。** `ag-envelope.capture.json` 的 skeleton 只保留了 `argKeys`，**参数值全部省略**（`grep '"False"'` 在 skeleton 里 0 命中）。该结论目前只有 `implementation-notes.md` 的散文记录，无法在库内复核。`native-tools.capture.json` 里 `write_to_file.Overwrite` 明确声明 `"type": "BOOLEAN"`。
> **实现取向**：发 boolean（跟 schema）。若上游报 `invalid_args`，改发 `"False"`/`"True"` 字符串并把响应体存成夹具再来改这里。

**原生 14 工具名**（`native-tools.capture.json` 顺序）：

```
ask_question  browser_subagent  generate_image  grep_search  list_dir
manage_task   multi_replace_file_content  read_url_content  replace_file_content
run_command   schedule  search_web  view_file  write_to_file
```

P0 桥接 6 个：`view_file` `run_command` `write_to_file` `replace_file_content` `list_dir` `grep_search`。其余 8 个仍**上传声明**（少一个就与 IDE 指纹不符），但不主动产生；上游若调用则回 error `output`。

### 1.3.1 FR `output` 实录格式

所有 FR 的 `output` 都是**纯文本**（不是 JSON 对象），统一前缀两行时间戳。这是回填时必须复刻的形状（源：`ag-envelope.capture.json` 的 `outputHead`）：

```
Created At: 2026-08-08T09:01:05Z
Completed At: 2026-08-08T09:01:05Z
<载荷>
```

| tool | 载荷形状 |
|---|---|
| `list_dir` | 每行一个 JSON：`{"name":".DS_Store","sizeBytes":"6148"}` / `{"name":".git","isDir":true}`。**`sizeBytes` 是字符串**；目录不带 size |
| `view_file` | ``File Path: `file:///abs/path` `` + `Total Lines: 512` + `Total By…`（URL 编码非 ASCII：`%E8%BF%9B%E5%BA%A6`） |
| `write_to_file` | `Created file file:///abs/path with requested content.` + `If relevant, proacti…` |
| `run_command` | `\n\t\t\t\tThe command completed successfully.\n\t\t\t\tOutput:\n\t\t\t\t<truncated 275 lines>\n…`（4 个 tab 缩进，超长截断） |
| 失败 | 只有 `Created At:`，第二行换成 `Error invalid tool call: There was a problem parsing the tool call. \nError Message: model output error: invalid tool call error (invalid_args) fail…`（实录 `view_file/nG4KpKW2`） |

失败样本证明：**无 `Completed At:` 行 = 失败**，桥接侧的 error output 照此形状写。

### 1.4 SSE 响应

`data: ` 前缀，JSON 单行，无 `event:`：

```jsonc
data: {"response":{"candidates":[{"content":{"role":"model","parts":[…]},
       "finishReason":null}],
       "usageMetadata":{"promptTokenCount":27155,"candidatesTokenCount":7,
                        "totalTokenCount":27207,"thoughtsTokenCount":45,
                        "cachedContentTokenCount":28608},
       "modelVersion":"gemini-3.6-flash","responseId":"uPB2…"},
       "traceId":"ea302a9a71cac620","metadata":{}}
```

- 每帧都重发**累计** `usageMetadata`，不是增量。
- `modelVersion` 回 `gemini-3.6-flash`（请求发的是 `-high`）。
- 文本流是**增量分片**，直接拼接。
- **末帧固定为空文本 + 独立 `thoughtSignature` + `finishReason:"STOP"`**：
  ```jsonc
  {"parts":[{"thoughtSignature":"EvQBCvEB…","text":""}]},"finishReason":"STOP"
  ```
  解析时不要把这个 `text:""` 当内容，也不要把这个签名误配给 FC。
- FC 轮次极简 —— 实录 `922174` 全程只有 **2 帧**：
  ```
  [0] FC:list_dir/tAyN1Fx2 +sig    finish=None
  [1] text(0)                      finish=STOP
  ```

### 1.5 systemInstruction 15 段

`ag-system.capture.txt`，`role:"user"`，脱敏后 35528 字符（wire 原值 **35570** = 35528 + 2×(36−15)，与 `ag-envelope.capture.json` 的 `_textChars` 一致）。offset 见 `ag-system.sections.json`。

下表 `字符` 列**含首尾标签**（`<identity>` … `</identity>`）。裁剪组装时若只取内容，减去标签：identity 698 / ephemeral_message 271 / guidelines 5557 / communication_style 1056。

| offset | 段 | 字符 | 桥接 |
|---|---|---|---|
| 0 | `identity` | 721 | ✅ 原样 |
| 722 | `user_information` | 638 | ✅ **重写**（填 CC 抽出的 cwd/platform/git） |
| 1361 | `web_application_development` | 4176 | ❌ |
| 5538 | `ephemeral_message` | 312 | ✅ 原样 |
| 5851 | `customizations` | 2886 | ❌ IDE 专属（`.agents`/`skills/`/`AGENTS.md`） |
| 8738 | `skills` | 1328 | ❌ |
| 10067 | `messaging` | 810 | ❌ 无后台任务总线 |
| 10878 | `knowledge_items` | 2607 | ❌ |
| 13486 | `conversation_transcript` | 3302 | ❌ |
| 16789 | `artifacts` | 6069 | ❌ 无 Artifact 面板 |
| 22859 | `slash_commands` | 1138 | ❌ |
| 23998 | `planning_mode` | 2477 | ❌ |
| 26476 | `planning_mode_artifacts` | 2365 | ❌ |
| 28842 | `guidelines` | 5584 | ✅ 原样（22 条工程纪律，主要价值） |
| 34427 | `communication_style` | 1101 | ⚠️ 改（删 `file://` 链接规则、后台任务规则） |

保留 5 段合计 8356 字符，丢弃 10 段合计 **27158** 字符（8356 + 27158 + 14 个段间换行 = 35528 ✅）。实际组装后 ≈ 7.6–7.8k（`user_information` 重写后比原 638 短）。

token 差（实测，非夹具）：短 system(201 字符) → promptTokens 8572；全量 → 16463 —— 主要成本其实是 14 个 tool 声明。

---

## 二、下游：Claude Code → 本服务

### 2.1 抓包方法（可复现）

`~/.claude/settings.json` 的 `env` 块**优先级高于 shell export**。直接 `export ANTHROPIC_BASE_URL=` 会被它覆盖（症状：`502 unknown provider for model … check your inference gateway (localhost:8317)`）。必须用独立 config dir：

```bash
node cc-sink.mjs &     # 127.0.0.1:8787 落盘 body 并回假 SSE
mkdir -p /tmp/ccconf && cat > /tmp/ccconf/settings.json <<'X'
{"env":{"ANTHROPIC_BASE_URL":"http://127.0.0.1:8787","ANTHROPIC_AUTH_TOKEN":"dummy",
        "ANTHROPIC_MODEL":"probe-model","ANTHROPIC_SMALL_FAST_MODEL":"probe-model"}}
X
cd /tmp/ccprobe && CLAUDE_CONFIG_DIR=/tmp/ccconf claude -p "hi" </dev/null
```

### 2.2 出站形状（`cc-request.capture.json`）

```
POST /v1/messages?beta=true
user-agent: claude-cli/2.1.204 (external, sdk-cli)
anthropic-beta: claude-code-20250219, interleaved-thinking-2025-05-14,
  thinking-token-count-2026-05-13, context-management-2025-06-27,
  prompt-caching-scope-2026-01-05, mid-conversation-system-2026-04-07, effort-2025-11-24
```

| 位置 | 大小 | 处置 |
|---|---|---|
| `system[0]` `x-anthropic-billing-header: cc_version=2.1.204.5a9; cc_entrypoint=sdk-cli;` | 74 | ✗ |
| `system[1]` `You are a Claude agent, built on Anthropic's Claude Agent SDK.`（TUI 入口为 `You are Claude Code, Anthropic's official CLI for Claude.`） | 62 | ✗ |
| `system[2]` `# Harness`/`# Session-specific guidance`/`# Memory`(2100)/`# Environment`/`# Context management` | 5618 | ✗ 正文，只抠 4 值 |
| `tools[]` 25 个 | **73476 字符 / 73847 B** | ✗ 换 14 原生 |
| `messages[i].role=="system"`（agent types 清单，`mid-conversation-system` beta） | 6600 | ✗（上游 contents 只认 user/model） |
| `messages[0]` `<system-reminder>` 内 `# claudeMd` | 变长 | ✓ 抽 → `<user_rules>` |

25 个 CC 工具名（无一在原生 14 里）：`Agent Bash CronCreate CronDelete CronList DesignSync Edit EnterWorktree ExitWorktree NotebookEdit Read ReportFindings ScheduleWakeup SendMessage Skill TaskCreate TaskGet TaskList TaskOutput TaskStop TaskUpdate WebFetch WebSearch Workflow Write`

其他字段：`max_tokens 32000`、`thinking {type:"adaptive",display:"omitted"}`、`context_management.edits[0].type "clear_thinking_20251015"`、`output_config.effort "high"`、`metadata.user_id` 内嵌 device_id/session_id。

**指纹面占比**（按 wire 字节，分母 87835）：

| | 字节 | 占比 |
|---|---|---|
| `tools[]` | 73847 | **84.1%** |
| `messages[1]` mid-conv system | 6632 | 7.6% |
| `system[]` 三块 | 5788 | 6.6% |
| 其余（真实对话 + 参数） | 1568 | 1.8% |

三者全丢 = 消掉 **98.2%**；单丢 `tools[]` 消掉 84.1%。`tools` 是 `system` 的 **12.8 倍**（按字符 73476 / 5754）。

**CLAUDE.md 不在 system 里。** 二次验证：写入 `CLAUDE.md` 后三块长度一字未变（74/62/5618），内容出现在 `messages[0].content[0]` 的 `<system-reminder>`。

---

## 三、转换：CC → Antigravity

丢弃 `system[]` 全部三块，只抽 5 值重建 harness。实现参考 [`leakcheck.prototype.mjs`](./leakcheck.prototype.mjs)（已跑通）。

| 从哪抠 | 正则 | 填到哪 |
|---|---|---|
| `system[2]` | `/^ - Primary working directory:\s*(\S+)$/m` | `<user_information>` 的 `[URI] -> [CorpusName]` |
| `system[2]` | `/^ - Platform:\s*(\S+)$/m`（`darwin→mac`/`win32→windows`/`linux→linux`） | `The USER's OS version is {x}.` |
| `system[2]` | `/^ - Is a git repository:\s*(\S+)$/m` | 追加一行 |
| `system[2]` | `/^ - Additional working directories:\n((?:  - .+\n)+)/m` | 追加 URI→CorpusName |
| `messages[0]` | `` /# claudeMd\n([\s\S]*?)(?=\n# (?:currentDate\|userEmail\|attachedProject\|gitStatus\|directoryStructure)\n\|\n\s+IMPORTANT: this context)/ `` | `<user_rules>` |

`CorpusName` 上游只当标签，取 `basename(dirname)+"/"+basename`。

组装：`identity + buildUserInformation() + ephemeral_message + guidelines + communication_style(改) + <user_rules>`

### 3.1 tool-bridge：原生 FC → Claude tool_use

**方向是上游→CC**：上游模型发原生 FC，桥接侧必须翻译成 CC **实际持有**的工具。CC 的 25 个工具里**没有 `LS` / `Grep` / `Glob`**（已断言），所以 `list_dir` 与 `grep_search` 只能落到 **`Bash`**。

| 原生 FC | Claude tool_use | 参数映射 |
|---|---|---|
| `view_file` | `Read` | `file_path←AbsolutePath`；`offset←StartLine`；`limit←EndLine-StartLine+1` |
| `run_command` | `Bash` | `command←CommandLine`；`description←toolAction`。`Cwd` 需前置 `cd`（见下）；`WaitMsBeforeAsync`(≤10000) → `timeout` |
| `write_to_file` | `Write` | `file_path←TargetFile`；`content←CodeContent` |
| `replace_file_content` | `Edit` | `file_path←TargetFile`；`old_string←TargetContent`；`new_string←ReplacementContent`；`replace_all←AllowMultiple` |
| `list_dir` | **`Bash`** | 见下 |
| `grep_search` | **`Bash`** | 见下 |
| 其余 8 个 | — | 不翻译，直接回 error `output` |

#### `list_dir` → Bash

`ls -la` 的输出与 IDE 的 JSON 行格式不同构，会让模型读到与训练分布不一致的结果。用一行 python3 精确复刻（已本地验证输出逐字段一致）：

```bash
python3 -c 'import json,os,sys
for e in sorted(os.scandir(sys.argv[1]),key=lambda x:x.name):
    print(json.dumps({"name":e.name,"isDir":True} if e.is_dir() else {"name":e.name,"sizeBytes":str(e.stat().st_size)},ensure_ascii=False))' <DirectoryPath>
```

#### `grep_search` → Bash

IDE 声明就是「Use ripgrep」，直接落 `rg`。逐字段对应：

| 原生参数 | rg flag |
|---|---|
| `Query` | 位置参数，**前置 `--`**（防 `-` 开头被当 flag） |
| `SearchPath` | 位置参数（schema 要求绝对路径 → 输出自带绝对前缀） |
| `IsRegex: false` | `-F`（字面量）；`true` 则不加 |
| `CaseInsensitive: true` | `-i` |
| `MatchPerLine: true` | `-nH --no-heading`；`false` → `-l` |
| `Includes: ["*.go","!**/vendor/*"]` | 每项一个 `-g`（`!` 前缀 rg 原生支持排除） |
| 总量上限 50 | `\| head -50` —— **不能用 `--max-count 50`**，那是 per-file，IDE 说的是 total |

```bash
rg -nH --no-heading -F -g '*.md' -- 'Query' '/abs/SearchPath' | head -50
```

**两个必须做对的点：**

1. **`-H` 不能省。** SearchPath 是单文件时 rg 默认不打文件名前缀，FR 的 `Filename` 字段就没了。实测：`rg -n ... docs/wire-reference.md` 输出 `114:...`，加 `-H` 才是 `docs/wire-reference.md:114:...`。
2. **Query 必须 shell 引用。** CC 的 `Bash.command` 是**字符串**，不是参数数组 —— 无法像 `execFile` 那样天然免疫注入。`Query` 直接来自上游模型输出，含 `$(id)` / 反引号 / 引号都会被 shell 求值。用单引号包裹 + 转义内部单引号：

   ```js
   const sq = s => "'" + s.replace(/'/g, `'\\''`) + "'";
   // $(id)  -> '$(id)'     it's -> 'it'\''s'
   ```
   实测 `rg -nH --no-heading -F -- '$(id)' '/tmp/sqtest'` 匹配到字面量 `hello $(id)`，未执行 `id`。`SearchPath` 与每个 `Includes` 同样处理。

`Cwd`（`run_command`）也走这条：`cd <sq(Cwd)> && <CommandLine>`。

#### FR 回填

Claude 的 `tool_result` 是纯文本，套上 §1.3.1 的时间戳前缀即可。`grep_search` 需把 `rg` 的 `path:line:content` 转成 IDE 声明的 JSON 行：

```js
l.match(/^(.*?):(\d+):([\s\S]*)$/)  // -> {Filename, LineNumber, LineContent}
```

（`MatchPerLine:false` 时 rg 只输出路径，直接每行一个 `{Filename}`。）

**退出码陷阱**：`rg` 无匹配时 exit 1，CC 的 Bash 会把它当失败。FR 应据 stdout 为空判定「0 matches」，而不是据 exit code 判定错误。

### 四个已实测的坑（首版正则全中，扫描 exit=1）

1. **`\s+` 吃穿缩进层级。** `# Environment` 是两级缩进（` - key:` / `  - value`）。`(?:\s+- .+\n)+` 会吞掉后续 ` - Platform:` ` - Shell:` ` - You are powered by the model…` ` - The most recent Claude models are…` ` - Claude Code is available as a CLI…` ` - Fast mode for Claude Code…`，把 CC 模型清单和产品介绍原样塞进 `<user_information>`。→ 锚定 **2 空格字面量**。
2. **CLAUDE.md 正文自带 `#` 标题。** 前瞻 `(?=\n# )` 被正文首行 `# CLAUDE.md` 截断，`<user_rules>` 抽出空串。→ 前瞻只匹配**已知节名白名单**。
3. **CC 包装头带路径。** claudeMd 段前两行是 CC 模板：`Codebase and user instructions are shown below…` 与 `Contents of /Users/…/.claude/CLAUDE.md (user's private global instructions…):`，后者命中 `.claude`。→ 两条 `replace` 剥掉。
4. **symlink 重复。** `cwd=/private/tmp/ccprobe`、additional=`/tmp/ccprobe` 是同一目录，误报 "2 active workspaces"。→ `fs.realpathSync` 去重。

### 泄漏扫描

`leakcheck.prototype.mjs` 内 **44 词**黑名单：身份（`Claude Code`/`Anthropic`/`Claude Agent SDK`/`claude-cli`/`cc_version`/`cc_entrypoint`）、`#` 标题、机制（`<system-reminder`/`claudeMd`/`cache_control`/`anthropic-beta`）、路径（`.claude/projects`/`/.claude`）、CC 独有工具名、`opus`/`haiku`/`sonnet`。

`Read`/`Write`/`Edit`/`Agent`/`Skill`/`Bash` **不进文本黑名单** —— 这些短词在 Antigravity harness 与用户正文里天然出现，必然误报；改用 `tools[]` 结构断言（长度 14 + 名字白名单）。

保留 `opus`/`haiku`/`sonnet`：坑 1 就是靠它们先炸出来的，命中位置比 `Claude Code` 更靠前。

两组夹具现状：

| 夹具 | claudeMd | 转换后 | 命中 |
|---|---|---|---|
| probe（单标题 CLAUDE.md） | 311 | 7563 | 0 ✅ |
| 本机真实 CLAUDE.md（`#` + 4 个 `##`） | 526 | 7772 | 0 ✅ |
