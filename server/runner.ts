import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";

const pexec = promisify(execFile);

export interface ExecOpts {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

/**
 * A Runner executes work ON a machine. The local box (machine #0) runs things
 * directly; a future RemoteRunner will wrap each call in ssh. Every git/tmux
 * command and every filesystem touch goes through a Runner, so the same
 * orchestration code can target any machine just by swapping the Runner.
 */
export interface Runner {
  kind: "local" | "ssh";
  /** Run a one-shot command and return its stdout. */
  exec(file: string, args: string[], opts?: ExecOpts): Promise<string>;
  /** `mkdir -p`. */
  mkdirp(dir: string): Promise<void>;
  /** Does a path exist? */
  exists(p: string): Promise<boolean>;
  /** `rm -rf`. */
  rmrf(p: string): Promise<void>;
  /**
   * Build the (file, args) to hand to node-pty for an interactive terminal.
   * Local: passthrough. Remote: an `ssh -t` wrapper. (The pty bridge wires this
   * up in a later step; defined here so the abstraction is complete.)
   */
  ptySpec(file: string, args: string[]): { file: string; args: string[] };
}

/** The machine the dispatcher itself runs on — direct child_process + fs. */
export class LocalRunner implements Runner {
  kind = "local" as const;

  async exec(file: string, args: string[], opts: ExecOpts = {}): Promise<string> {
    const { stdout } = await pexec(file, args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      maxBuffer: 1024 * 1024 * 64,
    });
    return stdout;
  }

  async mkdirp(dir: string): Promise<void> {
    fs.mkdirSync(dir, { recursive: true });
  }

  async exists(p: string): Promise<boolean> {
    return fs.existsSync(p);
  }

  async rmrf(p: string): Promise<void> {
    fs.rmSync(p, { recursive: true, force: true });
  }

  ptySpec(file: string, args: string[]): { file: string; args: string[] } {
    return { file, args };
  }
}

export const localRunner = new LocalRunner();
