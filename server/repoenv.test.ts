import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { initSchema } from "./schema.ts";
import { repoFindOrCreate } from "./repoenv.ts";

const opts = { didMigrate: false, legacyDir: "/legacy", dataDir: "/data" };

function seed() {
  const db = new Database(":memory:");
  initSchema(db, opts);
  db.prepare("INSERT INTO hosts (id,name,target,kind,status) VALUES (1,'local','','local','online')").run();
  return db;
}

// When A dispatches a repo task to a node, the node registers the repo on itself
// (so it owns + can display the task) keyed by the mirror path — idempotent, so
// repeated dispatches of the same repo reuse the one row.
test("repoFindOrCreate inserts a repo on first dispatch, owned by the local host", () => {
  const db = seed();
  const r = repoFindOrCreate(db, { mirror: "/data/mirrors/5-sw.git", name: "sw", git_url: "git@x:sw" });
  assert.equal(typeof r.id, "number");
  assert.equal(r.name, "sw");
  assert.equal(r.mirror_path, "/data/mirrors/5-sw.git");
  const row = db.prepare("SELECT host_id, status FROM repos WHERE id=?").get(r.id) as { host_id: number; status: string };
  assert.equal(row.host_id, 1, "the node's own local host owns the repo");
  assert.equal(row.status, "ready");
});

test("repoFindOrCreate is idempotent — same mirror path reuses the existing row", () => {
  const db = seed();
  const a = repoFindOrCreate(db, { mirror: "/data/mirrors/5-sw.git", name: "sw", git_url: "git@x:sw" });
  const b = repoFindOrCreate(db, { mirror: "/data/mirrors/5-sw.git", name: "sw", git_url: "git@x:sw" });
  assert.equal(a.id, b.id);
  assert.equal((db.prepare("SELECT count(*) c FROM repos").get() as { c: number }).c, 1);
});

test("repoFindOrCreate keeps distinct repos distinct (different mirror paths)", () => {
  const db = seed();
  const a = repoFindOrCreate(db, { mirror: "/data/mirrors/5-sw.git", name: "sw", git_url: "u1" });
  const b = repoFindOrCreate(db, { mirror: "/data/mirrors/6-ug.git", name: "ug", git_url: "u2" });
  assert.notEqual(a.id, b.id);
  assert.equal((db.prepare("SELECT count(*) c FROM repos").get() as { c: number }).c, 2);
});
