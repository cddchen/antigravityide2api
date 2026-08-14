# antigravityide2api

Export the locally logged-in Antigravity IDE session as an Anthropic-compatible `/v1/messages` endpoint for use with Claude Code.

## Quick start

```bash
npm i && npm run build
node dist/cli.js extract-token   # Read OAuth from the local IDE → ~/.antigravityide2api/token.json (0600)
node dist/cli.js start           # Run in the background; use start-fg or no arguments for the foreground
PORT=4000 DUMP_SYSTEM=1 DEBUG=1 node dist/server.js # Debug startup; view conversation logs at /logcat
```

On the Claude Code side:

```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:3000
export ANTHROPIC_AUTH_TOKEN=<API_KEY or any non-empty value if API_KEY is not set>
```

## CLI

| Command | Description |
|---------|-------------|
| (no arguments) / `start-fg` | Start in the foreground |
| `start` | Start the background daemon; store the pid/log in the token directory |
| `stop` | Stop the background daemon |
| `status` | Show the token path/account count (masked) and process status |
| `extract-token` | Read IDE credentials only |
| `-h` / `--help` | Show usage |

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Listening port |
| `HOST` | `127.0.0.1` | Listening address |
| `API_KEY` | Empty | If non-empty, requests must include this key |
| `TOKEN_FILE` | `~/.antigravityide2api/token.json` | Credential file |
| `DEFAULT_MODEL` | `gemini-3.6-flash-high` | Default upstream model |
| `WORKSPACE_ROOT` | Empty | Boundary for persisted Write/Edit operations |
| `REQUEST_TIMEOUT` | `300000` | Upstream request timeout in milliseconds |
| `PENDING_TIMEOUT` | `600000` | Pending-session timeout in milliseconds |
| `ANTIGRAVITY_BASE` | `https://daily-cloudcode-pa.googleapis.com` | Upstream base URL |
| `IDE_VERSION` | `2.1.1` | User-Agent / metadata version |
| `ANTIGRAVITY_SYSTEM` | `trimmed` | System prompt: `full` / `trimmed` / `short` |

## Disclaimer

For personal learning and use with your own local account only. Use at your own risk. The token file is stored with permission `0600`, and IDE database data is not written back.
