#!/usr/bin/env python3
"""Parse Surge MITM capture Requests/ into conversation JSON + HTML.

Output names (default) use capture folder + conversation id short form:
  2026-08-10-161533-3963bc81.json / .html

requestId shapes observed:
  agent/{agentId}/{tsMs}/{conversationId}/{step}
  checkpoint/{uuid}
  tab/{uuid}

Usage:
  python3 surge_to_conversation.py "/path/to/.../Requests"
  python3 surge_to_conversation.py "/path/to/.../Requests" -o ./out --open
  python3 surge_to_conversation.py "/path/to/.../Requests" --name my-run
"""

from __future__ import annotations

import argparse
import html
import json
import re
import subprocess
import sys
from collections import Counter
from pathlib import Path


# ---------------------------------------------------------------------------
# dump parsing
# ---------------------------------------------------------------------------

def parse_chunked(raw: str) -> str:
    data = raw
    if (
        "\r\n\r\n" in data[:2000]
        and not data.lstrip()[:1] in "{["
        and not re.match(r"^[0-9a-fA-F]+\r?\n", data.lstrip())
    ):
        data = data.split("\r\n\r\n", 1)[1]

    s = data.lstrip()
    if s.startswith("{") or s.startswith("["):
        return s

    out: list[str] = []
    i = 0
    while i < len(data):
        nl = data.find("\r\n", i)
        sep = 2
        if nl < 0:
            nl = data.find("\n", i)
            sep = 1
            if nl < 0:
                break
        line = data[i:nl].strip()
        i = nl + sep
        if not line:
            continue
        try:
            size = int(line.split(";")[0], 16)
        except ValueError:
            break
        if size == 0:
            break
        out.append(data[i : i + size])
        i += size
        if data[i : i + 2] == "\r\n":
            i += 2
        elif data[i : i + 1] == "\n":
            i += 1
    return "".join(out)


def first_json(s: str):
    dec = json.JSONDecoder()
    obj, end = dec.raw_decode(s.strip())
    return obj, s.strip()[end:]


def extract_text_parts(parts) -> str:
    texts: list[str] = []
    for p in parts or []:
        if not isinstance(p, dict):
            continue
        if "text" in p and p["text"] is not None:
            if p.get("thought"):
                texts.append(f"[thought]\n{p['text']}")
            else:
                texts.append(p["text"])
        elif "functionCall" in p:
            fc = p["functionCall"]
            name = fc.get("name", "?")
            args = fc.get("args", {})
            texts.append(
                f"[tool_call] {name}\n{json.dumps(args, ensure_ascii=False, indent=2)}"
            )
        elif "functionResponse" in p:
            fr = p["functionResponse"]
            name = fr.get("name", "?")
            resp = fr.get("response", {})
            r = json.dumps(resp, ensure_ascii=False, indent=2)
            if len(r) > 4000:
                r = r[:4000] + "\n… (truncated)"
            texts.append(f"[tool_result] {name}\n{r}")
        elif "inlineData" in p or "inline_data" in p:
            texts.append("[inline media]")
        else:
            texts.append(f"[part] {json.dumps(p, ensure_ascii=False)[:300]}")
    return "\n".join(texts)


def parse_sse_response(raw: str):
    body = parse_chunked(raw) or raw
    texts: list[str] = []
    model = None
    finish = None
    src = body if "data:" in body else raw
    for line in src.splitlines():
        line = line.strip()
        payload = None
        if line.startswith("data:"):
            payload = line[5:].strip()
        elif line.startswith("{"):
            payload = line
        if not payload or payload == "[DONE]":
            continue
        try:
            obj, _ = first_json(payload)
        except Exception:
            continue
        resp = obj.get("response", obj)
        if model is None:
            model = resp.get("modelVersion") or resp.get("model")
        for c in resp.get("candidates") or []:
            finish = c.get("finishReason") or finish
            content = c.get("content") or {}
            t = extract_text_parts(content.get("parts"))
            if t:
                texts.append(t)
    return "\n".join(texts), model, finish


def parse_request_id(req_id: str) -> dict:
    """Split Antigravity/CloudCode requestId into stable ids.

    agent/{agentId}/{tsMs}/{conversationId}/{step}
    checkpoint/{uuid}
    tab/{uuid}
    """
    parts = [p for p in (req_id or "").split("/") if p]
    info = {
        "kind": parts[0] if parts else None,
        "agentId": None,
        "tsMs": None,
        "conversationId": None,
        "step": None,
        "uuid": None,
    }
    if not parts:
        return info
    kind = parts[0]
    if kind == "agent" and len(parts) >= 5:
        info.update(
            {
                "agentId": parts[1],
                "tsMs": parts[2],
                "conversationId": parts[3],
                "step": parts[4],
            }
        )
    elif kind in ("checkpoint", "tab") and len(parts) >= 2:
        info["uuid"] = parts[1]
    elif len(parts) >= 2:
        info["uuid"] = parts[1]
    return info


def short_id(value: str | None, n: int = 8) -> str:
    if not value:
        return "unknown"
    return value[:n]


def capture_label(requests_dir: Path) -> str:
    """Prefer parent capture folder name (e.g. 2026-08-10-161533)."""
    name = requests_dir.name
    if name.lower() == "requests":
        return requests_dir.parent.name
    return name


def default_basename(requests_dir: Path, sessions: list[dict]) -> str:
    """{capture}-{conversationShort} — unique across captures/conversations."""
    cap = capture_label(requests_dir)
    conv_ids = [
        s.get("conversationId")
        for s in sessions
        if s.get("conversationId")
    ]
    if conv_ids:
        top, _ = Counter(conv_ids).most_common(1)[0]
        return f"{cap}-{short_id(top)}"
    agent_ids = [s.get("agentId") for s in sessions if s.get("agentId")]
    if agent_ids:
        top, _ = Counter(agent_ids).most_common(1)[0]
        return f"{cap}-{short_id(top)}"
    return f"surge-{cap}"


def parse_requests_dir(requests_dir: Path) -> list[dict]:
    dirs = sorted(
        d
        for d in requests_dir.iterdir()
        if d.is_dir() and "streamGenerateContent" in d.name
    )
    if not dirs:
        raise SystemExit(f"No streamGenerateContent dirs under {requests_dir}")

    sessions: list[dict] = []
    for d in dirs:
        req_path = d / "request.dump"
        resp_path = d / "response.dump"
        model_path = d / "model.json"
        if not req_path.exists():
            print(f"skip {d.name}: no request.dump", file=sys.stderr)
            continue

        req_raw = req_path.read_text(encoding="utf-8", errors="replace")
        resp_raw = (
            resp_path.read_text(encoding="utf-8", errors="replace")
            if resp_path.exists()
            else ""
        )
        model_meta = (
            json.loads(model_path.read_text()) if model_path.exists() else {}
        )

        body = parse_chunked(req_raw)
        try:
            payload, _ = first_json(body)
        except Exception as e:
            print(f"FAIL parse {d.name}: {e}", file=sys.stderr)
            continue

        req = payload.get("request", payload)
        contents = req.get("contents", [])
        system = req.get("systemInstruction") or req.get("system_instruction")
        model_name = req.get("model") or payload.get("model")
        req_id = payload.get("requestId", "")
        rid = parse_request_id(req_id)

        msgs: list[dict] = []
        if system:
            if isinstance(system, dict):
                msgs.append(
                    {
                        "role": "system",
                        "text": extract_text_parts(system.get("parts")),
                    }
                )
            else:
                msgs.append({"role": "system", "text": str(system)})

        for c in contents:
            msgs.append(
                {
                    "role": c.get("role", "unknown"),
                    "text": extract_text_parts(c.get("parts")),
                }
            )

        resp_text, resp_model, finish = parse_sse_response(resp_raw)
        if resp_text:
            msgs.append(
                {
                    "role": "model",
                    "text": resp_text,
                    "source": "response",
                    "finish": finish,
                }
            )

        time_str = d.name.split(" - ")[1] if " - " in d.name else ""
        sessions.append(
            {
                "dir": d.name,
                "id": model_meta.get("id"),
                "time": time_str,
                "requestId": req_id,
                "kind": rid["kind"],
                "agentId": rid["agentId"],
                "conversationId": rid["conversationId"],
                "step": rid["step"],
                "tsMs": rid["tsMs"],
                "project": payload.get("project"),
                "model": model_name or resp_model,
                "msg_count": len(msgs),
                "msgs": msgs,
                "status": model_meta.get("status"),
                "resp_chars": len(resp_text),
            }
        )
        tag = rid["conversationId"] or rid["uuid"] or req_id
        print(
            f"#{model_meta.get('id')} kind={rid['kind']} step={rid['step']} "
            f"contents={len(contents)} msgs={len(msgs)} resp={len(resp_text)} "
            f"conv={tag[:36]}"
        )

    sessions.sort(
        key=lambda s: (
            len([m for m in s["msgs"] if m["role"] != "system"]),
            sum(len(m["text"]) for m in s["msgs"]),
        ),
        reverse=True,
    )
    return sessions


# ---------------------------------------------------------------------------
# HTML
# ---------------------------------------------------------------------------

def esc(t: str) -> str:
    return html.escape(t or "")


def mdish(text: str) -> str:
    t = esc(text)
    t = re.sub(
        r"```(\w*)\n(.*?)```",
        r'<pre class="code"><code>\2</code></pre>',
        t,
        flags=re.S,
    )
    t = re.sub(r"`([^`\n]+)`", r'<code class="inline">\1</code>', t)
    t = re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", t)
    return t.replace("\n", "<br>\n")


def classify(msg: dict) -> str:
    role = msg["role"]
    text = msg.get("text") or ""
    if role == "system":
        return "system"
    if text.startswith("[tool_call]"):
        return "tool_call"
    if text.startswith("[tool_result]"):
        return "tool_result"
    if text.startswith("[thought]"):
        return "thought"
    if role == "model":
        return "assistant"
    if role == "user":
        return "user"
    return role


def clean_user(text: str):
    m = re.search(r"<USER_REQUEST>\s*(.*?)\s*</USER_REQUEST>", text, re.S)
    if m:
        return m.group(1).strip(), text[m.end() :].strip()
    return text, ""


def tool_parse(text: str):
    lines = text.split("\n", 1)
    head = lines[0]
    body = lines[1] if len(lines) > 1 else ""
    kind = "call" if head.startswith("[tool_call]") else "result"
    name = head.split("]", 1)[-1].strip()
    return kind, name, body


def render_session(sess: dict) -> str:
    out: list[str] = []
    for i, m in enumerate(sess["msgs"]):
        kind = classify(m)
        text = m.get("text") or ""
        meta = ""

        if kind == "system":
            body_html = (
                f"<details><summary>system prompt ({len(text):,} chars) "
                f"— click to expand</summary>"
                f'<pre class="raw">{esc(text)}</pre></details>'
            )
            label = "System Prompt"
        elif kind == "user":
            main, rest = clean_user(text)
            body_html = f'<div class="md">{mdish(main)}</div>'
            if rest:
                body_html += (
                    f'<details class="meta">'
                    f"<summary>metadata / context ({len(rest):,} chars)</summary>"
                    f'<pre class="raw">{esc(rest)}</pre></details>'
                )
            label = "User"
        elif kind in ("tool_call", "tool_result"):
            _, name, body = tool_parse(text)
            try:
                body_pretty = json.dumps(
                    json.loads(body), ensure_ascii=False, indent=2
                )
            except Exception:
                body_pretty = body
            open_attr = "" if len(body_pretty) > 1200 else " open"
            body_html = (
                f'<div class="tool-name">{esc(name)}</div>'
                f"<details{open_attr}>"
                f"<summary>payload ({len(body_pretty):,} chars)</summary>"
                f'<pre class="raw">{esc(body_pretty)}</pre></details>'
            )
            label = "Tool Call" if kind == "tool_call" else "Tool Result"
        elif kind == "thought":
            body = (
                text[len("[thought]") :].lstrip()
                if text.startswith("[thought]")
                else text
            )
            body_html = f'<div class="md thought-body">{mdish(body)}</div>'
            label = "Thought"
        else:
            body_html = f'<div class="md">{mdish(text)}</div>'
            label = "Assistant"
            if m.get("finish"):
                meta = f"finish={m['finish']}"

        out.append(
            f"""
    <article class="msg {kind}" id="s{sess.get('id')}-m{i}">
      <header>
        <span class="role">{esc(label)}</span>
        <span class="idx">#{i}</span>
        <span class="chars">{len(text):,} chars</span>
        {f'<span class="meta-tag">{esc(meta)}</span>' if meta else ''}
      </header>
      <div class="body">{body_html}</div>
    </article>"""
        )
    return "\n".join(out)


CSS = """
  :root {
    --bg: #0f1115; --panel: #171a21; --card: #1c212b; --border: #2a3140;
    --text: #e7ecf3; --muted: #8b95a8; --accent: #60a5fa;
    --user: #1e3a5f; --user-border: #3b82f6;
    --assistant: #1a2e24; --assistant-border: #34d399;
    --tool-call: #2a2418; --tool-call-border: #f59e0b;
    --tool-result: #231a2e; --tool-result-border: #a78bfa;
    --thought: #1a2430; --thought-border: #64748b;
    --system-border: #52525b;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto,
      "PingFang SC", "Noto Sans SC", sans-serif;
    background: var(--bg); color: var(--text); line-height: 1.55;
  }
  header.top {
    position: sticky; top: 0; z-index: 10;
    background: rgba(15,17,21,.92); backdrop-filter: blur(8px);
    border-bottom: 1px solid var(--border);
    padding: 14px 20px 10px;
  }
  header.top h1 { margin: 0 0 4px; font-size: 16px; font-weight: 600; }
  header.top p { margin: 0 0 10px; color: var(--muted); font-size: 12px; }
  .tabs { display: flex; gap: 6px; flex-wrap: wrap; }
  .tab {
    background: var(--panel); color: var(--muted);
    border: 1px solid var(--border); border-radius: 999px;
    padding: 6px 12px; font-size: 12px; cursor: pointer;
  }
  .tab:hover { color: var(--text); border-color: #3b4558; }
  .tab.active { color: #fff; background: #243044; border-color: var(--accent); }
  main { max-width: 920px; margin: 0 auto; padding: 18px 16px 60px; }
  .panel { display: none; }
  .panel.active { display: block; }
  .session-meta {
    background: var(--panel); border: 1px solid var(--border);
    border-radius: 10px; padding: 12px 14px; margin-bottom: 16px;
    font-size: 12px; color: var(--muted); display: grid; gap: 6px;
  }
  .session-meta code {
    color: #cbd5e1; font-size: 11px; word-break: break-all;
  }
  .msg {
    background: var(--card); border: 1px solid var(--border);
    border-left-width: 3px; border-radius: 10px; margin: 12px 0; overflow: hidden;
  }
  .msg > header {
    display: flex; align-items: center; gap: 10px; padding: 8px 12px;
    border-bottom: 1px solid var(--border); font-size: 12px; color: var(--muted);
  }
  .msg .role { font-weight: 600; color: var(--text); }
  .msg .body { padding: 12px 14px; font-size: 14px; }
  .msg.user {
    border-left-color: var(--user-border);
    background: linear-gradient(90deg, var(--user), var(--card) 40%);
  }
  .msg.assistant {
    border-left-color: var(--assistant-border);
    background: linear-gradient(90deg, var(--assistant), var(--card) 40%);
  }
  .msg.tool_call {
    border-left-color: var(--tool-call-border);
    background: linear-gradient(90deg, var(--tool-call), var(--card) 40%);
  }
  .msg.tool_result {
    border-left-color: var(--tool-result-border);
    background: linear-gradient(90deg, var(--tool-result), var(--card) 40%);
  }
  .msg.thought {
    border-left-color: var(--thought-border);
    background: linear-gradient(90deg, var(--thought), var(--card) 40%);
  }
  .msg.system { border-left-color: var(--system-border); opacity: .95; }
  .tool-name {
    display: inline-block;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    background: rgba(0,0,0,.35); border: 1px solid var(--border);
    border-radius: 6px; padding: 2px 8px; margin-bottom: 8px;
    color: #fde68a; font-size: 13px;
  }
  pre.raw {
    margin: 0; white-space: pre-wrap; word-break: break-word;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 12px; line-height: 1.45; color: #d1d5db;
    background: rgba(0,0,0,.25); border-radius: 8px; padding: 10px;
    max-height: 480px; overflow: auto;
  }
  pre.code {
    background: #0b0d11; border: 1px solid var(--border);
    border-radius: 8px; padding: 10px; overflow: auto; font-size: 12.5px;
  }
  code.inline {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    background: rgba(0,0,0,.35); padding: 1px 5px; border-radius: 4px;
    font-size: .9em;
  }
  details { margin-top: 8px; }
  details summary {
    cursor: pointer; color: var(--muted); font-size: 12px; user-select: none;
  }
  details summary:hover { color: var(--text); }
  .thought-body { color: #cbd5e1; font-style: italic; }
  .md { word-wrap: break-word; }
  footer {
    max-width: 920px; margin: 0 auto; padding: 0 16px 40px;
    color: var(--muted); font-size: 11px;
  }
"""


def render_html(sessions: list[dict], source_label: str) -> str:
    tabs: list[str] = []
    panels: list[str] = []
    models = sorted({s.get("model") or "?" for s in sessions})

    for si, sess in enumerate(sessions):
        active = "active" if si == 0 else ""
        label = f"#{sess['id']} · {sess['time']} · {sess['msg_count']} msgs"
        tabs.append(
            f'<button class="tab {active}" data-tab="s{si}">{esc(label)}</button>'
        )
        info = f"""
    <div class="session-meta">
      <div><b>Request ID</b> <code>{esc(sess['requestId'])}</code></div>
      <div><b>Kind</b> {esc(str(sess.get('kind') or '?'))}
        &nbsp; <b>Step</b> {esc(str(sess.get('step') or '-'))}
        &nbsp; <b>Conversation</b> <code>{esc(sess.get('conversationId') or sess.get('uuid') or '-')}</code></div>
      <div><b>Agent</b> <code>{esc(sess.get('agentId') or '-')}</code>
        &nbsp; <b>Project</b> <code>{esc(sess.get('project') or '-')}</code></div>
      <div><b>Model</b> <code>{esc(sess.get('model') or '?')}</code></div>
      <div><b>Time</b> {esc(sess.get('time') or '')}
        &nbsp; <b>Status</b> {esc(sess.get('status') or '')}</div>
      <div><b>Messages</b> {sess['msg_count']}
        &nbsp; <b>Response chars</b> {sess.get('resp_chars', 0):,}</div>
    </div>"""
        panels.append(
            f'<section class="panel {active}" id="s{si}">'
            f"{info}{render_session(sess)}</section>"
        )

    return f"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Surge Conversation · streamGenerateContent</title>
<style>{CSS}</style>
</head>
<body>
<header class="top">
  <h1>Antigravity · streamGenerateContent 对话回放</h1>
  <p>Source: {esc(source_label)} · {len(sessions)} streamGenerateContent requests
     · model {esc(', '.join(models))}</p>
  <div class="tabs">
    {''.join(tabs)}
  </div>
</header>
<main>
{''.join(panels)}
</main>
<footer>
  Generated from Surge MITM dumps. System prompts collapsed by default. Tool payloads expandable.
</footer>
<script>
document.querySelectorAll('.tab').forEach(btn => {{
  btn.addEventListener('click', () => {{
    document.querySelectorAll('.tab').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(btn.dataset.tab).classList.add('active');
    window.scrollTo({{ top: 0, behavior: 'smooth' }});
  }});
}});
</script>
</body>
</html>
"""


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main():
    ap = argparse.ArgumentParser(
        description="Surge Requests/ → {capture}-{conversationId}.{json,html}"
    )
    ap.add_argument(
        "requests_dir",
        type=Path,
        help="Surge capture Requests directory (or capture root)",
    )
    ap.add_argument(
        "-o",
        "--out-dir",
        type=Path,
        default=Path("."),
        help="Output directory (default: cwd)",
    )
    ap.add_argument(
        "-n",
        "--name",
        default=None,
        help="Output basename override (default: {capture}-{conversationShort})",
    )
    ap.add_argument(
        "--open",
        action="store_true",
        help="Open HTML in default browser (macOS open)",
    )
    args = ap.parse_args()

    requests_dir = args.requests_dir.expanduser().resolve()
    if not requests_dir.is_dir():
        raise SystemExit(f"Not a directory: {requests_dir}")

    # allow passing the capture root that contains Requests/
    if (requests_dir / "Requests").is_dir() and not any(
        "streamGenerateContent" in p.name for p in requests_dir.iterdir()
    ):
        requests_dir = requests_dir / "Requests"

    out_dir = args.out_dir.expanduser().resolve()
    out_dir.mkdir(parents=True, exist_ok=True)

    sessions = parse_requests_dir(requests_dir)
    if not sessions:
        raise SystemExit("No sessions parsed")

    basename = args.name or default_basename(requests_dir, sessions)
    # sanitize for filesystem
    basename = re.sub(r"[^\w.\-]+", "_", basename).strip("._") or "surge-conversation"

    json_path = out_dir / f"{basename}.json"
    html_path = out_dir / f"{basename}.html"

    json_path.write_text(
        json.dumps(sessions, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    source_label = str(requests_dir)
    parts = requests_dir.parts
    if "Surge Catpure" in parts or "Surge Capture" in parts:
        source_label = "/".join(parts[-3:])

    html_path.write_text(
        render_html(sessions, source_label), encoding="utf-8"
    )

    convs = sorted({s.get("conversationId") for s in sessions if s.get("conversationId")})
    agents = sorted({s.get("agentId") for s in sessions if s.get("agentId")})
    print(f"\nBasename: {basename}")
    print(f"  capture={capture_label(requests_dir)}")
    print(f"  conversationId(s)={convs or '-'}")
    print(f"  agentId(s)={agents or '-'}")
    print(f"Wrote {json_path} ({json_path.stat().st_size:,} bytes)")
    print(f"Wrote {html_path} ({html_path.stat().st_size:,} bytes)")
    print(
        f"Sessions: {len(sessions)}, default = #{sessions[0].get('id')} "
        f"with {sessions[0]['msg_count']} msgs"
    )

    if args.open:
        subprocess.run(["open", str(html_path)], check=False)


if __name__ == "__main__":
    main()
