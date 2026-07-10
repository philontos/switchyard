import { Runner } from "../fleet/runner.js";
import { agentArgv, type AgentKind } from "./agent.js";

async function tmux(runner: Runner, args: string[]): Promise<string> {
  return runner.exec("tmux", args);
}

function absGitPath(cwd: string, p: string): string {
  const s = p.trim();
  if (!s || s.startsWith("/")) return s;
  return `${cwd.replace(/\/+$/, "")}/${s.replace(/^\.\//, "")}`;
}

async function gitPath(runner: Runner, cwd: string, flag: "--git-dir" | "--git-common-dir"): Promise<string | null> {
  try {
    return (await runner.exec("git", ["-C", cwd, "rev-parse", "--path-format=absolute", flag])).trim();
  } catch {
    try {
      const p = (await runner.exec("git", ["-C", cwd, "rev-parse", flag])).trim();
      return absGitPath(cwd, p);
    } catch {
      return null;
    }
  }
}

async function codexWritableGitDirs(runner: Runner, cwd: string, agent: AgentKind): Promise<string[]> {
  if (agent !== "codex") return [];
  const dirs = await Promise.all([
    gitPath(runner, cwd, "--git-dir"),
    gitPath(runner, cwd, "--git-common-dir"),
  ]);
  return [...new Set(dirs.filter((d): d is string => !!d))];
}

/**
 * Build an `env K=V ...` prefix that sets per-session vars directly on the
 * launched process. `tmux new-session` does NOT propagate arbitrary env vars
 * into a new session (only its `update-environment` allowlist), so we can't
 * count on the spawn's own environment reaching claude — we prepend an `env`
 * command that sets them on the claude process itself. Used to point claude at
 * an alternate model backend (ANTHROPIC_BASE_URL / _AUTH_TOKEN / _MODEL …).
 * Empty/blank values are dropped; each `K=V` is one argv element, so values
 * with spaces need no quoting here (the Runner re-quotes every arg for a remote
 * shell). Returns [] when there's nothing to inject, so the default launch is
 * byte-for-byte unchanged.
 */
function envPrefix(env?: Record<string, string>): string[] {
  const pairs = Object.entries(env ?? {})
    .filter(([, v]) => v != null && v !== "")
    .map(([k, v]) => `${k}=${v}`);
  return pairs.length ? ["env", ...pairs] : [];
}

/**
 * Start a detached tmux session running the agent (claude by default, or codex)
 * in the worktree. If a prompt is given it is passed as the agent's initial
 * message; the session stays interactive (TUI). opts.env injects environment for
 * the process (claude's alternate provider). opts.model picks a codex model.
 * How to launch/resume each agent lives in agentArgv — this stays agent-agnostic.
 */
export async function startSession(
  runner: Runner,
  session: string,
  cwd: string,
  prompt?: string | null,
  opts?: { continue?: boolean; env?: Record<string, string>; agent?: AgentKind; model?: string | null },
) {
  // resume reattaches to the prior conversation (both agents key it by cwd:
  // `claude --continue` / `codex resume --last`). The original opening prompt is
  // NOT re-sent — the conversation already has it. The env prefix (provider) goes
  // BEFORE the agent argv so the vars land on the agent process.
  const agent = opts?.agent ?? "claude";
  const pre = envPrefix(opts?.env);
  const addDirs = await codexWritableGitDirs(runner, cwd, agent);
  const launch = agentArgv(agent, { prompt, model: opts?.model, resume: opts?.continue, addDirs });
  const cmd = ["new-session", "-d", "-s", session, "-c", cwd, ...pre, ...launch];
  await tmux(runner, cmd);
  await ensureSessionOptions(runner, session);
}

/**
 * Start a detached bare-shell tmux session (the login shell, no command) in cwd.
 * Used by the local quick task: a throwaway terminal where the user cd's and
 * runs claude (or anything) themselves — deliberately more general than
 * auto-launching claude.
 */
export async function startShellSession(runner: Runner, session: string, cwd: string) {
  await tmux(runner, ["new-session", "-d", "-s", session, "-c", cwd]);
  await ensureSessionOptions(runner, session);
}

/**
 * Normalize the tmux options Switchyard relies on for its web terminal. User/global
 * tmux config differs across machines; in particular `mouse off` makes trackpad
 * wheel gestures fall through as Up/Down keys in Codex, which flips prompt history
 * instead of scrolling. A second problem is tmux's `window-size latest`: when a
 * browser and a direct SSH attach have different dimensions, merely typing in the
 * other client resizes the shared window. Codex then redraws at alternating widths,
 * so its right border disappears and the whole TUI visibly squeezes back and forth.
 * `smallest` keeps the shared pane inside every attached client; when a narrow client
 * detaches, tmux automatically grows to the next-smallest one.
 *
 * Set these on every dispatcher-owned session and again when attaching an older
 * session. Each command stays best-effort for older tmux versions.
 */
export async function ensureSessionOptions(runner: Runner, session: string) {
  // keep the pane around if the agent/shell exits so the user can read the result
  await tmux(runner, ["set-option", "-t", session, "remain-on-exit", "on"]).catch(() => {});
  await tmux(runner, ["set-option", "-t", session, "mouse", "on"]).catch(() => {});
  await tmux(runner, ["set-window-option", "-t", session, "window-size", "smallest"]).catch(() => {});
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

/**
 * Mobile quick-input submits a complete message to the real tmux pane, not to
 * the browser's attach client. Pasting handles arbitrary Unicode/newlines as one
 * input; send-keys Enter then submits it as a real terminal Enter.
 */
export async function pasteSubmit(runner: Runner, session: string, text: string) {
  if (text) await pasteText(runner, session, text);
  await tmux(runner, ["send-keys", "-t", session, "Enter"]);
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
