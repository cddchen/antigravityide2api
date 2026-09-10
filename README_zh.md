# antigravityide2api

把本机已登录的 Antigravity IDE 会话导出为 Anthropic 兼容的 `/v1/messages` HTTP API，供 Claude Code 或其他兼容 Anthropic API 的客户端使用。

---

## 前置要求

1. **已安装并登录 Antigravity IDE**：首次使用需要从中读取本地凭证；
2. **Node.js** >= 18；
3. （推荐可选）**ripgrep (`rg`)**：若需要使用原生 grep 搜索工具，建议确保系统已安装 `rg`。

---

## 方式一：直接通过 npx 运行（免安装，推荐）

无需克隆源码或全局安装，使用 `npx` 即可直接开箱即用。

### 1. 提取本地 IDE 凭证

确保 Antigravity IDE 已经打开并登录，然后在终端执行：

```bash
npx @cddchen/antigravityide2api@latest extract-token
```

> **说明**：该命令会自动读取本机 IDE 数据库中的 OAuth 凭证，以安全权限 `0600` 保存在 `~/.antigravityide2api/token.json`。该步骤仅在首次��用或 IDE 凭证过期时需要执行。

### 2. 启动服务

**前台运行**（终端直接输出日志，适合调试与日常交互）：
```bash
npx @cddchen/antigravityide2api@latest
# 或者显式指定 start-fg
npx @cddchen/antigravityide2api@latest start-fg
```

**后台守护进程（Daemon）**：
```bash
# 启动后台服务
npx @cddchen/antigravityide2api@latest start

# 查看运行状态及账号信息
npx @cddchen/antigravityide2api@latest status

# 停止后台服务
npx @cddchen/antigravityide2api@latest stop
```

### 3.（可选）全局安装

若不想每次输入 `npx`，可直接全局安装：

```bash
npm i -g @cddchen/antigravityide2api@latest

# 安装后可直接使用 antigravityide2api 命令：
antigravityide2api extract-token
antigravityide2api start
antigravityide2api status
antigravityide2api stop
```

---

## 方式二：从源码运行（二次开发）

适合希望查看实现、修改代码或进行本地定制的用户。

### 1. 克隆仓库并安装依赖

```bash
git clone https://github.com/cddchen/antigravityide2api.git
cd antigravityide2api
npm install
```

### 2. 编译构建

```bash
# 执行 TypeScript 编译
npm run build

# （开发时）开启 watch 模式监听自动编译
npm run dev
```

### 3. 提取本地 IDE 凭证

```bash
npm run extract-token
# 等价于: node dist/cli.js extract-token
```

### 4. 运行服务

**前台运行**：
```bash
npm start
# 等价于: node dist/cli.js start-fg
```

**后台守护进程**：
```bash
node dist/cli.js start    # 启动后台服务
node dist/cli.js status   # 查看运行状态
node dist/cli.js stop     # 停止后台服务
```

**调试模式启动**（可查看完整调试日志与 logcat 抓包）：
```bash
PORT=4000 DUMP_SYSTEM=1 DEBUG=1 node dist/server.js
```
> 服务启动后，浏览器打开 `http://127.0.0.1:4000/logcat` 可实时查看入站 `/v1/messages`、出站 Antigravity `contents`，以及每轮上游 `functionCall` 与桥接结果（同一帧；不含 token）。

### 5. 运行测试套件

```bash
npm test
```

---

## 配置 Claude Code

服务默认监听在 `http://127.0.0.1:3000`。在运行 Claude Code 前配置以下环境变量：

```bash
# 指定 Anthropic 兼容端点为本地代理
export ANTHROPIC_BASE_URL=http://127.0.0.1:3000

# 若本地代理未设置 API_KEY，填入任意非空字符即可通过客户端鉴权检查
export ANTHROPIC_AUTH_TOKEN=test
```

随后直接启动 Claude Code：
```bash
claude
```

---

## CLI 命令一览

支持通过 `antigravityide2api <command>` 或 `npx @cddchen/antigravityide2api@latest <command>` 调用：

| 命令 | 说明 |
|------|------|
| （无参数）/ `start-fg` | 在当前终端前台启动代理服务 |
| `start` | 以后台守护进程（Daemon）启动，PID 与日志记录在 token 同级目录 |
| `stop` | 停止后台守护进程 |
| `status` | 显示凭证文件路径、脱敏账号数量及进程运行状态 |
| `extract-token` | 仅只读提取本机 Antigravity IDE 的 OAuth 凭证 |
| `trim-words` | 查看生效过滤词（默认 ∪ 文件 ∪ env） |
| `trim-words add/rm/clear` | 向配置目录追加 / 删除 / 清空持久化过滤词 |
| `-h` / `--help` | 查看 CLI 命令帮助 |

---

## 环境变量配置

启动时可通过环境变量覆盖默认行为：

| 环境变量 | 默认值 | 说明 |
|----------|--------|------|
| `PORT` | `3000` | HTTP 服务监听端口 |
| `HOST` | `127.0.0.1` | 监听地址（建议保持本地 loopback） |
| `API_KEY` | 空 | 若配置，则对所有请求进行鉴权（请求头需带 `x-api-key` 或 Bearer Token） |
| `TOKEN_FILE` | `~/.antigravityide2api/token.json` | 凭证保存路径 |
| `DEFAULT_MODEL` | `gemini-3.6-flash-high` | 默认上游模型 |
| `WORKSPACE_ROOT` | 空 | 文件修改（Write/Edit）的安全操作边界 |
| `REQUEST_TIMEOUT` | `300000` | 上游请求超时时间（毫秒） |
| `PENDING_TIMEOUT` | `600000` | 工具续轮状态过期时间（毫秒） |
| `ANTIGRAVITY_BASE` | `https://daily-cloudcode-pa.googleapis.com` | 上游服务基地址 |
| `IDE_VERSION` | 本机 `product.json` 的 `ideVersion` | 上游请求元数据与 User-Agent 版本，默认自动探测 |
| `ANTIGRAVITY_SYSTEM` | `trimmed` | 系统提示词构建策略：`full` / `trimmed` / `short` |
| `ANTIGRAVITY_TRIM_WORDS` | 空 | 额外过滤词（逗号分隔或 JSON 数组）。不区分大小写的子串匹配；命中后替换为等长零宽字符，不删整段。较长词优先（`claude code` 先于 `claude`）。内置默认词仅 `trimmed` 模式生效，覆盖 `communication_style` 里的 `file://` 与后台任务用语。持久化文件为 token 同级 `trim-words.json`。改词表后需重启。 |

---

## 接口验证

服务启动后，可在终端通过以下命令进行接口探测与验证：

```bash
# 1. 健康检查
curl -s http://127.0.0.1:3000/health

# 2. 查询上游动态模型目录
curl -s http://127.0.0.1:3000/v1/models | jq '.data[] | {id, display_name}'

# 3. 发送非流式消息测试
curl -s -X POST http://127.0.0.1:3000/v1/messages \
  -H "Content-Type: application/json" \
  -d '{"model":"gemini-3.6-flash-high","max_tokens":100,"messages":[{"role":"user","content":"Hello"}]}'
```

---

## 安全与免责声明

- 本项目仅供个人学习与使用本机已有合法登录会话，使用者自负风险；
- 凭证提取为**纯只读**操作，绝不回写或修改 Antigravity IDE 的本地数据库；
- 导出的 `token.json` 会设置操作系统权限为 `0600`，请勿将凭证文件提交至公开仓库或分享给他人。
