import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { initSchema } from "./schema.ts";
import { writeTaskManifest } from "./taskmanifest.ts";
import type { Task } from "./db.ts";
import {
  createLocalTask,
  createRepoTask,
  type LocalTaskEnv,
  type RepoTaskEnv,
  type RepoRef,
} from "./createtask.ts";

const opts = { didMigrate: false, legacyDir: "/legacy", dataDir: "/data" };

function makeEnv(overrides: Partial<LocalTaskEnv> = {}) {
  const db = new Database(":memory:");
  initSchema(db, opts);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tdsp-ct-"));
  const started: { session: string; cwd: string }[] = [];
  const env: LocalTaskEnv = {
    db,
    home: "/Users/phil",
    ns: "abcd1234",
    dataDir: dir,
    cwdExists: async () => true,
    startShell: async (session, cwd) => {
      started.push({ session, cwd });
    },
    ...overrides,
  };
  return { env, started, dir, db };
}

test("createLocalTask inserts a running local task, starts a shell, and writes its manifest", async () => {
  const { env, started, dir, db } = makeEnv();
  try {
    const r = await createLocalTask(env, { cwd: "~/work", title: "debug B" });
    assert.equal(r.ok, true);
    if (!r.ok) return;

    const row = db.prepare("SELECT * FROM tasks WHERE id=?").get(r.id) as any;
    assert.equal(row.kind, "local");
    assert.equal(row.status, "running");
    assert.equal(row.cwd, "/Users/phil/work", "~ expands against the machine's home");
    assert.equal(row.title, "debug B");

    assert.equal(started.length, 1, "the shell session is started exactly once");
    assert.equal(started[0].cwd, "/Users/phil/work");
    assert.match(started[0].session, /^tdsp-abcd1234-\d+-local-/, "session carries this node's ns");

    // the manifest IS the edge-resident truth — written on the machine it runs on
    const m = JSON.parse(fs.readFileSync(path.join(dir, "tasks", String(r.id), "task.json"), "utf8"));
    assert.equal(m.task.title, "debug B");
    assert.equal(m.task.session, started[0].session);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("createLocalTask defaults a blank title to 'Local task #<id>'", async () => {
  const { env, dir, db } = makeEnv();
  try {
    const r = await createLocalTask(env, { cwd: "/tmp", title: "" });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    const title = (db.prepare("SELECT title FROM tasks WHERE id=?").get(r.id) as { title: string }).title;
    assert.equal(title, `Local task #${r.id}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("createLocalTask rejects a missing cwd and leaves no row behind", async () => {
  const { env, started, dir, db } = makeEnv({ cwdExists: async () => false });
  try {
    const r = await createLocalTask(env, { cwd: "/nope" });
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.error, "cwdMissing");
    assert.equal((db.prepare("SELECT count(*) c FROM tasks").get() as { c: number }).c, 0);
    assert.equal(started.length, 0, "no shell is started for a rejected task");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("createLocalTask marks the task errored (and manifests it) when the shell fails to start", async () => {
  const { env, dir, db } = makeEnv({
    startShell: async () => {
      throw new Error("tmux: boom");
    },
  });
  try {
    const r = await createLocalTask(env, { cwd: "/tmp", title: "willfail" });
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.error, "startFailed");
    const row = db.prepare("SELECT status, error FROM tasks WHERE title='willfail'").get() as {
      status: string;
      error: string;
    };
    assert.equal(row.status, "error");
    assert.match(row.error, /boom/);
    // a failed task still gets a manifest so the node owns the record of the failure
    const id = (db.prepare("SELECT id FROM tasks WHERE title='willfail'").get() as { id: number }).id;
    assert.ok(fs.existsSync(path.join(dir, "tasks", String(id), "task.json")));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- createRepoTask ----------
// The repo-task orchestration sinks to the owner: worktree+skills+hooks+session
// are prepared locally and the manifest is the record. The mechanical steps are
// grouped behind setupWorktree (the prod env fills in the real git/putDir/exclude
// /hooks); the core owns ordering, naming, opening-message, cleanup and manifest.
const REPO: RepoRef = { id: 4, name: "switchyard", mirror_path: "/data/mirrors/4-switchyard.git" };

function makeRepoEnv(overrides: Partial<RepoTaskEnv> = {}) {
  const db = new Database(":memory:");
  initSchema(db, opts);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tdsp-cr-"));
  const calls: string[] = [];
  let setupArgs: any = null;
  const env: RepoTaskEnv = {
    db,
    ns: "abcd1234",
    writeManifest: (id) => writeTaskManifest(dir, db.prepare("SELECT * FROM tasks WHERE id=?").get(id) as Task),
    resolveSkills: (keys) => ({ found: keys.map((k) => ({ key: k, name: k.split(":").pop()!, dir: `/skills/${k}` })), missing: [] }),
    setupWorktree: async (a) => {
      calls.push("setup");
      setupArgs = a;
    },
    startSession: async (_session, _worktree, opening) => {
      calls.push(`start:${opening ?? "∅"}`);
    },
    removeWorktree: async () => {
      calls.push("remove");
    },
    ...overrides,
  };
  return { env, dir, db, calls, getSetup: () => setupArgs };
}

test("createRepoTask inserts a running task, prepares the worktree, starts the session, writes manifest", async () => {
  const { env, dir, db, calls, getSetup } = makeRepoEnv();
  try {
    const r = await createRepoTask(env, REPO, { baseBranch: "master", title: "fix login", prompt: "go" });
    assert.equal(r.ok, true);
    if (!r.ok) return;

    const row = db.prepare("SELECT * FROM tasks WHERE id=?").get(r.id) as any;
    assert.equal(row.kind, "repo");
    assert.equal(row.status, "running");
    assert.equal(row.repo_id, 4);
    assert.equal(row.base_branch, "master");
    assert.equal(row.work_branch, `feat/${r.id}-fix-login`);
    assert.equal(r.workBranch, `feat/${r.id}-fix-login`);
    assert.equal(row.session, `tdsp-abcd1234-${r.id}-switchyard-fix-login`);

    assert.deepEqual(calls, ["setup", "start:go"]);
    const s = getSetup();
    assert.equal(s.mirror, REPO.mirror_path);
    assert.equal(s.baseBranch, "master");
    assert.equal(s.workBranch, `feat/${r.id}-fix-login`);
    assert.equal(s.worktree, path.resolve(`/data/worktrees/4-${r.id}`));
    assert.equal(s.skills.length, 0);

    const m = JSON.parse(fs.readFileSync(path.join(dir, "tasks", String(r.id), "task.json"), "utf8"));
    assert.equal(m.task.work_branch, `feat/${r.id}-fix-login`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("createRepoTask preflights skills and rejects a missing one before inserting any row", async () => {
  const { env, dir, db, calls } = makeRepoEnv({
    resolveSkills: () => ({ found: [], missing: ["dispatcher:nope"] }),
  });
  try {
    const r = await createRepoTask(env, REPO, { baseBranch: "master", title: "t", extraSkills: ["dispatcher:nope"] });
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.error, "skillsMissing");
    assert.deepEqual((r as any).missing, ["dispatcher:nope"]);
    assert.equal((db.prepare("SELECT count(*) c FROM tasks").get() as { c: number }).c, 0, "no row before a failed preflight");
    assert.deepEqual(calls, [], "nothing orchestrated");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("createRepoTask appends a skills line to the opening when skills are delivered", async () => {
  const { env, dir, calls } = makeRepoEnv({
    resolveSkills: () => ({ found: [{ key: "dispatcher:tdd", name: "tdd", dir: "/skills/tdd" }], missing: [] }),
  });
  try {
    const r = await createRepoTask(env, REPO, { baseBranch: "m", title: "t", prompt: "build", extraSkills: ["dispatcher:tdd"] });
    assert.equal(r.ok, true);
    const start = calls.find((c) => c.startsWith("start:"))!;
    assert.match(start, /build/);
    assert.match(start, /tdd/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("createRepoTask with neither prompt nor skills starts the session with a null opening", async () => {
  const { env, dir, calls } = makeRepoEnv();
  try {
    await createRepoTask(env, REPO, { baseBranch: "m", title: "t" });
    assert.ok(calls.includes("start:∅"), "null opening when there's nothing to say");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("createRepoTask cleans up the worktree and marks error when setup fails", async () => {
  const { env, dir, db, calls } = makeRepoEnv({
    setupWorktree: async () => {
      throw new Error("worktree add: boom");
    },
  });
  try {
    const r = await createRepoTask(env, REPO, { baseBranch: "m", title: "willfail" });
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.error, "dispatchFailed");
    assert.ok(calls.includes("remove"), "a partial dispatch must remove the worktree");
    const row = db.prepare("SELECT status, error FROM tasks WHERE title='willfail'").get() as { status: string; error: string };
    assert.equal(row.status, "error");
    assert.match(row.error, /boom/);
    const id = (db.prepare("SELECT id FROM tasks WHERE title='willfail'").get() as { id: number }).id;
    assert.ok(fs.existsSync(path.join(dir, "tasks", String(id), "task.json")), "failed task is still manifested");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("createRepoTask cleans up when the session fails to start after the worktree was made", async () => {
  const { env, dir, db, calls } = makeRepoEnv({
    startSession: async () => {
      throw new Error("tmux: no server");
    },
  });
  try {
    const r = await createRepoTask(env, REPO, { baseBranch: "m", title: "t" });
    assert.equal(r.ok, false);
    assert.deepEqual(calls, ["setup", "remove"], "worktree prepared then torn down");
    const row = db.prepare("SELECT status FROM tasks WHERE title='t'").get() as { status: string };
    assert.equal(row.status, "error");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
