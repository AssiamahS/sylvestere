#!/usr/bin/env python3
"""Sylvestere Mac agent.

Dials OUT to the sylvestere-api Durable Object and answers tutor turns with the
local Claude Code login (Max subscription, no API key, $0 per turn).

  app -> worker /chat -> DO -> this agent -> `claude -p` -> DO -> worker -> app

Env (~/sylvestere/agent/.env): RELAY_URL, MAC_TOKEN, CLAUDE_MODEL
"""
import asyncio, json, os, subprocess, time
from pathlib import Path

import websockets

HERE = Path(__file__).resolve().parent
ENV = {}
if (HERE / ".env").exists():
    for line in (HERE / ".env").read_text().splitlines():
        if "=" in line and not line.startswith("#"):
            k, v = line.split("=", 1)
            ENV[k.strip()] = v.strip()

RELAY_URL = os.environ.get("RELAY_URL", ENV.get("RELAY_URL", ""))
MAC_TOKEN = os.environ.get("MAC_TOKEN", ENV.get("MAC_TOKEN", ""))
CLAUDE_MODEL = os.environ.get("CLAUDE_MODEL", ENV.get("CLAUDE_MODEL", "sonnet"))
CLAUDE_BIN = os.environ.get("CLAUDE_BIN", str(Path.home() / ".local/bin/claude"))
EMPTY_MCP = HERE / "empty-mcp.json"
MAX_PARALLEL = 3


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


def transcript(messages, tutor="Sylvie"):
    lines = ["Conversation so far:"]
    for m in messages:
        who = tutor if m.get("role") == "assistant" else "Learner"
        lines.append(f"{who}: {m.get('content', '')}")
    lines.append("")
    lines.append(f"Reply as {tutor} now, JSON only.")
    return "\n".join(lines)


def ask_claude(system: str, messages: list) -> str:
    tutor = "Sylvie"
    cmd = [
        CLAUDE_BIN, "-p", "--model", CLAUDE_MODEL,
        "--no-session-persistence", "--strict-mcp-config", "--mcp-config", str(EMPTY_MCP),
        "--tools", "", "--output-format", "text", "--system-prompt", system,
    ]
    try:
        r = subprocess.run(cmd, input=transcript(messages, tutor), capture_output=True, text=True, timeout=80, cwd=str(HERE))
    except subprocess.TimeoutExpired:
        log("claude timeout")
        return ""
    if r.returncode != 0:
        log("claude rc", r.returncode, r.stderr[-300:])
        return ""
    return r.stdout.strip()


async def handle(ws, msg, sem):
    async with sem:
        t0 = time.time()
        loop = asyncio.get_running_loop()
        text = await loop.run_in_executor(None, ask_claude, msg.get("system", ""), msg.get("messages", []))
        log(f"turn {msg.get('id', '')[:8]} {time.time() - t0:.1f}s {len(text)} chars")
        try:
            await ws.send(json.dumps({"id": msg.get("id"), "text": text}))
        except Exception as e:
            log("send failed:", e)


async def keepalive(ws):
    while True:
        await asyncio.sleep(25)
        await ws.send(json.dumps({"type": "ping"}))


async def run():
    if not RELAY_URL or not MAC_TOKEN:
        raise SystemExit("RELAY_URL / MAC_TOKEN missing in agent/.env")
    sem = asyncio.Semaphore(MAX_PARALLEL)
    backoff = 2
    while True:
        try:
            async with websockets.connect(f"{RELAY_URL}?token={MAC_TOKEN}", ping_interval=20, ping_timeout=20, max_size=2**20) as ws:
                log("connected to relay; model", CLAUDE_MODEL)
                backoff = 2
                ka = asyncio.create_task(keepalive(ws))
                try:
                    async for raw in ws:
                        try:
                            msg = json.loads(raw)
                        except Exception:
                            continue
                        if msg.get("type") == "pong":
                            continue
                        if msg.get("id"):
                            asyncio.create_task(handle(ws, msg, sem))
                finally:
                    ka.cancel()
        except Exception as e:
            log("relay disconnected:", repr(e)[:200], f"retry in {backoff}s")
        await asyncio.sleep(backoff)
        backoff = min(backoff * 2, 60)


if __name__ == "__main__":
    asyncio.run(run())
