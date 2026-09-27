import { test } from "node:test";
import assert from "node:assert/strict";
import type { Task } from "../core/db.ts";
import type { Runner } from "../fleet/runner.ts";
import { parseClaudeLine, parseCodexUserLine, readTranscript } from "./transcript.ts";

test("Claude string messages preserve their semantic role", () => {
  assert.deepEqual(parseClaudeLine({
    type: "assistant", message: { content: "answer" },
  }), [{ t: "assistant", text: "answer" }]);
  assert.deepEqual(parseClaudeLine({
    type: "user", message: { content: "question" },
  }), [{ t: "user", text: "question" }]);
});

test("Codex user-only parsing uses semantic user_message events", () => {
  assert.deepEqual(parseCodexUserLine({
    type: "event_msg",
    payload: { type: "user_message", message: "first\n\nsecond" },
  }), [{ t: "user", text: "first\n\nsecond" }]);
  assert.deepEqual(parseCodexUserLine({
    type: "response_item",
    payload: { type: "message", role: "user", content: [{ type: "input_text", text: "duplicate" }] },
  }), [], "response_item mirror is ignored in the user-only event stream");
  assert.deepEqual(parseCodexUserLine({
    type: "event_msg",
    payload: { type: "agent_message", message: "assistant" },
  }), []);
});

test("transcript reading refuses a remote runner", async () => {
  const task = {
    id: 7, repo_id: 1, base_branch: "main", base_commit: null,
    work_branch: "feat/7", title: "remote", prompt: null,
    worktree_path: "/remote/wt", session: "tdsp-7", status: "running", error: null,
    created_at: "now", kind: "repo", host_id: null, cwd: null,
    claude_session: null, provider_id: null, agent: "claude", agent_model: null,
  } satisfies Task;
  const remote = { kind: "ssh" } as Runner;
  await assert.rejects(() => readTranscript(remote, task), /node that owns the task/);
});
