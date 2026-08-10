# implementation-notes

## 决策修正（2026-08-08）

### 产品路径：B（原生 harness + 语义桥）— 正式

- **决策：** 对标 **cursoride2api**，使用 Antigravity **自己的**工具调用与 API 会话形态。
- **禁止：** CLIProxyAPI 式「把 Claude Code `tools[]` 原样上传 + args 透传」。
- **原因（用户确认）：** 该路径易被识别/封号；且与「IDE→服务器流程导出」目标不一致。
- **做法：**
  1. 请求注入 **原生** `functionDeclarations`（14 tools，见 `docs/native-tools.capture.json`）
  2. 上游 `functionCall` → Claude `tool_use`（字段映射）
  3. Claude `tool_result` → 原生 `functionResponse.{output}`
  4. `pending-session` 多轮直到 end_turn
  5. envelope / OAuth / SSE 可参考 CLIProxy **规格事实**，不参考其工具哲学

### 与首轮调研文档的关系

- 首轮误将「给 CC 用 = 路径 A」写成推荐；**已在 `docs/Antigravity-IDE-API.md` 全文纠正**。
- CLIProxy 材料降级为：**传输层/OAuth/SSE 词典**，不是产品蓝图。

### 实现分层（对齐 cursoride2api）

| 模块 | 职责 |
|------|------|
| `server` / `cli` | `/v1/messages`、daemon、token 文件 |
| `extract-token` | IDE `state.vscdb` oauthToken |
| `antigravity-client` | envelope、SSE、多轮 HTTP |
| `tool-bridge` | 原生 harness ↔ Claude tools |
| `pending-session` | tool 轮次状态 |
| （可选）`system-prompt` | 注入 IDE harness 约束文案 |

---

## 抓包校准（2026-08-08-170054）

来源：`/private/var/folders/…/Surge Catpure/2026-08-08-170054`  
已回写：`docs/Antigravity-IDE-API.md`、`docs/native-tools.capture.json`、`docs/cliproxy-vs-ide-fingerprint.md`

### 硬事实（实现默认值）

| 项 | 抓包值 | 实现含义 |
|----|--------|----------|
| Base | **daily-cloudcode-pa.googleapis.com**（本会话全部） | 默认 daily；可配置；prod 回退 |
| HTTP UA | `antigravity/ide/2.1.1 darwin/arm64` | 禁止 hub/2.2.1 |
| body.userAgent | `antigravity` | 固定 |
| requestType | `agent`（+ checkpoint/tab） | 主路径 agent |
| requestId | `agent/{cascadeUuid}/{ms}/{trajectoryUuid}/{seq}` | 不要用 `agent-{uuid}` |
| sessionId | 负整数字符串，轨迹内稳定 | 勿用首句 hash |
| toolConfig | agent **VALIDATED**；checkpoint NONE | VALIDATED 是 IDE 行为 |
| tools 结构 | **14 个** `{functionDeclarations:[one]}` | 不要合并成单一 declarations 数组（除非后续验证等价） |
| 必填元字段 | 每 tool 必有 `toolAction`+`toolSummary` | bridge 侧生成 |
| generationConfig | max=65536, includeThoughts=true, thinkingBudget=-1 | agent 默认 |
| FC/FR role | **均为 model** | 历史拼装关键 |
| FR | `{output: string}` only | 带 Created/Completed At 风格可后补 |
| labels | trajectory_id / last_step_index / model_enum / used_claude=false | P1 |
| 伴生 | recordCodeAssistMetrics + listExperiments | P1 指纹 |
| model | `gemini-3.6-flash-high` | 本会话 agent |

### 相对旧笔记的纠正

- ~~默认 base 优先 prod~~ → **本机实际 agent 流量是 daily**（LS 启动参数仍可见 prod，二者并存）
- ~~toolConfig 更贴近 AUTO~~ → agent 抓包为 **VALIDATED**
- ~~VALIDATED 仅 CLIProxy 指纹~~ → **降级**；真正硬指纹仍是 **Claude tools 透传 + reason placeholder + hub UA**
- ~~FR 放 user 轮~~ → **model 轮**
- ~~待抓包：完整 tools / FR / UA~~ → **已闭合**（见上）

### 风控实现约束（校准后）

1. 只上传 **14 原生 tools** + toolAction/toolSummary  
2. token **优先 extract IDE**  
3. UA / userAgent / requestId / sessionId / VALIDATED / system 对齐抓包  
4. 独立 `token.json` 刷新，0600，日志掩码  
5. Write 限 `WORKSPACE_ROOT`  
6. 不盲抄 CLIProxy：HTTP/1.1 强制、sessionId=hash、schema reason placeholder  
7. 详细对比：`docs/cliproxy-vs-ide-fingerprint.md`

### 仍开放（实现中按需）

- prod 何时被 IDE 使用  
- TLS/JA3  
- system 全文是否必须 35k 一字不差（可先短版 harness 纪律）  
- labels.model_enum 与 wire model 对照表  
- multi_replace / browser 等未调用 tool 的 FR 细节  

### 合规

- 仅用户本机已登录会话桥接  
- token 文件 0600；日志掩码  

---

## 活体校验（2026-08-09）

对 `.plans/expressive-brewing-wand.md` 做实调用验证（本机账号，daily base，共 ~6 次 generate）。**方案整体成立**，但推翻 3 条计划假设。

### 已实证成立

| 环节 | 证据 |
|------|------|
| extract-token | `state.vscdb` → `antigravityUnifiedStateSync.oauthToken`（1068B）→ 外层 base64 → 嵌套 BFS 扫出 1×`ya29` + 1×`1//` |
| refresh | CLIProxy 同源 client_id/secret + `grant_type=refresh_token` → 200，`expires_in=3599`，scope 含 cloud-platform / cclog / experimentsandconfigs / userinfo.* |
| projectId | `loadCodeAssist {"metadata":{"ideType":"ANTIGRAVITY"}}` → **daily 与 prod 都 200**，均返回 `cloudaicompanionProject: fluent-falcon-nrl9f`（本机 state.vscdb 里**搜不到**该 project，必须走 RPC） |
| 自造 envelope | 自建 `requestId`/`sessionId`/`labels`（最小集）+ 14 原生 tools + **~300 字短 system** → 200，返回 `functionCall: list_dir`，模型自行填 `toolAction`/`toolSummary` |
| 多轮闭环 | FC(role=model, 带 sig) + FR(role=model, `{output}`) → 第 2 轮继续并产出最终文本 |
| 并行 FC | 一次 SSE 可返回 2 个 `functionCall` part |

### 被证伪的计划假设（已回写 plan）

**1. `thoughtSignature` 是硬性必填，不是「尽力回放」**

```
[无 sig] 400 INVALID_ARGUMENT
  "Function call is missing a thought_signature in functionCall parts.
   ... function call `default_api:list_dir`, position 2"
[带 sig] 200
```

→ pending 必须持久化原样 FC parts。原计划「无效则丢弃不伪造」= 会话必死。signature 丢失只能重开会话。

**2. 并行 FC 不能按抓包的「一 FC 一 content」拆**

一次 SSE 里只有**第一个** FC part 带 signature：

```
part0 ['thoughtSignature','functionCall']
part1 ['functionCall']            ← 无 sig
```

- 拆成两个 model content → `400 ... position 4`
- 合并进同一个 model content 的 parts 数组 → 200

抓包呈现成对拆分，只是因为 IDE 每轮串行只发 1 个 FC，不是协议要求。
→ 规则：**一次 SSE 的所有 FC parts 进一个 model content；对应 FR parts 进下一个 model content。** resume 必须等齐所有 tool_result。

**3. `Overwrite` 实发字符串**

schema 声明 `BOOLEAN`，IDE 抓包实发 `"False"`（字符串）。跟 IDE，不跟 schema。

### 次要修正

- `systemInstruction.role = "user"`（不是 `system`）
- **短 system 可用** → 撤销原「失败再贴 35k capture 段落」的回退分支
- `labels` 抓包全量 = `last_execution_id / last_step_index / model_enum:"MODEL_PLACEHOLDER_M71" / trajectory_id / used_claude / used_claude_conservative`；最小集（trajectory_id + last_step_index + used_claude）已 200，`model_enum` 可省
- 请求 model `gemini-3.6-flash-high` ↔ 响应 `modelVersion: gemini-3.6-flash`，二者不同；`/v1/models` 用请求名
- `WaitMsBeforeAsync` schema 明确上限 10000
- 伴生 RPC 比例 13 stream : 13 metrics : 4 listExperiments ≈ 1 : 1 : 0.3（P1 补，代价低）
- `fetchAvailableModels` 探测超时，未确认存在性 → `/v1/models` P0 保持静态

### 仍开放（收敛后）

- ~~system 是否必须 35k~~ → 已闭合，短版可用
- ~~FR 细节~~ → 已闭合（`{output}` + `Created At/Completed At` 前缀）
- prod 何时被 IDE 使用（两 base 均可用，非阻塞）
- TLS/JA3
- signature 跨会话/跨 base 是否可迁移（未测，假定不可）

---

## CC system 抓包（2026-08-09）

### 方法

`~/.claude/settings.json` 的 `env` 块**优先级高于 shell export** —— 直接 `export ANTHROPIC_BASE_URL=` 会被它里面的 `http://localhost:8317` 覆盖，第一次探测因此失败（`502 unknown provider for model probe-model`，报错里点名了 8317 网关）。正确做法：

```bash
node /tmp/cc-sink.mjs &                      # 127.0.0.1:8787，落盘 body 并回假 SSE
mkdir -p /tmp/ccconf && cat > /tmp/ccconf/settings.json <<'X'
{"env":{"ANTHROPIC_BASE_URL":"http://127.0.0.1:8787","ANTHROPIC_AUTH_TOKEN":"dummy",
        "ANTHROPIC_MODEL":"probe-model","ANTHROPIC_SMALL_FAST_MODEL":"probe-model"}}
X
cd /tmp/ccprobe && CLAUDE_CONFIG_DIR=/tmp/ccconf claude -p "hi" </dev/null
```

单轮 `hi` 出站 **87835 B**（= 抓包 `content-length`）。

### 推翻的先前推断

先前靠 `strings` 逆二进制得出的结论，有三条被 wire 证伪：

| 先前推断 | wire 实况 |
|---|---|
| system 是一段拼好的字符串 | `system` 是**数组 3 块**，身份单独成块（62 字符）并单独 `cache_control: ephemeral` |
| CLAUDE.md 进 system | **不进**。二次验证：写入 `/tmp/ccprobe/CLAUDE.md` 后三块长度一字未变（74/62/5618），内容出现在 `messages[0].content[0]` 的 `<system-reminder>` 里 |
| system 是主要指纹面 | system 仅 5754 字符 / 5788 B；`tools[]` **73476 字符 / 73847 B**，是 system 的 12.8 倍、占 body 84.1%。丢 tools 才是消指纹的主手段 |

### wire 事实

```
POST /v1/messages?beta=true
user-agent: claude-cli/2.1.204 (external, sdk-cli)
anthropic-beta: claude-code-20250219, interleaved-thinking-2025-05-14,
  thinking-token-count-2026-05-13, context-management-2025-06-27,
  prompt-caching-scope-2026-01-05, mid-conversation-system-2026-04-07, effort-2025-11-24
```

- `system[0]` 74 字符：`x-anthropic-billing-header: cc_version=2.1.204.5a9; cc_entrypoint=sdk-cli;`
- `system[1]` 62 字符：`You are a Claude agent, built on Anthropic's Claude Agent SDK.`
  —— `-p` 走 sdk-cli 入口用 `$zc`；交互 TUI 用 `NUUi`（`You are Claude Code, Anthropic's official CLI for Claude.`）
- `system[2]` 5618 字符：`# Harness` / `# Session-specific guidance` / `# Memory`(2100) / `# Environment` / `# Context management`
- `tools[]` 25 个：Agent Bash CronCreate CronDelete CronList DesignSync Edit EnterWorktree ExitWorktree NotebookEdit Read ReportFindings ScheduleWakeup SendMessage Skill TaskCreate TaskGet TaskList TaskOutput TaskStop TaskUpdate WebFetch WebSearch Workflow Write
- `messages[1].role == "system"`（6600 字符 agent types 清单）—— `mid-conversation-system` beta 的产物，上游 `contents[]` 只认 user/model，**只能丢**
- 其他：`max_tokens 32000`、`thinking {type:"adaptive",display:"omitted"}`、`context_management.edits[0].type "clear_thinking_20251015"`、`output_config.effort "high"`、`metadata.user_id` 内嵌 device_id/session_id

### 决策

system 处理是**丢弃 + 抽 5 值重建**，不是「替换」。抽取表与裁剪版组装见 plan「system 处理」节。

黑名单扫描要区分两类词：CC **独有**标识（`CronCreate`/`DesignSync`/`EnterWorktree`/`cc_version`/`# Harness`…）可直接子串匹配；`Read`/`Write`/`Edit`/`Agent`/`Bash` 这类短词在 Antigravity harness 和用户正文里天然出现，文本扫必然误报，改用 `tools[]` 结构断言（长度 14 + 名字白名单）。

### 安全事项

排查 8317 劫持时 dump 了 `~/.claude/settings.json`，`ANTHROPIC_AUTH_TOKEN` 与 `BRAVE_SEARCH_API_KEY` 明文进了会话记录 —— 已提示用户轮换。若把 `docs/cc-request.capture.json` 入库，须先脱敏 `metadata.user_id` 的 device_id。

### 转换后关键词扫描（同日，已跑通）

拿真实抓包 body 跑了一版转换 + 黑名单扫描（现已入库为 `docs/leakcheck.prototype.mjs`，44 词黑名单）。**首版正则三处全错，exit=1**：

| # | 症状 | 根因 | 修法 |
|---|------|------|------|
| 1 | `<user_information>` 里出现 `Claude Code is available as a CLI…`、`claude-opus-4-8`、`claude-sonnet-5`、`claude-haiku-4-5`（8 处命中） | `# Environment` 是**两级缩进**（` - key:` / `  - value`），`(?:\s+- .+\n)+` 的 `\s+` 同时匹配 1 空格和 2 空格，把 `Platform:`/`Shell:`/`OS Version:`/模型清单/产品介绍全当成"额外工作目录" | 锚定 2 空格字面量 `(?:  - .+\n)+` |
| 2 | `<user_rules>` 抽出空串 | 前瞻 `(?=\n# )` 被 CLAUDE.md 正文首行 `# CLAUDE.md` 截断 | 前瞻改为已知节名白名单 `(?=\n# (?:currentDate\|userEmail\|attachedProject\|gitStatus\|directoryStructure)\n\|\n\s+IMPORTANT: this context)` |
| 3 | `/.claude` 命中 | claudeMd 段前两行是 CC 模板包装头，第二行 `Contents of /Users/cddchen/.claude/CLAUDE.md (user's private global instructions…):` 带路径 | 两条 `replace` 剥掉包装头再包 `<user_rules>` |

附带：`cwd` = `/private/tmp/ccprobe`、additional = `/tmp/ccprobe`，同一目录的 symlink，`<user_information>` 误报 "2 active workspaces"。→ 按 `fs.realpathSync` 去重。

修完两组夹具均 **exit=0**：

- probe CLAUDE.md（单标题，311 字符）→ 转换后 7563 字符，0 命中
- 本机真实 CLAUDE.md（`# CLAUDE.md` + 4 个 `##`，526 字符）→ 转换后 7772 字符，0 命中，5 个标题全部抽全

规模对照：CC system 5754 → 转换后 ~7.6–7.8k（AG `guidelines` 5584 占大头），全量 AG harness wire 35570 / 脱敏后 35528。

黑名单实际词表（44 条）已在 plan「验证」第 6 条列出。`opus`/`haiku`/`sonnet` 这三个词值得留在表里 —— 坑 1 就是靠它们先炸出来的，比 `Claude Code` 更早命中。

### 数字勘误与夹具化（2026-08-10）

复核计划里的 `docs/` 引用时，发现 7 处数字与夹具对不上，逐条改正：

| 错值 | 正确 | 根因 |
|---|---|---|
| body 87051 B | **87835** | 87051 用四种序列化都复现不出，来源不明；87835 = `content-length`，也 = 紧凑+`ensure_ascii=False` 的 UTF-8 字节 |
| tools 75549 | **73476 字符 / 73847 B** | 75549 是 `separators=(', ', ': ')`（带空格）的产物，非 wire 形态 |
| AG system wire 35549 | **35570** | `<REDACTED-uuid>` 15 字符 vs uuid 36 字符，差 **21** 不是 4；35528+2×21=35570，与 `ag-envelope.capture.json` 的 `_textChars` 一致 |
| identity 710 / ephemeral 313 / guidelines 5585 | **721 / 312 / 5584** | 混淆了「含标签」与「不含标签」两种长度；不含标签是 698 / 271 / 5557 |
| 丢弃 10 段 ~23.6k | **27158** | 口算；核对式：保留 8356 + 丢弃 27158 + 14 换行 = 35528 |
| 黑名单 41 词 | **44** | 数错 |
| 丢 tools 消 93% 指纹 | **84.1%** | tools 73847/87835；三者（tools + mid-conv system + system[]）全丢才是 98.2% |

**教训**：凡是写进文档的字节数，必须给出可复跑的一行命令，否则下次复核只能重算一遍。已在 `wire-reference.md` 夹具索引下方固定「字节数复现约定」。

同时把 `docs/leakcheck.prototype.mjs` 的输入从 `/tmp/cc-capture-3.json` + `/tmp/ag_system.txt` 改成同目录入库夹具（`import.meta.url` 定位），落盘改为可选 `LEAKCHECK_OUT`。之前能跑通只是因为 `/tmp` 尚未清理 —— 重启即失效，等于没入库。改后任意 cwd 跑 `node docs/leakcheck.prototype.mjs` 均 exit=0，输出与改前逐字节一致（脱敏只动 `metadata`，不影响 `system`/`messages`）。

### tool-bridge：`list_dir` / `grep_search` 重新映射（同日）

原计划映射到 `LS` / `Grep`。**CC 的 25 个工具里没有这两个**（也没有 `Glob`），按原表无法实现。方向是**上游→CC**，目标必须是 CC 实际持有的工具 → 只能落 `Bash`。

**`list_dir` 不用 `ls -la`。** IDE 的 FR 载荷是每行一个 JSON（`{"name":"x","sizeBytes":"6148"}` / `{"name":"d","isDir":true}`，注意 size 是**字符串**），`ls` 输出与之不同构，模型会读到偏离训练分布的结果。改用一行 `python3 -c`，本地验证输出逐字段一致。

**`grep_search` 落 `rg`**（IDE 描述原文就是 "Use ripgrep"）。三个实测坑：

1. **`-H` 不能省** —— `SearchPath` 是单文件时 rg 不打文件名前缀，FR 的 `Filename` 字段直接丢。
2. **`| head -50` 而非 `--max-count 50`** —— 后者是 per-file，IDE 声明的 50 是 total。实测同一文件 154 行匹配，`head -50` 才截到 50。
3. **`Query` 必须 shell 引用** —— 这条是安全项，不是风格项。CC 的 `Bash.command` 是**字符串**而非参数数组，没有 `execFile` 那种天然免疫；`Query` 又直接来自上游模型输出。`sq = s => "'" + s.replace(/'/g, "'\\''") + "'"`，实测 `rg ... -- '$(id)' '/tmp/sqtest'` 匹配字面量而未执行 `id`。`SearchPath`、每个 `Includes`、`run_command` 的 `Cwd` 同样处理。

附带：`rg` 无匹配时 exit 1，CC 的 Bash 会当失败。FR 应据 stdout 为空判 "0 matches"。

### `Overwrite` 字符串结论降级为存疑

「IDE 实发字符串 `"False"`，跟 IDE 不跟 schema」这条**在库内无法复核** —— `ag-envelope.capture.json` 的 skeleton 只保留 `argKeys`，参数值全部省略（`grep '"False"'` 0 命中）。而 `native-tools.capture.json` 明确声明 `"type": "BOOLEAN"`。

改为：**发 boolean 跟 schema**；若上游报 `invalid_args`，改发字符串**并把响应体存成夹具**再回来改文档。原结论只有散文记录，不足以推翻 schema。

---

## extract-token + auth（2026-08-10）

### 已实现
- `src/extract-token.ts`：sqlite3 只读 `antigravityUnifiedStateSync.oauthToken`；嵌套 base64 BFS（depth≤6）扫 `ya29.*` / `1//*`；`storage.json` 取 machineId（缺失 warn）；写 `token.json` 强制 0600（write+chmod）
- `src/auth.ts`：load/save token 文件；Google refresh；loadCodeAssist 多路径 projectId；withAuth 401 单次 refresh 重试

### 决策
| 项 | 决定 | 原因 |
|----|------|------|
| OAuth client_secret | 常量 `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` | docs 只写了 ClientID；secret 取自 CLIProxy `internal/auth/antigravity/constants.go`（与 IDE 同源），活体 refresh 已 200 |
| client_id/secret 覆盖 | `ANTIGRAVITY_CLIENT_ID` / `ANTIGRAVITY_CLIENT_SECRET` | 规格要求 |
| BFS 解码 | latin1 保留二进制 | protobuf 嵌套，utf8 会丢不可见字节里的 ASCII token 边界 |
| writeTokenFile | `mode:0o600` + `chmodSync` | 已存在文件时 mode 不生效 |
| ensureProjectId | 就地写 `entry.projectId` | 调用方可复用；不强制落盘（withAuth 只在 401 refresh 后写文件） |
| withAuth tokenPath | 默认 `getDefaultTokenPath()`，可选第三参 | 规格未要求第三参，给测试/多文件留口，无额外抽象 |

### 偏离
- 无。`types.ts` / `config.ts` / `token-paths.ts` 未改。

---

## native-tools + system-prompt（2026-08-10）

产品化 `docs/leakcheck.prototype.mjs` + `docs/native-tools.capture.json`。

### 导出
- `src/native-tools.ts`: `getNativeTools()` / `NATIVE_TOOL_NAMES` / `isNativeTool(name)`
- `src/system-prompt.ts`: `extractEnv` / `buildUserInformation` / `buildSystemInstruction` / `LEAK_BLACKLIST`(44) / `scanLeaks`

### 决策
| 项 | 决定 | 原因 |
|----|------|------|
| 夹具加载 | `fs.readFileSync` + `__dirname/../docs` + `../../docs` fallback | 禁止 `require('../docs/*.json')`（rootDir 报错）；dist/ 与 src/ 都能定位 |
| sections 切段 | 用 `ag-system.sections.json` offset/chars | 不把 35k 文本嵌进 .ts |
| full 模式 | capture 全文，只替换 `user_information` 段 | 规格要求；其余 14 段原样 |
| ExtractedEnv.userRules | **已剥** CC 两行包装头 | types 注释写「已剥掉 CC 包装头」；与原型 L50-54 一致 |
| system 输入 | string 或 block[] 都支持 | 原型只处理数组；AnthropicMessagesRequest 契约是 union |
| 启动断言 | 14 项、每项 1 decl、required 含 toolAction+toolSummary | 不满足 throw；fingerprint 硬约束 |

### 验收（夹具 `cc-request.capture.json`）
```
trimmed chars = 7563
scanLeaks = []
byte-identical to leakcheck.prototype.mjs output = true
```

### 偏离
- 无正则改动。AdditionalDirs 锚定 2 空格、claudeMd 白名单前瞻、realpath 去重、commStyle filter 全部照抄原型。

---

## antigravity-client（2026-08-10）

`src/antigravity-client.ts`：信封 + SSE 流式一轮归并。

### 导出
- `buildEnvelope(opts)` / `newSessionId()` / `streamGenerate(opts)`
- `AntigravityError`（`status`/`upstreamStatus`/`body`）
- 纯函数：`parseSseLine` / `isSseDoneLine` / `createStreamAcc` / `accumulateFrame`

### 决策
| 项 | 决定 | 原因 |
|----|------|------|
| labels | P0 最小集 3 键（trajectory_id / last_step_index / used_claude） | 已实证 200；省略 model_enum 等 |
| sessionId | randomBytes(8)→asIntN(64)→负绝对值字符串 | 对齐实录负 int64 形状；会话内稳定由调用方缓存 |
| SSE 行缓冲 | TextDecoder + `\n` 切，跨 chunk 留 buffer | chunk 边界切断 data 行 |
| 末帧 | `!functionCall && text==='' && thoughtSignature` → skip | §1.4；签名不属于任何 FC，text:"" 非内容 |
| FC part | 原样 `push(part)` 引用 | thoughtSignature 是兄弟键，改字节即 400 |
| usage | 每帧覆盖 | 上游发累计值 |
| 超时 | `AbortSignal.timeout` + 可选 `AbortSignal.any` | config.requestTimeout 默认 300s |
| 401 | status 原样透出 | withAuth 靠 `.status===401` refresh |
| 400+thought_signature | 消息前缀「会话不可恢复，需重开」 | 不可伪造签名 |

### 自检
`npx tsc && node dist/antigravity-client.js` exit 0（无网络）。覆盖 requestId 正则、role=user、VALIDATED、generationConfig 三值、sessionId 负 BigInt、text 拼接、FC 原样、末帧跳过、usage 覆盖、frame.error 提示。

### 偏离 §1.4
无。

---

## tool-bridge（2026-08-10）

`src/tool-bridge.ts`：原生 FC → CC tool_use，以及 tool_result → 原生 FR。

### 导出
- `sq(s)` shell 单引号转义
- `bridgeFunctionCall(fc, workspaceRoot?)` → `BridgeOutcome`
- `buildFunctionResponse(native, claudeResult, isError)` → `FunctionResponse`
- `rejectionOutput(rej)` → `FunctionResponse`
- `describeToolUse(fc)` → toolAction 字符串（缺失用工具名）

### 决策
| 项 | 决定 | 原因 |
|----|------|------|
| toolUseId | 直接复用原生 FC id | Anthropic 对 id 格式无约束；双向映射零成本 |
| list_dir/grep_search | 落 Bash | CC 25 工具无 LS/Grep/Glob |
| IsRegex 缺失 | 当 false（加 `-F`） | schema 无默认；字面量更安全 |
| MatchPerLine 缺失 | 当 true（`-nH --no-heading`） | schema 描述默认按 per-line 语义 |
| WaitMsBeforeAsync | `>0` 才写 timeout，`min(v, 600000)` | 0 不写；CC Bash timeout 上限 600s |
| workspace 边界 | 仅 Write/Edit；空 root 跳过 | config.workspaceRoot 可空，由调用方传入 |
| grep 无匹配 | isError && 空载荷 → 成功 0 matches | rg exit 1 陷阱 §3.1 |
| toolAction/toolSummary | 不本地生成 | 上游 FC 必带（14 声明 required） |
| view_file 无 StartLine 仅 EndLine | limit=EndLine | 罕见；按 1 起点推 |

### 自检
`npx tsc && node dist/tool-bridge.js` exit 0。覆盖 sq×3、grep 命令串、list_dir 命令串、越界拒绝、grep 空匹配、FR 失败无 Completed At、run_command cd 引用、view_file 中文 URI、8 个 reject。

### 偏离 §3.1
- §3.1 表写 `run_command` 的 timeout 来自 WaitMsBeforeAsync(≤10000)；实现用 `min(v, 600000)` 对齐 CC Bash 上限，schema 上限 10000 由上游约束。
- wire 旧笔记写「bridge 侧必须本地生成 toolAction」；用户任务与 schema required 均表明上游自带，本模块只透传 `describeToolUse`。

---

## pending-session + anthropic（2026-08-10）

### `src/pending-session.ts`
- Map 按 `claudeToolIds` 多索引到同一 session 对象；`removePending` 清 timer + 全部 id。
- `pendingTimeout <= 0` → 不挂 timer。
- `appendToolRound` 直接 `push({role:'model', parts: fcParts/frParts})`，**parts 数组是原引用**（不 `slice`/spread/map），保证 thoughtSignature 不被重建。

### `src/anthropic.ts`
- `parseToolResults`：从后往前找第一条含 tool_result 的 user message，抽出全部（并行）。
- `buildUserContent`：只取最后 user 纯文本；正则剥 system-reminder；包 USER_REQUEST + ADDITIONAL_METADATA（`formatLocalIso` 自算偏移，无依赖）。
- `AnthropicSseWriter`：抄 cursor 状态机，去掉 token-usage；usage 由调用方传入 `AnthropicUsage`。
- 非流式 `buildToolUseResponse`：text 非空才前置 text 块，再 tool_use 块，`stop_reason:'tool_use'`。

### 自检断言
- pending：3 id 同 session / 任一可取 / remove 全消 / append 恰好 2 条且 `parts === fcParts` / cleanupAll。
- anthropic：system-reminder 剥净、USER_REQUEST 包装、时间 `[+-]HH:MM`、parse 多块、SSE 事件序列 + index 递增、end_turn 路径。
- `npx tsc && node dist/pending-session.js && node dist/anthropic.js` 静默 exit 0。

### 偏离
- 无：按任务规格实现。msgId 用 `Date.now+random` 而非 uuid 依赖（package 虽有 uuid，此文件不引）。

---

## cli / README / token.json.example（2026-08-10）

`src/cli.ts` + `README.md` + `token.json.example`。

### 子命令
- 无参数 / `start-fg`：前台
- `start`：后台 daemon（pid/log 在 `getConfigDir()`）
- `stop` / `status` / `extract-token` / `--help`

### 规避 server.ts 编译期依赖
- **禁止** `import { startServer } from './server'`
- 前台：`require(path.join(__dirname, 'server.js'))` 运行期加载，缺文件明确报错
- 后台：`spawn(process.execPath, [server.js], { detached, stdio→server.log })`
- 启动探测：轮询 `http://host:port/health`（0.0.0.0→127.0.0.1），超时 15s；子进程提前退出则失败

### 决策
| 项 | 决定 | 原因 |
|----|------|------|
| token 缺失 | 除 extract-token/help 外 exit 1，提示跑 extract-token | 规格；不自动 extract（与 cursor 不同） |
| status 脱敏 | `maskToken` + `loadTokenFile` | 绝不回显完整 token |
| pid 路径 | token 同目录 | 与 TOKEN_FILE 自定义一致 |
| help | 无 token 检查 | 可独立查看用法 |

### 偏离
- 相对 cursoride2api：不自动 extract；status 含 token/账号信息；启动成功用 /health 而非 grace timer。
- 相对规格「stdout 出现监听行」备选：只实现 /health 探测（够用）。

---

## server.ts（2026-08-10）

`src/server.ts`：Express 单文件串起 `/health` `/v1/models` `/v1/messages` 多轮闭环。**未改** `src/` 其它文件。

### 路由
| 方法 | 路径 | 鉴权 | 行为 |
|------|------|------|------|
| GET | `/health` | 无 | `{ok, tokens, pending}`，无 token 明文 |
| GET | `/v1/models` | API_KEY | 静态列表，`id=config.antigravity.defaultModel` |
| POST | `/v1/messages` | API_KEY | 分支 A 首轮 / 分支 B tool_result 续轮 |

### 边界处理
- **全部 FC 被 reject**：`runGenerateLoop` 内 `appendToolRound` + `stepIndex++` 就地再 `streamGenerate`，上限 3 次；超限抛错文案返回（流已开则 SSE 错误文本收尾）。
- **tool_result 未等齐 / id 未知**：400 + `invalid_request_error`（不 500、不挂死）。等齐条件 = `pending.claudeToolIds` 全在本批 tool_result 里。
- **mixed reject + tool_use**：挂 pending 时只暴露 bridged 的 tool_use；resume 时 `buildFrPartsForResume` 按 `pendingFcParts` 顺序补 reject FR（re-bridge 出 rejectionOutput），与 client FR 同一批 append。

### 风控插点
`assertSafeToSend(tools, systemInstruction)` 在每次 `streamGenerate` **前**调用（含 reject 就地续轮）。断言：`tools.length===14` 且 name∈`NATIVE_TOOL_NAMES`；`scanLeaks(systemInstruction)` 空。命中只打命中词。`LEAKCHECK_OFF` 非空可关。

### 决策
| 项 | 决定 | 原因 |
|----|------|------|
| P0 单号 | `loadTokenFile().tokens[0]` | 规格 |
| contents 不含本轮 FC | register 时 `pendingFcParts` 另存，resume 再 append | `PendingAgentSession` 契约 + §1.3 |
| 续轮 systemInstruction | 复用 pending 缓存，不重抽 body | 首轮 CLAUDE.md 必须复用 |
| 流已开错误 | SSE textDelta 错误 + end_turn | 不能改 status code |
| 无 token 启动 | `startServer` 内 load 失败 exit 1 | 规格；不栈溢出 |
| uuid | `uuid` 包 `v4` | package.json 已有；cascade/trajectory |

### 偏离
- 无相对规格的功能偏离。cursor 的 BiDi/exec 长连接路径不适用，本实现全 HTTP SSE 多轮。

---

## 测试套件 T1–T5/T7/T8（2026-08-10）

产出 `scripts/test-*.mjs` + `assert-no-cc-leak.mjs` + `run-tests.mjs`（T6 由另一 agent 补）。

### 决策
| 项 | 决定 | 原因 |
|----|------|------|
| 无测试框架 | `node:assert/strict` + 独立 `.mjs` | TEST-PLAN 硬约束 |
| CJS dist 加载 | `await import('../dist/xxx.js')` 取 named export | package type=commonjs；default 是 dual 嵌套，named 更稳 |
| T5 timeout | 文件顶部先 `process.env.PENDING_TIMEOUT=50` 再 import | config 在 load 时读 env；pending-session 缓存 config.default |
| T3.6 pipefail | `set -o pipefail; ${cmd}` 经 `/bin/bash` | 桥接命令是 `rg\|head`，默认 sh 取 head=0 吞掉 rg exit1，正是「退出码陷阱」本身 |
| T7 短词 | 文本扫 `LEAK_BLACKLIST`（44，已无 Read/Write 等短词）+ 结构断言 tools 14 白名单 | wire-reference / notes 风控分治 |
| run-tests 不 build | 只 spawn 脚本；T6 文件不存在则 SKIP | 避免与 `npm test` 递归 |

### 断言依据
全部可追到 `docs/ag-envelope.capture.json` / `native-tools.capture.json` / `cc-request.capture.json` / `leakcheck.prototype.mjs` / wire-reference §1.2–§1.5 / §3.1。

### 结果
`node scripts/run-tests.mjs`：T1–T5/T7 + 4 模块自检 PASS；T6 SKIP。

---

## T6 test-server.mjs（2026-08-10）

端到端 mock 上游，不打真实 Google。仅新增 `scripts/test-server.mjs`。

### 决策
| 项 | 决定 | 原因 |
|----|------|------|
| mock 路由 | `POST /v1internal:streamGenerateContent` + `loadCodeAssist` | 与 `antigravity-client`/`auth` 实路径一致 |
| token | 预填 `projectId` + `expiresAt=1893456000000`（2030） | 跳过 loadCodeAssist；withAuth 仅 401 才 refresh |
| 端口 | mock 34111 / server 34112 | 高位固定，避免抢占 |
| 双 FC SSE | 同一 content.parts 里 2 个 FC，仅 parts[0] 带 `thoughtSignature` | wire-reference §1.3 硬规则 3 / 用户必测 |
| 末帧 | `text:""` + 独立 sig + `finishReason:STOP` | §1.4；`accumulateFrame` 跳过 |
| 未测 6.12 | mock 回 401→refresh 重试 | 需假 OAuth token 端点；用户说明可不做假 OAuth，故本文件未覆盖 6.12 |

### 结果
`node scripts/test-server.mjs`：13/13 PASS（含 T6 表内主路径 + 用户追加：缺 tool_result/未知 id/14 tools 子串扫/stream 事件序）。

---

## Wave 4 架构师验收（2026-08-10）

### 全量测试
`node scripts/run-tests.mjs` → **通过 11 / 失败 0**（T1–T7 + 4 个模块自检）。

### 变异测试（验证测试本身有效，而非自证）
三处对 `dist/` 的注入，全部被测试红：

| 变异 | 注入点 | 红在哪 |
|------|--------|--------|
| 拆开并行 FC parts | `appendToolRound` 改为逐 part push | T6：`新增 contents 条数期望 2 实际 3` |
| 剥 `thoughtSignature` | `acc.fcParts.push` 时置 undefined | T6：`thoughtSignature 期望原样回放` |
| 混入 CC 工具名 | `getNativeTools()[0].name='NotebookEdit'` | 风控 500 `leakcheck: tools[0].name=NotebookEdit`；T6 三条断言红 |

变异后均恢复原文件。

### 架构师本轮改的 4 处代码

1. **`src/anthropic.ts` `parseToolResults` 逻辑 bug**
   原实现从后往前扫**所有** user message 找 tool_result。CC 每轮回传全量历史，
   工具轮结束后用户的新提问会命中上一轮 tool_result → 被误判成 resume → 400。
   改为只看**最后一条** user message。已补自检。

2. **`src/anthropic.ts` 新增 `buildContents`，server 首轮改用它**
   `buildUserContent` 只取最后一条 user，纯文本多轮上下文全丢（验收标准第 2 条要求文本多轮可用）。
   `buildContents` 搬历史文本、`assistant→model`、丢 `role:'system'`、只有最后一条包 `<USER_REQUEST>`。
   **只搬文本**：历史 tool_use/tool_result 一律丢 —— 回放 FC 需 thoughtSignature，CC transcript 里没有，硬塞必 400。
   代价：工具轮后再提问，模型看不到工具细节，只看到文本结论。

3. **`src/server.ts` 风控前置**
   `assertSafeToSend` 原本只在 `runGenerateLoop` 内、SSE 头已发之后。命中泄漏时返不了 500，
   只能把错误写进流。改为**开流前**再调一次（loop 内保留，覆盖 reject 续轮）。

4. **`src/server.ts` token entry 缓存 + `src/cli.ts` status 不再强制 token**
   `firstTokenEntry()` 每请求 `loadTokenFile()` 造新对象，`ensureProjectId` 写在 entry 上的
   `projectId` 缓存被丢弃 → 每个请求多打一次 `loadCodeAssist`。改为按 mtime 缓存 entry 对象。
   `cli status`/`stop` 是诊断命令，缺 token 也应能看，移到 `ensureTokenFileOrExit` 之前。

### 验收标准核对
| 项 | 状态 | 证据 |
|----|------|------|
| extract-token 可用 | 代码就绪，未跑真机 | `src/extract-token.ts` 只读 sqlite，`writeFileSync mode 0o600` + `chmodSync` |
| `/v1/messages` 文本多轮 | ✅ | `buildContents` + T6 6.4 |
| 4 工具桥接闭环 | ✅ | T3 真实 shell 执行 `list_dir`/`grep_search`，输出与夹具字节同构 |
| 上游不含 Claude tool 名 | ✅ | `grep body.tools src/*.ts` 无引用；tools 14 名全部原生；T6/T7 扫描 0 hit |
| README 可启动 | ✅ | `cli status` exit 0，`node dist/server.js` 无 token 优雅 exit 1 |

### 未覆盖（已知）
- 真实上游网络调用（T1–T7 全 mock）
- 401 → refresh 链路（需假 OAuth 端点）
- sqlite 提取真机验证
- TLS/JA3 指纹 —— **从未实现，也不打算实现**（计划「明确不做（P0）」）。见下节。

## 传输层对齐 IDE 出站（2026-08-10）

### 一个纠正过的错误前提

之前把基线当成 Electron/BoringSSL。**错的。** 抓包 `processPath` 显示发请求的是
`extensions/antigravity/bin/language_server_macos_arm` —— Mach-O arm64 独立进程，
`strings` 命中 `go1.27` + 1194 处 `crypto/tls`，无 utls/BoringSSL。
基线是 **Go crypto/tls**，不是浏览器栈。之前那套 GREASE / ECH / ALPS 的差异分析
全部作废（Go 同样不发 GREASE）。

### HTTP 层：已逐字对齐

夹具 `docs/ide-headers.capture.json`（Surge 2026-08-08，13/13 条一致，token 已脱敏）：

```
POST /v1internal:streamGenerateContent?alt=sse HTTP/1.1
Host / User-Agent / Transfer-Encoding: chunked / Authorization / Content-Type / Accept-Encoding: gzip
```

两处改动，各有实测依据：

1. **弃用 `fetch`（undici）改 `node:http`**。undici 无条件注入 `accept: */*`、
   `accept-language: *`、`sec-fetch-mode: cors`，且 `sec-fetch-mode` 无法覆盖
   （实测置空串仍输出 `cors`）。三个头全是浏览器语义，Go 客户端不可能发。
2. **显式写 `Host` + `req.removeHeader('connection')`**。node:http 自动补的 Host
   排在**末尾**（实测），抓包在首位；Node 还会追加 `Connection: close`，Go net/http
   两者都不发。

抓包里没有 `Connection` 一度被我当成「IDE 不发」——**是 Surge 剥逐跳头**：
同一份抓包 42/42 条请求全无 Connection，含 Chromium 系的 Comet Helper。
结论不变（还是要抹掉），但理由是「Go 默认不发」而非「抓包没有」。

回归：`scripts/test-headers.mjs`（T9），裸 TCP sink 收真实字节，比对请求行 +
头名顺序 + 头值。三个变异各自变红：恢复 Connection / Host 挪末尾 / 插
Accept-Language。

### TLS 层：对不齐，且不做

本机 go1.26 实测（`tls.Dial` 默认配置，最接近上游）对比 Node：

| | JA3 | ciphers | extensions |
|---|---|---|---|
| Go crypto/tls | `03117a8e…` | 13 | `0,11,65281,23,18,5,10,13,50,16,43,51` |
| Node 默认 | `d67b0948…` | 52 | `65281,0,11,10,35,16,22,23,13,43,45,51` |
| Node 尽力逼近 | `0eedf711…` | 13 ✅ | `65281,0,11,10,5,16,23,13,43,45,51` ❌ |

「尽力逼近」= 按 Go 顺序写 13 个 cipher + `ecdhCurve` + `requestOCSP`（出 ext 5）
+ `SSL_OP_NO_TICKET|NO_ENCRYPT_THEN_MAC`（去 ext 35/22）。cipher 数对上了，扩展仍差：
OpenSSL **编不出** ext 18(SCT)、50(sig_algs_cert)，**去不掉** 45(psk_key_exchange_modes)，
且扩展顺序在 OpenSSL 里写死。JA3 必不同。

要真对齐只能换网络栈（Go 写 transport / curl-impersonate）。P0 不做。

### 非流式端点也已对齐

抓包里 cloudcode-pa 三个端点的头形状（30 条，各自内部 100% 一致）：

```
13x streamGenerateContent    Host|UA|Transfer-Encoding|Auth|Content-Type|Accept-Encoding
13x recordCodeAssistMetrics  Host|UA|Content-Length   |Auth|Content-Type|Accept-Encoding
 4x listExperiments          Host|UA|Content-Length   |Auth|Content-Type|Accept-Encoding
```

唯一区别是成帧头。故 `postStream` 加 `chunked` 参数（默认 true），
`ensureProjectId` 改用它（`chunked=false`）。抓包无 `loadCodeAssist` 样本，
按同族非流式端点推定。

`refreshAccessToken` 保留 `fetch` —— 打的是 `oauth2.googleapis.com`，
Google 通用 OAuth 端点，不属于 cloudcode-pa 指纹面。

## 真机端到端验证（2026-08-10）

此前 T1–T7 全 mock。这次拿本机已登录账号打真实上游，暴露 3 个 mock 测不出的 bug。

### bug 1：401 永不自愈（两处叠加）

真机首个请求返回 `500 loadCodeAssist 失败 (HTTP 401)`，本该 refresh 自愈。两个原因叠加：

1. `ensureProjectId` 的 !ok 分支抛**裸 `Error`**，没有 `.status`。
   `withAuth` 按 `err.status === 401` 判定 → 永远为 false。
2. `ensureProjectId` 调用点在 `try` **外面**。它自己就会打上游、自己就会 401，
   放在 try 外时异常直接冒泡，连 catch 都进不去。

两处都改。改后真机 401 → refresh → 重试 → 200，一次通过。

**mock 测不出的原因**：T6 的 mock upstream 直接返回 200，从不 401；
withAuth 的 catch 分支在整个测试套件里从未被执行过。

### bug 2：projectId 从不落盘

`ensureProjectId` 只写内存 `entry.projectId`。进程重启或 token 文件 mtime 变化
（refresh 就会变）后缓存失效重新读盘，盘上没有 → 又打一次 loadCodeAssist。
改为首次解析出就 `writeBack`，refresh 路径也带上。

顺带把重复的写回逻辑抽成 `writeBack()`（原来 refresh 分支内联了一坨）。

### 验证结果

| 项 | 结果 |
|---|---|
| `extract-token` 真机 | ✅ 0600，ya29/1// 均提取到，控制台掩码 |
| 401 → refresh 自愈 | ✅ 修复后一次通过 |
| projectId 落盘 | ✅ 清空后重新请求，自动重建 |
| 单轮文本（非流式） | ✅ `收到`，usage prompt=10077 |
| 流式 SSE | ✅ 6 个 event 齐全 |
| 工具单轮 | ✅ 上游 `view_file` → CC `Read`，stop_reason=tool_use |
| **工具多轮闭环** | ✅ 回填 tool_result 后正确总结，**thoughtSignature 回放无 400** |

thoughtSignature 回放是最大的未知项（wire-reference 标了「缺失必 400」），
真机确认可用。

### bug 3：`~/.claude` 当工作目录 → leakcheck 误杀整个请求

真机日志：

```
[leakcheck] 命中词: /.claude
[error] status=500 leakcheck: systemInstruction 命中 1 类黑名单词
```

命中源不是泄漏，是**用户真实的工作目录**。CC 的 `# Environment` 段：

```
 - Additional working directories:
  - /Users/cddchen/Documents
  - /Users/cddchen/.claude      ← 用户自己加的
```

`extractEnv` 把它抽进 `<user_information>` 的 workspace 列表，撞上黑名单的 `/.claude`。

**行为确认**：`assertSafeToSend` 是**抛异常**，不是告警。命中即请求整体中止，
返 500，一个字节都不发上游。这个设计是对的（宁可失败也不泄漏），
但要求黑名单零误报——而这里就是误报。

**没放宽黑名单**：`.claude` 路径进上游确实是 CC 特征，规则本身正确。
改成在 `buildUserInformation` 组 workspace 列表时过滤：

```ts
const isCc = (p: string): boolean => /(^|\/)\.claude(\/|$)/.test(p);
const paths = [env.cwd, ...env.additionalDirs].filter((p) => !isCc(p));
if (paths.length === 0) paths.push(os.homedir());
```

`paths` 是这些路径唯一的出口，一处过滤覆盖 cwd 和 additionalDirs 两个来源。
全被滤光时退回 `homedir()` —— 不能保留 cwd，那正是要滤掉的那个。

**代价**：模型看不到 `~/.claude` 是工作区，在其中写文件会判定越界。可接受。

回归 T4 4.14，覆盖两种形态（additional 含 / cwd 本身是）。变异（去掉 `.filter`）变红。
真机复现原始目录组合：leakcheck 零命中，200 返回。

### 仍未覆盖

- `recordCodeAssistMetrics` / `listExperiments` 未实现（计划列为 P1）。
  IDE 每轮都发，长期不发是否构成行为差异，未知。
- 8 个未桥接工具（browser/image/schedule/…）走统一 error output，未真机触发过。
- TLS/JA3 —— 见上节，不做。
- **黑名单误报面**：这次是 `/.claude`。同类风险还有 `'Anthropic'`、`'sonnet'`、
  `'opus'`、`'tool_use'` —— 用户 CLAUDE.md 或提问里写到这些词就会被杀。
  `<user_rules>` 走的是同一个 `scanLeaks`。目前没有「用户内容豁免」机制。

## CC rules/skills → Antigravity `<RULE[...]>` / `<skills>`（2026-08-10）

原实现把整段 claudeMd 塞进一个 `<user_rules>`，缀在 `communication_style` 之后。
对照 `surge-conversation.json`（IDE 真实 system，35972 字符 18 段）后重做。

### 抓包给出的位置与形状

```
5559 ephemeral_message   5872 customizations
8759 user_rules (401)  ← <RULE[user_global]> + <RULE[code-style.md]>
9161 skills     (1328) ← Available skills: - name (SKILL.md 路径): desc
…
29286 guidelines   34871 communication_style
```

三个来源都在本机核对过，与 system 里的文本逐字一致：

| 上游块 | 磁盘来源 |
|---|---|
| `<RULE[user_global]>` | `~/.gemini/GEMINI.md` |
| `<RULE[code-style.md]>` | `<workspace>/.agents/rules/code-style.md` |
| `<skills>` | `~/.gemini/config/skills/*/SKILL.md`（本机是指向 `~/.claude/skills` 的符号链接） |

`<user_rules>` 的前言在旧夹具 `ag-system.capture.txt` 里没有（抓那份时用户还没配规则），
只能内联进 `USER_RULES_PREAMBLE`，逐字取自 surge 抓包。

### CC 侧的来源（实测，非推断）

隔离实录 `docs/cc-rules-skills.capture.json`（`CLAUDE_CONFIG_DIR=/tmp/ccconf2`，
全局+项目双 CLAUDE.md，15 个 skill）：

```
msg 0 user   blk 0 text  764B   ← <system-reminder> # claudeMd（两条 Contents of）
msg 0 user   blk 1 text    2B   ← "hi"
msg 1 system str        6807B   ← 内含 2 个 <system-reminder>
   reminder 0  733B  Available agent types for the Agent tool:  ← 丢
   reminder 1 6002B  The following skills are available…  ← 抽
```

**skill 清单不在 `messages[0]`**，在 `role:"system"` 的 message 里 —— 计划书原本把
这条 message 整体标为「丢弃」。`parseSkills` 因此扫全部 message，不能只看首条。

### 映射规则

| CC 来源 | 判定 | → 上游 |
|---|---|---|
| `Contents of <path> (user's private global instructions for all projects):` | label 含 `global` | `<RULE[user_global]>` |
| `Contents of <path> (project instructions, checked into the codebase):` | 其余 | `<RULE[project.md]>` |
| `- name: desc` 行 | — | `<skills>` 的 `Available skills:` |
| 其余 reminder（agent types / task tools / cwd reset） | — | 丢 |

### 四个必错点

1. **不能先剥 `Contents of` 头再解析。** 原 `extractEnv` 第一步就 `replace` 掉它，
   路径和 global/project 标签一起没了。改成先按它切段，再在每段内剥。
2. **tag 不能用真实 basename。** 项目那份文件就叫 `CLAUDE.md`，`RULE[CLAUDE.md]`
   是明牌。全局固定 `user_global`（与 IDE 一致），项目固定 `project.md`。
   —— 这里偏离了「照抄抓包的 `code-style.md`」：那是 gemini 侧的文件名，不该硬编码。
3. **skill 描述自带 CC 特征词。** 实测 15 个里 5 个会让 `assertSafeToSend` 抛错：
   `update-config`→`Claude Code`、`claude-api`→`Anthropic`、
   `keybindings-help`→`~/.claude/keybindings.json`、`init`→`CLAUDE.md`、
   `fewer-permission-prompts`→`.claude/settings.json`。
   在 `parseSkills` 出口过滤掉。这些本就是操作 CC 自身的 skill，对上游无意义。
4. **过滤用的是比 `LEAK_BLACKLIST` 更严的规则**（多查 `CLAUDE.md` / `.claude`）。
   黑名单本身不能加这两条 —— 用户 CLAUDE.md 正文首行常常就是 `# CLAUDE.md`，
   加了会误杀 `<user_rules>`。skill 描述是 CC 自己的元数据、不含用户正文，
   在那里收紧无副作用。

### 偏离与代价

- **T4 4.2 从「与原型逐字节相同」降级为「共有段落一致」。**
  `docs/leakcheck.prototype.mjs` 早于 rules/skills，输出必然不同了。
  保留的断言仍能抓住 identity/user_information/ephemeral/guidelines/
  communication_style 五段的偏离。
- **4.1 长度 7563 → 12400。** 差值来自新增的 `<skills>`（9 个可用 skill）与
  RULE 拆分。
- **`<skills>` 从「丢弃段」改为「条件重建段」**，T4 4.7 的丢弃清单从 10 段减到 9 段。
- `userRules` 字段保留未删 —— `rules` 为空但 `userRules` 非空时（无 `Contents of`
  头的旧形态 body）退回单块 `<user_rules>`，旧断言 4.9/4.10 不动。

### 验证

T4 新增 4.15，四处变异各自变红（把 4.1 的长度断言同步改成变异值，
否则长度先失败会掩盖具体断言）：

| 变异 | 变红的断言 |
|---|---|
| tag 改成真实 basename | `rules 应拆成 user_global + project.md` |
| `parseSkills` 只扫 `messages[0]` | `skills 应非空（源在 role=system 的 message 里）` |
| 去掉 skill 泄漏过滤 | `scanLeaks(si)` 非空 |
| `user_rules`/`skills` 放回末尾 | `须在 ephemeral 与 guidelines 之间` |

`npx tsc` = 0，`run-tests.mjs` 12/12。

### DUMP_SYSTEM 解剖日志

`src/system-prompt.ts: dumpSystemAnatomy()`，默认关（首行 `if (!dest) return`）。

- `DUMP_SYSTEM=1` —— 打印入站 system 各块大小与一级标题、reminder、tools 数、
  抽出的值、出站各段来源（capture 原样 / 重建）
- `DUMP_SYSTEM=<path>` —— 另存 `{inbound, extracted, outbound}` 全文，0600。
  含 CC 关键词，只落本地磁盘，不进上游。

本机跑 `NODE_EXTRA_CA_CERTS`：Surge 在代理时 Node 不认它的 CA，
`security find-certificate -a -c Surge -p /Library/Keychains/System.keychain` 导出后指过去。
环境问题，非代码问题。
