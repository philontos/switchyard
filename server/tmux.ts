import { Runner } from "./runner.js";

async function tmux(runner: Runner, args: string[]): Promise<string> {
  return runner.exec("tmux", args);
}

/**
 * Start a detached tmux session running claude in the worktree.
 * If a prompt is given it is passed as claude's initial message; the
 * session stays interactive (TUI), so permission prompts work normally.
 */
export async function startSession(
  runner: Runner,
  session: string,
  cwd: string,
  prompt?: string | null,
  opts?: { continue?: boolean },
) {
  // resume reattaches to the prior conversation: claude keys its transcript by
  // cwd, so launching `claude --continue` from the same worktree reopens it. The
  // original opening prompt is NOT re-sent — the conversation already has it.
  const launch = opts?.continue ? ["claude", "--continue"] : ["claude"];
  const cmd = ["new-session", "-d", "-s", session, "-c", cwd, ...launch];
  if (prompt && prompt.trim() && !opts?.continue) cmd.push(prompt);
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
  if (!session || !session.trim()) return false;
  try {
    // "=" forces exact match — otherwise tmux prefix-matches and "tdsp-1" would be
    // reported live whenever "tdsp-12" exists (a wrong green/alive light).
    await tmux(runner, ["has-session", "-t", "=" + session]);
    return true;
  } catch {
    return false;
  }
}

export async function killSession(runner: Runner, session: string) {
  // An empty target makes tmux kill the CURRENT/most-recent session — so a task
  // whose session was never set (a failed dispatch stores "") would, on cleanup,
  // tear down whatever session you're actively using. Never let "" reach tmux.
  if (!session || !session.trim()) return;
  // "=" forces an exact-match target; without it tmux prefix-matches, so killing
  // "tdsp-1" could also catch "tdsp-12".
  await tmux(runner, ["kill-session", "-t", "=" + session]).catch(() => {});
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
    return out.split("\n").map((s) => s.trim()).filter((s) => /^(tdsp|task)-([a-z0-9]+-)?\d+(-[a-z0-9-]+)?$/.test(s));
  } catch {
    return []; // no server / no sessions
  }
}
