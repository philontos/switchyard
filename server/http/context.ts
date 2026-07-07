// Shared server context: the prepared statements + cross-cutting helpers +
// resolved binaries that the HTTP routes, the preview proxy, and the pty bridge
// all lean on. Lifted verbatim out of the old monolithic index.ts.
import fs from "node:fs";
import { db, Repo, Task, Host, Provider } from "../core/db.js";
import { localRunner, runnerFor } from "../fleet/runner.js";
import { writeTaskManifest } from "../task/taskmanifest.js";
import { DATA_DIR } from "../core/paths.js";
export { str, providerEnv, checkProvider } from "../provider/providers.js";

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
