import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { initSchema } from "../core/schema.ts";
import { fleetTargets } from "./fleet.ts";

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
  assert.equal(targets[0].tdsp_bin, "/Users/phil/.task-dispatcher/bin/tdsp");
  assert.equal(targets[0].kind, "ssh");
  // local (no remote fetch) and C (no bin) are excluded
  assert.ok(!targets.some((t) => t.name === "local"));
  assert.ok(!targets.some((t) => t.name === "C"));
});
