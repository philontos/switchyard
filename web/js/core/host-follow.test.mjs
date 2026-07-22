import test from "node:test";
import assert from "node:assert/strict";
import { remoteFollowTasks } from "./host-follow.js";

test("an unavailable remote machine still selects the remote task source", () => {
  assert.deepEqual(remoteFollowTasks({ id: 2, kind: "ssh" }, { ok: false, reason: "notBootstrapped" }), []);
  assert.deepEqual(remoteFollowTasks({ id: 2, kind: "ssh" }, undefined), []);
});

test("a ready remote returns only its fleet tasks", () => {
  const tasks = [{ id: 7 }];
  assert.equal(remoteFollowTasks({ id: 2, kind: "ssh" }, { ok: true, tasks }), tasks);
});

test("a local machine keeps using the local task source", () => {
  assert.equal(remoteFollowTasks({ id: 1, kind: "local" }, { ok: true, tasks: [{ id: 9 }] }), null);
});
