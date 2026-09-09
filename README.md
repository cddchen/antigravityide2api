# antigravityide2api

Export the locally logged-in Antigravity IDE session as an Anthropic-compatible `/v1/messages` HTTP API, designed for use with Claude Code or any other Anthropic API compatible client.

---

## Prerequisites

1. **Antigravity IDE installed and logged in** on your local machine;
2. **Node.js** >= 18;
3. (Recommended) **ripgrep (`rg`)**: installed and available in `$PATH` if using fast file search via native tools.

---

## Method 1: Direct Usage via npx (Recommended)

No manual clone or global installation required—run directly using `npx`.

### 1. Extract Local IDE Credentials

Ensure Antigravity IDE is open and logged in, then run:

```bash
npx @cddchen/antigravityide2api@latest extract-token
```

> **Note**: This reads OAuth credentials from the local IDE database and stores them safely with `0600` permissions at `~/.antigravityide2api/token.json`. You only need to run this on initial setup or when your session expires.

### 2. Start the Proxy Server

**Foreground execution** (logs stream directly to the terminal):
```bash
npx @cddchen/antigravityide2api@latest
# Or explicitly:
npx @cddchen/antigravityide2api@latest start-fg
```

**Background daemon**:
```bash
# Start background daemon
npx @cddchen/antigravityide2api@latest start

# Check process status and masked token info
npx @cddchen/antigravityide2api@latest status

# Stop background daemon
npx @cddchen/antigravityide2api@latest stop
```

### 3. (Optional) Install Globally

If you prefer calling `antigravityide2api` directly without `npx`:

```bash
npm i -g @cddchen/antigravityide2api@latest

# Then use the CLI directly:
antigravityide2api extract-token
antigravityide2api start
antigravityide2api status
antigravityide2api stop
```

---

## Method 2: Run from Source (Development)

Recommended if you want to inspect the source code, develop features, or customize behavior.

### 1. Clone & Install Dependencies

```bash
git clone https://github.com/cddchen/antigravityide2api.git
cd antigravityide2api
npm install
```

### 2. Build

```bash
# Compile TypeScript to dist/
npm run build

# Or run compiler in watch mode during development
npm run dev
```

### 3. Extract Local IDE Credentials

```bash
npm run extract-token
# Equivalent to: node dist/cli.js extract-token
```

### 4. Start Server

**Foreground execution**:
```bash
npm start
# Equivalent to: node dist/cli.js start-fg
```

**Background daemon**:
```bash
node dist/cli.js start    # Start background daemon
node dist/cli.js status   # Check status
node dist/cli.js stop     # Stop daemon
```

**Debug mode** (with live logcat and prompt inspection):
```bash
PORT=4000 DUMP_SYSTEM=1 DEBUG=1 node dist/server.js
```
> Once started, visit `http://127.0.0.1:4000/logcat` in your browser to inspect conversation streams and tool calls in real time.

### 5. Run Tests

```bash
npm test
```

---

## Claude Code Configuration

By default, the server listens at `http://127.0.0.1:3000`. Configure Claude Code with the following environment variables before starting:

```bash
# Point Claude Code to the local proxy
export ANTHROPIC_BASE_URL=http://127.0.0.1:3000

# If no API_KEY is set on the server, any non-empty string satisfies client checks
export ANTHROPIC_AUTH_TOKEN=test
```

Then start Claude Code:
```bash
claude
```

---

## CLI Reference

Commands can be invoked via `antigravityide2api <command>` or `npx @cddchen/antigravityide2api@latest <command>`:

| Command | Description |
|---------|-------------|
| (no args) / `start-fg` | Start proxy server in the foreground |
| `start` | Start background daemon; stores PID and logs in the token directory |
| `stop` | Stop background daemon |
| `status` | Display token path, masked account count, and process status |
| `extract-token` | Read OAuth credentials from the local Antigravity IDE |
| `-h` / `--help` | Show CLI usage help |

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | HTTP listening port |
| `HOST` | `127.0.0.1` | HTTP listening address (defaults to loopback for security) |
| `API_KEY` | Empty | When set, requests must provide matching `x-api-key` or Bearer token |
| `TOKEN_FILE` | `~/.antigravityide2api/token.json` | Path to the credentials file |
| `DEFAULT_MODEL` | `gemini-3.6-flash-high` | Default upstream model |
| `WORKSPACE_ROOT` | Empty | Allowed directory boundary for file modifications (Write/Edit) |
| `REQUEST_TIMEOUT` | `300000` | Upstream request timeout in milliseconds |
| `PENDING_TIMEOUT` | `600000` | Multi-turn tool execution pending session timeout in milliseconds |
| `ANTIGRAVITY_BASE` | `https://daily-cloudcode-pa.googleapis.com` | Upstream API base endpoint |
| `IDE_VERSION` | local `product.json` `ideVersion` | Metadata and User-Agent version (auto-detected from local IDE) |
| `ANTIGRAVITY_SYSTEM` | `trimmed` | System prompt strategy: `full` / `trimmed` / `short` |

---

## Verification & API Endpoints

Once the server is running, you can test it directly via curl:

```bash
# 1. Health check
curl -s http://127.0.0.1:3000/health

# 2. Dynamic upstream model catalog
curl -s http://127.0.0.1:3000/v1/models | jq '.data[] | {id, display_name}'

# 3. Test non-streaming message
curl -s -X POST http://127.0.0.1:3000/v1/messages \
  -H "Content-Type: application/json" \
  -d '{"model":"gemini-3.6-flash-high","max_tokens":100,"messages":[{"role":"user","content":"Hello"}]}'
```

---

## Security & Disclaimer

- For personal educational use and interaction with your own authenticated local session only. Use at your own risk.
- Credential extraction is strictly read-only; it never modifies or writes back to the Antigravity IDE database.
- The exported `token.json` is protected with `0600` file permissions. Never commit or share your token file.
