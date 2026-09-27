import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import type { Task } from "../core/db.ts";
import type { Runner } from "../fleet/runner.ts";
import {
  isTranscriptReadRequest,
  isTranscriptResult,
  parseClaudeLine,
  parseCodexUserLine,
  parseKimiLine,
  readTranscript,
} from "./transcript.ts";

function task(agent: Task["agent"] = "kimi"): Task {
  return {
    id: 7, repo_id: 1, base_branch: "main", base_commit: null,
    work_branch: "feat/7", title: "transcript", prompt: null,
    worktree_path: "/worktrees/7", session: "tdsp-7", status: "running", error: null,
    created_at: "now", kind: "repo", host_id: null, cwd: null,
    claude_session: null, provider_id: null, agent, agent_model: null,
  };
}

test("Claude string messages preserve their semantic role", () => {
  assert.deepEqual(parseClaudeLine({
    type: "assistant", message: { content: "answer" },
  }), [{ t: "assistant", text: "answer" }]);
  assert.deepEqual(parseClaudeLine({
    type: "user", message: { content: "question" },
  }), [{ t: "user", text: "question" }]);
});

test("Codex user-only parsing supports both semantic rollout event shapes", () => {
  assert.deepEqual(parseCodexUserLine({
    type: "event_msg",
    payload: { type: "user_message", message: "first\n\nsecond" },
  }), [{ t: "user", text: "first\n\nsecond" }]);
  assert.deepEqual(parseCodexUserLine({
    type: "event_msg",
    payload: {
      type: "item_completed",
      item: {
        type: "UserMessage",
        id: "item-1",
        client_id: "client-1",
        content: [
          { type: "text", text: "current\n\nformat", text_elements: [] },
          { type: "image", image_url: "ignored" },
        ],
      },
    },
  }), [{ t: "user", text: "current\n\nformat" }]);
  assert.deepEqual(parseCodexUserLine({
    type: "response_item",
    payload: { type: "message", role: "user", content: [{ type: "input_text", text: "duplicate" }] },
  }), [], "response_item mirror is ignored in the user-only event stream");
  assert.deepEqual(parseCodexUserLine({
    type: "event_msg",
    payload: { type: "agent_message", message: "assistant" },
  }), []);
  assert.deepEqual(parseCodexUserLine({
    type: "event_msg",
    payload: { type: "item_completed", item: { type: "AgentMessage", content: [{ type: "text", text: "assistant" }] } },
  }), []);
});

test("Codex user-only reads advertise their semantic event mode", async () => {
  const file = "/codex/rollout-test.jsonl";
  const body = [
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "synthetic mirror" }] } },
    {
      type: "event_msg",
      payload: {
        type: "item_completed",
        item: { type: "UserMessage", content: [{ type: "text", text: "actual\n\ninput" }] },
      },
    },
    { type: "event_msg", payload: { type: "agent_message", message: "answer" } },
  ].map((record) => JSON.stringify(record)).join("\n") + "\n";
  const runner = {
    kind: "local" as const,
    dataDir: "/data",
    async exec(command: string, args: string[]) {
      if (command === "sh") return file;
      if (command === "wc") return `${Buffer.byteLength(body, "utf8")} ${file}\n`;
      if (command === "tail") {
        const from = Math.max(0, Number((args[1] || "+1").slice(1)) - 1);
        return Buffer.from(body, "utf8").subarray(from).toString("utf8");
      }
      throw new Error(`unexpected exec: ${command}`);
    },
    async exists(p: string) { return p === file; },
    async readText() { return null; },
    async mkdirp() {},
    async rmrf() {},
    async putDir() {},
    async putFile() {},
  } satisfies Runner;

  const result = await readTranscript(runner, task("codex"), 0, null, { userOnly: true });
  assert.equal(result.mode, "codex-user-message-v1");
  assert.equal(result.source, "codex:rollout-test.jsonl");
  assert.deepEqual(result.entries, [{ t: "user", text: "actual\n\ninput" }]);
});

test("transcript reading refuses a remote runner", async () => {
  const remote = { kind: "ssh" } as Runner;
  await assert.rejects(() => readTranscript(remote, task("claude")), /node that owns the task/);
});

test("transcript cursor requests accept only bounded owner-opaque values", () => {
  assert.equal(isTranscriptReadRequest({ taskId: 7, since: 0, source: null }), true);
  assert.equal(isTranscriptReadRequest({ taskId: 7, since: 42, source: "kimi:session-7" }), true);
  assert.equal(isTranscriptReadRequest({ taskId: 7, since: 42, source: null, userOnly: true }), true);
  assert.equal(isTranscriptReadRequest({ taskId: 7, since: 42, source: null, userOnly: "yes" }), false);
  assert.equal(isTranscriptReadRequest({ taskId: 0, since: 0, source: null }), false);
  assert.equal(isTranscriptReadRequest({ taskId: 7, since: -1, source: null }), false);
  assert.equal(isTranscriptReadRequest({ taskId: 7, since: 0, source: "x".repeat(4097) }), false);
  assert.equal(isTranscriptResult({
    agent: "kimi",
    source: "kimi:session-7",
    entries: [{ t: "assistant", text: "done" }],
    cursor: 42,
  }), true);
  assert.equal(isTranscriptResult({
    agent: "kimi",
    source: "kimi:session-7",
    entries: [{ t: "assistant", text: 7 }],
    cursor: 42,
  }), false);
  assert.equal(isTranscriptResult({
    agent: "codex",
    source: "codex:rollout.jsonl",
    entries: [],
    cursor: 42,
    mode: "ordinary-transcript",
  }), false);
});

test("parseKimiLine maps visible messages and loop events while dropping injected context", () => {
  assert.deepEqual(parseKimiLine({
    type: "context.append_message",
    message: { role: "user", origin: { kind: "user" }, content: [{ type: "text", text: "hello" }] },
  }), [{ t: "user", text: "hello" }]);
  assert.deepEqual(parseKimiLine({
    type: "context.append_message",
    message: { role: "user", origin: { kind: "injection", variant: "todo_list_reminder" }, content: [{ type: "text", text: "internal" }] },
  }), []);
  assert.deepEqual(parseKimiLine({
    type: "context.append_loop_event",
    event: { type: "content.part", part: { type: "think", think: "checking" } },
  }), [{ t: "thinking", text: "checking" }]);
  assert.deepEqual(parseKimiLine({
    type: "context.append_loop_event",
    event: { type: "content.part", part: { type: "text", text: "done" } },
  }), [{ t: "assistant", text: "done" }]);
  assert.deepEqual(parseKimiLine({
    type: "context.append_loop_event",
    event: { type: "tool.call", toolCallId: "tc-1", name: "Bash", args: { command: "npm test" } },
  }), [{
    t: "tool_call", id: "tc-1", name: "Bash", arg: "npm test",
    detail: "{\n  \"command\": \"npm test\"\n}",
  }]);
  assert.deepEqual(parseKimiLine({
    type: "context.append_loop_event",
    event: {
      type: "tool.result", toolCallId: "tc-1",
      result: { output: [{ type: "text", text: "ok\n" }, { type: "image", imageUrl: { url: "blobref:image/png;x" } }], isError: true },
    },
  }), [{ t: "tool_result", id: "tc-1", ok: false, output: "ok\n[image]" }]);
  assert.deepEqual(parseKimiLine({ type: "turn.prompt", input: [{ type: "text", text: "hello" }] }), []);
});

test("readTranscript locates the most recently active Kimi session, tails it, and follows a new source", async () => {
  const kimiHome = path.join(os.homedir(), ".kimi-code");
  const firstDir = path.join(kimiHome, "sessions", "wd-7", "session-first");
  const secondDir = path.join(kimiHome, "sessions", "wd-7", "session-second");
  const firstWire = path.join(firstDir, "agents", "main", "wire.jsonl");
  const secondWire = path.join(secondDir, "agents", "main", "wire.jsonl");
  const firstBody = [
    { type: "context.append_message", message: { role: "user", origin: { kind: "user" }, content: [{ type: "text", text: "first prompt" }] } },
    { type: "context.append_loop_event", event: { type: "content.part", part: { type: "text", text: "first answer" } } },
  ].map((record) => JSON.stringify(record)).join("\n") + "\n";
  const secondBody = [
    { type: "context.append_message", message: { role: "user", origin: { kind: "user" }, content: [{ type: "text", text: "new prompt" }] } },
  ].map((record) => JSON.stringify(record)).join("\n") + "\n";

  let index = JSON.stringify({ sessionId: "session-first", sessionDir: firstDir, workDir: "/worktrees/7" }) + "\n";
  const textFiles = new Map<string, string>([
    [path.join(firstDir, "state.json"), JSON.stringify({ workDir: "/worktrees/7", updatedAt: "2026-07-27T01:00:00Z" })],
    [path.join(secondDir, "state.json"), JSON.stringify({ workDir: "/worktrees/7", updatedAt: "2026-07-27T02:00:00Z" })],
  ]);
  const wireFiles = new Map<string, string>([[firstWire, firstBody], [secondWire, secondBody]]);
  const runner = {
    kind: "local" as const,
    dataDir: "/data",
    async exec(file: string, args: string[]) {
      const wire = wireFiles.get(args.at(-1) || "");
      if (file === "wc" && wire != null) return `${Buffer.byteLength(wire, "utf8")} ${args.at(-1)}\n`;
      if (file === "tail" && wire != null) {
        const from = Math.max(0, Number((args[1] || "+1").slice(1)) - 1);
        return Buffer.from(wire, "utf8").subarray(from).toString("utf8");
      }
      throw new Error(`unexpected exec: ${file} ${args.join(" ")}`);
    },
    async exists(p: string) { return wireFiles.has(p); },
    async readText(p: string) {
      if (p === path.join(kimiHome, "session_index.jsonl")) return index;
      return textFiles.get(p) ?? null;
    },
    async mkdirp() {},
    async rmrf() {},
    async putDir() {},
    async putFile() {},
  } satisfies Runner;

  const first = await readTranscript(runner, task());
  assert.equal(first.source, "kimi:session-first");
  assert.doesNotMatch(first.source!, /worktrees|sessions|wire\.jsonl/);
  assert.deepEqual(first.entries, [
    { t: "user", text: "first prompt" },
    { t: "assistant", text: "first answer" },
  ]);
  assert.equal(first.cursor, Buffer.byteLength(firstBody, "utf8"));

  const unchanged = await readTranscript(runner, task(), first.cursor, first.source);
  assert.deepEqual(unchanged.entries, []);
  assert.equal(unchanged.cursor, first.cursor);

  index += JSON.stringify({ sessionId: "session-second", sessionDir: secondDir, workDir: "/worktrees/7" }) + "\n";
  const switched = await readTranscript(runner, task(), first.cursor, first.source);
  assert.equal(switched.source, "kimi:session-second");
  assert.deepEqual(switched.entries, [{ t: "user", text: "new prompt" }]);
  assert.equal(switched.cursor, Buffer.byteLength(secondBody, "utf8"));
});

test("readTranscript pages a large normalized history without skipping a complete line", async () => {
  const t = task("claude");
  t.claude_session = "session-large";
  const file = path.join(os.homedir(), ".claude", "projects", "-worktrees-7", "session-large.jsonl");
  const text = "x".repeat(2_200_000);
  const lines = [
    JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: text + " first" }] } }),
    JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: text + " second" }] } }),
  ];
  const body = lines.join("\n") + "\n";
  const runner = {
    kind: "local" as const,
    dataDir: "/data",
    async exec(command: string, args: string[]) {
      if (command === "wc") return `${Buffer.byteLength(body, "utf8")} ${file}\n`;
      if (command === "tail") {
        const from = Math.max(0, Number((args[1] || "+1").slice(1)) - 1);
        return Buffer.from(body, "utf8").subarray(from).toString("utf8");
      }
      throw new Error(`unexpected exec: ${command}`);
    },
    async exists(p: string) { return p === file; },
    async readText() { return null; },
    async mkdirp() {},
    async rmrf() {},
    async putDir() {},
    async putFile() {},
  } satisfies Runner;

  const first = await readTranscript(runner, t);
  assert.equal(first.source, "claude:session-large");
  assert.equal(first.entries.length, 1);
  assert.equal(first.hasMore, true);
  assert.equal(first.cursor, Buffer.byteLength(lines[0] + "\n", "utf8"));

  const second = await readTranscript(runner, t, first.cursor, first.source);
  assert.equal(second.entries.length, 1);
  assert.match((second.entries[0] as any).text, / second$/);
  assert.equal(second.hasMore, false);
  assert.equal(second.cursor, Buffer.byteLength(body, "utf8"));
});
