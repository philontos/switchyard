// Shared server context: the prepared statements + cross-cutting helpers +
// resolved binaries that the HTTP routes, the preview proxy, and the pty bridge
// all lean on. Lifted verbatim out of the old monolithic index.ts.
import fs from "node:fs";
import { db, Task, Host, Provider } from "../core/db.js";
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

// Local HTTP routes can resolve only this node's own rows. Historical rows that
// point at another host stay available to the legacy auditor, but no normal API
// can operate on them.
export const getRepo = db.prepare(
  "SELECT r.* FROM repos r JOIN hosts h ON h.id=r.host_id WHERE r.id=? AND h.kind='local'",
);
export const getTask = db.prepare(
  "SELECT t.* FROM tasks t " +
    "LEFT JOIN hosts th ON th.id=t.host_id " +
    "LEFT JOIN repos r ON r.id=t.repo_id LEFT JOIN hosts rh ON rh.id=r.host_id " +
    "WHERE t.id=? AND ((t.kind='local' AND th.kind='local') OR (t.kind!='local' AND rh.kind='local'))",
);
export const getHost = db.prepare("SELECT * FROM hosts WHERE id = ?");
export const getProvider = db.prepare("SELECT * FROM providers WHERE id = ?");

// Transport guard for a registered remote node.
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
  writeTaskManifest(DATA_DIR, t);
}

// matches dispatcher-owned sessions: tdsp-[<ns>-]<id>[-slug] (+ legacy task-N).
// the optional <ns> segment is this local Switchyard instance's namespace (a-z0-9).
export const SESSION_RE = /^(tdsp|task)-([a-z0-9]+-)?\d+(-[a-z0-9-]+)?$/;
