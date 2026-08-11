import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { initSchema } from "../core/schema.ts";
import { addTaskReference, type AddTaskReferenceEnv } from "./addreference.ts";

const schemaOpts = { didMigrate: false, legacyDir: "/legacy", dataDir: "/data" };

function seed() {
  const db = new Database(":memory:");
  initSchema(db, schemaOpts);
  db.prepare("INSERT INTO hosts (id,name,target,kind,status) VALUES (1,'local','','local','online')").run();
  db.prepare(
    "INSERT INTO repos (id,host_id,name,git_url,default_branch,mirror_path,status) VALUES (1,1,'switchyard','git@x:sw','main','/data/mirrors/1-switchyard.git','ready')",
  ).run();
  db.prepare(
    "INSERT INTO repos (id,host_id,name,git_url,default_branch,mirror_path,status) VALUES (2,1,'frontend','git@x:fe','develop','/data/mirrors/2-frontend.git','ready')",
  ).run();
  db.prepare(
    "INSERT INTO tasks (id,kind,repo_id,base_branch,work_branch,title,worktree_path,session,status,agent) " +
      "VALUES (7,'repo',1,'main','feat/7-api','api','/data/worktrees/1-7','tdsp-x-7-api','running','claude')",
  ).run();
  return db;
}

function envFor(db: Database.Database) {
  const setup: any[] = [];
  const removed: any[] = [];
  const manifests: number[] = [];
  const env: AddTaskReferenceEnv = {
    db,
    exists: async () => true,
    setupReference: async (args) => {
      setup.push(args);
      return "a".repeat(40);
    },
    removeReference: async (...args) => { removed.push(args); },
    writeManifest: async (id) => { manifests.push(id); },
  };
  return { env, setup, removed, manifests };
}

test("addTaskReference materializes and manifests a task-local runtime reference without a session callback", async () => {
  const db = seed();
  const s = envFor(db);
  const result = await addTaskReference(s.env, 7, { repo_id: 2, ref: "develop", alias: "web" });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.load, "manifest");
  assert.equal(result.reference.alias, "web");
  assert.deepEqual(s.setup, [{
    mirror: "/data/mirrors/2-frontend.git",
    worktree: "/data/worktrees/1-7/.tdsp/refs/web",
    requestedRef: "develop",
  }]);
  const row = db.prepare("SELECT * FROM task_references WHERE task_id=7 AND alias='web'").get() as any;
  assert.equal(row.resolved_commit, "a".repeat(40));
  assert.deepEqual(s.manifests, [7]);
});

test("addTaskReference avoids an existing alias and returns duplicate repo/ref idempotently", async () => {
  const db = seed();
  db.prepare(
    "INSERT INTO task_references (task_id,repo_id,alias,requested_ref,resolved_commit,worktree_path) VALUES (7,2,'web','main',?,?)",
  ).run("b".repeat(40), "/data/worktrees/refs/7/web");
  const s = envFor(db);
  const added = await addTaskReference(s.env, 7, { repo_id: 2, ref: "develop", alias: "web" });
  assert.equal(added.ok, true);
  if (added.ok) assert.equal(added.reference.alias, "web-2");

  const duplicate = await addTaskReference(s.env, 7, { repo_id: 2, ref: "develop", alias: "anything" });
  assert.equal(duplicate.ok, true);
  if (duplicate.ok) {
    assert.equal(duplicate.existing, true);
    assert.equal(duplicate.load, "already");
    assert.equal(duplicate.reference.alias, "web-2");
  }
  assert.equal(s.setup.length, 1, "an idempotent retry does not create another worktree");
});

test("addTaskReference is valid even when the task session is not running", async () => {
  const db = seed();
  db.prepare("UPDATE tasks SET status='cleaned' WHERE id=7").run();
  const s = envFor(db);
  const result = await addTaskReference(s.env, 7, { repo_id: 2, ref: "develop" });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.load, "manifest");
  assert.equal((db.prepare("SELECT count(*) AS c FROM task_references WHERE task_id=7").get() as any).c, 1);
});

test("addTaskReference rejects the primary repo before touching Git", async () => {
  const db = seed();
  const s = envFor(db);
  const result = await addTaskReference(s.env, 7, { repo_id: 1, ref: "main" });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error, "invalidReference");
  assert.equal(s.setup.length, 0);
});

test("addTaskReference trusts atomic materialization cleanup and never deletes a competing destination", async () => {
  const db = seed();
  const s = envFor(db);
  s.env.setupReference = async () => { throw new Error("fetch failed"); };
  const result = await addTaskReference(s.env, 7, { repo_id: 2, ref: "develop", alias: "web" });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error, "materializeFailed");
  assert.deepEqual(s.removed, []);
  assert.equal((db.prepare("SELECT count(*) AS c FROM task_references").get() as any).c, 0);
});
