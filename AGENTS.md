# AGENTS.md

## 项目与适用范围

本仓库构建严格 TypeScript 的 Node/Express 代理，把 Claude 的 Anthropic Messages 接口转换为 Antigravity IDE agent 协议。本文件适用于整个仓库。`harness.md` 负责描述当前事实；本文件只记录修改项目时必须遵守的规则。

## 证据优先级

1. 当前用户指令和本范围内的协作契约。
2. 已入库的 capture/schema 输入，尤其是 `docs/native-tools.capture.json` 和 system/envelope captures。
3. `src/` 下的生产代码与 `package.json`。
4. `scripts/run-tests.mjs` 中的可执行测试和实际结果。
5. `harness.md`、`docs/wire-reference.md` 和当前用户 README。
6. `implementation-notes.md`、旧架构/checklist 文档、本地 smoke 笔记和参考/对比项目。

来源冲突时，在 `harness.md` 中保留差异；没有代码、capture 或测试证据，不得把历史散文提升为硬规则。

## 仓库地图

- `src/server.ts`：HTTP 组合根，以及新请求/续轮分支。
- `src/anthropic.ts`：Claude 请求提取和 Anthropic JSON/SSE 响应。
- `src/system-prompt.ts`：Prompt 重建、rule/skill 提取和泄漏扫描。
- `src/antigravity-client.ts`：上游 envelope、受控 HTTP 传输、SSE 解析和超时。
- `src/auth.ts`、`src/extract-token.ts`、`src/token-paths.ts`：凭证、project 发现和本地 token 路径。
- `src/native-tools.ts`、`src/tool-bridge.ts`、`src/pending-session.ts`：原生目录、语义工具映射和进程内续轮状态。
- `docs/*.capture.*`：脱敏协议证据和运行时输入；不得仅为让测试通过而修改。
- `scripts/run-tests.mjs`：标准测试清单；`scripts/TEST-PLAN.md` 是辅助设计说明，且有已知漂移。
- `dist/`：被忽略的编译产物。只修改 `src/`，不得手工编辑 `dist/`。

## 硬性所有权与分层规则

- `src/server.ts` 只做编排。Claude wire 转换放在 `anthropic.ts`，system 过滤放在 `system-prompt.ts`，上游 wire 行为放在 `antigravity-client.ts`，凭证放在 `auth.ts`/`extract-token.ts`，工具语义映射放在 `tool-bridge.ts`，pending 索引/过期放在 `pending-session.ts`。
- 严禁上传 Claude 入站 `tools[]`、Claude 身份/system 文本、中途 `role: "system"` 内容或没有原始签名的历史工具块。必须重建 system instruction，并以原生目录替换工具。
- 保留发送前泄漏闸门。上游必须收到 capture 顺序下严格 14 个原生工具项，每项一个 declaration。当前只支持 6 个映射，不代表可以移除另外 8 个声明。
- Capture 表示已观测契约。只有取得脱敏且可复现的证据时才能重新生成或修订，并同时更新对应 mapper、测试和文档。
- 保留手工控制的 `node:http`/`node:https` 传输，除非替代方案能证明 header 顺序、header 集合、streaming/content-length、压缩处理和错误语义均满足要求。

## 生命周期、状态与并发不变量

- 没有当前尾随 `tool_result` 的请求必须创建新的 `sessionId`、`cascadeUuid`、`trajectoryUuid` 和 step 0。不得从 Claude message ID 推断上游连续性。
- 按原顺序保留每个上游 FC part 及其兄弟字段，尤其是 `thoughtSignature`。同一上游 turn 的全部 FC parts 必须放入一个 `role: "model"` content；匹配的 FR parts 放入紧随其后的另一个 `role: "model"` content。
- 不得重建、拆分、丢弃或伪造缺失的 `thoughtSignature`。签名丢失应视为上游 trajectory 不可恢复。
- 并行的可桥接 call 只有在全部记录的 Claude tool ID 都有结果后才能 resume。混合拒绝 call 仍要按序生成原生错误 FR。纯拒绝循环必须有上限。
- 续轮必须复用原 system instruction 和上游 session/cascade/trajectory 身份，并恰好把 step 加一。当前未强制 model、账号和 workspace root 重绑定；修改这些行为前，必须解决 `harness.md` 中的不一致并添加回归测试。
- Pending session 只存在于进程内，由每个 bridged tool ID 索引，可因过期、完成或关闭而删除。未实现持久化和测试前，不得声称支持崩溃/重启 restore。
- 保留第一次上游 `await` 前同步完成 pending 校验/删除的特性；当前正是这一点让重复 resume 看到 unknown ID。如引入更早的 `await` 或跨 worker，必须增加显式幂等或锁。Token refresh/writeback 和 mtime cache 更新不得引入竞态。
- 保留请求超时。若增加客户端取消或优雅关闭，必须把 abort 传播到上游，并测试发送 header 前和 SSE 中途两种情况。

## 协议与映射规则

- 保持 `systemInstruction.role: "user"`、`requestType: "agent"`、`toolConfig` mode `VALIDATED`、原生 FC/FR history role `model`，以及只含 `{ output: string }` 的 `functionResponse.response`；只有新 capture 能证明需要改变。
- 上游 SSE usage 是累计值，不是 delta。Function-call part 必须整体保留；末尾空 text/signature frame 必须忽略；thought text 不得作为普通响应文本暴露。
- Claude 文本历史可以回放；没有原始签名的历史 Claude `tool_use`/`tool_result` 不得翻译进上游历史。
- 原生到 Claude 的映射必须是语义映射，不得透传。增加剩余 8 个原生工具之一时，必须同时定义参数映射、结果整形、拒绝行为和夹具测试。
- 所有插入合成 shell 文本的模型输入都必须使用现有 `sq` helper 引用。`run_command.CommandLine` 本身是有意执行的内容；不得在周围拼接其他未引用字段。
- 保留显式 `WORKSPACE_ROOT` 或提取 cwd 形成的 Write/Edit 边界。不得暗示 Read/Bash/list/grep 已有相同边界；收紧或放宽策略均需明确测试和运维文档。
- 即使并行 FC 只有第一个携带签名，也要保持原分组；FR 必须按 FC 顺序生成，不能按客户端结果顺序。

## 安全与持久化

- IDE `state.vscdb` 和 `storage.json` 是只读输入。严禁把刷新后的凭证写回 IDE 存储。
- Token JSON 和显式 prompt dump 必须保持 0600，token 目录保持 0700。严禁提交 token 文件、OAuth client secret、bearer/refresh token、machine identifier 或未脱敏 capture。
- OAuth client 值只能来自环境覆盖或运行时已安装的 IDE。不得硬编码，并确保仓库和测试输出兼容 secret scanning。
- Token/status/error 日志必须脱敏并限制长度。`DEBUG` logcat 和 `DUMP_SYSTEM` 产物可能含 prompt、规则、路径和工具结果，必须按敏感数据处理。
- `/v1/models` 和 `/v1/messages` 共用可选 API key 闸门；`/health` 有意不鉴权。建议使用非 loopback `HOST` 前，必须重新评估鉴权与 CORS。
- 当前账号选择固定为 `tokens[0]`。实现并测试选择契约前，不得宣称支持多账号路由。

## 测试与验证

| 修改类型 | 最低证据要求 |
| --- | --- |
| TypeScript/运行时逻辑 | `npm run build` 加最相关专项脚本；依赖可用时，交付前运行 `npm test`。 |
| Envelope、原生目录或 labels | T1、T6、T7 和 `antigravity-client` 自检。 |
| 上游 SSE/parser 或 Anthropic SSE 输出 | T2、T6 和 `anthropic` 自检。 |
| 工具映射、shell 构造或 FR 整形 | T3、按需 T5/T6，以及 `tool-bridge` 自检。T3 需要 `rg`；list 行为需要 Python 3。 |
| System/rule/skill 转换 | T4、T7、`npm run leakcheck` 和 T6 发送前断言。 |
| Pending/续轮生命周期 | T5 和 T6，包括并行结果不完整与原始签名回放。 |
| Headers/传输/auth | T9/T10 和 T6。不得用真实凭证测试代替这些测试。 |
| 打包文件选择 | `npm pack --dry-run --json`；全局 cache 不可用时使用任务专用可写 npm cache。 |
| 仅文档 | 核验每个路径/命令；若有文档 linter 则运行；最后执行 `git diff --check`。默认不运行真实上游 smoke。 |

`npm test` 是标准套件（`npm run build && node scripts/run-tests.mjs`）。2026-09-04 审计机器结果为 13 条通过，1 条因缺少 `rg` 发生环境失败。不得误报为产品断言失败，也不得声称全部通过。Manifest 声明 Node 18+；`rg` 和 Python 3 是尚未声明的工具桥/测试运行依赖。

真实 token 提取、refresh 或 Google API 调用需要用户已安装并登录的 IDE，以及明确意图。普通验证优先使用本地 mock-upstream T6。

## 工作区与交付规则

- 修改前检查 `git status`。保留无关 tracked/untracked 用户工作；没有明确指示时，不得 reset、stage、commit、publish 或重写。
- 用户可见命令、环境变量、前置依赖和行为变化时，保持 `README.md` 与 `README_zh.md` 同步。
- 所有权、生命周期、协议、持久化、安全边界、测试层级或已知漂移变化时更新 `harness.md`。只有影响后续决策的耐久规则才进入 `AGENTS.md`。
- 不得静默“修复”历史笔记。应标记被取代结论或更新状态，同时保留有价值的决策缘由。
- 交付报告必须包含：修改文件、实际验证、失败/跳过及原因、未解决的运行时问题，以及无关用户改动得到保留的确认。

## 完成检查

- 是否保留原生工具和 system 泄漏边界？
- Session 身份、FC 分组、签名、FR 顺序与 pending 清理是否仍正确？
- 凭证、debug 数据、文件系统路径和 shell 值是否在正确边界处理？
- 代码、capture、测试、用户文档、`harness.md` 与本规则是否一致；若不一致，剩余漂移是否明确？
- 是否如实报告专项和完整验证，包括本机缺少的依赖和未运行的真实 smoke？
