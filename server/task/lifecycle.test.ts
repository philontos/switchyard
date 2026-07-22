import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { initSchema } from "../core/schema.ts";
import { cleanupTask, deleteTaskRecord, resumeTask } from "./lifecycle.ts";

const opts = { didMigrate: false, legacyDir: "/legacy", dataDir: "/data" };

function seed() {
  const db = new Database(":memory:");
  initSchema(db, opts);
  db.prepare("INSERT INTO hosts (id,name,target,kind,status) VALUES (1,'local','','local','online')").run();
  db.prepare(
    "INSERT INTO repos (id,host_id,name,git_url,mirror_path,status) VALUES (1,1,'repo','git@example/repo','/mirror/repo.git','ready')",
  ).run();
  db.prepare(
    "INSERT INTO tasks (id,repo_id,base_branch,work_branch,title,worktree_path,session,status) " +
      "VALUES (7,1,'main','feat/7','task','/wt/7','tdsp-7','cleaned')",
  ).run();
  return db;
}

test("resumeTask relaunches a dead archived task and marks it running", async () => {
  const db = seed();
  const started: number[] = [];
  const manifested: number[] = [];
  const result = await resumeTask(
    {
      db,
      exists: async (path) => path === "/wt/7",
      hasSession: async () => false,
      startSession: async (task) => { started.push(task.id); },
      writeManifest: (id) => { manifested.push(id); },
    },
    7,
  );

  assert.deepEqual(result, { ok: true, alreadyAlive: false });
  assert.deepEqual(started, [7]);
  assert.deepEqual(manifested, [7]);
  assert.equal((db.prepare("SELECT status FROM tasks WHERE id=7").get() as any).status, "running");
});

test("resumeTask refuses a task whose retained worktree is gone", async () => {
  const db = seed();
  const result = await resumeTask(
    {
      db,
      exists: async () => false,
      hasSession: async () => false,
      startSession: async () => { throw new Error("must not start"); },
      writeManifest: () => {},
    },
    7,
  );
  assert.deepEqual(result, { ok: false, error: "worktreeGone" });
});

test("cleanupTask removes the worktree and persists the cleaned task", async () => {
  const db = seed();
  const killed: string[] = [];
  const removed: string[][] = [];
  const manifested: number[] = [];
  const result = await cleanupTask(
    {
      db,
      killSession: async (session) => { killed.push(session); },
      removeWorktree: async (...args) => { removed.push(args); },
      writeManifest: (id) => { manifested.push(id); },
    },
    7,
  );

  assert.deepEqual(result, { ok: true });
  assert.deepEqual(killed, ["tdsp-7"]);
  assert.deepEqual(removed, [["/mirror/repo.git", "/wt/7", "feat/7"]]);
  assert.deepEqual(manifested, [7]);
});

test("deleteTaskRecord refuses a retained worktree, then deletes after cleanup", async () => {
  const db = seed();
  const manifests: number[] = [];
  const retained = await deleteTaskRecord(
    { db, exists: async () => true, removeManifest: (id) => { manifests.push(id); } },
    7,
  );
  assert.deepEqual(retained, { ok: false, error: "worktreeExists" });
  assert.ok(db.prepare("SELECT id FROM tasks WHERE id=7").get());

  const deleted = await deleteTaskRecord(
    { db, exists: async () => false, removeManifest: (id) => { manifests.push(id); } },
    7,
  );
  assert.deepEqual(deleted, { ok: true });
  assert.equal(db.prepare("SELECT id FROM tasks WHERE id=7").get(), undefined);
  assert.deepEqual(manifests, [7]);
});

test("deleteTaskRecord leaves historical remote rows and manifests untouched", async () => {
  const db = seed();
  db.prepare("INSERT INTO hosts (id,name,target,kind,status) VALUES (2,'B','dev@b','ssh','online')").run();
  db.prepare("INSERT INTO repos (id,host_id,name,git_url,mirror_path,status) VALUES (2,2,'remote','git@example/remote','/b/mirror','ready')").run();
  db.prepare(
    "INSERT INTO tasks (id,repo_id,base_branch,work_branch,title,worktree_path,session,status) " +
      "VALUES (8,2,'main','feat/8','remote','/b/wt/8','tdsp-b-8','cleaned')",
  ).run();
  const removed: number[] = [];
  const result = await deleteTaskRecord(
    { db, exists: async () => false, removeManifest: (id) => { removed.push(id); } },
    8,
  );
  assert.deepEqual(result, { ok: false, error: "notFound" });
  assert.ok(db.prepare("SELECT id FROM tasks WHERE id=8").get());
  assert.deepEqual(removed, []);
});
