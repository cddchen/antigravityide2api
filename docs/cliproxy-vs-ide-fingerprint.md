# CLIProxyAPI vs Antigravity IDE：识别差异报告

> 调研日期：2026-08-08  
> **抓包校准**：Surge `2026-08-08-170054`（同日）  
> 范围：CLIProxy 实现 vs 本机 Antigravity IDE（ideVersion 2.1.1）+ 真实 PA 流量  
> 目的：解释为何 CLIProxy 路径易被识别/封号；约束 antigravityide2api 实现

---

## 0. 结论摘要

### Top 识别点（按风险，抓包后重排）

| # | 差异 | 类型 | 一句话 |
|---|------|------|--------|
| 1 | **工具模型**：Claude `Read`/`Bash`+`file_path` vs 原生 14 tools（`view_file`/`run_command`+PascalCase+`toolAction`/`toolSummary`） | **硬指纹** | 上游一眼分「CC 代理」vs「IDE agent」 |
| 2 | **schema 清洗**：空 object 注入固定 `properties.reason` placeholder | **硬指纹** | CLIProxy 特有加工；IDE 无此字段 |
| 3 | OAuth：`localhost:51121` 独立登录 vs IDE 会话 / `antigravity.google` 回调；多号池 | 硬/账号画像 | 设备与账号行为不像 IDE |
| 4 | HTTP UA：`antigravity/hub/2.2.1` vs 抓包 **`antigravity/ide/2.1.1 darwin/arm64`** | **中高** | hub vs ide + 版本号 |
| 5 | 缺伴生 RPC：IDE 高频 **recordCodeAssistMetrics + listExperiments**；CLIProxy 几乎只有 generate | **统计异常** | 生命周期不像 IDE |
| — | ~~toolConfig VALIDATED 独有~~ | **降级** | **IDE agent 抓包亦为 VALIDATED**（checkpoint=NONE） |

### 防识别原则（antigravityide2api）

1. 只上传 **原生 14 harness tools**（`docs/native-tools.capture.json`），绝不透传 Claude `tools[]`
2. token **优先 extract IDE**，独立 OAuth 仅 fallback
3. envelope/UA/base **对齐抓包**：daily（本环境）、`ide/2.1.1` UA、`requestId` 格式、稳定负整数 `sessionId`
4. toolConfig agent 用 **VALIDATED**（与 IDE 一致）；system 用 harness 纪律文案
5. 传输层可参考 CLIProxy 事实，**产品语义禁止学 CLIProxy**

---

## 1. 对比总表（抓包校准）

| 维度 | IDE（抓包 2026-08-08） | CLIProxy | 风险 |
|------|------------------------|----------|------|
| OAuth client | 同源 | 同源 | 低 |
| redirect | `https://antigravity.google/oauth-callback` | `http://localhost:51121/oauth-callback` | **高** |
| token 来源 | IDE `state.vscdb` 会话 | 独立 OAuth + 多账号 | **高** |
| Base | 本会话 **daily**；LS 亦可见 prod | daily → prod | 中（环境相关） |
| stream | `streamGenerateContent?alt=sse` | `?alt=sse` | 低 |
| HTTP UA | **`antigravity/ide/2.1.1 darwin/arm64`** | `antigravity/hub/2.2.1 darwin/arm64` | **中高** |
| HTTP 版本 | 抓包 HTTP/1.1 + chunked | 强制 HTTP/1.1 + Connection: close | 中 |
| body.userAgent | **`antigravity`** | `"antigravity"` | 低 |
| requestType | **`agent`** / `checkpoint` / `tab` | `"agent"` / `image_gen` | 低-中 |
| requestId | **`agent/{uuid}/{ms}/{uuid}/{n}`** | 实现相关（易不一致） | 中 |
| sessionId | **稳定负整数字符串** | 首条 user text hash | **中高** |
| **tools** | **14 原生**，每项独立 `functionDeclarations[1]` | **Claude tools 透传** | **极高** |
| tool 元字段 | 必填 **toolAction + toolSummary** | 无 / reason placeholder | **极高** |
| toolConfig | agent **VALIDATED** | Claude → VALIDATED | **低**（双方同） |
| schema | 原生固定 | Clean + **reason placeholder** | **极高** |
| system | ~35k Antigravity harness | CC system，滤 billing | **高** |
| FC/FR 历史 | **均 role=model**；FR=`{output}` | 常见 user 侧 FR / 不同 shape | **高** |
| 伴生 RPC | **metrics + listExperiments** 高频 | 基本 generate | **高** |
| 版本 | ideVersion **2.1.1** | hub **2.2.1**/latest | 中 |

---

## 2. 分项详解

### 2.1 工具模型（最关键，硬证据）

**IDE（抓包 + LS）**

- 固定 **14** tools：`ask_question`, `browser_subagent`, `generate_image`, `grep_search`, `list_dir`, `manage_task`, `multi_replace_file_content`, `read_url_content`, `replace_file_content`, `run_command`, `schedule`, `search_web`, `view_file`, `write_to_file`
- 结构：`tools[i].functionDeclarations` 每项 **仅 1** 个 tool（共 14 个数组元素）
- 参数 PascalCase：`AbsolutePath`, `CommandLine`, `TargetFile`, `CodeContent`, `Cwd`, …（`search_web` 例外用小写 `query`）
- **每个 tool 必填** `toolAction` + `toolSummary`
- agent `toolConfig.mode = VALIDATED`（checkpoint = NONE）
- system ~35k harness 身份/纪律
- 完整 schema：`docs/native-tools.capture.json`

**CLIProxy（源码 + 测试）**

- `ConvertClaudeRequestToAntigravity`：`tools[].input_schema` → `functionDeclarations`
- 测试期望上游看到：`functionCall.name == "Read"` / `"Bash"`，`file_path` / `command`
- `CleanJSONSchemaForAntigravity` + 空 schema 注入：
  ```
  properties.reason.description =
    "Brief explanation of why you are calling this tool"
  required: ["reason"]
  ```
- model 名含 `claude` → `toolConfig.mode = "VALIDATED"`（**与 IDE agent 相同，单独不再构成识别点**）

**判定：** 工具名/参数/元字段 才是「像 IDE」vs「像第三方 CC 代理」的最大分界。用户反馈封号与此强相关。

证据：

- `CLIProxyAPI/internal/translator/antigravity/claude/antigravity_claude_request.go`
- `.../antigravity_claude_request_test.go`
- `CLIProxyAPI/internal/util/gemini_schema.go`
- Surge `2026-08-08-170054`；`docs/native-tools.capture.json`

### 2.2 OAuth

| | IDE | CLIProxy |
|--|-----|----------|
| ClientID/secret | LS 内嵌同源 | 同 |
| scopes | cloud-platform 等 | 同 |
| redirect | `antigravity.google/oauth-callback` | `localhost:51121/oauth-callback` |
| 主路径 | 已登录会话落盘 vscdb | `offline`+`consent` 独立登录 |
| 多号 | 单用户 IDE | AuthManager 轮询 |

client 同源 **不是**识别主因；**redirect + 独立 refresh 生命周期 + 多号** 才是。

证据：`internal/auth/antigravity/constants.go`, `auth.go`；LS strings。

### 2.3 HTTP / Base / UA

- IDE LS 启动参数可见 prod；**本会话 agent 抓包全部 daily**
- CLIProxy generate 回退：**daily 优先**（与本抓包 base 一致，base  alone 不是硬指纹）
- **IDE HTTP UA（抓包）**：`antigravity/ide/2.1.1 darwin/arm64`
- CLIProxy UA：`antigravity/hub/2.2.1 darwin/arm64` → **hub vs ide + 版本** 仍是中高风险
- body.userAgent 双方多为 `"antigravity"`
- CLIProxy 强制 HTTP/1.1 ALPN + `Connection: close`；抓包亦见 HTTP/1.1 + chunked（MITM 下 TLS/ALPN 未独立证伪）
- refresh UA：`Go-http-client/2.0`（CLIProxy）

证据：`antigravity_executor.go`；`misc/antigravity_version.go`；`product.json`；Surge `2026-08-08-170054`

### 2.4 Envelope（抓包）

IDE agent 外层：

```json
{
  "project": "fluent-falcon-nrl9f",
  "requestId": "agent/{cascadeUuid}/{ms}/{trajectoryUuid}/{seq}",
  "model": "gemini-3.6-flash-high",
  "userAgent": "antigravity",
  "requestType": "agent",
  "request": {
    "sessionId": "-3750763034362895579",
    "tools": [/* 14× {functionDeclarations:[native]} */],
    "toolConfig": { "functionCallingConfig": { "mode": "VALIDATED" } },
    "labels": { "trajectory_id": "…", "last_step_index": "…", "used_claude": "false", "…": "…" },
    "generationConfig": { "maxOutputTokens": 65536, "thinkingConfig": { "includeThoughts": true, "thinkingBudget": -1 } }
  }
}
```

CLIProxy 常见偏差：`requestId: agent-<uuid>`、`sessionId = hash(first user text)`、tools=Claude 形、可选 `enabledCreditTypes`（本 IDE 抓包 **未见**）。

FC/FR 历史：IDE 将 **FC 与 FR 都放在 `role: model`**；FR 仅 `{output:string}`。勿按「FR 必在 user」拼装。

### 2.5 会话 / 伴生 RPC

**本抓包高频伴生：**

- `recordCodeAssistMetrics`（metadata.ideType=`ANTIGRAVITY`, ideVersion=`2.1.1`, platform=`DARWIN_ARM64`）
- `listExperiments`（body `{}`）

日志/LS 另可见：`loadCodeAssist`、`fetchAvailableModels`、`onboardUser`、`cascadeNuxes`、`recordClientEvent`、`retrieveUserQuota`…

CLIProxy：几乎只有 generate + 取 project 时的 load/onboard。

→ 即便 UA 对了，**纯 generate 风暴 + 429 换号** 仍是强统计异常。

### 2.6 内容层

- CC 常用 cat/grep/ls via Bash vs IDE harness 纪律 → **行为分布**可识别
- thinking / `thoughtSignature`：IDE FC 常带 signature，续轮应原样回放
- 仅滤 `x-anthropic-billing-header:` 的 CC system 其余仍可能进上游：高内容差

### 2.7 版本

| 源 | 值 |
|----|-----|
| IDE product | ideVersion **2.1.1**, languageServerCL **933924006** |
| CLIProxy fallback | hub **2.2.1** / remote latest |

应用本机 `product.json`，不要盲跟 hub。

---

## 3. 「像 IDE」最小集合 vs CLIProxy 实际

### 像 IDE 最小集

1. Bearer = IDE 会话 token（extract）
2. Base 默认 **prod**
3. UA / userAgent / ideVersion 对齐本机
4. **仅原生 functionDeclarations**
5. toolConfig 贴近 IDE（勿强行 VALIDATED + placeholder）
6. system 含 harness 约束
7. contents 历史保持原生 FC/FR
8. 控制面底噪：至少 loadCodeAssist
9. SSE streamGenerateContent
10. 单账号本机会话节奏

### CLIProxy 实际

1. 独立 OAuth localhost:51121  
2. daily→prod  
3. hub UA + HTTP/1.1 硬编码  
4. Claude tools + schema clean + VALIDATED  
5. `Read`/`Bash` 名  
6. sessionId 首句 hash  
7. requestType≈agent  
8. inject GOOGLE_ONE_AI  
9. 429 换号  
10. 几乎无伴生 RPC  

→ **外壳略像，语义完全不像。**

---

## 4. 证据强度

### 硬证据（静态/日志）

- Claude tools 透传与测试 `Read`/`Bash`
- schema `reason` placeholder
- VALIDATED 强制
- OAuth redirect 不同
- daily 优先 vs LS 启动 prod
- IDE 伴生 RPC 与 harness 禁 cat 字符串
- ideVersion/CL

### 推测 / 待抓包

- 完整 agent Header / TLS(JA3)
- requestType wire 是否总是 `"agent"`
- IDE toolConfig.mode 精确值
- functionResponse 全 schema
- IDE sessionId 算法
- 封号与单点指纹的因果（多信号加权；工具模型差异为强相关）

本机日志几乎无完整 `streamGenerateContent` agent dump，envelope 细字段需一次真实 Cascade 抓包校准。

---

## 5. antigravityide2api 可执行清单

### 必须

- [ ] 禁止上传 Claude `tools[]`；注入原生 harness
- [ ] tool-bridge + pending-session
- [ ] extract-token 主路径
- [ ] base 跟随抓包（本环境 daily）+ 可配置
- [ ] UA = `antigravity/ide/{product.ideVersion} {os}/{arch}`
- [ ] requestId / sessionId / labels 对齐抓包
- [ ] agent toolConfig **VALIDATED** + 14 原生 tools JSON
- [ ] harness system 约束
- [ ] 原生 FC/FR **model role** + `{output}` 进历史
- [ ] loadCodeAssist 就绪后再 generate
- [ ] （P1）recordCodeAssistMetrics / listExperiments

### 不要学 CLIProxy

1. Claude tools 透传 + schema `reason` placeholder cleaner  
2. localhost:51121 作主登录 / 默认多号池  
3. 把 VALIDATED 当「伪装开关」却仍上传 Claude schema  
4. CC system 当默认内容模型  
5. `hub/2.2.1` 冒充本机 `ide/2.1.1`  
6. sessionId=首句 hash  
7. 盲抄 Force HTTP/1.1 / Connection: close（抓包后再定）

### 可延后

- 全量伴生 RPC（recordClientEvent 等）
- hub updater
- 多账号农场

---

## 6. 证据路径索引

| 主题 | 路径 |
|------|------|
| executor | `CLIProxyAPI/internal/runtime/executor/antigravity_executor.go` |
| UA/version | `CLIProxyAPI/internal/misc/antigravity_version.go` |
| OAuth | `CLIProxyAPI/internal/auth/antigravity/{constants,auth}.go` |
| Claude tools | `CLIProxyAPI/internal/translator/antigravity/claude/*` |
| schema | `CLIProxyAPI/internal/util/gemini_schema.go` |
| IDE product | `/Applications/Antigravity IDE.app/.../product.json` |
| LS | `.../extensions/antigravity/bin/language_server_macos_arm` |
| 抓包 | Surge `2026-08-08-170054` |
| 原生 tools 导出 | `docs/native-tools.capture.json` |
| 项目决策 | `docs/Antigravity-IDE-API.md`, `implementation-notes.md` |

---

**一句话：** CLIProxy 借用了同源 OAuth 与 Cloud Code PA 外壳，但 **`functionDeclarations` 仍是 Claude Code 代理**。识别只需看是 `Read/file_path` 还是 `view_file/AbsolutePath`（外加 toolAction/toolSummary）。`VALIDATED` 本身不是 CLIProxy 指纹——IDE agent 同样使用。antigravityide2api 必须走 **抓包对齐的 IDE 原生 harness + 语义桥**。
