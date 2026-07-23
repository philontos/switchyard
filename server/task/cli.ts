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
import type {
  TailscaleDiagnosis,
  TailscalePeerRelayResult,
  TailscaleSetupOptions,
  TailscaleSetupResult,
  TailscaleStatus,
} from "../network/tailscale.js";
import type {
  ServeOptions,
  ServeStatus,
  ServeStopResult,
} from "../core/serve-lifecycle.js";
import type { ProfileUninstallResult } from "../fleet/profile-uninstall.js";
export { CODE_VIEW_CAPABILITY } from "../codeview/codeview.js";

// The spec A sends to `tdsp create` (base64-JSON over ssh argv, so a multiline
// prompt survives intact). The repo id belongs to the target node's own catalog;
// paths and credentials never cross the node boundary.
export interface CreateRepoSpec {
  repo_id: number;
  base: string;
  title: string;
  prompt?: string | null;
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
  serveStatus: () => ServeStatus | Promise<ServeStatus>;
  serveStop: () => ServeStopResult | Promise<ServeStopResult>;
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
  // Set up THIS machine's canonical tdsp, or a side-by-side isolated profile.
  install: (profile?: string) => {
    src: string;
    binPath: string;
    localBin: string;
    clone: string;
    profile?: string;
    dataDir?: string;
  };
  uninstall: (profile: string, purge: boolean) => Promise<ProfileUninstallResult>;
  networkStatus: () => Promise<TailscaleStatus>;
  networkSetup: (options: TailscaleSetupOptions) => Promise<TailscaleSetupResult>;
  networkDiagnose: (peer: string) => Promise<TailscaleDiagnosis>;
  networkOff: (httpsPort: number, expectedLocalPort: number) => Promise<{ ok: boolean; error?: string }>;
  networkRelayEnable: (port: number, staticEndpoints: string[]) => Promise<TailscalePeerRelayResult>;
  networkRelayDisable: () => Promise<TailscalePeerRelayResult>;
  // pull the machine's install (the clone behind ~/.task-dispatcher/src) to the
  // latest code and refresh its deps; a running serve picks it up on next start
  update: () => Promise<{ ok: true; clone: string; head: string } | { ok: false; error: string }>;
}

export type ServeOpts = ServeOptions;

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

function parsePort(value: string | undefined, fallback: number): number | null {
  if (value == null || value === "") return fallback;
  const port = Number(value);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null;
}

const SERVE_VALUE_FLAGS = new Set([
  "host",
  "hosts",
  "host-cidr",
  "cidr",
  "wireguard",
  "wg",
  "port",
  "tailscale-port",
  "https-port",
]);
const SERVE_BOOLEAN_FLAGS = new Set(["tailscale"]);

function parseServeFlags(args: string[]): { ok: true; flags: Record<string, string> } | { ok: false; error: string } {
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith("--")) {
      return { ok: false, error: `serve: unknown action or positional argument: ${arg}` };
    }
    const eq = arg.indexOf("=");
    const key = arg.slice(2, eq >= 0 ? eq : undefined);
    if (!SERVE_VALUE_FLAGS.has(key) && !SERVE_BOOLEAN_FLAGS.has(key)) {
      return { ok: false, error: `serve: unknown option: --${key}` };
    }
    if (SERVE_BOOLEAN_FLAGS.has(key)) {
      if (eq >= 0) return { ok: false, error: `serve: --${key} does not take a value` };
      flags[key] = "";
      continue;
    }
    const value = eq >= 0 ? arg.slice(eq + 1) : args[++i];
    if (!value || value.startsWith("--")) {
      return { ok: false, error: `serve: --${key} requires a value` };
    }
    flags[key] = value;
  }
  return { ok: true, flags };
}

function parseUninstallFlags(
  args: string[],
): { ok: true; profile: string; purge: boolean; json: boolean } | { ok: false; error: string } {
  let profile = "";
  let purge = false;
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--purge") {
      purge = true;
      continue;
    }
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg === "--profile" || arg.startsWith("--profile=")) {
      const value = arg === "--profile" ? args[++i] : arg.slice("--profile=".length);
      if (!value || value.startsWith("--")) {
        return { ok: false, error: "uninstall: --profile requires a value" };
      }
      profile = value;
      continue;
    }
    return {
      ok: false,
      error: arg.startsWith("--")
        ? `uninstall: unknown option: ${arg}`
        : `uninstall: unexpected positional argument: ${arg}`,
    };
  }
  if (!profile) {
    return {
      ok: false,
      error: "uninstall: --profile is required; the canonical tdsp installation is never removed by this command",
    };
  }
  return { ok: true, profile, purge, json };
}

function serveStatusText(status: ServeStatus): string {
  const headline =
    status.state === "running"
      ? "Switchyard: running"
      : status.state === "starting"
        ? "Switchyard: starting"
        : status.state === "legacy"
          ? "Switchyard: running (legacy launch)"
          : status.state === "stale"
            ? "Switchyard: stopped (stale process record)"
            : "Switchyard: stopped";
  return [
    headline,
    `  instance ${status.instance}`,
    status.pid != null ? `  PID      ${status.pid}` : "",
    status.readyAt || status.startedAt ? `  since    ${status.readyAt || status.startedAt}` : "",
    status.command ? `  command  ${status.command}` : "",
    `  data     ${status.dataDir}`,
    status.message ? `  note     ${status.message}` : "",
  ].filter(Boolean).join("\n");
}

function networkStatusText(status: TailscaleStatus): string {
  const lines = [
    `Tailscale: ${status.state}`,
    status.self?.dnsName ? `  node  ${status.self.dnsName}` : "",
    status.self?.ips?.length ? `  IP    ${status.self.ips.join(", ")}` : "",
    status.tailnet ? `  net   ${status.tailnet}` : "",
    status.health.length ? `  health ${status.health.join("; ")}` : "",
    status.error ? `  error ${status.error}` : "",
  ].filter(Boolean);
  if (status.peers.length) {
    lines.push("  peers");
    for (const peer of status.peers) {
      const address = peer.dnsName || peer.ips[0] || peer.hostName;
      lines.push(`    ${peer.online ? "●" : "○"} ${address}  ${peer.connection}`);
    }
  }
  return lines.join("\n");
}

/** Parse argv (after `tdsp`) and run the verb. Returns a process exit code. */
export async function runCli(argv: string[], deps: CliDeps): Promise<number> {
  const [cmd] = argv;
  switch (cmd) {
    case "serve": {
      const action = argv[1];
      if (action === "status") {
        const rest = argv.slice(2);
        if (rest.some((arg) => arg !== "--json")) {
          deps.err("Usage: tdsp serve status [--json]");
          return 1;
        }
        const status = await deps.serveStatus();
        deps.out(rest.includes("--json") ? JSON.stringify(status) : serveStatusText(status));
        return status.running ? 0 : 1;
      }
      if (action === "stop") {
        const rest = argv.slice(2);
        if (rest.some((arg) => arg !== "--json")) {
          deps.err("Usage: tdsp serve stop [--json]");
          return 1;
        }
        const result = await deps.serveStop();
        if (rest.includes("--json")) deps.out(JSON.stringify(result));
        else if (!result.ok) deps.err(`Switchyard stop failed: ${result.error || "unknown error"}`);
        else if (result.alreadyStopped) deps.out("Switchyard is already stopped");
        else deps.out(`Switchyard stopped${result.pid != null ? ` (PID ${result.pid})` : ""}`);
        return result.ok ? 0 : 1;
      }
      if (action === "restart") {
        if (argv.length > 2) {
          deps.err("Usage: tdsp serve restart");
          return 1;
        }
        const status = await deps.serveStatus();
        if (!status.options) {
          deps.err("serve restart: no previous managed launch found; run `tdsp serve [options]` once first");
          return 1;
        }
        const stopped = await deps.serveStop();
        if (!stopped.ok) {
          deps.err(`Switchyard restart failed: ${stopped.error || "could not stop the current process"}`);
          return 1;
        }
        try {
          await deps.serve(status.options);
        } catch (error: any) {
          deps.err(String(error?.message || error));
          return 1;
        }
        return 0;
      }

      const parsed = parseServeFlags(argv.slice(1));
      if (!parsed.ok) {
        deps.err(`${parsed.error}\nUsage: tdsp serve [--port <port>] [--host <ip>|--hosts <ips>|--host-cidr <cidr>] [--tailscale [--tailscale-port <port>]]`);
        return 1;
      }
      const f = parsed.flags;
      const hosts = f.hosts
        ? f.hosts
            .split(",")
            .map((h) => h.trim())
            .filter(Boolean)
        : undefined;
      const hostCidr = f["host-cidr"] ?? f.cidr ?? f.wireguard ?? f.wg;
      const tailscale = Object.prototype.hasOwnProperty.call(f, "tailscale");
      const port = parsePort(f.port, Number(process.env.PORT || 4500));
      const tailscaleHttpsPort = tailscale
        ? parsePort(f["tailscale-port"] ?? f["https-port"], 443)
        : undefined;
      if (port == null || (tailscale && tailscaleHttpsPort == null)) {
        deps.err("serve: ports must be integers between 1 and 65535");
        return 1;
      }
      try {
        await deps.serve({
          host: f.host || undefined,
          hosts,
          hostCidr,
          port,
          tailscale,
          tailscaleHttpsPort: tailscaleHttpsPort ?? undefined,
        });
      } catch (e: any) {
        deps.err(String(e?.message || e));
        return 1;
      }
      return 0;
    }
    case "network": {
      const action = argv[1];
      const f = parseFlags(argv.slice(2));
      const json = argv.includes("--json");
      if (action === "status") {
        const status = await deps.networkStatus();
        deps.out(json ? JSON.stringify(status) : networkStatusText(status));
        return status.state === "running" ? 0 : 1;
      }
      if (action === "setup") {
        const localPort = parsePort(f.port ?? f["local-port"], 4500);
        const httpsPort = parsePort(f["https-port"] ?? f["tailscale-port"], 443);
        if (localPort == null || httpsPort == null) {
          deps.err("network setup: ports must be integers between 1 and 65535");
          return 1;
        }
        const result = await deps.networkSetup({ localPort, httpsPort });
        if (json) deps.out(JSON.stringify(result));
        else if (result.ok) {
          deps.out(`Tailscale access ready:\n  ${result.url || "(MagicDNS name unavailable)"}\n  → http://127.0.0.1:${localPort}`);
        } else {
          deps.err(`Tailscale setup failed: ${result.error || result.status.error || "unknown error"}`);
        }
        return result.ok ? 0 : 1;
      }
      if (action === "diagnose") {
        const peer = argv[2] && !argv[2].startsWith("--") ? argv[2] : "";
        if (!peer) {
          deps.err("Usage: tdsp network diagnose <peer> [--json]");
          return 1;
        }
        const result = await deps.networkDiagnose(peer);
        if (json) deps.out(JSON.stringify(result));
        else if (result.ok) {
          deps.out(
            `Tailscale route to ${result.peer}:\n` +
              `  ${result.connection}${result.via ? ` via ${result.via}` : ""}` +
              `${result.latencyMs != null ? ` · ${result.latencyMs} ms median` : ""}\n` +
              `  UDP ${result.udp == null ? "unknown" : result.udp ? "available" : "blocked"}` +
              `${result.nearestDerp ? ` · nearest DERP ${result.nearestDerp}` : ""}`,
          );
        } else {
          deps.err(`Tailscale diagnosis failed: ${result.error || "peer unreachable"}`);
        }
        return result.ok ? 0 : 1;
      }
      if (action === "off") {
        const httpsPort = parsePort(f["https-port"] ?? f["tailscale-port"], 443);
        const localPort = httpsPort == null
          ? null
          : parsePort(f.port ?? f["local-port"], httpsPort === 443 ? 4500 : httpsPort);
        if (httpsPort == null || localPort == null) {
          deps.err("network off: ports must be integers between 1 and 65535");
          return 1;
        }
        const result = await deps.networkOff(httpsPort, localPort);
        if (json) deps.out(JSON.stringify(result));
        else if (result.ok) deps.out(`Tailscale Serve listener on :${httpsPort} removed`);
        else deps.err(`Tailscale Serve cleanup failed: ${result.error || "unknown error"}`);
        return result.ok ? 0 : 1;
      }
      if (action === "relay") {
        const relayAction = argv[2];
        if (relayAction === "enable") {
          const port = parsePort(f.port, 40000);
          if (port == null) {
            deps.err("network relay enable: port must be an integer between 1 and 65535");
            return 1;
          }
          const endpoints = (f["static-endpoints"] || "").split(",").map((value) => value.trim()).filter(Boolean);
          const result = await deps.networkRelayEnable(port, endpoints);
          if (json) deps.out(JSON.stringify(result));
          else if (result.ok) {
            deps.out(
              `Peer relay listener ready on UDP :${port}\n` +
                "Tailnet admin action still required: grant selected source devices " +
                "`tailscale.com/cap/relay` access to this relay node.",
            );
          } else deps.err(`Peer relay setup failed: ${result.error || "unknown error"}`);
          return result.ok ? 0 : 1;
        }
        if (relayAction === "disable") {
          const result = await deps.networkRelayDisable();
          if (json) deps.out(JSON.stringify(result));
          else if (result.ok) deps.out("Peer relay listener disabled");
          else deps.err(`Peer relay cleanup failed: ${result.error || "unknown error"}`);
          return result.ok ? 0 : 1;
        }
        deps.err("Usage: tdsp network relay <enable [--port 40000]|disable> [--json]");
        return 1;
      }
      deps.err("Usage: tdsp network <status|setup|diagnose <peer>|off|relay> [--json]");
      return 1;
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
      const f = parseFlags(argv.slice(1));
      const profile = f.profile?.trim() || undefined;
      if (profile && !/^[a-z0-9][a-z0-9-]{0,31}$/.test(profile)) {
        deps.err("install: profile must be 1-32 lowercase letters, numbers, or hyphens");
        return 1;
      }
      const r = deps.install(profile);
      const command = profile ? `tdsp-${profile}` : "tdsp";
      deps.out(
        `${profile ? `tdsp profile "${profile}" installed` : "tdsp installed"}:\n` +
          `  code   ${r.src} -> ${r.clone}\n` +
          (r.dataDir ? `  data   ${r.dataDir}\n` : "") +
          `  command ${r.binPath}\n` +
          `  on PATH ${r.localBin}  (ensure ~/.local/bin is on your PATH)\n` +
          `  state  installed only (no server was started)\n` +
          `next: start with \`${command} serve${profile ? " --port <unused-port>" : ""}\`, then check \`${command} serve status\`\n` +
          (profile ? `remove: stop it, then run \`tdsp uninstall --profile ${profile}\`\n` : "") +
          `remote check: \`ssh <host> ${r.binPath} list\``,
      );
      return 0;
    }
    case "uninstall": {
      const parsed = parseUninstallFlags(argv.slice(1));
      if (!parsed.ok) {
        deps.err(`${parsed.error}\nUsage: tdsp uninstall --profile <name> [--purge] [--json]`);
        return 1;
      }
      if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(parsed.profile)) {
        deps.err("uninstall: profile must be 1-32 lowercase letters, numbers, or hyphens");
        return 1;
      }
      const result = await deps.uninstall(parsed.profile, parsed.purge);
      if (parsed.json) {
        deps.out(JSON.stringify(result));
        return result.ok ? 0 : 1;
      }
      if (!result.ok) {
        deps.err(`uninstall failed: ${result.message || result.error || "unknown error"}`);
        return 1;
      }
      const lines = [
        result.alreadyAbsent
          ? `tdsp profile "${parsed.profile}" is already uninstalled`
          : `tdsp profile "${parsed.profile}" uninstalled`,
        result.alreadyAbsent
          ? ""
          : result.purged
            ? "  data     permanently deleted (--purge)"
            : result.archivedAt
              ? `  data     archived at ${result.archivedAt}`
              : "",
        result.launcherRemoved ? `  command  tdsp-${parsed.profile} removed` : "",
        result.networkRoutesRemoved
          ? `  network  removed ${result.networkRoutesRemoved} Tailscale Serve route${result.networkRoutesRemoved === 1 ? "" : "s"}`
          : "",
        ...(result.warnings || []).map((warning) => `  warning  ${warning}`),
      ].filter(Boolean);
      deps.out(lines.join("\n"));
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
      else deps.out(`tdsp updated: ${r.clone}\n  now at ${r.head}\nrestart the console to pick it up (\`tdsp serve restart\`, or re-run \`tdsp serve\`)`);
      return 0;
    }
    default:
      deps.err(`Usage: tdsp <serve [status|stop|restart]|network|list|inspect-code|create-local|create|repo-create|repo-fetch|repo-branches|repo-delete|stop|resume|cleanup|delete-task|paste-image|providers-list|providers-test|providers-create|providers-delete|doctor|install|uninstall|update>\n${cmd ? `unknown command: ${cmd}` : "no command given"}`);
      return 1;
  }
}
