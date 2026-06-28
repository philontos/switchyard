// The `tdsp` node-local API: pure functions that take a DB handle (like tasks.ts
// / schema.ts), so they're testable against an in-memory sqlite and reusable by
// both the HTTP server (tdsp serve) and the one-shot CLI verbs. A node is the
// sole authority for its own tasks; these read/return that local truth.
import type Database from "better-sqlite3";
import type { Task } from "./db.js";
import type { CreateLocalOpts, CreateLocalResult, CreateRepoResult, StopResult } from "./createtask.js";

// The spec A sends to `tdsp create` (base64-JSON over ssh argv, so a multiline
// prompt and skill list survive intact). The node registers the repo by `mirror`
// and dispatches the task on itself.
export interface CreateRepoSpec {
  mirror: string;
  name: string;
  git_url: string;
  base: string;
  title: string;
  prompt?: string | null;
  skills?: string[];
}

type DB = Database.Database;

// The cross-node read contract carries its own version so a newer controller can
// detect an older node and prompt an upgrade instead of misparsing the payload.
// Bump ONLY for additive, backward-compatible shape changes.
export const TASK_LIST_VERSION = 1;

export interface TaskListPayload {
  schema_version: number;
  tasks: Task[];
}

/** The versioned envelope emitted by `tdsp list --json`: this node's own tasks. */
export function taskListPayload(db: DB): TaskListPayload {
  const tasks = db.prepare("SELECT * FROM tasks ORDER BY id DESC").all() as Task[];
  return { schema_version: TASK_LIST_VERSION, tasks };
}

// ---- cross-node aggregation: the "see other nodes' tasks" half of 打通 ----
// Each node is the sole authority for its own tasks; a controller assembles a
// fleet view by asking each one (`ssh <node> tdsp list --json`) at view time —
// no central store, no sync. Truth is read on demand; offline = honestly unknown.

export interface NodeRef {
  id: number;
  name: string;
}

export interface NodeTasks<T extends NodeRef = NodeRef> {
  node: T;
  ok: boolean;
  reason?: "unreachable" | "version" | "error"; // why ok=false
  schema_version?: number;
  tasks?: Task[];
}

/**
 * Fan out to every node and merge the results, one entry per node, order
 * preserved. `fetch` returns the raw stdout of that node's `tdsp list --json`
 * (it owns transport + timeout). Degrades honestly:
 *   - fetch throws        → unreachable (offline / ssh timeout)
 *   - unparseable output  → error
 *   - payload version too new for us → version (prompt: upgrade this controller)
 * A slow/bad node is isolated to its own entry and never blocks the others.
 */
export async function aggregateNodes<T extends NodeRef>(
  nodes: T[],
  fetch: (node: T) => Promise<string>,
): Promise<NodeTasks<T>[]> {
  return Promise.all(
    nodes.map(async (node): Promise<NodeTasks<T>> => {
      let raw: string;
      try {
        raw = await fetch(node);
      } catch {
        return { node, ok: false, reason: "unreachable" };
      }
      let payload: TaskListPayload;
      try {
        payload = JSON.parse(raw) as TaskListPayload;
      } catch {
        return { node, ok: false, reason: "error" };
      }
      // additive-only contract: a newer reader parses older payloads, but a
      // payload newer than we know we must not guess at — flag for upgrade.
      if (typeof payload?.schema_version !== "number" || payload.schema_version > TASK_LIST_VERSION) {
        return { node, ok: false, reason: "version", schema_version: payload?.schema_version };
      }
      return { node, ok: true, schema_version: payload.schema_version, tasks: payload.tasks ?? [] };
    }),
  );
}

// IO the dispatch layer needs, injected so runCli is testable without opening the
// real DB or booting the server. The bin (`tdsp`) supplies the real handles.
export interface CliDeps {
  db: DB;
  out: (s: string) => void;
  err: (s: string) => void;
  serve: () => void | Promise<void>;
  createLocal: (opts: CreateLocalOpts) => Promise<CreateLocalResult>;
  createRepo: (spec: CreateRepoSpec) => Promise<CreateRepoResult>;
  stop: (id: number) => Promise<StopResult>;
}

// Minimal flag parser: supports `--key value` and `--key=value`. Bare flags
// (no following value) map to "". Enough for the node-control verbs.
function parseFlags(args: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith("--")) continue;
    const eq = a.indexOf("=");
    if (eq >= 0) out[a.slice(2, eq)] = a.slice(eq + 1);
    else out[a.slice(2)] = args[i + 1] && !args[i + 1].startsWith("--") ? args[++i] : "";
  }
  return out;
}

/** Parse argv (after `tdsp`) and run the verb. Returns a process exit code. */
export async function runCli(argv: string[], deps: CliDeps): Promise<number> {
  const [cmd] = argv;
  switch (cmd) {
    case "serve":
      await deps.serve();
      return 0;
    case "list":
      deps.out(JSON.stringify(taskListPayload(deps.db)));
      return 0;
    case "create-local": {
      const f = parseFlags(argv.slice(1));
      const r = await deps.createLocal({ cwd: f.cwd ?? null, title: f.title ?? null });
      deps.out(JSON.stringify(r));
      return r.ok ? 0 : 1;
    }
    case "create": {
      let spec: CreateRepoSpec;
      try {
        spec = JSON.parse(Buffer.from(argv[1] ?? "", "base64").toString("utf8")) as CreateRepoSpec;
        if (!spec || typeof spec.mirror !== "string") throw new Error("missing fields");
      } catch {
        deps.err("create: expected a base64-encoded JSON spec");
        deps.out(JSON.stringify({ ok: false, error: "invalid spec" }));
        return 1;
      }
      const r = await deps.createRepo(spec);
      deps.out(JSON.stringify(r));
      return r.ok ? 0 : 1;
    }
    case "stop": {
      const id = Number(argv[1]);
      if (!Number.isInteger(id)) {
        deps.out(JSON.stringify({ ok: false, error: "invalid id" }));
        return 1;
      }
      const r = await deps.stop(id);
      deps.out(JSON.stringify(r));
      return r.ok ? 0 : 1;
    }
    default:
      deps.err(`Usage: tdsp <serve|list|create-local|create|stop>\n${cmd ? `unknown command: ${cmd}` : "no command given"}`);
      return 1;
  }
}
