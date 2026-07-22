import { test } from "node:test";
import assert from "node:assert/strict";
import type { Task } from "../core/db.ts";
import type { Runner } from "../fleet/runner.ts";
import { readTranscript } from "./transcript.ts";

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
