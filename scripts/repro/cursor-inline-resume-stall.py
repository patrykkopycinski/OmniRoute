"""Deterministic reproducer for the cursor inline-resume stall.

Run against a container built with the inline-resume gate ON:

    docker run -d --name omni-stall-probe -p 20129:20128 \
      -e OMNIROUTE_CURSOR_INLINE_RESUME=1 \
      -e CURSOR_AUTH_TOKEN=... -v omniroute-data:/app/data <image>
    python3 scripts/repro/cursor-inline-resume-stall.py 20129 3

Measured 2026-08-25 against cursor-grok-4.6-medium: 3/3 turn-2 timeouts on an
IDLE container. The stall is DETERMINISTIC, not load-dependent and not
intermittent -- earlier "clean" runs were masked (see below).

WHAT IS ESTABLISHED

  * Detection works. `acquire()` returns a session, `sendToolResult` writes one
    ExecMcpResult frame. Instrumented: `[WEDGE] send execId=...`.
  * The framing is NOT malformed. `wrapExecClientMessage` already Connect-wraps
    the payload (cursorAgentProtobuf.ts:1047).
  * cursor DOES answer the resumed turn: one ~401-byte frame arrives, then an
    unbounded run of identical 9-byte frames `00 00000004 0a026a00` -- a Connect
    envelope carrying a 2-byte keepalive. No completion frame ever follows, so
    driveH2 waits until the client aborts.
  * The stale cold-path `req.on("data")` listener is NOT the cause. Detaching it
    (listeners=0 on resume, verified) does not fix the stall.

THE MASKING TRAP -- this is why it looked intermittent

  Adding a `console.log` immediately before the `h2Req.write()` in
  sendToolResult makes the stall disappear (5/5 pass). Any probe that perturbs
  timing on the send path hides the bug, so an instrumented build "proves" a fix
  that does not exist. Verify ONLY on an unpatched build.

NEXT STEP FOR WHOEVER PICKS THIS UP

  The question is what terminator cursor expects after an ExecMcpResult that it
  is not receiving -- capture the native cursor client's frame sequence for the
  same tool follow-up and diff it against ours. Do not tune the reader.
"""
import json
import sys
import threading
import time
import urllib.error
import urllib.request

PORT = sys.argv[1] if len(sys.argv) > 1 else "20129"
BASE = "http://127.0.0.1:%s/v1/chat/completions" % PORT
MODEL = "cursor/cursor-grok-4.6-medium"
TURN_TIMEOUT = 90

TOOLS = [{
    "type": "function",
    "function": {
        "name": "get_time",
        "description": "Get the current time in a city",
        "parameters": {
            "type": "object",
            "properties": {"city": {"type": "string"}},
            "required": ["city"],
        },
    },
}]


def post(payload, timeout=TURN_TIMEOUT):
    req = urllib.request.Request(
        BASE,
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read())


def one_followup(tag):
    """One tool call + one tool-result follow-up. Returns (ok, seconds, note)."""
    msgs = [{"role": "user", "content": "What time is it in Warsaw? Use the tool."}]
    try:
        r1 = post({"model": MODEL, "messages": msgs, "tools": TOOLS, "stream": False})
    except Exception as e:
        return (False, 0.0, "turn1 %s" % type(e).__name__)

    m = r1["choices"][0]["message"]
    calls = m.get("tool_calls") or []
    if not calls:
        return (False, 0.0, "no tool_call")

    msgs.append(m)
    for c in calls:
        msgs.append({
            "role": "tool",
            "tool_call_id": c["id"],
            "content": "14:32 local time",
        })

    t0 = time.time()
    try:
        post({"model": MODEL, "messages": msgs, "tools": TOOLS, "stream": False})
        return (True, time.time() - t0, "")
    except Exception as e:
        return (False, time.time() - t0, "turn2 %s" % type(e).__name__)


class Load:
    """Background chatter so the container is not idle."""

    def __init__(self, workers):
        self.workers = workers
        self.stop = threading.Event()
        self.threads = []
        self.count = 0
        self.lock = threading.Lock()

    def _run(self):
        while not self.stop.is_set():
            try:
                post({
                    "model": MODEL,
                    "messages": [{"role": "user", "content": "Reply with one word: ok"}],
                    "stream": False,
                }, timeout=60)
                with self.lock:
                    self.count += 1
            except Exception:
                pass

    def __enter__(self):
        for _ in range(self.workers):
            t = threading.Thread(target=self._run, daemon=True)
            t.start()
            self.threads.append(t)
        time.sleep(3)
        return self

    def __exit__(self, *a):
        self.stop.set()
        for t in self.threads:
            t.join(timeout=5)


def arm(name, trials, load_workers):
    results = []
    if load_workers:
        with Load(load_workers) as ld:
            for i in range(trials):
                results.append(one_followup(i))
                print("   %s trial %d: %s" % (name, i + 1, results[-1]), flush=True)
            bg = ld.count
    else:
        bg = 0
        for i in range(trials):
            results.append(one_followup(i))
            print("   %s trial %d: %s" % (name, i + 1, results[-1]), flush=True)

    stalls = [r for r in results if not r[0]]
    oks = [r for r in results if r[0]]
    print("%s: %d/%d STALLED  (bg reqs=%d)" % (name, len(stalls), trials, bg))
    if oks:
        lat = sorted(r[1] for r in oks)
        print("   ok latency: min %.1fs median %.1fs max %.1fs"
              % (lat[0], lat[len(lat) // 2], lat[-1]))
    for r in stalls:
        print("   stall note:", r[2])
    return len(stalls), trials


if __name__ == "__main__":
    trials = int(sys.argv[2]) if len(sys.argv) > 2 else 8
    print("=== ARM A: idle container (baseline) ===", flush=True)
    a_s, a_n = arm("idle", trials, 0)
    print("\n=== ARM B: concurrent load (4 workers) ===", flush=True)
    b_s, b_n = arm("loaded", trials, 4)
    print("\n=== VERDICT ===")
    print("idle   stall rate: %d/%d" % (a_s, a_n))
    print("loaded stall rate: %d/%d" % (b_s, b_n))
