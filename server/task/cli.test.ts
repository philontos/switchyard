import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { initSchema } from "../core/schema.ts";
import {
  taskListPayload,
  runCli,
  aggregateNodes,
  ARCHIVED_TASK_LIFECYCLE_CAPABILITY,
  CODE_VIEW_CAPABILITY,
  isUnknownTdspCommand,
  type TaskLiveness,
} from "./cli.ts";
import type { CreateLocalResult } from "./createtask.ts";

// a probe that reports every task fully dead — for the existing tests that only
// care about the envelope shape, not the per-task liveness.
const noLive: TaskLiveness = async () => new Map();

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
test("taskListPayload wraps the local tasks in a versioned envelope", async () => {
  const db = seed();
  const payload = await taskListPayload(db, noLive);
  assert.equal(payload.schema_version, 3);
  assert.deepEqual(payload.capabilities, [ARCHIVED_TASK_LIFECYCLE_CAPABILITY, CODE_VIEW_CAPABILITY]);
  assert.equal(payload.tasks.length, 1);
  assert.equal(payload.tasks[0].title, "old");
  assert.equal(payload.tasks[0].session, "tdsp-1-r-old");
});

// `tdsp list` ships each task's OWN liveness (the node computes it locally — it's
// the sole authority for its tmux + worktree), so a controller can light the
// remote breathing dot the same way it does for a local task: green when the
// session is alive, yellow when it's blocked on a permission prompt. The probe is
// injected so this stays testable without a real tmux/fs.
test("taskListPayload enriches each task with alive/waiting/hasWorktree from the probe", async () => {
  const db = seed();
  const live: TaskLiveness = async (tasks) =>
    new Map(tasks.map((t) => [t.id, { alive: true, waiting: true, hasWorktree: true }]));
  const payload = await taskListPayload(db, live);
  assert.equal(payload.tasks[0].alive, true);
  assert.equal(payload.tasks[0].waiting, true);
  assert.equal(payload.tasks[0].hasWorktree, true);
});

// A task the probe doesn't know about (or a node that can't probe) degrades to
// "not alive" rather than throwing or leaving the field undefined.
test("taskListPayload defaults missing liveness to not-alive", async () => {
  const db = seed();
  const payload = await taskListPayload(db, noLive);
  assert.equal(payload.tasks[0].alive, false);
  assert.equal(payload.tasks[0].waiting, false);
  assert.equal(payload.tasks[0].hasWorktree, false);
});

// the list payload also carries the node's OWN repos, so a controller can group
// the node's tasks by repo (by name) and offer those repos when dispatching here —
// without the node's repos being registered on the controller.
test("taskListPayload also includes the node's repos", async () => {
  const db = seed();
  db.prepare("INSERT INTO repos (id,host_id,name,git_url,default_branch,mirror_path,status) VALUES (5,1,'ug-fe','git@x:ug','main','/d/mirrors/5-ug.git','ready')").run();
  const payload = await taskListPayload(db, noLive);
  assert.ok(Array.isArray(payload.repos));
  assert.equal(payload.repos.length, 1);
  assert.equal(payload.repos[0].id, 5);
  assert.equal(payload.repos[0].name, "ug-fe");
  assert.equal(payload.repos[0].mirror_path, "/d/mirrors/5-ug.git");
  assert.equal(payload.repos[0].default_branch, "main");
});

// Newest-first, matching today's GET /api/tasks (ORDER BY id DESC) so the list
// reads the same whether assembled locally or fetched from a node over ssh.
test("taskListPayload returns tasks newest-first", async () => {
  const db = seed();
  db.prepare(
    "INSERT INTO tasks (repo_id, base_branch, work_branch, title, worktree_path, session, status) VALUES (1,'m','feat/2-new','new','/wt/y','tdsp-2-r-new','running')",
  ).run();
  const payload = await taskListPayload(db, noLive);
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
  let serveOpts: any = null;
  const createCalls: { cwd?: string | null; title?: string | null }[] = [];
  const repoCalls: any[] = [];
  const stopCalls: number[] = [];
  const lifecycleCalls: Array<[string, number]> = [];
  const branchCalls: string[] = [];
  const providerCalls: any[] = [];
  const inspectCalls: any[] = [];
  return {
    deps: {
      db,
      out: (s: string) => {
        out += s;
      },
      err: (s: string) => {
        err += s;
      },
      serve: (opts?: any) => {
        served = true;
        serveOpts = opts;
      },
      liveness: noLive,
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
      resume: async (id: number) => {
        lifecycleCalls.push(["resume", id]);
        return { ok: true as const, alreadyAlive: false };
      },
      cleanup: async (id: number) => {
        lifecycleCalls.push(["cleanup", id]);
        return { ok: true as const };
      },
      deleteTask: async (id: number) => {
        lifecycleCalls.push(["delete-task", id]);
        return { ok: true as const };
      },
      inspectCode: async (request: any) => {
        inspectCalls.push(request);
        return { ok: true as const, kind: "tree" as const, files: ["README.md"], truncated: false,
          revision: { label: "main", commit: "a".repeat(40) }, generatedAt: "now" };
      },
      providersList: () => [{ id: 2, name: "GLM", base_url: "https://open.bigmodel.cn/api/anthropic", auth_token: "tok", model: "glm-5.2", small_fast_model: null, created_at: "now" }],
      providersTest: async (body: any) => {
        providerCalls.push(["test", body]);
        return { ok: true as const };
      },
      providersCreate: async (body: any) => {
        providerCalls.push(["create", body]);
        return { ok: true as const, id: 3 };
      },
      providersDelete: async (id: number) => {
        providerCalls.push(["delete", id]);
        return { ok: true as const };
      },
      install: () => ({ src: "/h/.task-dispatcher/src", binPath: "/h/.task-dispatcher/bin/tdsp", localBin: "/h/.local/bin/tdsp", clone: "/h/clone" }),
      update: async () => ({ ok: true as const, clone: "/h/clone", head: "abc1234 feat: latest" }),
      branches: async (mirror: string) => {
        branchCalls.push(mirror);
        return { ok: true as const, branches: ["main", "develop", "release/1.0"] };
      },
    },
    createCalls,
    repoCalls,
    stopCalls,
    lifecycleCalls,
    branchCalls,
    providerCalls,
    inspectCalls,
    get out() {
      return out;
    },
    get err() {
      return err;
    },
    get served() {
      return served;
    },
    get serveOpts() {
      return serveOpts;
    },
  };
}

test("runCli list --json prints the versioned task envelope and exits 0", async () => {
  const db = seed();
  const f = fakeDeps(db);
  const code = await runCli(["list", "--json"], f.deps);
  assert.equal(code, 0);
  const parsed = JSON.parse(f.out);
  assert.equal(parsed.schema_version, 3);
  assert.ok(parsed.capabilities.includes(ARCHIVED_TASK_LIFECYCLE_CAPABILITY));
  assert.ok(parsed.capabilities.includes(CODE_VIEW_CAPABILITY));
  assert.equal(parsed.tasks[0].title, "old");
});

test("runCli inspect-code decodes a typed read request and prints its result", async () => {
  const f = fakeDeps(seed());
  const request = { scope: "task", id: 7, operation: "tree" };
  const code = await runCli(["inspect-code", Buffer.from(JSON.stringify(request)).toString("base64")], f.deps);
  assert.equal(code, 0);
  assert.deepEqual(f.inspectCalls, [request]);
  assert.deepEqual(JSON.parse(f.out).files, ["README.md"]);
});

test("runCli inspect-code rejects malformed base64 JSON without invoking the reader", async () => {
  const f = fakeDeps(seed());
  const code = await runCli(["inspect-code", "not-json"], f.deps);
  assert.equal(code, 1);
  assert.equal(f.inspectCalls.length, 0);
  assert.equal(JSON.parse(f.out).error, "invalidRequest");
});

test("runCli inspect-code rejects a parsed but invalid request shape", async () => {
  const f = fakeDeps(seed());
  const invalid = Buffer.from(JSON.stringify({ scope: "repo", operation: "file" })).toString("base64");
  const code = await runCli(["inspect-code", invalid], f.deps);
  assert.equal(code, 1);
  assert.equal(f.inspectCalls.length, 0);
  assert.equal(JSON.parse(f.out).error, "invalidRequest");
});

test("runCli serve boots the local server and exits 0", async () => {
  const f = fakeDeps(seed());
  const code = await runCli(["serve"], f.deps);
  assert.equal(code, 0);
  assert.equal(f.served, true);
});

test("runCli serve passes explicit host and CIDR options", async () => {
  const f = fakeDeps(seed());
  const code = await runCli(["serve", "--host", "127.0.0.1", "--host-cidr", "10.10.0.0/24"], f.deps);
  assert.equal(code, 0);
  assert.equal(f.served, true);
  assert.deepEqual(f.serveOpts, { host: "127.0.0.1", hosts: undefined, hostCidr: "10.10.0.0/24" });
});

test("runCli rejects an unknown command with a usage hint on stderr and exits 1", async () => {
  const f = fakeDeps(seed());
  const code = await runCli(["bogus"], f.deps);
  assert.equal(code, 1);
  assert.match(f.err, /Usage|unknown/i);
  assert.equal(f.served, false);
});

test("isUnknownTdspCommand recognizes an older node's missing lifecycle verb", () => {
  const stderr = "Usage: tdsp <serve|list|stop>\nunknown command: cleanup\n";
  assert.equal(isUnknownTdspCommand(stderr, "cleanup"), true);
  assert.equal(isUnknownTdspCommand(stderr, "resume"), false);
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

// codex dispatches to a remote node exactly like a local one: the agent + model
// ride in the spec, so the node's own createRepoTask runs the same agent A picked.
test("runCli create round-trips the agent + model in the spec (symmetric codex dispatch)", async () => {
  const f = fakeDeps(seed());
  const spec = { mirror: "/d/mirrors/5-sw.git", name: "sw", git_url: "g", base: "main", title: "fix", prompt: "go", skills: [], agent: "codex", model: "gpt-5.4" };
  const b64 = Buffer.from(JSON.stringify(spec)).toString("base64");
  const code = await runCli(["create", b64], f.deps);
  assert.equal(code, 0);
  assert.equal(f.repoCalls[0].agent, "codex", "the node is handed the chosen agent");
  assert.equal(f.repoCalls[0].model, "gpt-5.4");
});

test("runCli create round-trips kimi as an agent in the spec", async () => {
  const f = fakeDeps(seed());
  const spec = { mirror: "/d/mirrors/5-sw.git", name: "sw", git_url: "g", base: "main", title: "fix", prompt: "go", skills: [], agent: "kimi", model: "kimi-code/kimi-for-coding" };
  const b64 = Buffer.from(JSON.stringify(spec)).toString("base64");
  const code = await runCli(["create", b64], f.deps);
  assert.equal(code, 0);
  assert.equal(f.repoCalls[0].agent, "kimi", "the node is handed the chosen agent");
  assert.equal(f.repoCalls[0].model, "kimi-code/kimi-for-coding");
});

test("runCli create round-trips provider_id in the spec (node-local provider)", async () => {
  const f = fakeDeps(seed());
  const spec = { mirror: "/d/mirrors/5-sw.git", name: "sw", git_url: "g", base: "main", title: "fix", prompt: "go", skills: [], agent: "claude", provider_id: 9 };
  const b64 = Buffer.from(JSON.stringify(spec)).toString("base64");
  const code = await runCli(["create", b64], f.deps);
  assert.equal(code, 0);
  assert.equal(f.repoCalls[0].provider_id, 9);
});

test("runCli provider verbs manage this node's provider catalog", async () => {
  const f = fakeDeps(seed());
  assert.equal(await runCli(["providers-list"], f.deps), 0);
  assert.match(f.out, /GLM/);

  const body = { name: "GLM", base_url: "https://open.bigmodel.cn/api/anthropic", auth_token: "tok", model: "glm-5.2" };
  const b64 = Buffer.from(JSON.stringify(body)).toString("base64");
  assert.equal(await runCli(["providers-test", b64], f.deps), 0);
  assert.equal(await runCli(["providers-create", b64], f.deps), 0);
  assert.equal(await runCli(["providers-delete", "3"], f.deps), 0);
  assert.deepEqual(f.providerCalls.map((c) => c[0]), ["test", "create", "delete"]);
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

test("runCli dispatches the remote archived-task lifecycle verbs", async () => {
  const f = fakeDeps(seed());
  assert.equal(await runCli(["resume", "7"], f.deps), 0);
  assert.equal(await runCli(["cleanup", "7"], f.deps), 0);
  assert.equal(await runCli(["delete-task", "7"], f.deps), 0);
  assert.deepEqual(f.lifecycleCalls, [["resume", 7], ["cleanup", 7], ["delete-task", 7]]);
});

test("runCli rejects an invalid archived-task lifecycle id", async () => {
  const f = fakeDeps(seed());
  assert.equal(await runCli(["resume", "nope"], f.deps), 1);
  assert.match(f.out, /invalid id/);
  assert.deepEqual(f.lifecycleCalls, []);
});

test("runCli branches lists a mirror's branches as JSON, exits 0", async () => {
  const f = fakeDeps(seed());
  const code = await runCli(["branches", "/d/mirrors/2-ug.git"], f.deps);
  assert.equal(code, 0);
  assert.deepEqual(f.branchCalls, ["/d/mirrors/2-ug.git"]);
  const parsed = JSON.parse(f.out);
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.branches, ["main", "develop", "release/1.0"]);
});

test("runCli branches requires a mirror path, exits 1 otherwise", async () => {
  const f = fakeDeps(seed());
  const code = await runCli(["branches"], f.deps);
  assert.equal(code, 1);
  assert.deepEqual(f.branchCalls, []);
});

test("runCli install sets up the machine and reports the paths", async () => {
  const f = fakeDeps(seed());
  const code = await runCli(["install"], f.deps);
  assert.equal(code, 0);
  assert.match(f.out, /\.task-dispatcher\/src/);
  assert.match(f.out, /\.task-dispatcher\/bin\/tdsp/);
});

test("runCli update pulls the install and reports the new head", async () => {
  const f = fakeDeps(seed());
  const code = await runCli(["update"], f.deps);
  assert.equal(code, 0);
  assert.match(f.out, /updated/);
  assert.match(f.out, /abc1234/);
  assert.match(f.out, /tdsp serve/, "tells the user a running console needs a restart");
});

test("runCli update exits 1 and surfaces the error when the pull fails", async () => {
  const f = fakeDeps(seed());
  f.deps.update = async () => ({ ok: false as const, error: "not possible to fast-forward" });
  const code = await runCli(["update"], f.deps);
  assert.equal(code, 1);
  assert.match(f.err, /fast-forward/);
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

test("aggregateNodes carries capabilities and treats an old node's missing field as empty", async () => {
  const nodes = [{ id: 2, name: "old" }, { id: 3, name: "new" }];
  const fetch = async (node: { name: string }) => JSON.stringify({
    schema_version: node.name === "old" ? 2 : 3,
    capabilities: node.name === "old" ? undefined : [ARCHIVED_TASK_LIFECYCLE_CAPABILITY],
    tasks: [],
  });
  const [oldNode, newNode] = await aggregateNodes(nodes, fetch);
  assert.deepEqual(oldNode.capabilities, []);
  assert.deepEqual(newNode.capabilities, [ARCHIVED_TASK_LIFECYCLE_CAPABILITY]);
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
