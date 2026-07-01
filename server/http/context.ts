// Shared server context: the prepared statements + cross-cutting helpers +
// resolved binaries that the HTTP routes, the preview proxy, and the pty bridge
// all lean on. Lifted verbatim out of the old monolithic index.ts.
import fs from "node:fs";
import { db, Repo, Task, Host, Provider } from "../core/db.js";
import { localRunner, runnerFor } from "../fleet/runner.js";
import { writeTaskManifest } from "../task/taskmanifest.js";
import { DATA_DIR } from "../core/paths.js";

// resolve tmux to an absolute path — node-pty's spawn-helper does not honor a
// mutated PATH, so a bare "tmux" fails with posix_spawnp on stripped envs.
export const TMUX_BIN =
  ["/opt/homebrew/bin/tmux", "/usr/local/bin/tmux", "/usr/bin/tmux"].find((p) => fs.existsSync(p)) ||
  "tmux";

// node-pty's spawn-helper ignores a mutated PATH, so resolve ssh/mosh to
// absolute paths the same way (used for remote machine terminals).
function resolveBin(name: string, candidates: string[]) {
  return candidates.find((p) => fs.existsSync(p)) || name;
}
export const SSH_BIN = resolveBin("ssh", ["/usr/bin/ssh", "/opt/homebrew/bin/ssh"]);
export const MOSH_BIN = resolveBin("mosh", ["/opt/homebrew/bin/mosh", "/usr/local/bin/mosh", "/usr/bin/mosh"]);

export const getRepo = db.prepare("SELECT * FROM repos WHERE id = ?");
export const getTask = db.prepare("SELECT * FROM tasks WHERE id = ?");
export const getHost = db.prepare("SELECT * FROM hosts WHERE id = ?");
export const getProvider = db.prepare("SELECT * FROM providers WHERE id = ?");

// trim a body field to a non-empty string, or null — providers store the
// optional ANTHROPIC_* values, and "" must round-trip to NULL (== "unset").
export const str = (v: unknown): string | null => {
  const s = (v ?? "").toString().trim();
  return s || null;
};

// Map a provider row to the env claude is launched with. Only set the vars that
// are present, so a provider can override just the model, just the endpoint, etc.
// Returns undefined when there's nothing to inject (→ default claude login).
export function providerEnv(p?: Provider): Record<string, string> | undefined {
  if (!p) return undefined;
  const env: Record<string, string> = {};
  if (p.base_url) env.ANTHROPIC_BASE_URL = p.base_url;
  if (p.auth_token) env.ANTHROPIC_AUTH_TOKEN = p.auth_token;
  if (p.model) env.ANTHROPIC_MODEL = p.model;
  if (p.small_fast_model) env.ANTHROPIC_SMALL_FAST_MODEL = p.small_fast_model;
  return Object.keys(env).length ? env : undefined;
}

// Format + reachability gate for a provider, shared by the test endpoint (green
// light) and the create endpoint (enforced on save). The reachability probe
// mirrors EXACTLY how claude will call the backend at runtime — same
// `Authorization: Bearer <token>` and same `<base_url>/v1/messages` path we
// inject as ANTHROPIC_AUTH_TOKEN/ANTHROPIC_BASE_URL — so a green here means
// claude can actually reach the model. A one-token ping keeps it cheap.
export async function checkProvider(body: any): Promise<{ ok: true } | { ok: false; error: string }> {
  const baseUrl = str(body?.base_url);
  const token = str(body?.auth_token);
  const model = str(body?.model);
  if (!baseUrl) return { ok: false, error: "base_url required" };
  let u: URL;
  try { u = new URL(baseUrl); } catch { return { ok: false, error: "invalid base_url" }; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return { ok: false, error: "base_url must be http(s)" };
  if (!token) return { ok: false, error: "auth_token required" };
  if (!model) return { ok: false, error: "model required" };

  const endpoint = baseUrl.replace(/\/+$/, "") + "/v1/messages";
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 12000);
  try {
    const r = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({ model, max_tokens: 1, messages: [{ role: "user", content: "ping" }] }),
      signal: ctl.signal,
    });
    if (r.ok) return { ok: true };
    // surface the backend's own error message so the user can act on it
    let detail = "";
    try { const j: any = await r.json(); detail = j?.error?.message || j?.message || ""; } catch { /* non-JSON body */ }
    return { ok: false, error: `HTTP ${r.status}${detail ? ": " + detail : ""}` };
  } catch (e: any) {
    return { ok: false, error: e?.name === "AbortError" ? "timeout" : String(e?.message || e) };
  } finally {
    clearTimeout(timer);
  }
}

// the Runner for a task's machine — local or remote(ssh/mosh)
export function taskRunner(task: Task) {
  const host = taskHost(task);
  return host ? runnerFor(host) : localRunner;
}

// the machine a task lives on — for attach + the offline write-guard. Shell
// tasks (kind='local') carry host_id directly; repo tasks resolve via their repo.
export function taskHost(task: Task): Host | undefined {
  if (task.host_id != null) return getHost.get(task.host_id) as Host | undefined;
  const repo = getRepo.get(task.repo_id) as Repo | undefined;
  return repo ? (getHost.get(repo.host_id) as Host | undefined) : undefined;
}

// a write that must run ON a machine is refused while that machine is offline
// (the local machine is always reachable). Reads stay allowed.
export function offline(host: Host | undefined): boolean {
  return !!host && host.kind !== "local" && host.status !== "online";
}

// Write-convergence: every task mutation funnels through here so the on-disk
// manifest (the durable, edge-resident truth) mirrors the row. We only write the
// manifest for tasks THIS machine owns — a task running on a remote is owned and
// manifested by that machine's own tdsp (once control sinks to the edge), never
// stamped into this controller's data dir.
export function syncTaskManifest(id: number) {
  const t = getTask.get(id) as Task | undefined;
  if (!t) return;
  const host = taskHost(t);
  if (!host || host.kind === "local") writeTaskManifest(DATA_DIR, t);
}

export function slug(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "task";
}

// matches dispatcher-owned sessions: tdsp-[<ns>-]<id>[-slug] (+ legacy task-N).
// the optional <ns> segment is this controller's namespace (a-z0-9).
export const SESSION_RE = /^(tdsp|task)-([a-z0-9]+-)?\d+(-[a-z0-9-]+)?$/;
