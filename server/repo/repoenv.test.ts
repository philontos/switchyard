import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import Database from "better-sqlite3";
import { initSchema } from "../core/schema.ts";
import { repoFindOrCreate, buildRepoTaskEnv } from "./repoenv.ts";
import type { Runner } from "../fleet/runner.ts";

const opts = { didMigrate: false, legacyDir: "/legacy", dataDir: "/data" };

// A Runner double that records every putDir (skill delivery + the hooks overlay
// both go through putDir) and swallows exec (the git worktree commands). This
// lets us assert exactly which .claude/* injections happened per agent.
function recordingRunner() {
  const putDirs: { src: string; dest: string }[] = [];
  const runner = {
    kind: "local", dataDir: "/tmp",
    exec: async () => "",
    mkdirp: async () => {}, exists: async () => false, readText: async () => null,
    rmrf: async () => {}, putFile: async () => {},
    putDir: async (src: string, dest: string) => { putDirs.push({ src, dest }); },
    ptySpec: (file: string, args: string[]) => ({ file, args }),
  } as unknown as Runner;
  return { runner, putDirs };
}

function setupWith(agent: "claude" | "codex", putDirs: { src: string; dest: string }[], runner: Runner) {
  const db = new Database(":memory:");
  initSchema(db, opts);
  const env = buildRepoTaskEnv({ db, ns: "ns", runner, writeManifest: () => {} });
  return env.setupWorktree({
    id: 1, mirror: "/m", worktree: "/wt", workBranch: "feat/1-x", baseBranch: "main",
    skills: [{ key: "d:tdd", name: "tdd", dir: "/skills/tdd" }], agent,
  } as any);
}

// claude keeps its .claude/ conventions: the skill dir is delivered and the
// waiting-hook overlay is injected. (Regression guard for existing behavior.)
test("setupWorktree (claude) delivers skills and injects the .claude hooks overlay", async () => {
  const { runner, putDirs } = recordingRunner();
  await setupWith("claude", putDirs, runner);
  assert.ok(putDirs.some((p) => p.dest === path.join("/wt", ".claude", "skills", "tdd")), "skill delivered");
  assert.ok(putDirs.some((p) => p.dest === path.join("/wt", ".claude")), "hooks overlay delivered");
});

// codex has no .claude/skills and no hook mechanism, so neither injection runs —
// zero putDir calls. Its full-auto launch is why it needs no waiting-hook.
test("setupWorktree (codex) skips skills and hooks — no .claude injection at all", async () => {
  const { runner, putDirs } = recordingRunner();
  await setupWith("codex", putDirs, runner);
  assert.equal(putDirs.length, 0, "codex delivers no skills and injects no hooks");
});

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
