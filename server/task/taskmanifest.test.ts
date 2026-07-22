import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { initSchema } from "../core/schema.ts";
import type { Task } from "../core/db.ts";
import {
  taskManifest,
  writeTaskManifest,
  readTaskManifests,
  adoptTaskManifests,
} from "./taskmanifest.ts";

const opts = { didMigrate: false, legacyDir: "/legacy", dataDir: "/data" };

function seedDb() {
  const db = new Database(":memory:");
  initSchema(db, opts);
  db.prepare("INSERT INTO hosts (id,name,target,kind,status) VALUES (1,'local','','local','online')").run();
  db.prepare("INSERT INTO repos (id,host_id,name,git_url,status) VALUES (1,1,'repo','git@example/repo','ready')").run();
  return db;
}

function insertTask(db: Database.Database, title: string): Task {
  const info = db
    .prepare(
      "INSERT INTO tasks (repo_id, base_branch, base_commit, work_branch, title, prompt, worktree_path, session, status) VALUES (1,'m',?,?,?, ?, '/wt/x', ?, 'running')",
    )
    .run("a".repeat(40), `feat/x-${title}`, title, `prompt for ${title}`, `tdsp-1-r-${title}`);
  return db.prepare("SELECT * FROM tasks WHERE id=?").get(Number(info.lastInsertRowid)) as Task;
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "tdsp-tm-"));
}

test("taskManifest wraps a task row in a versioned envelope", () => {
  const db = seedDb();
  const task = insertTask(db, "alpha");
  const m = taskManifest(task);
  assert.equal(m.schema_version, 1);
  assert.equal(m.task.title, "alpha");
  assert.equal(m.task.session, "tdsp-1-r-alpha");
});

test("writeTaskManifest then readTaskManifests round-trips the task as edge-resident truth", () => {
  const db = seedDb();
  const task = insertTask(db, "beta");
  const dir = tmpDir();
  try {
    writeTaskManifest(dir, task);
    // co-located under <dataDir>/tasks/<id>/task.json
    assert.ok(fs.existsSync(path.join(dir, "tasks", String(task.id), "task.json")));
    const all = readTaskManifests(dir);
    assert.equal(all.length, 1);
    assert.equal(all[0].task.title, "beta");
    assert.equal(all[0].task.base_commit, "a".repeat(40));
    assert.equal(all[0].schema_version, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("readTaskManifests returns [] when no tasks dir exists yet", () => {
  const dir = tmpDir();
  try {
    assert.deepEqual(readTaskManifests(dir), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("adoptTaskManifests inserts a manifest the DB doesn't have (sit-down-and-see)", () => {
  const db = seedDb();
  const other = seedDb();
  const task = insertTask(other, "gamma"); // a task that lives only as a manifest here
  const adopted = adoptTaskManifests(db, [taskManifest(task)]);
  assert.equal(adopted, 1);
  const row = db.prepare("SELECT title, session, base_commit FROM tasks WHERE id=?").get(task.id) as {
    title: string;
    session: string;
    base_commit: string | null;
  };
  assert.equal(row.title, "gamma");
  assert.equal(row.session, "tdsp-1-r-gamma");
  assert.equal(row.base_commit, "a".repeat(40));
});

test("adoptTaskManifests skips a task the DB already owns (no duplicate, no clobber)", () => {
  const db = seedDb();
  const task = insertTask(db, "delta");
  const m = taskManifest({ ...task, title: "STALE" });
  const adopted = adoptTaskManifests(db, [m]);
  assert.equal(adopted, 0);
  const title = (db.prepare("SELECT title FROM tasks WHERE id=?").get(task.id) as { title: string }).title;
  assert.equal(title, "delta", "an existing row must not be overwritten by adopt");
});

test("adoptTaskManifests refuses manifests explicitly owned by another node", () => {
  const db = seedDb();
  db.prepare("INSERT INTO hosts (id,name,target,kind,status) VALUES (2,'remote','dev@remote','ssh','online')").run();
  db.prepare("INSERT INTO repos (id,host_id,name,git_url,status) VALUES (2,2,'remote-repo','git@example/remote','ready')").run();

  const remoteShell = taskManifest({ ...insertTask(db, "shell-seed"), id: 100, kind: "local", host_id: 2, repo_id: 0 });
  const remoteRepoTask = taskManifest({ ...insertTask(db, "repo-seed"), id: 101, kind: "repo", host_id: null, repo_id: 2 });
  assert.equal(adoptTaskManifests(db, [remoteShell, remoteRepoTask]), 0);
  assert.equal(db.prepare("SELECT id FROM tasks WHERE id IN (100,101)").all().length, 0);
});

test("adoptTaskManifests does not mutate a legacy manifest while defaulting its owner", () => {
  const db = seedDb();
  const task = { ...insertTask(db, "legacy-shell"), id: 102, kind: "local", host_id: null, repo_id: 0 };
  db.prepare("DELETE FROM tasks WHERE id=?").run(task.id);
  const manifest = taskManifest(task);
  assert.equal(adoptTaskManifests(db, [manifest]), 1);
  assert.equal(manifest.task.host_id, null);
  assert.equal((db.prepare("SELECT host_id FROM tasks WHERE id=102").get() as { host_id: number }).host_id, 1);
});
