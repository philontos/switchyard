import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "./paths.js";
import { Host } from "./db.js";

const pexec = promisify(execFile);

export interface ExecOpts {
  cwd?: string;
  /** Extra env vars to set for THIS command (merged over the base env). */
  env?: Record<string, string>;
}

/**
 * A Runner executes work ON a machine. The local box (machine #0) runs things
 * directly; RemoteRunner wraps each call in ssh. Every git/tmux command and
 * every filesystem touch goes through a Runner, so the same orchestration code
 * can target any machine just by swapping the Runner.
 */
export interface Runner {
  kind: "local" | "ssh";
  /** This machine's ~/.task-dispatcher (absolute path ON the target machine). */
  dataDir: string;
  exec(file: string, args: string[], opts?: ExecOpts): Promise<string>;
  mkdirp(dir: string): Promise<void>;
  exists(p: string): Promise<boolean>;
  rmrf(p: string): Promise<void>;
  /** Copy a local directory tree to `dest` ON the target machine. */
  putDir(localSrc: string, dest: string): Promise<void>;
  ptySpec(file: string, args: string[]): { file: string; args: string[] };
}

export class LocalRunner implements Runner {
  kind = "local" as const;
  dataDir = DATA_DIR;

  async exec(file: string, args: string[], opts: ExecOpts = {}): Promise<string> {
    const { stdout } = await pexec(file, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      maxBuffer: 1024 * 1024 * 64,
    });
    return stdout;
  }
  async mkdirp(dir: string) { fs.mkdirSync(dir, { recursive: true }); }
  async exists(p: string) { return fs.existsSync(p); }
  async rmrf(p: string) { fs.rmSync(p, { recursive: true, force: true }); }
  async putDir(localSrc: string, dest: string) {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.cpSync(localSrc, dest, { recursive: true });
  }
  ptySpec(file: string, args: string[]) { return { file, args }; }
}

export const localRunner = new LocalRunner();

/** single-quote for a POSIX remote shell */
function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

// reuse one ssh connection per host — first connect sets up a master socket,
// later commands/probes ride it (a few ms instead of a full handshake).
const SSH_MUX = [
  "-o", "ControlMaster=auto",
  "-o", `ControlPath=${path.join(DATA_DIR, "cm-%C")}`,
  "-o", "ControlPersist=60s",
];
const SSH_BATCH = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=15"];

export class RemoteRunner implements Runner {
  kind = "ssh" as const;
  constructor(public target: string, public dataDir: string) {}

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
    return localRunner.exec("ssh", [...SSH_MUX, ...SSH_BATCH, this.target, this.remoteCmd(file, args, opts)]);
  }
  async mkdirp(dir: string) { await this.exec("mkdir", ["-p", dir]); }
  async exists(p: string) { try { await this.exec("test", ["-e", p]); return true; } catch { return false; } }
  async rmrf(p: string) { await this.exec("rm", ["-rf", p]); }

  // Stream the local dir to the remote with tar-over-ssh. We need a real pipe,
  // so this goes through a local shell (`sh -c`); each ssh arg + the remote
  // command are single-quoted for that shell, and the remote command's own
  // paths are quoted again for the remote shell. If the source dir's basename
  // differs from dest's, rename it ON THE REMOTE after extraction.
  async putDir(localSrc: string, dest: string) {
    const base = path.basename(localSrc);
    const srcParent = path.dirname(localSrc);
    const destParent = path.dirname(dest);
    const extracted = path.join(destParent, base);
    const rename = extracted === dest ? "" : ` && rm -rf ${shq(dest)} && mv ${shq(extracted)} ${shq(dest)}`;
    const remote = `mkdir -p ${shq(destParent)} && tar -C ${shq(destParent)} -xf -${rename}`;
    const sshArgs = [...SSH_MUX, ...SSH_BATCH, this.target, remote].map(shq).join(" ");
    await localRunner.exec("sh", ["-c", `tar -C ${shq(srcParent)} -cf - ${shq(base)} | ssh ${sshArgs}`]);
  }

  ptySpec(file: string, args: string[]) {
    // interactive terminal: ssh -t, no BatchMode (allow host-key/password prompts)
    const cmd = `exec ${[file, ...args].map(shq).join(" ")}`;
    return { file: "ssh", args: ["-t", ...SSH_MUX, this.target, cmd] };
  }
}

/** Pick the Runner for a machine. */
export function runnerFor(host: Host): Runner {
  if (host.kind === "local") return localRunner;
  return new RemoteRunner(host.target, host.data_dir ?? "");
}

/**
 * One ssh round-trip that proves reachability AND reports the remote home dir
 * (so we can derive its ~/.task-dispatcher). Throws if the host is unreachable.
 */
export async function sshProbe(target: string): Promise<{ home: string }> {
  const home = (await localRunner.exec("ssh", [...SSH_MUX, ...SSH_BATCH, target, 'echo "$HOME"'])).trim();
  return { home };
}
