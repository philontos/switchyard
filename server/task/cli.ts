// The `tdsp` node-local API: pure functions that take a DB handle (like tasks.ts
// / schema.ts), so they're testable against an in-memory sqlite and reusable by
// both the HTTP server (tdsp serve) and the one-shot CLI verbs. A node is the
// sole authority for its own tasks; these read/return that local truth.
import type Database from "better-sqlite3";
import type { Task } from "../core/db.js";
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
// v2: each task now carries its own liveness (alive/waiting/hasWorktree), computed
// on the node, so a controller can light the remote breathing/needs-you dot the
// same way it does for local tasks. Additive — an un-updated v1 node just omits
// them and the controller degrades to a status-based guess.
export const TASK_LIST_VERSION = 2;

// A repo as a node exposes it to controllers — enough to group the node's tasks
// by repo (name) and to dispatch a new task here using the node's OWN mirror (no
// re-registration on the controller). The token is deliberately never included.
export interface NodeRepo {
  id: number;
  name: string;
  git_url: string;
  default_branch: string;
  mirror_path: string;
}

// Per-task liveness a node computes for its OWN tasks — the same three signals the
// controller computes for local tasks in GET /api/tasks, but here the node reports
// them about itself (it's the sole authority for its tmux server + worktrees). This
// is what lets a remote card light its breathing dot exactly like a local one.
export interface TaskLive {
  alive: boolean;        // its tmux session is live
  hasWorktree: boolean;  // its worktree is still on disk
  waiting: boolean;      // blocked on a permission prompt (the .claude/waiting marker)
}
// Injected probe: given this node's tasks, report each one's liveness by id. Passed
// in (not computed here) so taskListPayload stays testable without a real tmux/fs —
// the same dependency-injection seam aggregateNodes uses for its ssh fetch.
export type TaskLiveness = (tasks: Task[]) => Promise<Map<number, TaskLive>>;
export interface LiveTask extends Task, TaskLive {}

export interface TaskListPayload {
  schema_version: number;
  tasks: LiveTask[];
  repos: NodeRepo[];
}

/** The node's own repos, for the cross-node view (group-by-repo + dispatch here). */
export function reposForList(db: DB): NodeRepo[] {
  return db.prepare("SELECT id, name, git_url, default_branch, mirror_path FROM repos ORDER BY id").all() as NodeRepo[];
}

/**
 * The versioned envelope emitted by `tdsp list --json`: this node's own tasks +
 * repos, each task enriched with the liveness the `liveness` probe reports (the
 * node computes it about its own tmux/worktrees). A task the probe omits degrades
 * to not-alive, so a missing/failed probe is honest rather than throwing.
 */
export async function taskListPayload(db: DB, liveness: TaskLiveness): Promise<TaskListPayload> {
  const tasks = db.prepare("SELECT * FROM tasks ORDER BY id DESC").all() as Task[];
  const live = await liveness(tasks);
  const enriched: LiveTask[] = tasks.map((t) => {
    const l = live.get(t.id);
    return { ...t, alive: l?.alive ?? false, hasWorktree: l?.hasWorktree ?? false, waiting: l?.waiting ?? false };
  });
  return { schema_version: TASK_LIST_VERSION, tasks: enriched, repos: reposForList(db) };
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
  repos?: NodeRepo[];
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
      return { node, ok: true, schema_version: payload.schema_version, tasks: payload.tasks ?? [], repos: payload.repos ?? [] };
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
  // report THIS node's own task liveness (tmux + worktree probes), for `list`
  liveness: TaskLiveness;
  createLocal: (opts: CreateLocalOpts) => Promise<CreateLocalResult>;
  createRepo: (spec: CreateRepoSpec) => Promise<CreateRepoResult>;
  stop: (id: number) => Promise<StopResult>;
  // set up THIS machine's global tdsp from its clone (symlink src + wrapper)
  install: () => { src: string; binPath: string; localBin: string; clone: string };
  // live branch list for one of this machine's mirrors (so a controller can offer
  // the node repo's real branches when dispatching here)
  branches: (mirror: string) => Promise<{ ok: boolean; branches?: string[]; error?: string }>;
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
      deps.out(JSON.stringify(await taskListPayload(deps.db, deps.liveness)));
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
    case "branches": {
      const mirror = argv[1];
      if (!mirror) {
        deps.out(JSON.stringify({ ok: false, error: "branches: a mirror path is required" }));
        return 1;
      }
      const r = await deps.branches(mirror);
      deps.out(JSON.stringify(r));
      return r.ok ? 0 : 1;
    }
    case "install": {
      const r = deps.install();
      deps.out(
        `tdsp installed:\n` +
          `  code   ${r.src} -> ${r.clone}\n` +
          `  command ${r.binPath}\n` +
          `  on PATH ${r.localBin}  (ensure ~/.local/bin is on your PATH)\n` +
          `now: type \`tdsp list\` here, or reach this machine from another with \`ssh <host> ${r.binPath} list\``,
      );
      return 0;
    }
    default:
      deps.err(`Usage: tdsp <serve|list|create-local|create|stop|branches|install>\n${cmd ? `unknown command: ${cmd}` : "no command given"}`);
      return 1;
  }
}
