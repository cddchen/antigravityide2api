# 测试用例设计（架构师制定，sonnet 实现）

原则：**每条断言必须能追到 `docs/` 里的夹具或已实证结论**，不许凭直觉写期望值。
不引入测试框架 —— `node:assert` + `scripts/*.mjs`，`npm test` 串跑。

夹具入口：
- `docs/cc-request.capture.json` → `.body`（CC 真实出站，wire 87835 B）
- `docs/ag-envelope.capture.json` → `.envelope` / `.contentsSkeleton`
- `docs/native-tools.capture.json` → 14 项
- `docs/ag-system.sections.json` → 15 段 offset

---

## T1 `scripts/test-envelope.mjs` —— 上游信封形状

对照 `ag-envelope.capture.json`。

| # | 断言 | 依据 |
|---|---|---|
| 1.1 | `envelope.userAgent === 'antigravity'` | capture |
| 1.2 | `envelope.requestType === 'agent'` | capture |
| 1.3 | `requestId` 匹配 `/^agent\/[^/]+\/\d{13}\/[^/]+\/\d+$/` | capture 形状 |
| 1.4 | `request.systemInstruction.role === 'user'` **不是 `'system'`** | §1.2 |
| 1.5 | `request.toolConfig.functionCallingConfig.mode === 'VALIDATED'` | §1.2 |
| 1.6 | `generationConfig.maxOutputTokens === 65536` | §1.2 |
| 1.7 | `generationConfig.thinkingConfig` 深等于 `{includeThoughts:true,thinkingBudget:-1}` | §1.2 |
| 1.8 | `sessionId` 是**负** int64 字符串：`/^-\d+$/` 且 `BigInt()` 不抛且 `< 0n` | §1.2 |
| 1.9 | 连续 20 次 `newSessionId()` 全部满足 1.8 | 防随机边界 |
| 1.10 | `request.tools.length === 14`，每项 `functionDeclarations.length === 1` | §1.2「一项一声明」 |
| 1.11 | tools 的 14 个 name **有序**等于 capture 的 0..13 顺序 | 指纹 |
| 1.12 | envelope 顶层键集合 === capture 顶层键集合 | 无多余键 |
| 1.13 | `request` 键集合 === capture 的 `request` 键集合 | 无多余键 |
| 1.14 | `labels` 含 `trajectory_id`/`last_step_index`/`used_claude`，且 `used_claude === 'false'` | §1.2 P0 最小集 |
| 1.15 | **序列化后 JSON 里不含 CC 独有工具名**（`CronCreate` 等 10 个独有词） | 风控 |

## T2 `scripts/test-sse.mjs` —— SSE 解析（喂假帧，不发网络）

| # | 断言 | 依据 |
|---|---|---|
| 2.1 | 多帧 text 增量按序拼接 | §1.4「文本是增量分片」 |
| 2.2 | FC part 进 `fcParts` 后 `thoughtSignature` **字符串相等且引用相同**（`strictEqual(acc.fcParts[0], 原 part)`） | §1.3 硬规则 2 —— 不可重建 |
| 2.3 | 末帧 `{thoughtSignature:'X', text:''}` + `finishReason:'STOP'`：`text` 不变、`fcParts` 长度不变 | §1.4「不要把 text:"" 当内容」 |
| 2.4 | `usageMetadata` 三帧递增值 → 最终等于**最后一帧**（覆盖，不是三帧之和） | §1.4「累计不是增量」 |
| 2.5 | `finishReason` 取最后一个非 null | §1.4 |
| 2.6 | `parseSseLine('data: {"a":1}')` → 对象；`parseSseLine('')` → null；`parseSseLine(': ping')` → null | SSE 格式 |
| 2.7 | 一帧含 2 个 FC part（仅第一个带 sig）→ 两个都进 `fcParts`，顺序不变 | §1.3 硬规则 3 |
| 2.8 | `frame.error = {code:401}` → 抛 `AntigravityError` 且 `.status === 401` | auth refresh 依赖它 |
| 2.9 | 400 且 message 含 `thought_signature` → 错误消息提示会话不可恢复 | §1.3 |

## T3 `scripts/test-tool-bridge.mjs` —— 桥接（**含真实 shell 执行**）

纯映射断言已在 `dist/tool-bridge.js` 自检里覆盖，这里只做**自检没做的**：真实执行 + 夹具同构。

| # | 断言 | 做法 |
|---|---|---|
| 3.1 | `list_dir` 桥接产物在真实 shell 跑出的**第一行**，与 `contentsSkeleton` 里 `list_dir` FR 的 `outputHead` 第 3 行**同构**（键序 `name`,`sizeBytes`；无空格；`sizeBytes` 是字符串） | `execSync(cmd)` 于一个临时目录，造一个已知大小的文件与一个子目录，逐字符比对 JSON |
| 3.2 | `grep_search` 桥接产物真实执行，`Query='$(id)'` 匹配到字面量且**输出里不含 `uid=`** | `execSync`，防注入 |
| 3.3 | `Query="it's"` 也能真实执行不报语法错 | 单引号转义 |
| 3.4 | `SearchPath` 是**单文件**时输出带 `文件名:行号:` 前缀（证明 `-H` 生效） | `execSync` |
| 3.5 | 一个含 60 处匹配的文件，输出**恰好 50 行**（证明 `head -50` 是 total 而非 per-file） | 造夹具文件 |
| 3.6 | `rg` 无匹配 → `execSync` 抛（exit 1），但 `buildFunctionResponse(..., '', true)` 仍产出**含 `Completed At:`** 的成功 output | 退出码陷阱 |
| 3.7 | `grep_search` FR 载荷每行可 `JSON.parse`，键恰为 `{Filename,LineNumber,LineContent}` | schema description 声明 |
| 3.8 | 14 个原生工具**逐个**过 `bridgeFunctionCall`：6 个 `tool_use`，8 个 `reject`；且 6 个的 `claudeName` ∈ `{Read,Bash,Write,Edit}` | 遍历 `native-tools.capture.json` 的 name |
| 3.9 | 桥出的 `claudeName` **没有** `LS`/`Grep`/`Glob` | CC 无这三个工具 |
| 3.10 | `write_to_file` 目标 `../../etc/passwd`（相对越界）也被 reject | `path.resolve` 后判定 |

## T4 `scripts/test-system-prompt.mjs` —— system 转换与泄漏

| # | 断言 | 依据 |
|---|---|---|
| 4.1 | `buildSystemInstruction(extractEnv(body),'trimmed').length === 7563` | 原型实测 |
| 4.2 | 与 `docs/leakcheck.prototype.mjs` 的输出**逐字节相同** | 产品化不得漂移 |
| 4.3 | `scanLeaks()` 返回 `[]` | 风控 |
| 4.4 | `LEAK_BLACKLIST.length === 44` | wire-reference |
| 4.5 | 输出**不含** `# Memory` / `# Environment` / `# Harness` / `# Context management` / `# Session-specific guidance` | 五个 CC 标题 |
| 4.6 | 输出含 `<identity>` `<user_information>` `<ephemeral_message>` `<guidelines>` `<communication_style>` `<user_rules>` 六段 | 组装规格 |
| 4.7 | 输出**不含** `web_application_development` / `artifacts` / `planning_mode` 等 10 个丢弃段的标签 | §1.5 |
| 4.8 | `extractEnv` 的 `additionalDirs` 里**不含** `Platform:` / `Shell:` / `powered by the model` 等字样 | 坑 1：`\s+` 吃穿缩进 |
| 4.9 | CLAUDE.md 正文首行是 `# CLAUDE.md` 时 `userRules` **非空** | 坑 2：前瞻白名单 |
| 4.10 | `userRules` **不含** `Contents of ` 与 `.claude` | 坑 3：包装头 |
| 4.11 | 构造 `cwd=/private/tmp/x` + `additional=['/tmp/x']`（同一 realpath）→ `<user_information>` 说 **1 active workspace** | 坑 4：symlink 去重 |
| 4.12 | `communication_style` 段里**不含** `file://` 与后台任务规则原文，但整行仍在（零宽替换） | 组装规格 |
| 4.17 | 额外过滤词只遮命中词、不删段；`parseTrimWordsSpec` 接受逗号与 JSON 数组 | 过滤词表 |
| 4.18 | 过滤词匹配不区分大小写；`claude`+`claude code` 时长词优先 | 过滤词表 |
| 4.13 | `system` 传 string（非数组）也能正确 `extractEnv` | 契约是 union |

## T5 `scripts/test-pending.mjs` —— 多轮状态机（400 陷阱回归）

| # | 断言 | 依据 |
|---|---|---|
| 5.1 | 一个 session 注册 3 个 tool id，**任一**都能 `getPendingByToolId` 取回**同一对象** | 并行 tool_use |
| 5.2 | `removePending` 后 3 个 id **全部** miss | 无泄漏 |
| 5.3 | `appendToolRound` 恰好 push **2 条** content | §1.3 |
| 5.4 | 两条的 `role` **都是 `'model'`** | 硬规则 1 —— FR 不是 user/function |
| 5.5 | `contents[n].parts` 与传入的 `fcParts` **引用相同**（`strictEqual`） | 硬规则 2 —— 原样回放，不可拷贝重建 |
| 5.6 | 2 个 FC（仅第一个带 sig）经一轮 append 后，**在同一个 content 的 parts 里**，且第一个的 sig 未丢 | 硬规则 3 —— 这是 400 的根源 |
| 5.7 | 序列化整个 contents，`thoughtSignature` 出现次数 === 输入里的次数 | 无丢失 |
| 5.8 | pendingTimeout=50ms 时 60ms 后自动清空 | 超时 |

## T6 `scripts/test-server.mjs` —— 端到端（**mock 上游，不发真网络**）

起真 express，用一个本地 mock SSE server 顶替上游（`ANTIGRAVITY_BASE` 指向它）。

| # | 断言 | 依据 |
|---|---|---|
| 6.1 | `GET /health` 200，body 含 token 数，**不含任何 token 明文** | 安全 |
| 6.2 | `GET /v1/models` 200，`data[]` 非空 | API |
| 6.3 | 设 `API_KEY` 后，无 `x-api-key`/`Authorization` → 401 | 鉴权 |
| 6.4 | `POST /v1/messages` 非流式、mock 回纯文本 → 200，`stop_reason:'end_turn'`，content[0].text 正确 | 首轮 |
| 6.5 | mock 回一个 FC → 响应 `stop_reason:'tool_use'`，content 里有 tool_use 块，`name` ∈ `{Read,Bash,Write,Edit}` | 桥接 |
| 6.6 | **mock 收到的请求体**：`tools` 14 项、`systemInstruction.role==='user'`、**不含** CC 的 25 个工具名、不含 `<system-reminder>` | 风控核心 |
| 6.15 | 尾条 user 仅 `<system-reminder>` 内文 → 分支 A，`contents` 以 `role:'user'` 结尾，`<USER_REQUEST>` 含内文、不含标签 | 会话末总结不得 400 |
| 6.7 | 带 tool_result 续轮 → mock 收到的 `contents` 里有连续两条 `role:'model'`，第一条含 FC + 原样 sig，第二条含 FR `{output}` | 400 陷阱 |
| 6.8 | 续轮的 FR `output` 是**字符串**且以 `Created At:` 开头 | §1.3.1 |
| 6.9 | mock 回 2 个 FC → 流式响应里 2 个 tool_use 块、1 次 `message_stop`、`stop_reason:'tool_use'` | 并行 |
| 6.10 | 未知 `tool_use_id` 的 **纯** tool_result → 400 而非 500/挂死 | 健壮性 |
| 6.13 | 未知 `tool_use_id` + 同条 sibling text → 分支 A（新 session step=0，`<USER_REQUEST>` 含该文本，无 FC 回放） | compact / pending miss |
| 6.14 | pending HIT + 同条 sibling text → 分支 A（新 session step=0，无 FC 回放）；随后同 id 纯 tool_result → 400 | compact 不得续进旧 cascade |
| 6.11 | 流式：事件序列合法（`message_start` 唯一且第一、`message_stop` 唯一且最后、每个 `content_block_start` 有配对 `stop`） | SSE 协议 |
| 6.12 | mock 回 401 → 服务端不把它当 500（能触发 refresh 路径；mock refresh 端点回新 token 后重试成功） | auth |

## T7 `scripts/assert-no-cc-leak.mjs` —— 风控闸门（独立可跑）

产品化 `docs/leakcheck.prototype.mjs`，但扫的是**完整 envelope**（systemInstruction + contents + tools），不只 system。

- 文本黑名单：44 词中的**独有词**（`Claude Code`/`Anthropic`/`claude-cli`/`cc_version`/`CronCreate`/`DesignSync`/… /`opus`/`haiku`/`sonnet`）
- **短词不走文本扫**（`Read`/`Write`/`Edit`/`Agent`/`Skill`/`Bash` 在 Antigravity harness 与用户正文里天然出现，必然误报）→ 改为**结构断言**：`tools.length===14` 且 name 集合 === 原生 14 白名单
- 命中任一 → 非 0 退出，打印命中词 + 前后 60 字符上下文
- 入参：可从 stdin 读 envelope JSON，也可 `--fixture` 用夹具跑一遍自证

## T8 `scripts/run-tests.mjs`

串跑 T1–T7 + 三个模块自检（`dist/tool-bridge.js`、`dist/antigravity-client.js`、`dist/pending-session.js`、`dist/anthropic.js`），汇总 `通过/失败` 计数，任一失败非 0 退出。

---

## 明确不测（P0）

- 真实上游网络调用（需要活体 token，且会计费/留痕）
- `extract-token` 的 sqlite 读取（依赖本机 IDE 已登录状态，非确定性）——只测 base64 BFS 纯函数部分（若可导出）
- TLS / JA3 指纹
