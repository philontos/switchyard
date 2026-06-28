import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { initSchema } from "./schema.ts";
import { createLocalTask, type LocalTaskEnv } from "./createtask.ts";

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
