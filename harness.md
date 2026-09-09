# antigravityide2api Harness 说明

> 范围：仓库根目录的 TypeScript 代理、Claude HTTP 接口、Antigravity 上游适配器、本地凭证生命周期、工具桥和验证设施。
> 最后核验：2026-09-04。
> 证据基线：`package.json` 0.1.0、当前 `src/`、已入库的 wire captures，以及 `main` 分支上的 `scripts/run-tests.mjs`。

## 摘要

`antigravityide2api` 把本机已登录的 Antigravity IDE 账号导出为 Anthropic Messages 兼容 HTTP API。`src/server.ts` 是组合根：接收 Claude 形态请求，重建 Antigravity system prompt，以抓包所得的 14 个原生工具声明替换入站工具目录，发送 IDE 形态的 envelope，再把上游 function call 翻译回 Claude 工具。

最重要的是语义边界，而不只是传输转换。Claude 的 system 元数据和工具声明不得透传到上游。该边界由 `src/system-prompt.ts`、`src/native-tools.ts` 和 `src/server.ts` 的 `assertSafeToSend` 负责。工具续轮状态仅存在于服务进程内，不是持久化对话存储。

```text
Claude 客户端
  -> Express 路由与 Anthropic 响应映射（server.ts、anthropic.ts）
     -> prompt 重建与泄漏闸门（system-prompt.ts）
     -> 14 个原生工具目录（native-tools.ts + capture）
     -> OAuth/project 包装（auth.ts）
     -> Antigravity envelope 与 HTTP/SSE（antigravity-client.ts）
        -> cloudcode-pa 上游

上游 functionCall[]
  -> 语义桥（tool-bridge.ts）
  -> Claude tool_use[] + 进程内 pending（pending-session.ts）
  -> Claude tool_result[]
  -> 原始 functionCall parts + 原生 functionResponse parts
  -> 下一次上游 turn
```

## 证据与权威性

| 来源 | 作用与可信度 | 权威性与已知漂移 |
| --- | --- | --- |
| `src/types.ts`、`src/*.ts`、`package.json` | 已核验的当前实现与 manifest | 在适用指令之后，是仓库内最高行为依据。类型描述内部预期，但入站 JSON 没有完整运行时校验。 |
| `docs/native-tools.capture.json`、`docs/ag-system.capture.txt`、`docs/ag-system.sections.json`、`docs/ag-envelope.capture.json` | 抓包/生成的 wire 证据 | 原生声明顺序和已观测 wire 形态的权威来源；不代表上游全部支持范围。 |
| `scripts/run-tests.mjs`、`scripts/test-*.mjs` | 可执行本地证据 | 当前测试清单。`scripts/TEST-PLAN.md` 有旧文件名和过时自检数量。 |
| `docs/wire-reference.md` | 当前协议综合说明 | 强解释，但从属于 capture、代码和测试；仍含重复 `Overwrite` 表述和未验证结论。 |
| `README.md`、`README_zh.md` | 用户/运维入门 | 主 CLI 与环境变量基本为当前状态，不是生命周期或测试权威。 |
| `implementation-notes.md` | 决策历史与实机实验 | 对缘由和被推翻假设有用；结论必须先用较新代码/capture 核验。 |
| `docs/Antigravity-IDE-API.md`、`docs/cliproxy-vs-ide-fingerprint.md` | 架构和对比历史 | 未勾选实现清单已过时；前者仍保留“丢弃无效 `thoughtSignature`”的旧说法，当前代码则视签名丢失为不可恢复。 |
| `.claude/skills/verify/SKILL.md` | 未跟踪的本地 smoke 配方 | 属于用户现有工作，只可作为线索；模型名和真实凭证步骤在使用前需实时核验。 |

默认优先级：当前用户/仓库指令 -> capture/schema/type 契约 -> 生产代码与 manifest -> 可执行测试和运行结果 -> 当前协议文档 -> 计划、笔记与参考项目。

## 证据账本

| 事实 | 所有者 | 最强来源 | 置信度 | 漂移/动作 |
| --- | --- | --- | --- | --- |
| 交付物是 Node/Express 的 Anthropic 兼容代理和 CLI。 | `src/server.ts`、`src/cli.ts` | 生产代码 + `package.json` | 已核验当前状态 | 无。 |
| 上游收到严格有序的 14 个原生工具项，每项一个声明。 | `src/native-tools.ts`、`assertSafeToSend` | 原生 capture + T1/T6/T7 | 已核验当前状态 | 正常桥接只有 6 个，不得推断 14 个均已支持。 |
| Function-call parts（含 `thoughtSignature`）作为一个有序 model content 回放，随后是 model role 的 function responses。 | `src/pending-session.ts`、`src/server.ts` | T2/T5/T6 + capture | 已核验当前状态 | 签名丢失不可恢复；声称可丢弃的旧文档已过时。 |
| 凭证从 IDE 复制到独立的 0600 token 文件并在其中刷新，绝不写回 IDE 数据库。 | `src/extract-token.ts`、`src/auth.ts` | 生产代码 + auth 测试 | 已核验当前状态 | 本次未执行真实提取/刷新。 |
| Pending、skill 清单缓存和 debug logcat 都只存在于内存。 | `src/pending-session.ts`、`src/system-prompt.ts`、`src/logcat.ts` | 生产代码 | 已核验当前状态 | 重启/过期会失去续轮能力；没有 restore。 |
| 标准测试先构建，再运行 14 个条目。 | `package.json`、`scripts/run-tests.mjs` | 实际执行 `npm test` | 已核验当前状态 | 本机 13 个通过；T3 因缺少 `rg` 失败。 |

## 身份与状态

| 身份/状态 | 所有者与生命周期 | 不得混淆为 |
| --- | --- | --- |
| Token entry `name` | `token.json`，持久化 | 可选账号；当前请求始终使用 `tokens[0]`。 |
| `projectId` | `loadCodeAssist` 解析，缓存在 token 对象并持久化 | Claude 对话或 workspace ID。 |
| `sessionId` | 随机负 int64，一个上游工具轨迹内有效 | `cascadeUuid`、`trajectoryUuid` 或 Claude message ID。 |
| `cascadeUuid` | 无 `tool_result` 的新请求创建；pending-session key | Claude transcript/session 元数据。 |
| `trajectoryUuid` | 工具续轮期间稳定，用于 labels/request ID | `cascadeUuid`。 |
| `functionCall.id` / `tool_use.id` | 桥接时原样保留，也是 pending 查询键 | Pending session；多个 ID 可索引同一 session。 |
| `stepIndex` | 从 0 开始，每次上游续轮加一 | 客户端 message 数量。 |
| 文本历史 | 每次新请求由 `buildContents` 重建 | 完整工具历史；历史工具块因缺少上游签名而被丢弃。 |

`pendingCount()` 返回已索引 tool ID 数，而不是不同 pending session 数。`PendingAgentSession.sessionKey`、`tokenName` 和 `projectId` 虽然会记录，但 resume 路由会重新获取第一个 token entry、接受续轮请求的新 model，并从该请求重算 workspace root；当前不会强制账号/model/workspace 与首轮一致。

## 架构与所有权

| 层 | 负责 | 不负责 |
| --- | --- | --- |
| `src/cli.ts`、`src/config.ts`、`src/token-paths.ts` | 前后台命令、PID/log 路径、环境配置汇聚、启动轮询 | 请求转换或上游协议映射。 |
| `src/server.ts` | HTTP 路由、鉴权、分支、编排和错误映射 | 原生声明内容或底层 HTTP 指纹。 |
| `src/anthropic.ts` | 入站文本/tool-result 提取和 Anthropic JSON/SSE 输出 | 上游身份或凭证刷新。 |
| `src/system-prompt.ts` | 环境/rule/skill 提取、prompt 重建、泄漏黑名单、skill 伪路径缓存 | 工具执行或 OAuth。 |
| `src/native-tools.ts` | 加载和校验原生工具目录 | 被明确丢弃的 Claude 入站 `tools[]`。 |
| `src/antigravity-client.ts` | Envelope、受控 HTTP headers、gzip/SSE、usage、超时 | Token 持久化和 Claude 响应格式。 |
| `src/auth.ts`、`src/extract-token.ts` | Token 读写、OAuth refresh、project 发现、只读 IDE 提取 | HTTP 路由和对话状态。 |
| `src/tool-bridge.ts` | 6 个已支持映射、结果整形、shell 引用、Write/Edit 路径拒绝 | Pending 生命周期或实际工具执行。 |
| `src/pending-session.ts` | 内存 tool-ID 索引、过期、成组 FC/FR 追加 | 持久化 restore。 |
| `src/logcat.ts` | `DEBUG` 下的有界内存调试视图 | 鉴权或持久化日志。 |

配置在模块加载时求值；进程启动后修改环境变量不会重新配置服务。

## 启动、凭证与关闭

1. `dist/cli.js extract-token` 只读 IDE SQLite 数据库和 `storage.json`。OAuth client 与 IDE 版本来自本机 IDE，也可由环境变量覆盖。
2. `extract-token` 写独立 `TOKEN_FILE`，默认位于用户的 `.antigravityide2api` 目录；文件 0600，目录 0700。
3. 前台启动要求 token 文件存在，`startServer` 在监听前确认至少一个可用 entry。后台启动会 spawn `dist/server.js`、写 PID、重定向日志并等待 `/health`。
4. Token 文件 mtime 改变时热加载第一个 entry。缺 `projectId` 时用 `loadCodeAssist` 获取并持久化。上游 401 只触发一次 OAuth refresh 和重试。
5. `SIGINT`/`SIGTERM` 清除 pending timers/indexes 后立即退出；当前不会先 drain HTTP、优雅关闭 listener 或取消进行中的上游请求。

`/health` 有意位于 `API_KEY` middleware 之外，仅返回 token 数和 pending 索引数。只有 `API_KEY` 非空时，`/v1/models` 和 `/v1/messages` 才要求 `x-api-key` 或 Bearer。CORS 不受限；安全默认值是 loopback（`HOST=127.0.0.1`）。

## 请求与工具续轮生命周期

### 新请求

1. `parseToolResults` 扫描末尾连续 user 段。没有当前 tool result 时，创建新的上游 session/cascade/trajectory 身份。
2. `extractEnv` 只提取选定的 workspace/platform/git/rule/skill 信息；`buildSystemInstruction` 使用入库 capture sections 重建 `full`、`trimmed` 或 `short` 文本。
3. `buildContents` 转发文本历史，把 `assistant` 映射为上游 `model`，移除 `<system-reminder>`，丢弃中途 `system` 和历史工具块，只把最后一条 user 文本包装为 `<USER_REQUEST>`。
4. Claude 入站工具目录被丢弃。加载并校验 14 项原生 capture 后，`assertSafeToSend` 在发送下游 SSE header 前拒绝非原生目录或 Claude 专属泄漏文本。
5. `withAuth` 解析凭证/project，`streamGenerate` 发送 IDE 形态请求。文本要么累积为 JSON，要么由 `AnthropicSseWriter` 增量转发。

### Function call 与 resume

- 6 个调用正常映射：`view_file -> Read`（skill 伪路径为 `Skill`）、`run_command -> Bash`、`write_to_file -> Write`、`replace_file_content -> Edit`、`list_dir`/`grep_search -> Bash`。其余 8 个仍上传声明，被调用时返回原生错误。
- `Write`/`Edit` 超出 `WORKSPACE_ROOT` 时被拒；未配置时使用请求提取的 cwd。Read、list、grep 和 command 没有相同边界。
- 全部 call 被拒时，本地追加 error responses 后重试上游，连续纯拒绝最多 3 次。
- 至少一个 call 可桥接时，保存完整原始 FC 组；混合场景的拒绝 call 仍留在组内，并在 resume 时生成 response。
- Resume 必须带齐所有 bridged tool ID。不完整时返回 400 且不访问上游。FC parts 一起追加到一个 `role: "model"` content，FR parts 按 FC 顺序放在随后另一个 `role: "model"` content。
- 访问续轮上游前删除 pending；若上游失败，当前进程无法用相同 tool ID 重试。
- 最终文本结束 turn；再次出现 function call 时，沿用上游身份并递增 step，建立新 pending。

没有显式 per-session lock，但 resume 路由在第一次上游 `await` 前同步完成 pending 校验与删除。单 Node 事件循环下，重复请求会看到 unknown ID，而不会发起第二次续轮。重构时必须保留 consume-before-await，或增加显式幂等/锁。Token refresh 和文件回写没有串行化。

## 取消、恢复与持久化

- `streamGenerate`/`fetchAvailableModels` 总使用 `REQUEST_TIMEOUT`，也支持调用方 `AbortSignal`；但 `src/server.ts` 没把 HTTP 客户端断开传播过去。
- Pending 在 `PENDING_TIMEOUT` 后过期；小于等于 0 表示禁用。过期或重启都会让 tool ID 变为 unknown。
- 对话、pending FC、skill cache、logcat frame 都不会在重启后恢复。新请求仅从客户端 payload 重建文本历史并创建新上游身份。
- 持久化仅包括 token JSON、其中的 refreshed/project 元数据、后台 PID/log 和显式 `DUMP_SYSTEM` 输出。`DUMP_SYSTEM=<path>` 以 0600 写入原始 prompt 数据，必须按敏感数据处理。

## 协议与安全不变量

- `docs/native-tools.capture.json` 是运行时输入，不只是说明材料。14 项各含一个 declaration，并要求 `toolAction`/`toolSummary`。
- `systemInstruction.role` 为 `user`，tool mode 为 `VALIDATED`，FC/FR history role 都是 `model`，FR 只含 `{ output: string }`。
- `thoughtSignature` 是 `functionCall` 的兄弟字段，必须原样保留。并行 FC 即使只有首个带签名，也保持原顺序和分组。
- 上游 usage frame 是累计值，应覆盖旧值；普通文本为增量。末尾空 text/signature frame 不是 function call。
- 传输有意使用 `node:http`/`node:https` 控制 header 名、顺序和 chunking，并避免浏览器自动 headers；当前未复刻 IDE 的 Go TLS 指纹。
- 合成 shell 片段通过 `sq` 引用模型提供的搜索路径、query、include glob 和 cwd。`run_command.CommandLine` 是有意交给 Claude Bash 执行的命令。
- OAuth client、bearer/refresh token 不得进入源码、capture、日志、测试输出或文档。Debug 输出仍可能含用户 prompt、规则、路径和工具结果。

## 文档地图

| 文档 | 作用 | 信任/更新边界 |
| --- | --- | --- |
| `harness.md` | 当前架构、所有权、生命周期、证据和漂移 | Adapter、生命周期、状态、安全或测试设施变化时更新。 |
| `AGENTS.md` | 后续修改必须遵守的规则 | 只从已核验行为提炼耐久规则，不作历史日志。 |
| `README.md`、`README_zh.md` | 安装、配置、运行和运维 | 命令或环境变量变化时保持双语同步。 |
| `docs/wire-reference.md` | 上下游 wire 契约与映射理由 | 以脱敏、可复现 capture 和对应测试更新。 |
| `docs/Antigravity-IDE-API.md` | 广义架构/API 调研 | Checklist 与旧错误建议在刷新前按历史材料处理。 |
| `implementation-notes.md` | 决策、实验与修正历史 | 保留缘由；不得直接当作可执行事实。 |
| `docs/fetch-available-models.md` | 模型目录端点证据 | Capture 或 mapper 契约变化时更新。 |
| `scripts/TEST-PLAN.md` | 测试设计意图 | 文件名/数量已漂移；runner 和测试文件拥有执行真相。 |

## 测试设施

| 层级 | 边界与依赖 | 命令 | 当前结果/缺口 |
| --- | --- | --- | --- |
| 编译 | 严格 TypeScript，`src/` -> 被忽略的 `dist/` | `npm run build` | 2026-09-04 通过。 |
| 标准本地套件 | Envelope、SSE、bridge、system/leak、pending、server、headers、OAuth 与模块自检 | `npm test` | 13/14 通过；T3 需要本机缺少的 `rg`。list bridge 还依赖 Python 3。 |
| 协议/泄漏夹具 | 已入库 Claude request 与 Antigravity system capture | `npm run leakcheck` | 黑名单命中 0；通过。 |
| 本地集成 | Express 子进程 + 本地模拟 Google endpoints；真实 HTTP/SSE 与鉴权 | `npm test` 的 T6 | 通过；无真实 Google 流量。 |
| 传输一致性 | 本地 capture server 检查 6 个上游 header 及顺序 | T9 | 通过；不验证 TLS/JA3。 |
| 打包 | npm 文件选择和 tarball 元数据 | `npm pack --dry-run --json` | 使用可写 cache 时通过；默认 npm cache 有项目外所有权错误。 |
| 真实 smoke | IDE 凭证提取、daemon、动态模型、流式/非流式消息 | 无已跟踪自动命令 | 需要已登录 IDE 和真实上游；本地未跟踪 verify skill 只是草案，不得自动执行。 |

仓库没有已跟踪 CI。覆盖缺口：客户端断开取消、优雅 drain、崩溃/过期 restore、显式并发重复 resume、refresh/writeback 串行化、resume 时账号/model/workspace 重绑定、真实上游兼容、daemon 生命周期自动化和安装后包执行。

## 已确认漂移与开放问题

### 已确认漂移

- `scripts/TEST-PLAN.md` 使用旧名 `test-tool-bridge.mjs`、`test-system-prompt.mjs`，runner 实际为 `test-bridge.mjs`、`test-system.mjs`；模块自检数量也过时。
- `docs/Antigravity-IDE-API.md` 和 `docs/cliproxy-vs-ide-fingerprint.md` 的实现 checklist 未勾选，但功能已落地；前者的无效签名建议与代码/测试冲突。
- `package.json#files` 含不存在的 `READ.md`。Dry run 证明 npm 仍自动包含 `README.md`，但 manifest 条目已过时。
- 生产 `grep_search` 与 T3 需要 `rg`，README 未声明，本次审计机器也未安装。
- `recordCodeAssistMetrics`/`listExperiments`、daily 到 prod 自动回退和更多工具桥仍只是目标/观测，生产代码未实现。

### 开放的运行时/设计问题

- Resume 是否应强制首轮 token entry、project、model 和 workspace 边界，而不是从续轮请求重算。
- 是否应在续轮上游成功后才删除 pending，以支持瞬时失败后的安全重试。
- 客户端断开是否应取消上游，以及优雅关闭如何 drain 活跃请求。
- 是否需要显式 per-session consume lock，以及 refresh/writeback 是否需要串行化。
- Prod 上游何时使用、缺少伴生 RPC 是否有影响、Node TLS 指纹是否可接受。
- 剩余 8 个原生工具中哪些需要语义桥；必须依据脱敏真实证据，不能只凭 schema 推断。
