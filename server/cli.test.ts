import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { initSchema } from "./schema.ts";
import { taskListPayload, runCli, aggregateNodes } from "./cli.ts";

const opts = { didMigrate: false, legacyDir: "/legacy", dataDir: "/data" };

function seed() {
  const db = new Database(":memory:");
  initSchema(db, opts);
  db.prepare(
    "INSERT INTO tasks (repo_id, base_branch, work_branch, title, worktree_path, session, status) VALUES (1,'m','feat/1-old','old','/wt/x','tdsp-1-r-old','running')",
  ).run();
  return db;
}

// The cross-node read contract: `tdsp list --json` emits a versioned envelope so
// a newer controller can detect an older node's schema instead of misparsing it.
test("taskListPayload wraps the local tasks in a versioned envelope", () => {
  const db = seed();
  const payload = taskListPayload(db);
  assert.equal(payload.schema_version, 1);
  assert.equal(payload.tasks.length, 1);
  assert.equal(payload.tasks[0].title, "old");
  assert.equal(payload.tasks[0].session, "tdsp-1-r-old");
});

// Newest-first, matching today's GET /api/tasks (ORDER BY id DESC) so the list
// reads the same whether assembled locally or fetched from a node over ssh.
test("taskListPayload returns tasks newest-first", () => {
  const db = seed();
  db.prepare(
    "INSERT INTO tasks (repo_id, base_branch, work_branch, title, worktree_path, session, status) VALUES (1,'m','feat/2-new','new','/wt/y','tdsp-2-r-new','running')",
  ).run();
  const payload = taskListPayload(db);
  assert.deepEqual(
    payload.tasks.map((t) => t.title),
    ["new", "old"],
  );
});

// runCli is the testable dispatch layer: real db / stdout / serve are injected so
// the bin stays a trivial wiring shell.
function fakeDeps(db: Database.Database) {
  let out = "";
  let err = "";
  let served = false;
  return {
    deps: {
      db,
      out: (s: string) => {
        out += s;
      },
      err: (s: string) => {
        err += s;
      },
      serve: () => {
        served = true;
      },
    },
    get out() {
      return out;
    },
    get err() {
      return err;
    },
    get served() {
      return served;
    },
  };
}

test("runCli list --json prints the versioned task envelope and exits 0", async () => {
  const db = seed();
  const f = fakeDeps(db);
  const code = await runCli(["list", "--json"], f.deps);
  assert.equal(code, 0);
  const parsed = JSON.parse(f.out);
  assert.equal(parsed.schema_version, 1);
  assert.equal(parsed.tasks[0].title, "old");
});

test("runCli serve boots the local server and exits 0", async () => {
  const f = fakeDeps(seed());
  const code = await runCli(["serve"], f.deps);
  assert.equal(code, 0);
  assert.equal(f.served, true);
});

test("runCli rejects an unknown command with a usage hint on stderr and exits 1", async () => {
  const f = fakeDeps(seed());
  const code = await runCli(["bogus"], f.deps);
  assert.equal(code, 1);
  assert.match(f.err, /Usage|unknown/i);
  assert.equal(f.served, false);
});

// --- cross-node aggregation (the "see other nodes' tasks" half of 打通) ---
// aggregateNodes fans out `ssh <node> tdsp list --json` (the fetch is injected),
// merges per node, and degrades honestly: unreachable nodes and version-too-new
// nodes are flagged, never silently dropped, and one bad node can't block others.

test("aggregateNodes returns each node's tasks on a successful fetch", async () => {
  const fetch = async () => JSON.stringify({ schema_version: 1, tasks: [{ id: 7, title: "x" }] });
  const [r] = await aggregateNodes([{ id: 2, name: "B" }], fetch);
  assert.equal(r.ok, true);
  assert.equal(r.node.name, "B");
  assert.equal(r.tasks?.[0].title, "x");
});

test("aggregateNodes marks a node unreachable when the fetch fails (offline/timeout)", async () => {
  const fetch = async () => {
    throw new Error("ssh: connect timeout");
  };
  const [r] = await aggregateNodes([{ id: 2, name: "B" }], fetch);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "unreachable");
});

test("aggregateNodes flags a node whose schema_version is newer than we can parse", async () => {
  const fetch = async () => JSON.stringify({ schema_version: 999, tasks: [] });
  const [r] = await aggregateNodes([{ id: 2, name: "B" }], fetch);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "version");
});

test("aggregateNodes returns one result per node in order; a bad node doesn't block others", async () => {
  const nodes = [
    { id: 2, name: "B" },
    { id: 3, name: "C" },
  ];
  const fetch = async (n: { name: string }) => {
    if (n.name === "B") throw new Error("down");
    return JSON.stringify({ schema_version: 1, tasks: [{ id: 1, title: "c-task" }] });
  };
  const res = await aggregateNodes(nodes, fetch);
  assert.equal(res.length, 2);
  assert.equal(res[0].node.name, "B");
  assert.equal(res[0].ok, false);
  assert.equal(res[1].ok, true);
  assert.equal(res[1].tasks?.[0].title, "c-task");
});
