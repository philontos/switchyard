import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { initSchema } from "./schema.ts";
import {
  clearProviderFromOwnedTasks,
  getOwnedRepo,
  getOwnedTask,
  legacyOwnershipReport,
  listOwnedRepos,
  listOwnedTasks,
} from "./ownership.ts";

const opts = { didMigrate: false, legacyDir: "/legacy", dataDir: "/data" };

function mixedOwnershipDb() {
  const db = new Database(":memory:");
  initSchema(db, opts);
  db.prepare("INSERT INTO hosts (id,name,target,kind,data_dir,status) VALUES (1,'A','','local','/a/data','online')").run();
  db.prepare("INSERT INTO hosts (id,name,target,kind,data_dir,status) VALUES (2,'B','dev@b','ssh','/b/data','online')").run();
  db.prepare("INSERT INTO repos (id,host_id,name,git_url,mirror_path,status) VALUES (11,1,'a-repo','a','/a/mirrors/11.git','ready')").run();
  db.prepare("INSERT INTO repos (id,host_id,name,git_url,mirror_path,status) VALUES (22,2,'b-repo','b','/b/mirrors/22.git','ready')").run();
  db.prepare(
    "INSERT INTO tasks (id,kind,repo_id,base_branch,work_branch,title,worktree_path,session,status) VALUES (101,'repo',11,'main','feat/a','A repo task','/a/wt','tdsp-a','running')",
  ).run();
  db.prepare(
    "INSERT INTO tasks (id,kind,repo_id,base_branch,work_branch,title,worktree_path,session,status) VALUES (202,'repo',22,'main','feat/b','B repo task','/b/wt','tdsp-b','running')",
  ).run();
  db.prepare(
    "INSERT INTO tasks (id,kind,host_id,repo_id,base_branch,work_branch,title,worktree_path,session,status,cwd) VALUES (103,'local',1,0,'','','A shell','','tdsp-a-shell','running','/a')",
  ).run();
  db.prepare(
    "INSERT INTO tasks (id,kind,host_id,repo_id,base_branch,work_branch,title,worktree_path,session,status,cwd) VALUES (204,'local',2,0,'','','B shell','','tdsp-b-shell','running','/b')",
  ).run();
  return db;
}

test("owner-local reads never mix another machine's repos or tasks", () => {
  const db = mixedOwnershipDb();
  assert.deepEqual(listOwnedRepos(db).map((repo) => repo.id), [11]);
  assert.deepEqual(listOwnedTasks(db).map((task) => task.id), [103, 101]);
  assert.equal(getOwnedRepo(db, 22), undefined);
  assert.equal(getOwnedTask(db, 202), undefined);
  assert.equal(getOwnedTask(db, 204), undefined);
});

test("legacy audit reports controller-owned remote rows without mutating them", () => {
  const db = mixedOwnershipDb();
  const before = (db.prepare("SELECT count(*) AS count FROM tasks").get() as { count: number }).count;
  const report = legacyOwnershipReport(db);
  assert.equal(report.local_host_id, 1);
  assert.deepEqual(report.remote_repos.map((repo) => repo.id), [22]);
  assert.deepEqual(report.remote_tasks.map((task) => task.id), [202, 204]);
  assert.deepEqual(report.remote_data_dirs.map((host) => host.host_id), [2]);
  assert.deepEqual(report.orphan_repos, []);
  assert.deepEqual(report.orphan_tasks, []);
  assert.equal((db.prepare("SELECT count(*) AS count FROM tasks").get() as { count: number }).count, before);
});

test("provider cleanup changes only this node's tasks", () => {
  const db = mixedOwnershipDb();
  db.prepare("UPDATE tasks SET provider_id=9").run();
  assert.equal(clearProviderFromOwnedTasks(db, 9), 2);
  assert.deepEqual(
    (db.prepare("SELECT id,provider_id FROM tasks ORDER BY id").all() as Array<{ id: number; provider_id: number | null }>),
    [
      { id: 101, provider_id: null },
      { id: 103, provider_id: null },
      { id: 202, provider_id: 9 },
      { id: 204, provider_id: 9 },
    ],
  );
});

test("legacy audit also exposes broken ownership references", () => {
  const db = mixedOwnershipDb();
  db.prepare("INSERT INTO repos (id,host_id,name,git_url,status) VALUES (33,999,'lost-repo','lost','ready')").run();
  db.prepare(
    "INSERT INTO tasks (id,kind,repo_id,base_branch,work_branch,title,worktree_path,session,status) " +
      "VALUES (303,'repo',999,'main','feat/lost','lost task','','tdsp-lost','cleaned')",
  ).run();
  db.prepare(
    "INSERT INTO tasks (id,kind,host_id,repo_id,base_branch,work_branch,title,worktree_path,session,status) " +
      "VALUES (304,'local',NULL,0,'','','ownerless shell','','tdsp-ownerless','cleaned')",
  ).run();

  const report = legacyOwnershipReport(db);
  assert.deepEqual(report.orphan_repos.map((repo) => repo.id), [33]);
  assert.deepEqual(report.orphan_tasks.map((task) => task.id), [303, 304]);
});
