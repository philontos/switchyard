import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { initSchema } from "../core/schema.ts";
import { renameTask } from "./tasks.ts";

const opts = { didMigrate: false, legacyDir: "/legacy", dataDir: "/data" };

// fresh in-memory DB with the schema + one seeded task (id 1, title "old")
function seed() {
  const db = new Database(":memory:");
  initSchema(db, opts);
  db.prepare("INSERT INTO hosts (id,name,target,kind,status) VALUES (1,'local','','local','online')").run();
  db.prepare("INSERT INTO repos (id,host_id,name,git_url,status) VALUES (1,1,'repo','git@example/repo','ready')").run();
  db.prepare(
    "INSERT INTO tasks (repo_id, base_branch, work_branch, title, worktree_path, session) VALUES (1,'m','feat/1-old','old','/wt/x','tdsp-1-r-old')",
  ).run();
  return db;
}

const title = (db: Database.Database) =>
  (db.prepare("SELECT title FROM tasks WHERE id=1").get() as { title: string }).title;

test("renameTask updates only the title, leaving session & branch untouched", () => {
  const db = seed();
  const r = renameTask(db, 1, "new name");
  assert.deepEqual(r, { ok: true, title: "new name" });
  assert.equal(title(db), "new name");
  const row = db.prepare("SELECT session, work_branch FROM tasks WHERE id=1").get() as {
    session: string;
    work_branch: string;
  };
  assert.equal(row.session, "tdsp-1-r-old", "session must not change");
  assert.equal(row.work_branch, "feat/1-old", "work_branch must not change");
});

test("renameTask trims surrounding whitespace", () => {
  const db = seed();
  const r = renameTask(db, 1, "  spaced  ");
  assert.deepEqual(r, { ok: true, title: "spaced" });
  assert.equal(title(db), "spaced");
});

test("renameTask rejects an empty/whitespace title and leaves the row unchanged", () => {
  const db = seed();
  assert.deepEqual(renameTask(db, 1, "   "), { error: "empty" });
  assert.deepEqual(renameTask(db, 1, ""), { error: "empty" });
  assert.equal(title(db), "old", "title must be unchanged after a rejected rename");
});

test("renameTask reports notFound for a missing task id", () => {
  const db = seed();
  assert.deepEqual(renameTask(db, 999, "whatever"), { error: "notFound" });
});

test("renameTask cannot mutate a historical task owned by another node", () => {
  const db = seed();
  db.prepare("INSERT INTO hosts (id,name,target,kind,status) VALUES (2,'B','dev@b','ssh','online')").run();
  db.prepare("INSERT INTO repos (id,host_id,name,git_url,status) VALUES (2,2,'remote','git@example/remote','ready')").run();
  db.prepare(
    "INSERT INTO tasks (id,repo_id,base_branch,work_branch,title,worktree_path,session) " +
      "VALUES (2,2,'main','feat/2','remote title','/b/wt','tdsp-b-2')",
  ).run();
  assert.deepEqual(renameTask(db, 2, "changed by A"), { error: "notFound" });
  assert.equal((db.prepare("SELECT title FROM tasks WHERE id=2").get() as { title: string }).title, "remote title");
});
