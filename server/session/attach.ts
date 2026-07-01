import type { Host } from "../core/db.js";

export interface AttachBins { ssh: string; mosh: string; tmux: string; }

// Build the node-pty argv that attaches a terminal to tmux `session` on `host`'s
// machine. Local (or no host) → attach with local tmux. Remote → node-pty spawns
// ssh/mosh locally and we attach to the session ON the remote; the shell, tmux,
// and files all live there, this box is just the relay.
export function attachCommand(host: Host | undefined, session: string, bins: AttachBins): { file: string; args: string[]; label: string } {
  if (host && host.kind !== "local") {
    const remote = `exec tmux attach -t ${session}`;
    const label = `${host.target} ${session}`;
    return host.kind === "mosh"
      ? { file: bins.mosh, args: [host.target, "--", "sh", "-c", remote], label }
      : { file: bins.ssh, args: ["-t", host.target, remote], label };
  }
  return { file: bins.tmux, args: ["attach", "-t", session], label: session };
}
