import test from "node:test";
import assert from "node:assert/strict";
import { taskLifecycle } from "./task-lifecycle.js";

test("an archived remote task with a retained worktree can resume or remove it", () => {
  assert.deepEqual(taskLifecycle({ status: "cleaned", alive: false, hasWorktree: true }), {
    active: false,
    action: "removeWorktree",
    resumable: true,
    connectable: false,
  });
});

test("an archived remote task without a worktree deletes only its record", () => {
  assert.deepEqual(taskLifecycle({ status: "cleaned", alive: false, hasWorktree: false }), {
    active: false,
    action: "deleteRecord",
    resumable: false,
    connectable: false,
  });
});

test("a live active remote task remains connectable and stoppable", () => {
  assert.deepEqual(taskLifecycle({ status: "running", alive: true, hasWorktree: true }), {
    active: true,
    action: "stop",
    resumable: false,
    connectable: true,
  });
});
