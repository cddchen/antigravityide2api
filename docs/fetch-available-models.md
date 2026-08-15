# `fetchAvailableModels` 事实记录

> 这份文档只记录抓包中确认的协议事实，以及本项目如何把该响应映射到 `/v1/models`。不把某次账号的模型目录当作永久常量。

## 1. 证据来源

主证据：Surge `2026-08-14-204936`，请求目录：

```text
Requests/014741 - 20.49.59 - POST - https%3A%2F%2Fdaily%2Dcloudcode%2Dpa.googleapis.com%2Fv1internal%3AfetchAvailableModels/
```

文件：

- `model.json`：请求/响应 HTTP 元数据；
- `request.dump`：请求 body；
- `response.dump`：gzip 压缩的响应 body。

同一批还捕获了 014709（20:49:33）和 014722（20:49:49）两次相同 RPC。三次响应的模型集合和分类列表一致；差异只有 24 个模型的 `quotaInfo.resetTime`，其值随响应时间变化。

响应体的 `project` 已在本文和夹具中脱敏为 `<projectId>`。Authorization 不写入文档。

## 2. HTTP

### 请求

```http
POST /v1internal:fetchAvailableModels HTTP/1.1
Host: daily-cloudcode-pa.googleapis.com
User-Agent: antigravity/ide/2.5.5 (aidev_client; os_type=darwin; arch=arm64)
Content-Length: 33
Authorization: Bearer <redacted>
Content-Type: application/json
Accept-Encoding: gzip
```

本 RPC 的请求 body 使用 `Content-Length`，不是 `streamGenerateContent` 使用的 chunked body：

```json
{"project":"<projectId>"}
```

014741 的实际抓包值已脱敏为 `<projectId>`；该 project 是本账号对应的 `cloudaicompanionProject`，不在文档中保留。

### 响应

```http
HTTP/1.1 200 OK
x-cloudaicompanion-trace-id: <per-request trace id>
Content-Type: application/json; charset=UTF-8
Content-Encoding: gzip
Transfer-Encoding: chunked
```

解压后是一个 JSON 对象，不是 SSE。014741 解压后的 JSON 长度为 127962 字节。

## 3. 响应顶层结构

014741 的顶层键及类型：

| 键 | 类型 | 抓包值/数量 |
|---|---|---:|
| `models` | object | 28 个模型键 |
| `defaultAgentModelId` | string | `gemini-3.7-flash-high` |
| `agentModelSorts` | array | 1 组排序配置 |
| `commandModelIds` | string[] | 1 |
| `tabModelIds` | string[] | 2 |
| `imageGenerationModelIds` | string[] | 1 |
| `mqueryModelIds` | string[] | 1 |
| `webSearchModelIds` | string[] | 1 |
| `deprecatedModelIds` | object | 1 |
| `commitMessageModelIds` | string[] | 1 |
| `audioTranscriptionModelIds` | string[] | 1 |
| `experimentIds` | number[] | 58 |
| `tieredModelIds` | object | 3 个 tier |

响应的最小形状为：

```json
{
  "models": {
    "<model id>": {
      "model": "<model enum>",
      "apiProvider": "<provider enum>",
      "modelProvider": "<provider enum>",
      "quotaInfo": {
        "remainingFraction": 1,
        "resetTime": "<RFC3339，可选>"
      }
    }
  },
  "defaultAgentModelId": "gemini-3.7-flash-high",
  "agentModelSorts": [],
  "commandModelIds": [],
  "tabModelIds": [],
  "imageGenerationModelIds": [],
  "mqueryModelIds": [],
  "webSearchModelIds": [],
  "deprecatedModelIds": {},
  "commitMessageModelIds": [],
  "audioTranscriptionModelIds": [],
  "experimentIds": [],
  "tieredModelIds": {}
}
```

示例中的空数组/空对象只是 schema 占位；实际值以本次响应为准。

## 4. 分类列表（014741 原值）

```json
{
  "defaultAgentModelId": "gemini-3.7-flash-high",
  "agentModelSorts": [
    {
      "displayName": "Recommended",
      "groups": [
        {
          "modelIds": [
            "gemini-3.7-flash-high",
            "gemini-3.7-flash-medium",
            "gemini-3.7-flash-low",
            "gemini-3.6-flash-high",
            "gemini-3.6-flash-medium",
            "gemini-3.6-flash-low",
            "gemini-3-flash-agent",
            "gemini-3.5-flash-low",
            "gemini-3.5-flash-extra-low",
            "gemini-pro-agent",
            "gemini-3.1-pro-low",
            "claude-sonnet-4-6",
            "claude-opus-4-6-thinking",
            "gpt-oss-120b-medium"
          ]
        }
      ]
    }
  ],
  "commandModelIds": ["gemini-3-flash"],
  "tabModelIds": ["chat_20706", "chat_23310"],
  "imageGenerationModelIds": ["gemini-3.1-flash-image"],
  "mqueryModelIds": ["gemini-3.1-flash-lite"],
  "webSearchModelIds": ["gemini-3.1-flash-lite"],
  "deprecatedModelIds": {
    "gemini-3.1-pro-high": {
      "newModelId": "gemini-pro-agent",
      "oldModelEnum": "MODEL_PLACEHOLDER_M37",
      "newModelEnum": "MODEL_PLACEHOLDER_M16"
    }
  },
  "commitMessageModelIds": ["gemini-3.1-flash-lite"],
  "audioTranscriptionModelIds": ["models/proactive-observer-v10"],
  "tieredModelIds": {
    "flashLite": ["gemini-3.1-flash-lite"],
    "flash": ["gemini-3.7-flash-tiered"],
    "pro": ["gemini-3.1-pro-low"]
  }
}
```

`models/proactive-observer-v10` 出现在 `audioTranscriptionModelIds`，但不出现在 `models` 对象中；这两个字段不是同一个目录。

## 5. 28 个模型目录

下表只列稳定可读的模型字段。未出现的字段代表该模型在本次响应中没有发送该字段，不代表协议保证其永远缺失。

`capabilities` 只列本次响应中出现且为 `true` 的布尔能力；`thinking` 是 `thinkingBudget`，`—` 表示字段未出现。

| id | displayName | model enum | provider | maxTokens / maxOutputTokens | thinking | capabilities |
|---|---|---|---|---:|---:|---|
| `chat_20706` | — | `MODEL_CHAT_20706` | INTERNAL / GOOGLE | 16384 / — | — | cumulative, estimate, lead-in, internal, XML/chatml, tab range, find/replace cursor |
| `chat_23310` | — | `MODEL_CHAT_23310` | INTERNAL / GOOGLE | 32768 / — | — | cumulative, estimate, lead-in, internal, XML/chatml |
| `claude-opus-4-6-thinking` | Claude Opus 4.6 (Thinking) | `MODEL_PLACEHOLDER_M26` | ANTHROPIC_VERTEX / ANTHROPIC | 250000 / 64000 | 1024 | images, thinking, recommended |
| `claude-sonnet-4-6` | Claude Sonnet 4.6 (Thinking) | `MODEL_PLACEHOLDER_M35` | ANTHROPIC_VERTEX / ANTHROPIC | 250000 / 64000 | 1024 | images, thinking, recommended |
| `gemini-2.5-flash` | Gemini 3.1 Flash Lite | `MODEL_GOOGLE_GEMINI_2_5_FLASH` | GOOGLE_GEMINI / GOOGLE | 1048576 / 65535 | — | — |
| `gemini-2.5-flash-lite` | Gemini 3.1 Flash Lite | `MODEL_GOOGLE_GEMINI_2_5_FLASH_LITE` | GOOGLE_GEMINI / GOOGLE | 1048576 / 65535 | — | — |
| `gemini-2.5-flash-thinking` | Gemini 3.1 Flash Lite | `MODEL_GOOGLE_GEMINI_2_5_FLASH_THINKING` | GOOGLE_GEMINI / GOOGLE | 1048576 / 65535 | — | — |
| `gemini-2.5-pro` | Gemini 2.5 Pro | `MODEL_GOOGLE_GEMINI_2_5_PRO` | GOOGLE_GEMINI / GOOGLE | 1048576 / 65535 | 1024 | images, thinking, recommended |
| `gemini-3-flash` | Gemini 3 Flash | `MODEL_PLACEHOLDER_M18` | GOOGLE_GEMINI / GOOGLE | 1048576 / 65536 | -1 | images, video, thinking, recommended |
| `gemini-3-flash-agent` | Gemini 3.5 Flash (High) | `MODEL_PLACEHOLDER_M84` | GOOGLE_GEMINI / GOOGLE | 1048576 / 65536 | -1 | images, video, thinking, recommended |
| `gemini-3.1-flash-image` | Gemini 3.1 Flash Image | `MODEL_PLACEHOLDER_M21` | GOOGLE_GEMINI / GOOGLE | — / — | — | — |
| `gemini-3.1-flash-lite` | Gemini 3.1 Flash Lite | `MODEL_PLACEHOLDER_M50` | GOOGLE_GEMINI / GOOGLE | 1048576 / 65535 | — | — |
| `gemini-3.1-pro-high` | Gemini 3.1 Pro (High) | `MODEL_PLACEHOLDER_M37` | GOOGLE_GEMINI / GOOGLE | 1048576 / 65535 | 10001 | images, video, thinking, recommended |
| `gemini-3.1-pro-low` | Gemini 3.1 Pro (Low) | `MODEL_PLACEHOLDER_M36` | GOOGLE_GEMINI / GOOGLE | 1048576 / 65535 | 1001 | images, video, thinking, recommended |
| `gemini-3.5-flash-extra-low` | Gemini 3.5 Flash (Low) | `MODEL_PLACEHOLDER_M187` | GOOGLE_GEMINI / GOOGLE | 1048576 / 65536 | 1000 | images, video, thinking, recommended |
| `gemini-3.5-flash-low` | Gemini 3.5 Flash (Medium) | `MODEL_PLACEHOLDER_M20` | GOOGLE_GEMINI / GOOGLE | 1048576 / 65536 | 4000 | images, video, thinking, recommended |
| `gemini-3.6-flash-high` | Gemini 3.6 Flash (High) | `MODEL_PLACEHOLDER_M71` | GOOGLE_GEMINI / GOOGLE | 1048576 / 65536 | -1 | images, video, thinking, recommended |
| `gemini-3.6-flash-low` | Gemini 3.6 Flash (Low) | `MODEL_PLACEHOLDER_M73` | GOOGLE_GEMINI / GOOGLE | 1048576 / 65536 | 1000 | images, video, thinking, recommended |
| `gemini-3.6-flash-medium` | Gemini 3.6 Flash (Medium) | `MODEL_PLACEHOLDER_M72` | GOOGLE_GEMINI / GOOGLE | 1048576 / 65536 | 4000 | images, video, thinking, recommended |
| `gemini-3.6-flash-tiered` | — | `MODEL_PLACEHOLDER_M196` | GOOGLE_GEMINI / GOOGLE | 1048576 / 65536 | -1 | images, video, thinking, recommended |
| `gemini-3.7-flash-high` | Gemini 3.7 Flash (High) | `MODEL_PLACEHOLDER_M298` | GOOGLE_GEMINI / GOOGLE | 1048576 / 65536 | -1 | images, video, thinking, recommended |
| `gemini-3.7-flash-low` | Gemini 3.7 Flash (Low) | `MODEL_PLACEHOLDER_M300` | GOOGLE_GEMINI / GOOGLE | 1048576 / 65536 | 1000 | images, video, thinking, recommended |
| `gemini-3.7-flash-medium` | Gemini 3.7 Flash (Medium) | `MODEL_PLACEHOLDER_M299` | GOOGLE_GEMINI / GOOGLE | 1048576 / 65536 | 4000 | images, video, thinking, recommended |
| `gemini-3.7-flash-tiered` | — | `MODEL_PLACEHOLDER_M301` | GOOGLE_GEMINI / GOOGLE | 1048576 / 65536 | -1 | images, video, thinking, recommended |
| `gemini-pro-agent` | Gemini 3.1 Pro (High) | `MODEL_PLACEHOLDER_M16` | GOOGLE_GEMINI / GOOGLE | 1048576 / 65535 | 10001 | images, video, thinking, recommended |
| `gpt-oss-120b-medium` | GPT-OSS 120B (Medium) | `MODEL_OPENAI_GPT_OSS_120B_MEDIUM` | OPENAI_VERTEX / OPENAI | 131072 / 32768 | 8192 | recommended |
| `tab_flash_lite_preview` | — | `MODEL_PLACEHOLDER_M19` | GOOGLE_GEMINI / GOOGLE | 16384 / 4096 | — | cumulative, estimate, lead-in, XML |
| `tab_jump_flash_lite_preview` | — | `MODEL_PLACEHOLDER_M28` | GOOGLE_GEMINI / GOOGLE | 16384 / 4096 | — | cumulative, estimate, lead-in, no-XML-examples, XML, tab range, find/replace cursor |

额外字段事实：

- `quotaInfo` 在 28/28 个模型上出现；全部 `remainingFraction` 为 `1`；24 个模型同时有 `resetTime`，4 个 tab/chat 模型只有 `remainingFraction`。
- `displayName` 在 22/28 个模型上出现；6 个模型没有该字段。
- `modelExperiments` 在 23/28 个模型上出现；其值形状为 `{ "experiments": { "<name>": { "stringValue": "..." } } }`。
- `supportedMimeTypes` 在 18/28 个模型上出现；本次并集为 31 种 MIME type。
- `recommended` 在 19/28 个模型上出现，出现时值为 `true`；其他模型不发送该字段。
- `supportsThinking` 在 19/28 个模型上出现，出现时值为 `true`；`thinkingBudget` 与 `minThinkingBudget` 随模型出现。
- `vertexModelId` 只在 3 个模型上出现：`claude-opus-4-6-thinking`、`claude-sonnet-4-6`、`gpt-oss-120b-medium`。

## 6. `modelExperiments` 的已观测键

本次 28 个模型中共观察到以下 7 个 experiment key：

| key | 出现模型数 |
|---|---:|
| `CASCADE_USE_EXPERIMENT_CHECKPOINTER` | 23 |
| `cascade-include-ephemeral-message` | 11 |
| `template__system_prompts__planning_mode_artifacts` | 8 |
| `template__system_prompts__communication_style` | 8 |
| `template__system_prompts__guidelines` | 4 |
| `template__system_prompts__messaging` | 4 |
| `task-details-suffix` | 4 |

`CASCADE_USE_EXPERIMENT_CHECKPOINTER` 在本次响应中有 4 种配置变体，区别包括 `strategy`、`max_token_limit`、`token_threshold`、`use_last_planner_model` 和 `max_output_tokens`。完整的 `stringValue` 保留在 `fetch-available-models.capture.json` 中；它们不是 `/v1/models` 映射所必需的字段。

## 7. 本项目的动态映射

当前实现路径：

```text
GET /v1/models
  → checkApiKey
  → firstTokenEntry()
  → withAuth(...)
      → 必要时 loadCodeAssist 获取 project
      → POST {ANTIGRAVITY_BASE}/v1internal:fetchAvailableModels
      → 401 时 refresh 一次并重试
  → Object.entries(response.models)
  → { id, type: "model", display_name, ...upstreamMetadata }
```

映射规则：

- `data[].id` 使用上游 `models` 对象的键；
- `data[].display_name` 使用上游 `displayName`，缺失时回退到该键；
- 上游模型元数据（如 `model`、provider、token 限制、能力字段、quota）保留在对应 data 项中；
- 不再生成固定的 `created_at`；上游响应没有该字段；
- 每次 `/v1/models` 请求都重新调用上游，不缓存某次账号的模型目录；
- `DEFAULT_MODEL` 仍只作为 `/v1/messages` 未指定模型时的默认值，不参与模型列表生成。

对应实现：[`src/antigravity-client.ts`](../src/antigravity-client.ts) 的 `fetchAvailableModels`，以及 [`src/server.ts`](../src/server.ts) 的 `/v1/models` 路由。
