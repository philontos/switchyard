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

function setup(remoteBranches = ["main", "develop"], remoteDefault: string | null = "main") {
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
      if (args[0] === "ls-remote") return [
        ...(remoteDefault ? [`ref: refs/heads/${remoteDefault}\tHEAD`, `${"a".repeat(40)}\tHEAD`] : []),
        ...remoteBranches.map((branch) => `${"a".repeat(40)}\trefs/heads/${branch}`),
        "",
      ].join("\n");
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

test("registration detects master from remote HEAD and publishes the resolved default", async () => {
  const s = setup(["develop", "master"], "master");
  const snapshots: any[] = [];
  s.env.syncRepos = () => { snapshots.push(s.db.prepare("SELECT default_branch,status FROM repos").get()); };
  const result = await registerOwnedRepo(s.env, { name: "master-repo", git_url: "git@example/master", default_branch: "  " });
  assert.equal(result.ok, true);
  assert.deepEqual(snapshots.at(-1), { default_branch: "master", status: "ready" });
  assert.equal(s.calls.some((call) => call.args[0] === "fetch"), false, "registration does not fetch objects");
});

test("registration preserves an explicit existing branch instead of replacing it with remote HEAD", async () => {
  const s = setup();
  const result = await registerOwnedRepo(s.env, { name: "release", git_url: "git@example/release", default_branch: " develop " });
  assert.equal(result.ok, true);
  assert.deepEqual(s.db.prepare("SELECT default_branch,status FROM repos").get(), { default_branch: "develop", status: "ready" });
});

test("registration rejects a missing explicit branch and can retry with automatic detection", async () => {
  const s = setup(["master"], "master");
  const input = { name: "master-repo", git_url: "git@example/master" };
  const result = await registerOwnedRepo(s.env, { ...input, default_branch: "main" });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.message || "", /Branch "main" does not exist on origin/);
  assert.deepEqual(s.db.prepare("SELECT default_branch,status FROM repos").get(), { default_branch: "main", status: "error" });

  const retry = await registerOwnedRepo(s.env, input);
  assert.equal(retry.ok, true);
  if (retry.ok) assert.equal(retry.retrying, true);
  assert.deepEqual(s.db.prepare("SELECT default_branch,status,error FROM repos").all(), [
    { default_branch: "master", status: "ready", error: null },
  ]);
});

test("registration requires a selection when remote HEAD is unavailable and multiple branches exist", async () => {
  const s = setup(["develop", "master"], null);
  const result = await registerOwnedRepo(s.env, { name: "ambiguous", git_url: "git@example/ambiguous" });
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.message || "", /specify an existing branch/);
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

test("repo deletion accounts for live tasks that reference the repository", async () => {
  const s = setup();
  s.db.prepare(
    "INSERT INTO repos (id,host_id,name,git_url,mirror_path,status) VALUES (10,1,'primary','git@example/primary','/mirror/primary.git','ready')",
  ).run();
  s.db.prepare(
    "INSERT INTO repos (id,host_id,name,git_url,mirror_path,status) VALUES (11,1,'api','git@example/api','/mirror/api.git','ready')",
  ).run();
  s.db.prepare(
    "INSERT INTO tasks (id,repo_id,base_branch,work_branch,title,worktree_path,session,status) " +
      "VALUES (7,10,'main','feat/7','task','/wt/7','tdsp-7','running')",
  ).run();
  s.db.prepare(
    "INSERT INTO task_references (task_id,repo_id,alias,requested_ref,resolved_commit,worktree_path) " +
      "VALUES (7,11,'api','develop',?, '/wt/refs/7/api')",
  ).run("a".repeat(40));
  const manifested: number[] = [];
  const roots: Array<[number, string]> = [];
  s.env.syncTaskManifest = (id) => { manifested.push(id); };
  s.env.removeReferenceRoots = async (id, worktree) => { roots.push([id, worktree]); };

  assert.deepEqual(await deleteOwnedRepo(s.env, 11), {
    ok: false,
    error: "hasLiveTasks",
    liveCount: 1,
  });
  assert.ok(s.db.prepare("SELECT id FROM repos WHERE id=11").get());

  assert.equal((await deleteOwnedRepo(s.env, 11, true)).ok, true);
  assert.ok(s.db.prepare("SELECT id FROM tasks WHERE id=7").get(), "the primary task survives a forced reference removal");
  assert.equal(s.db.prepare("SELECT 1 FROM task_references WHERE task_id=7").get(), undefined);
  assert.deepEqual(manifested, [7]);
  assert.deepEqual(roots, [[7, "/wt/7"]]);
  assert.ok(s.calls.some((call) => call.cwd === "/mirror/api.git" && call.args.slice(0, 3).join(" ") === "worktree remove --force"));
});
