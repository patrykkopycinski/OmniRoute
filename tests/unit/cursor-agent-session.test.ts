import test from "node:test";
import assert from "node:assert/strict";
import {
  CursorSessionManager,
  type CursorSession,
} from "../../open-sse/services/cursorSessionManager";
import {
  flattenMessages,
  deriveCursorConversationKey,
  parseConvertedToolResults,
} from "../../open-sse/utils/cursorAgentProtobuf";

// ─── Test doubles for h2 ───────────────────────────────────────────────────
//
// We don't open real h2 connections in unit tests. Sessions hold opaque
// references that the manager only ever .close()s or .write()s through
// encodeExecMcpResult. A pair of stubs is enough.

type WriteCall = { kind: "write"; data: Buffer } | { kind: "close" };

function mockReq() {
  const calls: WriteCall[] = [];
  return {
    req: {
      write: (data: Buffer) => {
        calls.push({ kind: "write", data });
        return true;
      },
      close: () => {
        calls.push({ kind: "close" });
      },
    } as unknown as import("node:http2").ClientHttp2Stream,
    calls,
  };
}

function mockClient() {
  const closed = { value: false };
  return {
    client: {
      close: () => {
        closed.value = true;
      },
    } as unknown as import("node:http2").ClientHttp2Session,
    closed,
  };
}

// ─── flattenMessages: Phase 6 cold-resume support ──────────────────────────

test("flattenMessages handles role:'tool' messages", () => {
  const out = flattenMessages([
    { role: "user", content: "what's the weather?" },
    {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "call_xyz",
          type: "function",
          function: { name: "get_weather", arguments: '{"city":"Paris"}' },
        },
      ],
    },
    { role: "tool", tool_call_id: "call_xyz", content: "sunny, 22C" },
  ]);
  assert.match(out, /User: what's the weather\?/);
  assert.match(
    out,
    /Assistant called tool get_weather \(call_xyz\) with arguments: \{"city":"Paris"\}/
  );
  assert.match(out, /Tool result \(call_xyz\): sunny, 22C/);
});

test("flattenMessages handles assistant with text + tool_calls in same message", () => {
  const out = flattenMessages([
    { role: "user", content: "do x" },
    {
      role: "assistant",
      content: "Let me check.",
      tool_calls: [
        {
          id: "c1",
          type: "function",
          function: { name: "check", arguments: "{}" },
        },
      ],
    },
    { role: "tool", tool_call_id: "c1", content: "result" },
  ]);
  assert.match(out, /Assistant: Let me check\./);
  assert.match(out, /Assistant called tool check \(c1\) with arguments: \{\}/);
  assert.match(out, /Tool result \(c1\): result/);
});

test("flattenMessages handles parallel tool_calls", () => {
  const out = flattenMessages([
    { role: "user", content: "check both" },
    {
      role: "assistant",
      content: null,
      tool_calls: [
        { id: "c1", type: "function", function: { name: "tool_a", arguments: "{}" } },
        { id: "c2", type: "function", function: { name: "tool_b", arguments: "{}" } },
      ],
    },
    { role: "tool", tool_call_id: "c1", content: "result_a" },
    { role: "tool", tool_call_id: "c2", content: "result_b" },
  ]);
  assert.match(out, /tool_a \(c1\)/);
  assert.match(out, /tool_b \(c2\)/);
  assert.match(out, /Tool result \(c1\): result_a/);
  assert.match(out, /Tool result \(c2\): result_b/);
});

test("flattenMessages keeps single-user fast path unchanged when no tool_calls", () => {
  const out = flattenMessages([{ role: "user", content: "hi" }]);
  assert.equal(out, "hi");
});

// ─── CursorSessionManager lifecycle ────────────────────────────────────────

test("CursorSessionManager.open registers a session under conversation_id", () => {
  const m = new CursorSessionManager();
  const { req } = mockReq();
  const { client } = mockClient();
  const session = m.open("conv-1", client, req, new Map());
  assert.equal(m.size(), 1);
  assert.ok(m.has("conv-1"));
  assert.equal(session.conversationId, "conv-1");
  assert.equal(session.state, "running");
});

test("CursorSessionManager.acquire returns undefined when no session", () => {
  const m = new CursorSessionManager();
  assert.equal(m.acquire("nope"), undefined);
});

test("CursorSessionManager.acquire returns undefined when session is still running", () => {
  const m = new CursorSessionManager();
  const { req } = mockReq();
  const { client } = mockClient();
  m.open("conv-2", client, req, new Map());
  // open() leaves state="running"; acquire requires "awaiting_tool_result"
  assert.equal(m.acquire("conv-2"), undefined);
});

test("CursorSessionManager.acquire returns the session after release(awaiting_tool_result)", () => {
  const m = new CursorSessionManager();
  const { req } = mockReq();
  const { client } = mockClient();
  const opened = m.open("conv-3", client, req, new Map());
  m.release(opened, "awaiting_tool_result");
  const acquired = m.acquire("conv-3");
  assert.equal(acquired, opened);
  assert.equal(acquired?.state, "running");
});

test("CursorSessionManager release(awaiting_tool_result) actively evicts after TTL", async () => {
  const m = new CursorSessionManager({ idleTtlMs: 20 });
  const { req } = mockReq();
  const { client, closed } = mockClient();
  const session = m.open("conv-ttl", client, req, new Map());
  m.release(session, "awaiting_tool_result");

  await new Promise((resolve) => setTimeout(resolve, 50));

  assert.equal(m.size(), 0);
  assert.ok(closed.value);
});

test("CursorSessionManager enforces a maximum retained session count", () => {
  const m = new CursorSessionManager({ maxSessions: 1 });
  const firstReq = mockReq();
  const firstClient = mockClient();
  m.open("conv-max-1", firstClient.client, firstReq.req, new Map());
  const secondReq = mockReq();
  const secondClient = mockClient();
  m.open("conv-max-2", secondClient.client, secondReq.req, new Map());

  assert.equal(m.size(), 1);
  assert.equal(m.has("conv-max-1"), false);
  assert.equal(m.has("conv-max-2"), true);
  assert.ok(firstClient.closed.value);
});

test("CursorSessionManager.release(idle) closes the session", () => {
  const m = new CursorSessionManager();
  const { req, calls } = mockReq();
  const { client, closed } = mockClient();
  const session = m.open("conv-4", client, req, new Map());
  m.release(session, "idle");
  assert.equal(m.size(), 0);
  assert.ok(closed.value);
  assert.ok(calls.some((c) => c.kind === "close"));
});

test("CursorSessionManager.acquire evicts expired sessions", () => {
  const m = new CursorSessionManager({ idleTtlMs: 10 });
  const { req } = mockReq();
  const { client, closed } = mockClient();
  const session = m.open("conv-5", client, req, new Map());
  m.release(session, "awaiting_tool_result");
  // Manually backdate lastActivityTs to simulate idle.
  session.lastActivityTs = Date.now() - 1000;
  const acquired = m.acquire("conv-5");
  assert.equal(acquired, undefined);
  assert.equal(m.size(), 0);
  assert.ok(closed.value);
});

test("CursorSessionManager.sendToolResult writes ExecMcpResult on the session's req", () => {
  const m = new CursorSessionManager();
  const { req, calls } = mockReq();
  const { client } = mockClient();
  const session = m.open("conv-6", client, req, new Map());
  session.pendingToolCalls.set("call_x", {
    execMsgId: 1,
    execId: "exec-1",
    toolName: "get_weather",
  });
  const ok = m.sendToolResult(session, "call_x", "sunny", false);
  assert.equal(ok, true);
  // Verify a write happened
  const writes = calls.filter((c) => c.kind === "write");
  assert.equal(writes.length, 1);
  // The write should be a Connect-RPC frame containing "sunny" and "exec-1"
  const data = (writes[0] as { kind: "write"; data: Buffer }).data;
  assert.ok(data.includes(Buffer.from("sunny", "utf8")));
  assert.ok(data.includes(Buffer.from("exec-1", "utf8")));
  // Pending tool call was consumed
  assert.equal(session.pendingToolCalls.has("call_x"), false);
});

test("CursorSessionManager.sendToolResult returns false when openAIToolCallId not pending", () => {
  const m = new CursorSessionManager();
  const { req } = mockReq();
  const { client } = mockClient();
  const session = m.open("conv-7", client, req, new Map());
  const ok = m.sendToolResult(session, "unknown_id", "x", false);
  assert.equal(ok, false);
});

test("CursorSessionManager.close clears unanswered pendingToolCalls", () => {
  const m = new CursorSessionManager();
  const { req } = mockReq();
  const { client } = mockClient();
  const session = m.open("conv-clear", client, req, new Map());
  session.pendingToolCalls.set("call_unanswered", {
    execMsgId: 1,
    execId: "exec-1",
    toolName: "get_weather",
  });
  m.close(session);
  // close() drops the unanswered mapping so it isn't pinned on the dead session.
  assert.equal(session.pendingToolCalls.size, 0);
  assert.equal(m.size(), 0);
});

test("CursorSessionManager.open replaces an existing session for the same conversation", () => {
  const m = new CursorSessionManager();
  const r1 = mockReq();
  const c1 = mockClient();
  const session1 = m.open("conv-8", c1.client, r1.req, new Map());
  m.release(session1, "awaiting_tool_result");
  const r2 = mockReq();
  const c2 = mockClient();
  const session2 = m.open("conv-8", c2.client, r2.req, new Map());
  // First session's client should be closed
  assert.ok(c1.closed.value);
  // Map only has one session; the new one
  assert.equal(m.size(), 1);
  assert.equal(m.acquire("conv-8"), undefined); // session2 is "running"
  void session2;
});

// ─── deriveCursorConversationKey: session-reuse key stability ──────────────
//
// The bug these cover: conversationId fell back to crypto.randomUUID() when a
// client sent no conversation_id, so acquire() could never match and every
// tool follow-up paid a full cold-resume (re-flattening ~200k tokens of
// history at ~15.9s per 100k input tokens).

const SYSTEM_PROMPT = "You are a helpful assistant with tools.";

test("deriveCursorConversationKey is stable across a tool follow-up turn", () => {
  const first = [
    { role: "system" as const, content: SYSTEM_PROMPT },
    { role: "user" as const, content: "list the files" },
  ];
  // The same thread one turn later: assistant tool_call + tool result appended.
  const followUp = [
    ...first,
    {
      role: "assistant" as const,
      content: null,
      tool_calls: [{ id: "call_1", type: "function", function: { name: "ls", arguments: "{}" } }],
    },
    { role: "tool" as const, tool_call_id: "call_1", content: "a.ts\nb.ts" },
  ];

  const k1 = deriveCursorConversationKey(first);
  const k2 = deriveCursorConversationKey(followUp);
  assert.ok(k1);
  // Stability across the follow-up is the entire point: an unstable key here
  // is exactly the cold-resume regression.
  assert.equal(k2, k1);
});

test("deriveCursorConversationKey separates distinct conversations", () => {
  const a = deriveCursorConversationKey([
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: "question one" },
  ]);
  const b = deriveCursorConversationKey([
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: "a completely different question" },
  ]);
  assert.ok(a && b);
  assert.notEqual(a, b);
});

test("deriveCursorConversationKey handles multimodal content parts", () => {
  const key = deriveCursorConversationKey([
    { role: "system", content: [{ type: "text", text: SYSTEM_PROMPT }] },
    {
      role: "user",
      content: [{ type: "text", text: "describe this" }, { type: "image_url" }],
    },
  ]);
  assert.ok(key);
  assert.match(key, /^[0-9a-f]{32}$/);
});

test("deriveCursorConversationKey returns null without a usable prefix", () => {
  // No system text and no user message — caller must fall back to a random id
  // rather than colliding every keyless request onto one shared session.
  assert.equal(deriveCursorConversationKey([]), null);
  assert.equal(
    deriveCursorConversationKey([{ role: "tool", tool_call_id: "x", content: "orphan result" }]),
    null
  );
});

test("deriveCursorConversationKey keys off the prefix, not later user turns", () => {
  const base = [
    { role: "system" as const, content: SYSTEM_PROMPT },
    { role: "user" as const, content: "first question" },
  ];
  const later = [
    ...base,
    { role: "assistant" as const, content: "an answer" },
    { role: "user" as const, content: "second question" },
  ];
  // Same thread, so the key must not move when the user speaks again.
  assert.equal(deriveCursorConversationKey(later), deriveCursorConversationKey(base));
});

// ─── Converted tool-result blocks (the shape the executor actually sees) ─────

test("parseConvertedToolResults ignores content that is not a converted block", () => {
  assert.deepEqual(parseConvertedToolResults("just a normal question"), []);
  assert.deepEqual(parseConvertedToolResults(undefined), []);
  assert.deepEqual(parseConvertedToolResults(null), []);
  assert.deepEqual(parseConvertedToolResults([{ type: "text", text: "hi" }]), []);
});

test("parseConvertedToolResults recovers the id and result the translator encoded", () => {
  // Exactly what openai-to-cursor's buildToolResultBlock emits for a tool turn.
  const block = [
    "<tool_result>",
    "<tool_name>get_weather</tool_name>",
    "<tool_call_id>call_zz1</tool_call_id>",
    "<result>18C sunny</result>",
    "</tool_result>",
  ].join("\n");
  assert.deepEqual(parseConvertedToolResults(block), [
    { toolCallId: "call_zz1", result: "18C sunny" },
  ]);
});

test("parseConvertedToolResults unescapes XML entities in the result", () => {
  const block = [
    "<tool_result>",
    "<tool_name>run</tool_name>",
    "<tool_call_id>call_amp</tool_call_id>",
    "<result>a &lt;b&gt; &amp;&amp; c</result>",
    "</tool_result>",
  ].join("\n");
  assert.deepEqual(parseConvertedToolResults(block), [
    { toolCallId: "call_amp", result: "a <b> && c" },
  ]);
});

test("parseConvertedToolResults handles several tool results in one message", () => {
  const mk = (id: string, r: string) =>
    `<tool_result>\n<tool_name>t</tool_name>\n<tool_call_id>${id}</tool_call_id>\n<result>${r}</result>\n</tool_result>`;
  assert.deepEqual(parseConvertedToolResults(`${mk("a1", "one")}\n${mk("b2", "two")}`), [
    { toolCallId: "a1", result: "one" },
    { toolCallId: "b2", result: "two" },
  ]);
});

test("parseConvertedToolResults skips a block with no tool_call_id", () => {
  // Without an id there is nothing to match against pendingToolCalls, so the
  // block must not produce a phantom entry that fakes a tool follow-up.
  const block = "<tool_result>\n<tool_name>t</tool_name>\n<result>orphan</result>\n</tool_result>";
  assert.deepEqual(parseConvertedToolResults(block), []);
});

test("a converted tool-result message is recognised as a tool follow-up", () => {
  // Regression guard for the live defect: the openai→cursor translator rewrites
  // role:"tool" into a user message carrying <tool_result>, so the executor's old
  // `lastMessage.role === "tool"` test was false on every real request and inline
  // resume never ran. Mirrors the exact message array captured from the running
  // container: the tool role survives but is no longer last.
  const messages = [
    { role: "user" as const, content: "weather in Paris?" },
    { role: "assistant" as const, content: "" },
    { role: "tool" as const, tool_call_id: "call_zz1", content: "" },
    {
      role: "user" as const,
      content:
        "<tool_result>\n<tool_name>get_weather</tool_name>\n<tool_call_id>call_zz1</tool_call_id>\n<result>18C sunny</result>\n</tool_result>",
    },
  ];
  const last = messages[messages.length - 1];
  const converted = parseConvertedToolResults(last.content);

  assert.equal(last.role === "tool", false, "the raw-role check alone must not fire");
  assert.equal(converted.length > 0, true, "the converted form must be detected");
  assert.equal(converted[0].toolCallId, "call_zz1");
});
