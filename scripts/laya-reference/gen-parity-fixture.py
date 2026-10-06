#!/usr/bin/env python3
"""Generate the model-router parity fixture.

Extracts `_text`, `_is_harness_nudge` and `state_from_body` VERBATIM from the
reference sidecar (scripts/laya-reference/laya-router.py, HEAD e6fdc10) and runs
them over the request bodies below, emitting JSON expected states. The TS
implementation (buildRouterState) must match these byte-for-byte.

Usage: python3 scripts/laya-reference/gen-parity-fixture.py [out.json]
"""
import json
import re
import sys
import pathlib

HERE = pathlib.Path(__file__).parent
REF = (HERE / "laya-router.py").read_text(encoding="utf-8")
OUT = pathlib.Path(sys.argv[1]) if len(sys.argv) > 1 else HERE / "parity-fixture.json"

STATE_CHARS = 6000


def extract(name: str) -> str:
    """Pull a top-level def block from the reference (verbatim source)."""
    m = re.search(rf"^def {name}\(.*?(?=^\S)", REF, re.M | re.S)
    if not m:
        raise SystemExit(f"cannot extract {name} from reference")
    return m.group(0)


src = "\n".join(
    [extract("_is_harness_nudge"), extract("_text"), extract("state_from_body")]
)
ns = {"STATE_CHARS": STATE_CHARS}
exec(compile(src, "laya-router.py (extracted)", "exec"), ns)
state_from_body = ns["state_from_body"]

# ── Request bodies: real shapes (user-only, tool-heavy, [System: nudges,
#    multi-part content, anthropic system), ≥30 cases. ──
BODIES = []


def add(body):
    BODIES.append(body)


# 1-6: single user turn, varying lengths
add({"model": "laya-router", "messages": [{"role": "user", "content": "hi"}]})
add({"model": "laya-router", "messages": [{"role": "user", "content": "Rename userCnt to userCount in src/app.ts"}]})
add({"model": "laya-router", "messages": [{"role": "user", "content": "Explain the CAP theorem and when eventual consistency is acceptable, with examples from real distributed systems."}]})
add({"model": "x", "messages": [{"role": "user", "content": "write a haiku"}]})
add({"messages": [{"role": "user", "content": "a" * 7000}]})
add({"model": "laya-router", "messages": [{"role": "user", "content": "  leading whitespace turn  "}]})

# 7-12: multi-turn user/assistant interleaves (assistant must be excluded when
# user turns exist)
add({"messages": [
    {"role": "user", "content": "first question about python"},
    {"role": "assistant", "content": "an answer"},
    {"role": "user", "content": "second question about rust"},
]})
add({"messages": [
    {"role": "user", "content": "q1"},
    {"role": "assistant", "content": "a1"},
    {"role": "user", "content": "q2"},
    {"role": "assistant", "content": "a2"},
    {"role": "user", "content": "q3"},
]})
add({"messages": [
    {"role": "system", "content": "You are terse."},
    {"role": "user", "content": "build a CLI"},
    {"role": "assistant", "content": "ok"},
    {"role": "user", "content": "add flags"},
]})
add({"messages": [
    {"role": "developer", "content": "dev instructions"},
    {"role": "user", "content": "refactor the parser"},
]})
add({"messages": [
    {"role": "user", "content": "u1"},
    {"role": "assistant", "content": "very long assistant answer " * 50},
    {"role": "user", "content": "u2"},
    {"role": "assistant", "content": "another long assistant answer " * 50},
]})
add({"messages": [{"role": "assistant", "content": "only an assistant"}]})

# 13-18: no user turns at all → non-system turns newest first
add({"messages": [
    {"role": "assistant", "content": "a1"},
    {"role": "tool", "content": "tool output 1"},
    {"role": "assistant", "content": "a2"},
    {"role": "tool", "content": "tool output 2"},
]})
add({"messages": [
    {"role": "system", "content": "sys"},
    {"role": "assistant", "content": "assistant only turn"},
]})
add({"messages": [{"role": "tool", "content": "just tool output"}]})
add({"messages": [{"role": "user", "content": ""}, {"role": "assistant", "content": "nonempty"}]})
add({"messages": [{"role": "user", "content": "   "}, {"role": "tool", "content": "t"}]})
add({"messages": []})

# 19-26: harness [System: nudges
add({"messages": [
    {"role": "user", "content": "do the thing"},
    {"role": "assistant", "content": "partial"},
    {"role": "user", "content": "[System: The previous response was truncated. Continue.]"},
]})
add({"messages": [
    {"role": "user", "content": "  [System: indented nudge]"},
]})
add({"messages": [
    {"role": "user", "content": "real q"},
    {"role": "user", "content": "[System: nudge]"},
    {"role": "user", "content": "another real q"},
]})
add({"messages": [
    {"role": "user", "content": "[System: only nudge, no real input]"},
    {"role": "assistant", "content": "assistant fallback"},
]})
add({"messages": [
    {"role": "user", "content": "q"},
    {"role": "user", "content": "not[System: at start"},
]})
add({"messages": [
    {"role": "user", "content": "nudge test"},
    {"role": "user", "content": "\t[System: tab-indented nudge]"},
]})
add({"messages": [
    {"role": "user", "content": "[System: nudge 1]"},
    {"role": "user", "content": "[System: nudge 2]"},
    {"role": "tool", "content": "tool after nudges"},
]})
add({"messages": [{"role": "system", "content": "[System: system role nudge is kept]"}]})

# 27-34: multi-part content + anthropic system + misc shapes
add({"messages": [
    {"role": "user", "content": [
        {"type": "text", "text": "part one"},
        {"type": "image_url", "image_url": {"url": "data:..."}},
        {"type": "text", "text": "part two"},
    ]},
]})
add({"messages": [
    {"role": "user", "content": [
        {"type": "text", "text": "single part"},
    ]},
]})
add({"system": "You are a coding agent.", "messages": [{"role": "user", "content": "fix the bug"}]})
add({"system": [{"type": "text", "text": "anthropic system part"}], "messages": [{"role": "user", "content": "q"}]})
add({"system": "S1", "messages": [
    {"role": "system", "content": "S2"},
    {"role": "developer", "content": "D1"},
    {"role": "user", "content": "q"},
]})
add({"messages": [
    {"role": "user", "content": "u1 " + "x" * 200},
    {"role": "user", "content": "u2 " + "y" * 200},
    {"role": "user", "content": "u3 " + "z" * 200},
    {"role": "user", "content": "u4 " + "a" * 200},
    {"role": "user", "content": "u5 " + "b" * 200},
    {"role": "user", "content": "u6 " + "c" * 200},
    {"role": "user", "content": "u7 " + "d" * 200},
    {"role": "user", "content": "u8 " + "e" * 200},
]})
add({"messages": [
    {"role": "user", "content": "emoji test 🚀🔥 plain"},
    {"role": "assistant", "content": "🤖"},
    {"role": "user", "content": "again 🎉"},
]})
add({"messages": [
    {"role": "user", "content": {"unexpected": "object"}},
    {"role": "tool", "content": "tool text"},
]})

# 35-38: edge shapes
add({"messages": [
    {"role": "user", "content": ["nested", {"text": 5}]},
]})
add({"messages": [{"role": "user"}, {"role": "user", "content": "ok"}]})
add({"messages": [
    {"role": "user", "content": "long " * 1500},
], "system": "sys " * 500})
add({})

fixture = [{"body": b, "state": state_from_body(b)} for b in BODIES]
OUT.write_text(json.dumps(fixture, ensure_ascii=False, indent=1), encoding="utf-8")
print(f"wrote {len(fixture)} cases to {OUT}")
