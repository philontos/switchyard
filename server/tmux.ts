import { Runner } from "./runner.js";

async function tmux(runner: Runner, args: string[]): Promise<string> {
  return runner.exec("tmux", args);
}

/**
 * Start a detached tmux session running claude in the worktree.
 * If a prompt is given it is passed as claude's initial message; the
 * session stays interactive (TUI), so permission prompts work normally.
 */
export async function startSession(runner: Runner, session: string, cwd: string, prompt?: string | null) {
  const cmd = ["new-session", "-d", "-s", session, "-c", cwd, "claude"];
  if (prompt && prompt.trim()) cmd.push(prompt);
  await tmux(runner, cmd);
  // keep the pane around if claude exits so the user can read the result
  await tmux(runner, ["set-option", "-t", session, "remain-on-exit", "on"]).catch(() => {});
}

/**
 * Start a detached bare-shell tmux session (the login shell, no command) in cwd.
 * Used by the local quick task: a throwaway terminal where the user cd's and
 * runs claude (or anything) themselves — deliberately more general than
 * auto-launching claude.
 */
export async function startShellSession(runner: Runner, session: string, cwd: string) {
  await tmux(runner, ["new-session", "-d", "-s", session, "-c", cwd]);
  // keep the pane around if the shell exits so the user can read the result
  await tmux(runner, ["set-option", "-t", session, "remain-on-exit", "on"]).catch(() => {});
}

export async function hasSession(runner: Runner, session: string): Promise<boolean> {
  try {
    await tmux(runner, ["has-session", "-t", session]);
    return true;
  } catch {
    return false;
  }
}

export async function killSession(runner: Runner, session: string) {
  await tmux(runner, ["kill-session", "-t", session]).catch(() => {});
}

/**
 * Force the session's active pane out of copy/scroll mode so a client attaching
 * next lands on the live prompt instead of stale scrollback. `-X cancel` is a
 * copy-mode COMMAND, not a keystroke: in copy-mode it exits, and when the pane
 * is NOT in a mode tmux just errors and inserts nothing — unlike a literal `q`,
 * which would be typed into claude's prompt. Best-effort, so errors are ignored.
 */
export async function cancelCopyMode(runner: Runner, session: string) {
  await tmux(runner, ["send-keys", "-t", session, "-X", "cancel"]).catch(() => {});
}

/**
 * Inject text into a session's input as a BRACKETED PASTE (not keystrokes), so
 * Claude Code treats a pasted image path the way it treats a real drag/paste —
 * converting it to an inline [Image #N] attachment (verified: typed keystrokes
 * route through the Read tool instead, a bracketed paste attaches directly). A
 * named buffer keeps the user's paste buffers untouched; -d removes it after.
 * No trailing newline, so it never auto-submits — the user adds text and Enters.
 */
export async function pasteText(runner: Runner, session: string, text: string) {
  await tmux(runner, ["set-buffer", "-b", "tdsp-paste", "--", text]);
  await tmux(runner, ["paste-buffer", "-t", session, "-b", "tdsp-paste", "-p", "-d"]);
}

/** List all dispatcher-owned tmux sessions (named task-<id>). */
export async function listSessions(runner: Runner): Promise<string[]> {
  try {
    const out = await tmux(runner, ["list-sessions", "-F", "#{session_name}"]);
    return out.split("\n").map((s) => s.trim()).filter((s) => /^(tdsp|task)-\d+(-[a-z0-9-]+)?$/.test(s));
  } catch {
    return []; // no server / no sessions
  }
}
