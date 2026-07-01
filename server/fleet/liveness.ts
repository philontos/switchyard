import { db, Host } from "../core/db.js";
import { sshProbe } from "./runner.js";
import { NS } from "../core/paths.js";

/**
 * Probe one remote machine: prove reachability and, on first success, discover
 * its ~/.task-dispatcher. The local machine is always online. Updates the host
 * row's status / last_checked / data_dir.
 */
export async function probeHost(host: Host) {
  if (host.kind === "local") return;
  try {
    const { home } = await sshProbe(host.target);
    // namespace the remote root by THIS controller's ns — its data on the remote
    // lives at <remote-home>/.task-dispatcher/<ns>/, disjoint from any other
    // controller (incl. the remote's own dispatcher) sharing that machine.
    const dataDir = host.data_dir || `${home}/.task-dispatcher/${NS}`;
    db.prepare("UPDATE hosts SET status='online', last_checked=datetime('now'), data_dir=? WHERE id=?")
      .run(dataDir, host.id);
  } catch {
    db.prepare("UPDATE hosts SET status='offline', last_checked=datetime('now') WHERE id=?").run(host.id);
  }
}

/** Periodically probe every remote machine (cheap — rides the ssh ControlPersist socket). */
export function startLivenessLoop(intervalMs = 10000) {
  const tick = async () => {
    const hosts = db.prepare("SELECT * FROM hosts WHERE kind != 'local'").all() as Host[];
    await Promise.allSettled(hosts.map(probeHost));
  };
  tick();
  setInterval(tick, intervalMs);
}
