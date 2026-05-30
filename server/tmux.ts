import { execFile } from "node:child_process";
import { promisify } from "node:util";

const pexec = promisify(execFile);

async function tmux(args: string[]) {
  const { stdout } = await pexec("tmux", args);
  return stdout;
}

/**
 * Start a detached tmux session running claude in the worktree.
 * If a prompt is given it is passed as claude's initial message; the
 * session stays interactive (TUI), so permission prompts work normally.
 */
export async function startSession(session: string, cwd: string, prompt?: string | null) {
  const cmd = ["new-session", "-d", "-s", session, "-c", cwd, "claude"];
  if (prompt && prompt.trim()) cmd.push(prompt);
  await tmux(cmd);
  // keep the pane around if claude exits so the user can read the result
  await tmux(["set-option", "-t", session, "remain-on-exit", "on"]).catch(() => {});
}

export async function hasSession(session: string): Promise<boolean> {
  try {
    await tmux(["has-session", "-t", session]);
    return true;
  } catch {
    return false;
  }
}

export async function killSession(session: string) {
  await tmux(["kill-session", "-t", session]).catch(() => {});
}
