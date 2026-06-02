import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { resolveDataDir } from "./paths.js";

const HOME = "/home/u";

test("defaults to ~/.task-dispatcher when no override is set", () => {
  assert.equal(resolveDataDir({}, HOME), path.join(HOME, ".task-dispatcher"));
});

test("TASK_DISPATCHER_DATA_DIR overrides the default (isolated controller)", () => {
  assert.equal(
    resolveDataDir({ TASK_DISPATCHER_DATA_DIR: "/srv/dispatch-dev" }, HOME),
    "/srv/dispatch-dev",
  );
});

test("a relative override is resolved to an absolute path", () => {
  assert.equal(
    resolveDataDir({ TASK_DISPATCHER_DATA_DIR: "data-dev" }, HOME),
    path.resolve("data-dev"),
  );
});

test("a blank / whitespace override falls back to the default", () => {
  assert.equal(resolveDataDir({ TASK_DISPATCHER_DATA_DIR: "" }, HOME), path.join(HOME, ".task-dispatcher"));
  assert.equal(resolveDataDir({ TASK_DISPATCHER_DATA_DIR: "   " }, HOME), path.join(HOME, ".task-dispatcher"));
});
