import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { initSchema } from "../core/schema.ts";
import {
  externalReferenceWorktreePaths,
  kimiWorkspaceAgentContent,
  legacyReferenceRootPath,
  pathIsInside,
  referenceRootPath,
  referenceRootPaths,
  resolveReferenceInputs,
  TASK_WORKSPACE_INSTRUCTIONS,
} from "./references.ts";

const opts = { didMigrate: false, legacyDir: "/legacy", dataDir: "/data" };

function seed() {
  const db = new Database(":memory:");
  initSchema(db, opts);
  db.prepare("INSERT INTO hosts (id,name,target,kind,status) VALUES (1,'local','','local','online')").run();
  db.prepare("INSERT INTO hosts (id,name,target,kind,status) VALUES (2,'remote','dev@remote','ssh','online')").run();
  db.prepare(
    "INSERT INTO repos (id,host_id,name,git_url,default_branch,mirror_path,status) VALUES (1,1,'API Service','git@example/api','develop','/mirror/api.git','ready')",
  ).run();
  db.prepare(
    "INSERT INTO repos (id,host_id,name,git_url,default_branch,mirror_path,status) VALUES (2,2,'remote','git@example/remote','main','/remote/mirror.git','ready')",
  ).run();
  return db;
}

test("resolveReferenceInputs resolves only owner-local repository coordinates", () => {
  const result = resolveReferenceInputs(seed(), [{ repo_id: 1 }]);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.references[0].requested_ref, "develop");
  assert.equal(result.references[0].alias, "api-service");
  assert.equal(result.references[0].repo.mirror_path, "/mirror/api.git");
});

test("resolveReferenceInputs normalizes and de-duplicates aliases", () => {
  const result = resolveReferenceInputs(seed(), [
    { repo_id: 1, ref: "feature/contracts", alias: "API docs" },
    { repo_id: 1, ref: "develop", alias: "API docs" },
  ]);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.references.map((reference) => reference.alias), ["api-docs", "api-docs-2"]);
});

test("resolveReferenceInputs avoids aliases already attached to a running task", () => {
  const result = resolveReferenceInputs(seed(), [
    { repo_id: 1, ref: "develop", alias: "API docs" },
  ], ["api-docs", "api-docs-2"]);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.references[0].alias, "api-docs-3");
});

test("resolveReferenceInputs rejects remote-owned repositories and unsafe branch refspecs", () => {
  assert.deepEqual(resolveReferenceInputs(seed(), [{ repo_id: 2, ref: "main" }]), {
    ok: false,
    error: "reference repository 2 was not found on this node",
  });
  const unsafe = resolveReferenceInputs(seed(), [{ repo_id: 1, ref: "main:refs/heads/injected" }]);
  assert.equal(unsafe.ok, false);
  if (!unsafe.ok) assert.match(unsafe.error, /invalid reference branch/);
});

test("task-local and legacy reference roots stay explicitly distinguishable", () => {
  assert.equal(referenceRootPath("/data/worktrees/1-7"), "/data/worktrees/1-7/.tdsp/refs");
  assert.equal(legacyReferenceRootPath("/data", 7), "/data/worktrees/refs/7");
  assert.deepEqual(referenceRootPaths("/data", 7, "/data/worktrees/1-7"), [
    "/data/worktrees/1-7/.tdsp/refs",
    "/data/worktrees/refs/7",
  ]);
  assert.equal(pathIsInside("/data/worktrees/1-7", "/data/worktrees/1-7/.tdsp/refs/api"), true);
  assert.equal(pathIsInside("/data/worktrees/1-7", "/data/worktrees/refs/7/api"), false);
});

test("the persistent workspace instruction points agents at the dynamic alias manifest", () => {
  assert.match(TASK_WORKSPACE_INSTRUCTIONS, /\.tdsp\/refs\.json/);
  assert.match(TASK_WORKSPACE_INSTRUCTIONS, /exact alias first/);
  const kimi = kimiWorkspaceAgentContent();
  assert.match(kimi, /\$\{base_prompt\}/);
  assert.match(kimi, /Switchyard manages this task workspace/);
});

test("only legacy external Refs need an additional workspace root on Resume", () => {
  const db = seed();
  db.prepare(
    "INSERT INTO tasks (id,repo_id,base_branch,work_branch,title,worktree_path,session,status) " +
      "VALUES (7,1,'main','feat/7','task','/data/worktrees/1-7','tdsp-7','running')",
  ).run();
  const insert = db.prepare(
    "INSERT INTO task_references (task_id,repo_id,alias,requested_ref,resolved_commit,worktree_path) VALUES (7,1,?,?,?,?)",
  );
  insert.run("api", "main", "a".repeat(40), "/data/worktrees/1-7/.tdsp/refs/api");
  insert.run("old", "main", "b".repeat(40), "/data/worktrees/refs/7/old");
  const task = db.prepare("SELECT id,worktree_path FROM tasks WHERE id=7").get() as any;
  assert.deepEqual(externalReferenceWorktreePaths(db, task), ["/data/worktrees/refs/7/old"]);
});
