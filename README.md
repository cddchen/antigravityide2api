# antigravityide2api

把本机已登录的 Antigravity IDE 会话导出为 Anthropic 兼容的 `/v1/messages`，供 Claude Code 使用。

## 快速开始

```bash
npm i && npm run build
node dist/cli.js extract-token   # 从本机 IDE 读 OAuth → ~/.antigravityide2api/token.json (0600)
node dist/cli.js start           # 后台；前台用 start-fg 或直接无参数
```

Claude Code 侧：

```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:3000
export ANTHROPIC_AUTH_TOKEN=<API_KEY 或任意非空，若服务未设 API_KEY>
```

## CLI

| 命令 | 作用 |
|------|------|
| （无参数）/ `start-fg` | 前台启动 |
| `start` | 后台 daemon，pid/log 在 token 同目录 |
| `stop` | 停后台 |
| `status` | token 路径/账号数（脱敏）+ 进程状态 |
| `extract-token` | 只读提取 IDE 凭证 |
| `-h` / `--help` | 用法 |

## 环境变量

| 变量 | 默认 | 说明 |
|------|------|------|
| `PORT` | `3000` | 监听端口 |
| `HOST` | `127.0.0.1` | 监听地址 |
| `API_KEY` | 空 | 非空则要求请求带该 key |
| `TOKEN_FILE` | `~/.antigravityide2api/token.json` | 凭证文件 |
| `DEFAULT_MODEL` | `gemini-3.6-flash-high` | 默认上游模型 |
| `WORKSPACE_ROOT` | 空 | Write/Edit 落盘边界 |
| `REQUEST_TIMEOUT` | `300000` | 上游请求超时 ms |
| `PENDING_TIMEOUT` | `600000` | pending session 超时 ms |
| `ANTIGRAVITY_BASE` | `https://daily-cloudcode-pa.googleapis.com` | 上游 base |
| `IDE_VERSION` | `2.1.1` | UA / metadata 版本 |
| `ANTIGRAVITY_SYSTEM` | `trimmed` | system prompt：`full` / `trimmed` / `short` |

## 免责声明

仅供个人学习与本机账号使用，使用者自负风险。token 文件权限 0600，不回写 IDE 数据库。
