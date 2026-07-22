import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { initSchema } from "../core/schema.ts";
import type { Runner } from "../fleet/runner.ts";
import {
  branchesForOwnedRepo,
  deleteOwnedRepo,
  fetchOwnedRepo,
  registerOwnedRepo,
  type OwnedRepoEnv,
} from "./owned.ts";

const opts = { didMigrate: false, legacyDir: "/legacy", dataDir: "/data" };

function setup() {
  const db = new Database(":memory:");
  initSchema(db, opts);
  db.prepare("INSERT INTO hosts (id,name,target,kind,status) VALUES (1,'A','','local','online')").run();
  db.prepare("INSERT INTO hosts (id,name,target,kind,status) VALUES (2,'B','dev@b','ssh','online')").run();
  const calls: Array<{ file: string; args: string[]; cwd?: string }> = [];
  const paths = new Set<string>();
  const runner: Runner = {
    kind: "local",
    dataDir: "/data",
    exec: async (file, args, execOpts = {}) => {
      calls.push({ file, args, cwd: execOpts.cwd });
      if (args[0] === "ls-remote") return `${"a".repeat(40)}\trefs/heads/main\n${"b".repeat(40)}\trefs/heads/develop\n`;
      return "";
    },
    mkdirp: async () => {},
    exists: async (target) => paths.has(target),
    readText: async () => null,
    rmrf: async (target) => { paths.delete(target); },
    putDir: async () => {},
    putFile: async () => {},
  };
  let syncs = 0;
  const env: OwnedRepoEnv = {
    db,
    runner,
    syncRepos: () => { syncs++; },
    removeTaskManifest: () => {},
    killSession: async () => {},
  };
  return { db, env, calls, paths, get syncs() { return syncs; } };
}

test("repo CRUD executes on the owner and keeps the catalog owner-local", async () => {
  const s = setup();
  const created = await registerOwnedRepo(s.env, { name: "switchyard", git_url: "git@example/switchyard" });
  assert.equal(created.ok, true);
  if (!created.ok) return;
  const row = s.db.prepare("SELECT host_id,mirror_path,status FROM repos WHERE id=?").get(created.id) as any;
  assert.equal(row.host_id, 1);
  assert.equal(row.mirror_path, `/data/mirrors/${created.id}-switchyard.git`);
  assert.equal(row.status, "ready");
  assert.ok(s.calls.some((call) => call.args[0] === "init" && call.args[1] === "--bare"));

  const branches = await branchesForOwnedRepo(s.env, created.id);
  assert.deepEqual(branches, { ok: true, branches: ["main", "develop"] });
  assert.equal((await fetchOwnedRepo(s.env, created.id)).ok, true);
  assert.equal((await deleteOwnedRepo(s.env, created.id)).ok, true);
  assert.equal(s.db.prepare("SELECT id FROM repos WHERE id=?").get(created.id), undefined);
  assert.ok(s.syncs >= 3);
});

test("owner repo service refuses a repo row assigned to another machine", async () => {
  const s = setup();
  s.db.prepare("INSERT INTO repos (id,host_id,name,git_url,mirror_path,status) VALUES (22,2,'remote','remote','/remote/22.git','ready')").run();
  assert.deepEqual(await fetchOwnedRepo(s.env, 22), { ok: false, error: "notFound" });
  assert.deepEqual(await branchesForOwnedRepo(s.env, 22), { ok: false, error: "notFound" });
  assert.deepEqual(await deleteOwnedRepo(s.env, 22), { ok: false, error: "notFound" });
  assert.equal(s.calls.length, 0, "no git/filesystem operation runs for a remote-owned row");
});

test("owner repo service refuses a RemoteRunner even for a local row", async () => {
  const s = setup();
  (s.env.runner as any).kind = "ssh";
  const result = await registerOwnedRepo(s.env, { name: "wrong-side", git_url: "git@example/wrong" });
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.message || "", /owning node/);
  assert.equal(s.db.prepare("SELECT id FROM repos").all().length, 0);
  assert.equal(s.calls.length, 0);
});
