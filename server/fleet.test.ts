import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { initSchema } from "./schema.ts";
import { fleetTargets, tasksForHost } from "./fleet.ts";

const opts = { didMigrate: false, legacyDir: "/legacy", dataDir: "/data" };

function seed() {
  const db = new Database(":memory:");
  initSchema(db, opts);
  // host 1 = local, 2 = B (bootstrapped), 3 = C (not bootstrapped yet)
  db.prepare("INSERT INTO hosts (id,name,target,kind,status,tdsp_bin) VALUES (1,'local','','local','online',NULL)").run();
  db.prepare("INSERT INTO hosts (id,name,target,kind,status,tdsp_bin) VALUES (2,'B','phil@b','ssh','online','/Users/phil/.task-dispatcher/bin/tdsp')").run();
  db.prepare("INSERT INTO hosts (id,name,target,kind,status,tdsp_bin) VALUES (3,'C','me@c','ssh','online',NULL)").run();
  return db;
}

test("fleetTargets keeps only remote hosts that have been bootstrapped (have a tdsp_bin)", () => {
  const db = seed();
  const hosts = db.prepare("SELECT * FROM hosts").all() as any[];
  const targets = fleetTargets(hosts);
  assert.equal(targets.length, 1);
  assert.equal(targets[0].name, "B");
  assert.equal(targets[0].target, "phil@b");
  assert.equal(targets[0].bin, "/Users/phil/.task-dispatcher/bin/tdsp");
  // local (no remote fetch) and C (no bin) are excluded
  assert.ok(!targets.some((t) => t.name === "local"));
  assert.ok(!targets.some((t) => t.name === "C"));
});

test("tasksForHost returns a host's local-kind tasks", () => {
  const db = seed();
  db.prepare(
    "INSERT INTO tasks (kind,host_id,repo_id,base_branch,work_branch,title,worktree_path,session,status) VALUES ('local',1,0,'','','shell on local','','tdsp-x-1','running')",
  ).run();
  db.prepare(
    "INSERT INTO tasks (kind,host_id,repo_id,base_branch,work_branch,title,worktree_path,session,status) VALUES ('local',2,0,'','','shell on B','','tdsp-x-2','running')",
  ).run();
  const local = tasksForHost(db, 1);
  assert.equal(local.length, 1);
  assert.equal(local[0].title, "shell on local");
});

test("tasksForHost returns repo tasks whose repo lives on the host (host_id via repo)", () => {
  const db = seed();
  db.prepare("INSERT INTO repos (id,host_id,name,git_url) VALUES (7,2,'switchyard','u')").run();
  db.prepare(
    "INSERT INTO tasks (kind,host_id,repo_id,base_branch,work_branch,title,worktree_path,session,status) VALUES ('repo',NULL,7,'m','feat/1','repo task on B','/wt','tdsp-x-3','running')",
  ).run();
  const onB = tasksForHost(db, 2);
  assert.equal(onB.length, 1);
  assert.equal(onB[0].title, "repo task on B");
  // host 1 (local) must not see B's repo task
  assert.equal(tasksForHost(db, 1).length, 0);
});
