import { execFile } from "node:child_process";
import { promisify } from "node:util";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "../core/paths.js";
import { Host } from "../core/db.js";
import { sshIdentityPaths } from "../network/ssh-identity.js";

const pexec = promisify(execFile);

export interface ExecOpts {
  cwd?: string;
  /** Extra env vars to set for THIS command (merged over the base env). */
  env?: Record<string, string>;
  /** Bound captured stdout/stderr for read-heavy commands such as code previews. */
  maxBuffer?: number;
}

/** Minimal command transport used by bootstrap and interactive tmux relays. */
export interface CommandRunner {
  kind: "local" | "ssh";
  exec(file: string, args: string[], opts?: ExecOpts): Promise<string>;
}

/**
 * Owner-local process/filesystem primitives. Repo/task domain services require
 * this fuller interface; RemoteRunner intentionally cannot satisfy it.
 */
export interface Runner extends CommandRunner {
  /** This local instance's namespaced data directory. */
  dataDir: string;
  mkdirp(dir: string): Promise<void>;
  exists(p: string): Promise<boolean>;
  /** Read a local text file; null if it is missing. */
  readText(p: string): Promise<string | null>;
  rmrf(p: string): Promise<void>;
  /** Copy a local directory tree to another local path. */
  putDir(localSrc: string, dest: string): Promise<void>;
  /** Copy a local file to another local path. */
  putFile(localSrc: string, dest: string): Promise<void>;
}

export class LocalRunner implements Runner {
  kind = "local" as const;
  dataDir = DATA_DIR;

  async exec(file: string, args: string[], opts: ExecOpts = {}): Promise<string> {
    const { stdout } = await pexec(file, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      maxBuffer: opts.maxBuffer ?? 1024 * 1024 * 64,
    });
    return stdout;
  }
  async mkdirp(dir: string) { fs.mkdirSync(dir, { recursive: true }); }
  async exists(p: string) { return fs.existsSync(p); }
  async readText(p: string) { try { return fs.readFileSync(p, "utf8"); } catch { return null; } }
  async rmrf(p: string) { fs.rmSync(p, { recursive: true, force: true }); }
  async putDir(localSrc: string, dest: string) {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.cpSync(localSrc, dest, { recursive: true });
  }
  async putFile(localSrc: string, dest: string) {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(localSrc, dest);
  }
}

export const localRunner = new LocalRunner();

/** single-quote for a POSIX remote shell */
function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

// Reuse one SSH connection per host. Unix-domain socket paths are capped at
// roughly 104 bytes on macOS; an isolated profile's DATA_DIR is intentionally
// deep, so placing `cm-%C` below it makes every SSH command fail before dialing.
// Hash the instance identity into a short /tmp path instead. /tmp is sticky and
// OpenSSH creates an owner-only socket; uid + data-dir hash prevent cross-user
// and cross-profile collisions.
export function sshControlPath(
  dataDir: string = DATA_DIR,
  uid: string | number = typeof process.getuid === "function" ? process.getuid() : "user",
  managed = false,
): string {
  if (process.platform === "win32") return path.join(dataDir, "cm-%C");
  const scope = crypto.createHash("sha256").update(dataDir).digest("hex").slice(0, 12);
  return `/tmp/tdsp-${uid}-${scope}${managed ? "-m" : ""}-%C`;
}

// First connect sets up a master socket; later commands/probes ride it (a few
// milliseconds instead of a full handshake).
const SSH_BATCH = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=15"];

/** ssh args (connection reuse + non-interactive) for one-off remote commands like
 *  the fleet's `ssh <node> tdsp list` — same muxing/batching the Runner uses. */
export function sshBaseArgs(managed = false, port = 22): string[] {
  const identityPaths = sshIdentityPaths(DATA_DIR);
  const mux = [
    "-o", "ControlMaster=auto",
    "-o", `ControlPath=${sshControlPath(DATA_DIR, typeof process.getuid === "function" ? process.getuid() : "user", managed)}`,
    "-o", "ControlPersist=60s",
  ];
  const identity = managed
    ? [
        "-o", "IdentitiesOnly=yes",
        "-i", identityPaths.privateKeyPath,
        // The Tailscale peer identity + same-user handshake authenticates the
        // network destination. Keep TOFU host keys in this profile's private
        // file so first use is non-interactive without weakening ~/.ssh.
        "-o", "StrictHostKeyChecking=accept-new",
        "-o", `UserKnownHostsFile=${path.join(identityPaths.dir, "known_hosts")}`,
      ]
    : [];
  const portArgs = port !== 22 ? ["-p", String(port)] : [];
  return [...mux, ...SSH_BATCH, ...identity, ...portArgs];
}

export const SSH_BASE_ARGS = sshBaseArgs();

export class RemoteRunner implements CommandRunner {
  kind = "ssh" as const;
  constructor(public target: string, public managed = false, public port = 22) {}

  // just forward: optional cd; per-command env prefix; the exec'd command —
  // joined into one remote shell command string. PATH/toolchain resolution is
  // the remote's job (the user's ssh/shell config), not ours.
  private remoteCmd(file: string, args: string[], opts: ExecOpts): string {
    const parts: string[] = [];
    if (opts.cwd) parts.push(`cd ${shq(opts.cwd)}`);
    const envPrefix = Object.entries(opts.env ?? {}).map(([k, v]) => `${k}=${shq(v)}`).join(" ");
    parts.push(`${envPrefix} ${[file, ...args].map(shq).join(" ")}`.trim());
    return parts.join("; ");
  }

  async exec(file: string, args: string[], opts: ExecOpts = {}): Promise<string> {
    return localRunner.exec("ssh", [...sshBaseArgs(this.managed, this.port), this.target, this.remoteCmd(file, args, opts)], {
      maxBuffer: opts.maxBuffer,
    });
  }
}

/** SSH transport runner; do not use it as a remote repo/task service. */
export function transportRunnerFor(host: Host): CommandRunner {
  if (host.kind === "local") return localRunner;
  return new RemoteRunner(host.target, host.managed_ssh === 1, host.ssh_port || 22);
}

/** One SSH round-trip that proves transport reachability. */
export async function sshProbe(target: string, managed = false, port = 22): Promise<void> {
  await localRunner.exec("ssh", [...sshBaseArgs(managed, port), target, "true"]);
}
