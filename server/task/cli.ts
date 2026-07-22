// The `tdsp` node-local API: pure functions that take a DB handle (like tasks.ts
// / schema.ts), so they're testable against an in-memory sqlite and reusable by
// both the HTTP server (tdsp serve) and the one-shot CLI verbs. A node is the
// sole authority for its own tasks; these read/return that local truth.
import type Database from "better-sqlite3";
import type { Repo, Task } from "../core/db.js";
import type { ProviderSummary } from "../provider/providers.js";
import type { CreateLocalOpts, CreateLocalResult, CreateRepoResult, StopResult } from "./createtask.js";
import type { LifecycleResult } from "./lifecycle.js";
import { CODE_VIEW_CAPABILITY, isCodeInspectRequest, type CodeInspectRequest, type CodeInspectResult } from "../codeview/codeview.js";
import type { OwnedRepoFailure, OwnedRepoInput, OwnedRepoResult } from "../repo/owned.js";
import type { PasteImageResult } from "./paste-service.js";
import { legacyOwnershipReport } from "../core/ownership.js";
import { listOwnedRepos, listOwnedTasks } from "../core/ownership.js";
export { CODE_VIEW_CAPABILITY } from "../codeview/codeview.js";

// The spec A sends to `tdsp create` (base64-JSON over ssh argv, so a multiline
// prompt and skill list survive intact). The repo id belongs to the target
// node's own catalog; paths and credentials never cross the node boundary.
export interface CreateRepoSpec {
  repo_id: number;
  base: string;
  title: string;
  prompt?: string | null;
  skills?: string[];
  // Which coding-agent CLI the node runs (claude default | codex | kimi) and the
  // optional non-Claude -m model. Local and remote dispatch are symmetric — the
  // node runs the same agent A picked, using createRepoTask on its own machine.
  agent?: string;
  model?: string | null;
  // Target-node local provider id. The controller never interprets this for a
  // remote node; it only relays the id selected from that node's provider list.
  provider_id?: number | null;
}

export interface ProviderInput {
  name?: string | null;
  base_url?: string | null;
  auth_token?: string | null;
  model?: string | null;
  small_fast_model?: string | null;
}

type DB = Database.Database;

// The cross-node read contract carries its own version so a newer controller can
// detect an older node and prompt an upgrade instead of misparsing the payload.
// Bump ONLY for additive, backward-compatible shape changes.
// v2: each task now carries its own liveness (alive/waiting/hasWorktree), computed
// on the node, so a controller can light the remote breathing/needs-you dot the
// same way it does for local tasks. Additive — an un-updated v1 node just omits
// them and the controller degrades to a status-based guess.
// v3: the envelope advertises node capabilities. This lets a newer controller
// spot a node that predates a one-shot CLI verb before offering a broken action.
export const TASK_LIST_VERSION = 3;
export const ARCHIVED_TASK_LIFECYCLE_CAPABILITY = "archived-task-lifecycle-v1";
export const NODE_CONTROL_CAPABILITY = "node-control-v1";
export const TASK_CAPABILITIES = [ARCHIVED_TASK_LIFECYCLE_CAPABILITY, CODE_VIEW_CAPABILITY, NODE_CONTROL_CAPABILITY] as const;

// A repo as a node exposes it to controllers — enough to group the node's tasks
// by repo (name) and to dispatch a new task here using the node's OWN mirror (no
// re-registration on the controller). The token is deliberately never included.
export interface NodeRepo {
  id: number;
  name: string;
  default_branch: string;
  status: string;
  error: string | null;
}

function repoForList(repo: Repo | NodeRepo): NodeRepo {
  return {
    id: Number(repo.id),
    name: String(repo.name ?? ""),
    default_branch: String(repo.default_branch || "main"),
    status: "status" in repo && typeof repo.status === "string" ? repo.status : "ready",
    // Raw git errors can contain owner-local paths or credential-bearing URLs.
    // The status is enough for the controller; detailed diagnostics stay on-node.
    error: "error" in repo && repo.error ? "Repository operation failed on this node" : null,
  };
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
export interface NodeTask {
  id: number;
  repo_id: number;
  base_branch: string;
  work_branch: string;
  title: string;
  session: string;
  status: string;
  kind: string;
  cwd: string | null;
  agent: string;
  alive?: boolean;
  hasWorktree?: boolean;
  waiting?: boolean;
}

export interface TaskListPayload {
  schema_version: number;
  capabilities: string[];
  tasks: NodeTask[];
  repos: NodeRepo[];
}

/** The node's own repos, for the cross-node view (group-by-repo + dispatch here). */
export function reposForList(db: DB): NodeRepo[] {
  return listOwnedRepos(db).map(repoForList);
}

/**
 * Cross-node task DTO. Paths, prompts, provider ids and transcript metadata stay
 * on the owner; a controller receives only what it needs to draw the card,
 * address the tmux session and send a node-local command.
 */
function taskForList(task: Task, live?: Partial<TaskLive>): NodeTask {
  const hasLive = !!live && ("alive" in live || "hasWorktree" in live || "waiting" in live);
  return {
    id: task.id,
    repo_id: task.repo_id,
    base_branch: task.base_branch,
    work_branch: task.work_branch,
    title: task.title,
    session: task.session,
    status: task.status,
    kind: task.kind,
    cwd: task.cwd,
    agent: task.agent,
    ...(hasLive ? {
      alive: live?.alive ?? false,
      hasWorktree: live?.hasWorktree ?? false,
      waiting: live?.waiting ?? false,
    } : {}),
  };
}

/**
 * The versioned envelope emitted by `tdsp list --json`: this node's own tasks +
 * repos, each task enriched with the liveness the `liveness` probe reports (the
 * node computes it about its own tmux/worktrees). A task the probe omits degrades
 * to not-alive, so a missing/failed probe is honest rather than throwing.
 */
export async function taskListPayload(db: DB, liveness: TaskLiveness): Promise<TaskListPayload> {
  const tasks = listOwnedTasks(db);
  const live = await liveness(tasks);
  const enriched: NodeTask[] = tasks.map((t) => {
    const l = live.get(t.id);
    return taskForList(t, l ?? { alive: false, hasWorktree: false, waiting: false });
  });
  return {
    schema_version: TASK_LIST_VERSION,
    capabilities: [...TASK_CAPABILITIES],
    tasks: enriched,
    repos: reposForList(db),
  };
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
  capabilities?: string[];
  tasks?: NodeTask[];
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
      const capabilities = Array.isArray(payload.capabilities)
        ? payload.capabilities.filter((cap): cap is string => typeof cap === "string")
        : [];
      return {
        node,
        ok: true,
        schema_version: payload.schema_version,
        capabilities,
        // Older list payloads exposed the full task row. Re-project at the
        // controller boundary so those owner-private fields never reach its UI.
        tasks: (Array.isArray(payload.tasks) ? payload.tasks : [])
          .map((task) => taskForList(task as unknown as Task, task)),
        // v1/v2 nodes exposed git_url + mirror_path. Strip those again at the
        // controller boundary before the aggregate reaches the browser.
        repos: (Array.isArray(payload.repos) ? payload.repos : [])
          .map((repo) => repoForList(repo as unknown as Repo)),
      };
    }),
  );
}

/** Recognize the stable error emitted by an older tdsp for a verb it predates. */
export function isUnknownTdspCommand(output: string, command: string): boolean {
  const expected = `unknown command: ${command}`.toLowerCase();
  return output.toLowerCase().includes(expected);
}

// IO the dispatch layer needs, injected so runCli is testable without opening the
// real DB or booting the server. The bin (`tdsp`) supplies the real handles.
export interface CliDeps {
  db: DB;
  out: (s: string) => void;
  err: (s: string) => void;
  serve: (opts?: ServeOpts) => void | Promise<void>;
  // report THIS node's own task liveness (tmux + worktree probes), for `list`
  liveness: TaskLiveness;
  createLocal: (opts: CreateLocalOpts) => Promise<CreateLocalResult>;
  createRepo: (spec: CreateRepoSpec) => Promise<CreateRepoResult | { ok: false; error: "repoNotFound" | "repoNotReady"; message?: string }>;
  repoCreate: (input: OwnedRepoInput) => Promise<OwnedRepoResult>;
  repoFetch: (id: number) => Promise<OwnedRepoResult>;
  repoBranches: (id: number) => Promise<{ ok: true; branches: string[] } | OwnedRepoFailure>;
  repoDelete: (id: number, force: boolean) => Promise<OwnedRepoResult>;
  stop: (id: number) => Promise<StopResult>;
  resume: (id: number) => Promise<LifecycleResult>;
  cleanup: (id: number) => Promise<LifecycleResult>;
  deleteTask: (id: number) => Promise<LifecycleResult>;
  pasteImage: (id: number, mime: string, bytes: Buffer) => Promise<PasteImageResult>;
  readStdin: () => Promise<Buffer>;
  // Typed, read-only repository/worktree inspection for remote controllers.
  inspectCode: (request: CodeInspectRequest) => Promise<CodeInspectResult>;
  providersList: () => ProviderSummary[];
  providersTest: (body: ProviderInput) => Promise<{ ok: true } | { ok: false; error: string }>;
  providersCreate: (body: ProviderInput) => Promise<{ ok: true; id: number } | { ok: false; error: string }>;
  providersDelete: (id: number) => Promise<{ ok: true }>;
  skillsList: () => unknown[];
  pluginsList: () => Promise<unknown[]>;
  pluginsInstall: (pluginId: string) => Promise<{ ok: true } | { ok: false; error: string }>;
  // set up THIS machine's global tdsp from its clone (symlink src + wrapper)
  install: () => { src: string; binPath: string; localBin: string; clone: string };
  // pull the machine's install (the clone behind ~/.task-dispatcher/src) to the
  // latest code and refresh its deps; a running serve picks it up on next start
  update: () => Promise<{ ok: true; clone: string; head: string } | { ok: false; error: string }>;
}

export interface ServeOpts {
  host?: string;
  hosts?: string[];
  hostCidr?: string;
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
    case "serve": {
      const f = parseFlags(argv.slice(1));
      const hosts = f.hosts
        ? f.hosts
            .split(",")
            .map((h) => h.trim())
            .filter(Boolean)
        : undefined;
      const hostCidr = f["host-cidr"] ?? f.cidr ?? f.wireguard ?? f.wg;
      try {
        await deps.serve({ host: f.host || undefined, hosts, hostCidr });
      } catch (e: any) {
        deps.err(String(e?.message || e));
        return 1;
      }
      return 0;
    }
    case "list":
      deps.out(JSON.stringify(await taskListPayload(deps.db, deps.liveness)));
      return 0;
    case "inspect-code": {
      let request: CodeInspectRequest;
      try {
        request = JSON.parse(Buffer.from(argv[1] ?? "", "base64").toString("utf8")) as CodeInspectRequest;
      } catch {
        const result = { ok: false, error: "invalidRequest", message: "inspect-code expects a base64 JSON request" };
        deps.out(JSON.stringify(result));
        return 1;
      }
      if (!isCodeInspectRequest(request)) {
        deps.out(JSON.stringify({ ok: false, error: "invalidRequest", message: "Invalid code inspection request" }));
        return 1;
      }
      const result = await deps.inspectCode(request);
      deps.out(JSON.stringify(result));
      return result.ok ? 0 : 1;
    }
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
        if (!spec || !Number.isInteger(spec.repo_id)) throw new Error("missing fields");
      } catch {
        deps.err("create: expected a base64-encoded JSON spec");
        deps.out(JSON.stringify({ ok: false, error: "invalid spec" }));
        return 1;
      }
      const r = await deps.createRepo(spec);
      deps.out(JSON.stringify(r));
      return r.ok ? 0 : 1;
    }
    case "repo-create": {
      let input: OwnedRepoInput;
      try {
        input = JSON.parse(Buffer.from(argv[1] ?? "", "base64").toString("utf8")) as OwnedRepoInput;
      } catch {
        deps.out(JSON.stringify({ ok: false, error: "invalid repo spec" }));
        return 1;
      }
      const r = await deps.repoCreate(input);
      deps.out(JSON.stringify(r));
      return r.ok ? 0 : 1;
    }
    case "repo-fetch":
    case "repo-branches":
    case "repo-delete": {
      const id = Number(argv[1]);
      if (!Number.isInteger(id)) {
        deps.out(JSON.stringify({ ok: false, error: "invalid repo id" }));
        return 1;
      }
      const r = cmd === "repo-fetch"
        ? await deps.repoFetch(id)
        : cmd === "repo-branches"
          ? await deps.repoBranches(id)
          : await deps.repoDelete(id, argv.includes("--force"));
      deps.out(JSON.stringify(r));
      return r.ok ? 0 : 1;
    }
    case "providers-list":
      deps.out(JSON.stringify({ ok: true, providers: deps.providersList() }));
      return 0;
    case "providers-test": {
      let body: ProviderInput;
      try {
        body = JSON.parse(Buffer.from(argv[1] ?? "", "base64").toString("utf8")) as ProviderInput;
      } catch {
        deps.out(JSON.stringify({ ok: false, error: "invalid provider spec" }));
        return 1;
      }
      const r = await deps.providersTest(body);
      deps.out(JSON.stringify(r));
      return r.ok ? 0 : 1;
    }
    case "providers-create": {
      let body: ProviderInput;
      try {
        body = JSON.parse(Buffer.from(argv[1] ?? "", "base64").toString("utf8")) as ProviderInput;
      } catch {
        deps.out(JSON.stringify({ ok: false, error: "invalid provider spec" }));
        return 1;
      }
      const r = await deps.providersCreate(body);
      deps.out(JSON.stringify(r));
      return r.ok ? 0 : 1;
    }
    case "providers-delete": {
      const id = Number(argv[1]);
      if (!Number.isInteger(id)) {
        deps.out(JSON.stringify({ ok: false, error: "invalid provider id" }));
        return 1;
      }
      const r = await deps.providersDelete(id);
      deps.out(JSON.stringify(r));
      return 0;
    }
    case "skills-list":
      deps.out(JSON.stringify({ ok: true, skills: deps.skillsList() }));
      return 0;
    case "plugins-list":
      deps.out(JSON.stringify({ ok: true, plugins: await deps.pluginsList() }));
      return 0;
    case "plugins-install": {
      let pluginId = "";
      try {
        pluginId = String(JSON.parse(Buffer.from(argv[1] ?? "", "base64").toString("utf8"))?.pluginId || "");
      } catch {}
      if (!pluginId) {
        deps.out(JSON.stringify({ ok: false, error: "pluginId required" }));
        return 1;
      }
      const r = await deps.pluginsInstall(pluginId);
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
    case "resume":
    case "cleanup":
    case "delete-task": {
      const id = Number(argv[1]);
      if (!Number.isInteger(id)) {
        deps.out(JSON.stringify({ ok: false, error: "invalid id" }));
        return 1;
      }
      const action = cmd === "resume" ? deps.resume : cmd === "cleanup" ? deps.cleanup : deps.deleteTask;
      const r = await action(id);
      deps.out(JSON.stringify(r));
      return r.ok ? 0 : 1;
    }
    case "paste-image": {
      const id = Number(argv[1]);
      const mime = String(argv[2] || "");
      if (!Number.isInteger(id) || !mime) {
        deps.out(JSON.stringify({ ok: false, error: "paste-image requires a task id and MIME type" }));
        return 1;
      }
      const r = await deps.pasteImage(id, mime, await deps.readStdin());
      deps.out(JSON.stringify(r));
      return r.ok ? 0 : 1;
    }
    case "doctor": {
      if (argv[1] !== "legacy") {
        deps.err("Usage: tdsp doctor legacy [--json]");
        return 1;
      }
      const report = legacyOwnershipReport(deps.db);
      if (argv.includes("--json")) deps.out(JSON.stringify(report));
      else deps.out(
        `Legacy ownership audit:\n` +
          `  remote repos      ${report.remote_repos.length}\n` +
          `  remote tasks      ${report.remote_tasks.length}\n` +
          `  remote data paths ${report.remote_data_dirs.length}\n` +
          `  orphan repos      ${report.orphan_repos.length}\n` +
          `  orphan tasks      ${report.orphan_tasks.length}`,
      );
      return 0;
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
    case "update": {
      const r = await deps.update();
      if (!r.ok) {
        if (argv.includes("--json")) deps.out(JSON.stringify(r));
        else deps.err(`update failed: ${r.error}`);
        return 1;
      }
      // The clone path is useful to the person running this node directly, but
      // is not part of the cross-node update result consumed by a controller.
      if (argv.includes("--json")) deps.out(JSON.stringify({ ok: true, head: r.head }));
      else deps.out(`tdsp updated: ${r.clone}\n  now at ${r.head}\nrestart the console to pick it up (re-run \`tdsp serve\`)`);
      return 0;
    }
    default:
      deps.err(`Usage: tdsp <serve|list|inspect-code|create-local|create|repo-create|repo-fetch|repo-branches|repo-delete|stop|resume|cleanup|delete-task|paste-image|providers-list|providers-test|providers-create|providers-delete|skills-list|plugins-list|plugins-install|doctor|install|update>\n${cmd ? `unknown command: ${cmd}` : "no command given"}`);
      return 1;
  }
}
