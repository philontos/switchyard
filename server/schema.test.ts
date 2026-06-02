import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { initSchema, runPathMigration } from "./schema.ts";

const opts = (didMigrate: boolean) => ({ didMigrate, legacyDir: "/legacy", dataDir: "/data" });

// The reported boot crash: an old DB whose `tasks` table predates the
// worktree_path column. initSchema must backfill it instead of throwing
// "no such column: worktree_path".
test("initSchema backfills worktree_path onto an old tasks table (regression)", () => {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE repos (id INTEGER PRIMARY KEY, name TEXT, mirror_path TEXT)");
  db.exec("CREATE TABLE tasks (id INTEGER PRIMARY KEY, repo_id INTEGER, title TEXT)");
  db.prepare("INSERT INTO tasks (repo_id, title) VALUES (1, 'old')").run();

  assert.doesNotThrow(() => initSchema(db, opts(false)));
  const cols = (db.prepare("PRAGMA table_info(tasks)").all() as { name: string }[]).map((c) => c.name);
  assert.ok(cols.includes("worktree_path"), "worktree_path should be backfilled");
  assert.equal(
    (db.prepare("SELECT worktree_path FROM tasks WHERE id=1").get() as { worktree_path: string }).worktree_path,
    "",
  );
});

test("initSchema on a fresh DB has worktree_path and the newer columns", () => {
  const db = new Database(":memory:");
  initSchema(db, opts(false));
  const cols = (db.prepare("PRAGMA table_info(tasks)").all() as { name: string }[]).map((c) => c.name);
  for (const c of ["worktree_path", "kind", "host_id", "cwd"]) assert.ok(cols.includes(c), `missing ${c}`);
});

test("path migration runs only when didMigrate is true", () => {
  const seed = (db: Database.Database) =>
    db.prepare(
      "INSERT INTO tasks (repo_id, base_branch, work_branch, title, worktree_path, session) VALUES (1,'m','f','t',?, 's')",
    ).run("/legacy/wt/x");
  const wt = (db: Database.Database) =>
    (db.prepare("SELECT worktree_path FROM tasks WHERE id=1").get() as { worktree_path: string }).worktree_path;

  // didMigrate=false → stored legacy path left untouched
  const skip = new Database(":memory:");
  initSchema(skip, opts(false));
  seed(skip);
  initSchema(skip, opts(false));
  assert.equal(wt(skip), "/legacy/wt/x");

  // explicit migration → prefix rewritten to the new data dir
  const mig = new Database(":memory:");
  initSchema(mig, opts(false));
  seed(mig);
  runPathMigration(mig, "/legacy", "/data");
  assert.equal(wt(mig), "/data/wt/x");
});
