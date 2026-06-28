import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { initSchema } from "./schema.ts";
import { taskListPayload, runCli, aggregateNodes } from "./cli.ts";
import type { CreateLocalResult } from "./createtask.ts";

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

// the list payload also carries the node's OWN repos, so a controller can group
// the node's tasks by repo (by name) and offer those repos when dispatching here —
// without the node's repos being registered on the controller.
test("taskListPayload also includes the node's repos", () => {
  const db = seed();
  db.prepare("INSERT INTO repos (id,host_id,name,git_url,default_branch,mirror_path,status) VALUES (5,1,'ug-fe','git@x:ug','main','/d/mirrors/5-ug.git','ready')").run();
  const payload = taskListPayload(db);
  assert.ok(Array.isArray(payload.repos));
  assert.equal(payload.repos.length, 1);
  assert.equal(payload.repos[0].id, 5);
  assert.equal(payload.repos[0].name, "ug-fe");
  assert.equal(payload.repos[0].mirror_path, "/d/mirrors/5-ug.git");
  assert.equal(payload.repos[0].default_branch, "main");
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
  const createCalls: { cwd?: string | null; title?: string | null }[] = [];
  const repoCalls: any[] = [];
  const stopCalls: number[] = [];
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
      createLocal: async (opts: { cwd?: string | null; title?: string | null }): Promise<CreateLocalResult> => {
        createCalls.push(opts);
        return { ok: true, id: 99, session: "tdsp-x-99-local-y" };
      },
      createRepo: async (spec: any) => {
        repoCalls.push(spec);
        return { ok: true as const, id: 77, session: "tdsp-x-77-sw-t", workBranch: "feat/77-t" };
      },
      stop: async (id: number) => {
        stopCalls.push(id);
        return { ok: true as const };
      },
    },
    createCalls,
    repoCalls,
    stopCalls,
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

// create-local is the control-sink verb: A drives B by `ssh B tdsp create-local`,
// and B's tdsp orchestrates locally. runCli only parses flags + prints the JSON
// result; the orchestration (createLocalTask) is injected.
test("runCli create-local parses --cwd/--title, invokes createLocal, prints JSON, exits 0", async () => {
  const f = fakeDeps(seed());
  const code = await runCli(["create-local", "--cwd", "/tmp/x", "--title", "debug B"], f.deps);
  assert.equal(code, 0);
  assert.deepEqual(f.createCalls[0], { cwd: "/tmp/x", title: "debug B" });
  const parsed = JSON.parse(f.out);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.id, 99);
});

test("runCli create-local supports --flag=value form too", async () => {
  const f = fakeDeps(seed());
  await runCli(["create-local", "--cwd=/tmp/y", "--title=hi there"], f.deps);
  assert.deepEqual(f.createCalls[0], { cwd: "/tmp/y", title: "hi there" });
});

// `tdsp create` is the repo-dispatch sink: A base64-encodes the task spec (so a
// prompt with newlines/quotes survives ssh argv) and the node decodes + runs it.
test("runCli create decodes the base64 spec, invokes createRepo, prints JSON, exits 0", async () => {
  const f = fakeDeps(seed());
  const spec = { mirror: "/d/mirrors/5-sw.git", name: "sw", git_url: "g", base: "main", title: "fix", prompt: "line1\nline2", skills: ["dispatcher:tdd"] };
  const b64 = Buffer.from(JSON.stringify(spec)).toString("base64");
  const code = await runCli(["create", b64], f.deps);
  assert.equal(code, 0);
  assert.deepEqual(f.repoCalls[0], spec, "the full spec (incl. multiline prompt) round-trips");
  const parsed = JSON.parse(f.out);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.id, 77);
});

test("runCli create exits 1 and reports an error when the spec is not valid base64 JSON", async () => {
  const f = fakeDeps(seed());
  const code = await runCli(["create", "@@not-base64-json@@"], f.deps);
  assert.equal(code, 1);
  assert.match(f.out + f.err, /spec|invalid|JSON/i);
});

test("runCli create exits 1 and prints the error when dispatch fails", async () => {
  const f = fakeDeps(seed());
  f.deps.createRepo = async () => ({ ok: false as const, error: "skillsMissing", missing: ["dispatcher:x"] });
  const b64 = Buffer.from(JSON.stringify({ mirror: "/m", name: "n", git_url: "g", base: "main", title: "t" })).toString("base64");
  const code = await runCli(["create", b64], f.deps);
  assert.equal(code, 1);
  assert.match(f.out, /skillsMissing/);
});

test("runCli stop parses the id, invokes stop, prints JSON, exits 0", async () => {
  const f = fakeDeps(seed());
  const code = await runCli(["stop", "42"], f.deps);
  assert.equal(code, 0);
  assert.deepEqual(f.stopCalls, [42]);
  assert.equal(JSON.parse(f.out).ok, true);
});

test("runCli stop rejects a non-numeric id with exit 1", async () => {
  const f = fakeDeps(seed());
  const code = await runCli(["stop", "abc"], f.deps);
  assert.equal(code, 1);
  assert.match(f.out, /invalid id/);
  assert.deepEqual(f.stopCalls, []);
});

test("runCli create-local exits 1 and prints the error when creation fails", async () => {
  const f = fakeDeps(seed());
  f.deps.createLocal = async () => ({ ok: false as const, error: "cwdMissing" });
  const code = await runCli(["create-local", "--cwd", "/nope"], f.deps);
  assert.equal(code, 1);
  const parsed = JSON.parse(f.out);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.error, "cwdMissing");
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
