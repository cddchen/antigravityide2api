---
name: verify
description: Build, extract token, start server, and verify API endpoints for antigravityide2api
---

# antigravityide2api Verification Recipe

## Build & Token Setup
```bash
npm run build
node dist/cli.js extract-token
```

## Launch Server
```bash
PORT=3218 node dist/cli.js
```

## Drive Surface
```bash
# Health check
curl -s http://127.0.0.1:3218/health

# Dynamic model catalog (/v1internal:fetchAvailableModels upstream)
curl -s http://127.0.0.1:3218/v1/models | jq '.data[] | {id, display_name}'

# Non-streaming message
curl -s -X POST http://127.0.0.1:3218/v1/messages \
  -H "Content-Type: application/json" \
  -d '{"model":"gemini-3.6-flash-high","max_tokens":100,"messages":[{"role":"user","content":"PONG"}]}'

# Streaming message
curl -s -N -X POST http://127.0.0.1:3218/v1/messages \
  -H "Content-Type: application/json" \
  -d '{"model":"gemini-3.6-flash-high","max_tokens":100,"stream":true,"messages":[{"role":"user","content":"Hi"}]}'
```
