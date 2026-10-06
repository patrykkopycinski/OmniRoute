#!/usr/bin/env python3
"""laya-router: input-aware tier router in front of OmniRoute.

Phase 2: fine-tuned tier head (~/laya-tier-adapter/laya_adapter/tier_head.pt)
on frozen laya english encoder CLS embeddings. 3-class: reasoning/coding/fast.
Confidence gate: conf < MIN_CONFIDENCE -> fallback to default combo.

Env: LAYA_ROUTER_PORT (20770), LAYA_UPSTREAM (127.0.0.1:20128),
     LAYA_MIN_CONFIDENCE (0.6), LAYA_STATE_CHARS (6000).
"""
import hashlib, json, logging, os, sys, threading, time
from collections import OrderedDict
import torch, torch.nn as nn
from http.client import HTTPConnection
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from laya import Router

PORT = int(os.environ.get("LAYA_ROUTER_PORT", "20770"))
UPSTREAM_HOSTPORT = os.environ.get("LAYA_UPSTREAM", "127.0.0.1:20128")
MIN_CONF = {"reasoning": 0.60, "coding": 0.60, "fast": 0.45}
# env override, single value applied to all tiers
if "LAYA_MIN_CONFIDENCE" in os.environ:
    MIN_CONF = {k: float(os.environ["LAYA_MIN_CONFIDENCE"]) for k in MIN_CONF}
STATE_CHARS = int(os.environ.get("LAYA_STATE_CHARS", "6000"))
LOG_HEAD_CHARS = int(os.environ.get("LAYA_LOG_HEAD_CHARS", "2000"))
VIRTUAL_MODEL = "laya-router"
TIER_COMBOS = {"reasoning": "best-reasoning-paid", "coding": "best-coding-paid", "fast": "fast"}
DEFAULT_COMBO = TIER_COMBOS["coding"]
ADAPTER = os.path.expanduser("~/laya-tier-adapter/laya_adapter/tier_head.pt")
LABELS = ["reasoning", "coding", "fast"]
LOG_PATH = os.environ.get("LAYA_LOG", os.path.expanduser("~/laya-router-calls.jsonl"))
_sessions = OrderedDict()
_sessions_lock = threading.Lock()
SESSION_TTL = 6 * 60 * 60
SESSION_CAP = 512

log = logging.getLogger("laya-router")
_router = Router(default="english", preload=True)
agent = _router.load("english")
enc = agent.model.encoder
agent.model.to("cpu")  # MPS placeholder-storage bug on direct forward; CPU is plenty for 1-example classify
enc.config.reference_compile = False
enc.eval()
for p in enc.parameters():
    p.requires_grad_(False)
HIDDEN = enc.config.hidden_size
head = nn.Sequential(nn.Dropout(0.1), nn.Linear(HIDDEN, 64), nn.ReLU(),
                     nn.Dropout(0.1), nn.Linear(64, 3))
head.load_state_dict(torch.load(ADAPTER, weights_only=True, map_location="cpu"))
head.eval()
log.info("tier head loaded")


def classify(state: str):
    state = (state or "")[:STATE_CHARS]
    if not state.strip():
        return "coding", 0.0, [], True
    with torch.no_grad():
        b = agent.tok([state], truncation=True, max_length=512, padding=True, return_tensors="pt")
        h = enc(input_ids=b["input_ids"], attention_mask=b["attention_mask"]).last_hidden_state[:, 0]
        logits = head(h)
        probs = torch.softmax(logits, -1)[0]
        conf, idx = probs.max(-1)
        tier = LABELS[int(idx)]
    return tier, float(conf), [round(float(x), 4) for x in probs], float(conf) < MIN_CONF[tier]


def _is_harness_nudge(text: str) -> bool:
    """Hermes injects retry nudges as user turns starting with '[System:'."""
    return text.lstrip().startswith("[System:")


def _text(content) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):  # OpenAI/Anthropic content parts
        return "\n".join(p["text"] for p in content
                         if isinstance(p, dict) and isinstance(p.get("text"), str))
    return ""


def state_from_body(body: dict) -> str:
    """Classifier input, most relevant text FIRST.

    The tokenizer keeps only the first 512 tokens, so ordering is the weighting.
    Persona/system prompts are long and task-agnostic; leading with them drowned
    the actual request. Order: user turns newest first; only when there are
    none, non-system turns newest first; system prompt last (leftover room).
    """
    msgs = [m for m in (body.get("messages") or []) if isinstance(m, dict)]
    turns = [(m.get("role"), _text(m.get("content"))) for m in msgs]
    turns = [(r, t) for r, t in turns if t.strip()]
    # Harness-injected '[System:' user turns (retry nudges) are not real input.
    turns = [(r, t) for r, t in turns if not (r == "user" and _is_harness_nudge(t))]
    users = [t for r, t in turns if r == "user"]
    parts = list(reversed(users))[:6] if users else [
        t for r, t in reversed(turns) if r not in ("system", "developer")
    ][:6]
    sys_txt = _text(body.get("system")) + "\n".join(t for r, t in turns if r in ("system", "developer"))
    if sys_txt.strip():
        parts.append(sys_txt)
    return "\n".join(parts)[:STATE_CHARS]


def classify_body(body: dict):
    """Return classification plus session telemetry for a chat request."""
    users = [_text(m.get("content")) for m in (body.get("messages") or [])
             if isinstance(m, dict) and m.get("role") == "user"
             and _text(m.get("content")).strip()
             and not _is_harness_nudge(_text(m.get("content")))]
    state = state_from_body(body)
    if not users:
        if not state.strip():
            return ("coding", 0.0, [], True), "", False, ""
        return classify(state), "", False, ""

    first, last = users[0], users[-1]
    sess = hashlib.sha1(first.encode()).hexdigest()[:12]
    fresh = classify(state)
    now = time.monotonic()
    with _sessions_lock:
        for key, (_, ts) in list(_sessions.items()):
            if now - ts >= SESSION_TTL:
                del _sessions[key]
        stored = _sessions.get(sess)
        last_turn_is_nudge = _is_harness_nudge(
            _text(body["messages"][-1]["content"])) if (
            body.get("messages") and isinstance(body["messages"][-1], dict)
            and body["messages"][-1].get("role") == "user") else False
        sticky = stored is not None and (len(last) < 40 or fresh[3] or last_turn_is_nudge)
        tier, conf, probs, fb = fresh
        if sticky:
            tier, fb = stored[0], False
        _sessions[sess] = (tier, now)
        _sessions.move_to_end(sess)
        if len(_sessions) > SESSION_CAP:
            _sessions.popitem(last=False)
    return (tier, conf, probs, fb), sess, sticky, last[:120]


HOP_HEADERS = {"connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
               "te", "trailers", "transfer-encoding", "upgrade", "host", "content-length"}


class H(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def do_POST_classify(self):
        """POST /classify {"state": str} -> the omniroute in-process tier-router
        contract: {tier, confidence, probabilities, fallback}. Any error -> 503
        so the gateway falls back to the default combo."""
        if self.path.rstrip("/") != "/classify":
            return self._proxy()
        n = int(self.headers.get("Content-Length") or 0)
        try:
            body = json.loads(self.rfile.read(n) or b"{}")
            tier, conf, probs, fb = classify((body.get("state") or "")[:STATE_CHARS])
            out = json.dumps({"tier": tier, "confidence": conf,
                              "probabilities": probs, "fallback": fb}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(out)))
            self.end_headers()
            self.wfile.write(out)
        except Exception as e:
            out = json.dumps({"error": str(e)}).encode()
            self.send_response(503)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(out)))
            self.end_headers()
            self.wfile.write(out)

    def do_POST(self):
        if self.path.rstrip("/") == "/classify":
            return self.do_POST_classify()
        return self._proxy()

    def _proxy(self):
        n = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(n) if n else b""
        route_model, tier, conf, fb = None, None, 0.0, True
        is_chat = self.path.endswith("/chat/completions") or self.path.endswith("/completions")
        if is_chat and raw:
            try:
                body = json.loads(raw)
                if body.get("model") == VIRTUAL_MODEL:
                    t0 = time.time()
                    (tier, conf, probs, fb), sess, sticky, user_head = classify_body(body)
                    route_model = DEFAULT_COMBO if fb else TIER_COMBOS[tier]
                    ms = round((time.time() - t0) * 1000, 1)
                    log.info("tier=%s conf=%.3f fb=%s -> %s (%.1fms)", tier, conf, fb, route_model, ms)
                    try:
                        with open(LOG_PATH, "a") as f:
                            f.write(json.dumps({"ts": time.time(), "tier": tier, "confidence": conf,
                                                "fallback": fb, "combo": route_model, "ms": ms,
                                                "probs": probs,
                                                "state_head": state_from_body(body)[:LOG_HEAD_CHARS],
                                                "sess": sess, "sticky": sticky,
                                                "user_head": user_head}) + "\n")
                    except OSError:
                        pass
            except (json.JSONDecodeError, AttributeError):
                pass
        fwd = HTTPConnection(UPSTREAM_HOSTPORT, timeout=600)
        headers = [(k, v) for k, v in self.headers.items() if k.lower() not in HOP_HEADERS]
        if route_model:
            headers.append(("X-Route-Model", route_model))
        fwd.request(self.command, self.path, body=raw if raw else None, headers=dict(headers))
        resp = fwd.getresponse()
        self.send_response_only(resp.status)
        for k, v in resp.getheaders():
            if k.lower() not in HOP_HEADERS:
                self.send_header(k, v)
        # Upstream framing (chunked/content-length) is stripped above, so the
        # client can only find end-of-body via connection close. Say so.
        self.send_header("Connection", "close")
        self.close_connection = True
        self.end_headers()
        try:
            while True:
                chunk = resp.read(8192)
                if not chunk:
                    break
                self.wfile.write(chunk)
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            pass
        finally:
            fwd.close()

    do_GET = do_PUT = do_DELETE = do_PATCH = do_HEAD = do_OPTIONS = _proxy

    def log_message(self, fmt, *args):
        log.info("%s %s", self.address_string(), fmt % args)


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, stream=sys.stderr)
    # 0.3.x loads the checkpoint lazily; warm the encoder so the first real
    # request does not trigger a ~9s cold classify and drop short-timeout clients.
    try:
        classify("warmup")
        log.info("encoder warm")
    except Exception as e:
        log.warning("warmup failed: %s", e)
    ThreadingHTTPServer((os.environ.get("LAYA_BIND","0.0.0.0"), PORT), H).serve_forever()
