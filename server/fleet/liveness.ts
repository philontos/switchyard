import { db, Host } from "../core/db.js";
import { sshProbe } from "./runner.js";

/**
 * Probe one remote machine for transport reachability. Runtime data paths belong
 * to the node itself and are never derived or stored by another node.
 */
export async function probeHost(host: Host) {
  if (host.kind === "local") return;
  try {
    await sshProbe(host.target, host.managed_ssh === 1, host.ssh_port || 22);
    db.prepare("UPDATE hosts SET status='online', ssh_ready=1, last_checked=datetime('now') WHERE id=?").run(host.id);
  } catch {
    db.prepare("UPDATE hosts SET status='offline', ssh_ready=0, last_checked=datetime('now') WHERE id=?").run(host.id);
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
