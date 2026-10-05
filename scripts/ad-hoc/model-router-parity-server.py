#!/usr/bin/env python3
"""Throwaway parity server (NOT the live router; separate port, imports the deployed module).

  POST /classify    {"state": str}  -> {tier, confidence, probabilities, fallback}   (the new contract)
  POST /standalone  {"body": {...}} -> same shape, computed via the sidecar's OWN
                                       state_from_body() + classify()               (ground truth)
  POST /state       {"body": {...}} -> {"state": state_from_body(body)}

Run from m1max:  ~/laya-router-venv/bin/python parity_server.py   (port PARITY_PORT, default 20771)
"""
import importlib.util, json, os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

spec = importlib.util.spec_from_file_location("laya_router_deployed",
                                              os.path.expanduser("~/laya-router.py"))
lr = importlib.util.module_from_spec(spec)
spec.loader.exec_module(lr)  # __main__ guard keeps the live server from starting
lr.classify("warmup")


def result(state):
    tier, conf, probs, fb = lr.classify(state)
    return {"tier": tier, "confidence": conf, "probabilities": probs, "fallback": fb}


class H(BaseHTTPRequestHandler):
    def do_POST(self):
        n = int(self.headers.get("Content-Length") or 0)
        data = json.loads(self.rfile.read(n) or b"{}")
        if self.path == "/classify":
            out = result(data.get("state", ""))
        elif self.path == "/standalone":
            out = result(lr.state_from_body(data["body"]))
        elif self.path == "/state":
            out = {"state": lr.state_from_body(data["body"])}
        else:
            self.send_response(404); self.end_headers(); return
        raw = json.dumps(out).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def log_message(self, *a):
        pass


if __name__ == "__main__":
    ThreadingHTTPServer(("127.0.0.1", int(os.environ.get("PARITY_PORT", "20771"))), H).serve_forever()
