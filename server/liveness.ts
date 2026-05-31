import { db, Host } from "./db.js";
import { sshProbe } from "./runner.js";

/**
 * Probe one remote machine: prove reachability and, on first success, discover
 * its ~/.task-dispatcher. The local machine is always online. Updates the host
 * row's status / last_checked / data_dir.
 */
export async function probeHost(host: Host) {
  if (host.kind === "local") return;
  try {
    const { home } = await sshProbe(host.target);
    const dataDir = host.data_dir || `${home}/.task-dispatcher`;
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
