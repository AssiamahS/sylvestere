#!/usr/bin/env python3
"""Sylvestere Mac agent.

Dials OUT to the sylvestere-api Durable Object and answers tutor turns with the
local Claude Code login (Max subscription, no API key, $0 per turn).

  app -> worker /chat -> DO -> this agent -> warm `claude -p` process -> DO -> worker -> app

Claude CLI startup costs ~3s, so we keep a pool of warm stream-json processes
(one serving, one spare) and retire each after MAX_TURNS to keep context small.

Env (~/sylvestere/agent/.env): RELAY_URL, MAC_TOKEN, CLAUDE_MODEL
"""
import asyncio, json, os, subprocess, threading, time
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
MAX_TURNS = 12          # retire a process after this many turns (context stays small = fast)
TURN_TIMEOUT = 60
GENERIC_SYSTEM = (
    "You are Sylvie, an English conversation tutor inside a language-learning app. "
    "Every message you receive contains INSTRUCTIONS (the scene, level and output format) and a TRANSCRIPT. "
    "Follow the INSTRUCTIONS exactly and reply ONLY with the JSON object they describe. No markdown, no prose outside JSON."
)


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


class WarmClaude:
    """One long-lived `claude -p --input-format stream-json` process."""

    def __init__(self):
        cmd = [
            CLAUDE_BIN, "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
            "--model", CLAUDE_MODEL, "--no-session-persistence", "--strict-mcp-config", "--mcp-config", str(EMPTY_MCP),
            "--tools", "", "--system-prompt", GENERIC_SYSTEM,
        ]
        self.p = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                  text=True, bufsize=1, cwd=str(HERE))
        self.turns = 0
        self.lock = threading.Lock()
        self.dead = False
        self.born = time.time()

    @property
    def alive(self):
        return not self.dead and self.p.poll() is None

    def ask(self, text: str) -> str:
        with self.lock:
            try:
                self.p.stdin.write(json.dumps({"type": "user", "message": {"role": "user", "content": text}}) + "\n")
                self.p.stdin.flush()
            except Exception as e:
                log("stdin write failed:", e); self.dead = True; return ""
            deadline = time.time() + TURN_TIMEOUT
            while time.time() < deadline:
                line = self.p.stdout.readline()
                if not line:
                    log("claude process ended"); self.dead = True; return ""
                try:
                    d = json.loads(line)
                except Exception:
                    continue
                if d.get("type") == "result":
                    self.turns += 1
                    if d.get("is_error"):
                        log("claude result error:", str(d.get("result"))[:200])
                    return str(d.get("result") or "").strip()
            log("turn timeout"); self.dead = True; return ""

    def warmup(self):
        t = time.time()
        self.ask('INSTRUCTIONS: warm-up. Reply with exactly {"ok":true}\nTRANSCRIPT:\n(none)')
        log(f"warm process ready in {time.time() - t:.1f}s")

    def close(self):
        self.dead = True
        try: self.p.stdin.close()
        except Exception: pass
        try: self.p.wait(timeout=5)
        except Exception:
            try: self.p.kill()
            except Exception: pass


class Pool:
    def __init__(self):
        self.lock = threading.Lock()
        self.ready = []          # warmed, idle processes
        self.spawning = 0
        self.ensure_spare(2)

    def ensure_spare(self, n=1):
        with self.lock:
            missing = n - len(self.ready) - self.spawning
            for _ in range(max(0, missing)):
                self.spawning += 1
                threading.Thread(target=self._spawn, daemon=True).start()

    def _spawn(self):
        try:
            w = WarmClaude(); w.warmup()
            with self.lock:
                self.spawning -= 1
                if w.alive: self.ready.append(w)
        except Exception as e:
            with self.lock: self.spawning -= 1
            log("spawn failed:", e)

    def take(self):
        with self.lock:
            while self.ready:
                w = self.ready.pop(0)
                if w.alive: return w
        return None

    def give_back(self, w):
        if not w.alive or w.turns >= MAX_TURNS:
            threading.Thread(target=w.close, daemon=True).start()
        else:
            with self.lock: self.ready.insert(0, w)
        self.ensure_spare(1)


POOL = Pool()


def build_message(system: str, messages: list, tutor="Sylvie") -> str:
    lines = ["INSTRUCTIONS:", system.strip(), "", "TRANSCRIPT:"]
    for m in messages:
        who = tutor if m.get("role") == "assistant" else "Learner"
        lines.append(f"{who}: {m.get('content', '')}")
    lines.append("")
    lines.append(f"Reply as {tutor} now, JSON only.")
    return "\n".join(lines)


def ask_claude(system: str, messages: list) -> str:
    text = build_message(system, messages)
    w = POOL.take()
    if w is None:
        POOL.ensure_spare(2)
        w = WarmClaude()          # cold path: nothing warm yet
        log("no warm process, cold start")
    out = w.ask(text)
    POOL.give_back(w)
    return out


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
    sem = asyncio.Semaphore(3)
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
