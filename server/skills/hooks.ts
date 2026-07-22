// Per-task Claude Code hooks, injected into the worktree's
// .claude/settings.local.json at dispatch. They let a session report when it is
// blocked on the user (a tool permission prompt → the card's yellow light) and
// when it resumes — by touching / removing a marker file IN ITS OWN WORKTREE
// (.claude/waiting). The owning node reads that marker locally and includes the
// boolean in its fleet payload, so no controller probes another node's path.
//
// Why a file and not an HTTP ping: the session and Switchyard node share the
// same machine. A local marker needs no callback service, and the node's existing
// fleet response carries the resulting state to any controller.

/**
 * settings.local.json content for one task, given the worktree's ABSOLUTE path
 * on the target machine. The hook command can never fail the session (`|| true`)
 * and touches only a local file (no network, no timeout needed).
 *   Notification (permission_prompt) → touch .claude/waiting   (yellow)
 *   PostToolUse / UserPromptSubmit / Stop → rm -f .claude/waiting
 *                              (a tool ran / user replied / turn ended → cleared)
 *   SessionStart → write the Claude session id to .claude/session-id
 *                  (so the dispatcher can show it above the task; see below)
 */
export function hookSettingsJson(worktreePath: string): string {
  const marker = `${worktreePath}/.claude/waiting`;
  const wait = `touch "${marker}" >/dev/null 2>&1 || true`;
  const clear = `rm -f "${marker}" >/dev/null 2>&1 || true`;
  // SessionStart's hook input arrives as JSON on stdin (no env var for it). Pull
  // session_id out with a pure-shell sed — robust whether the JSON is compact or
  // pretty-printed (the key and its value always share a line) — and write it to
  // .claude/session-id. SessionStart re-fires on --continue/--resume/clear, and a
  // resumed id is unchanged, so the file stays correct across the Resume button.
  // Never fails the session (trailing `; true`), like the markers above.
  const sidFile = `${worktreePath}/.claude/session-id`;
  const captureSid =
    `s=$(sed -n 's/.*"session_id"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p' | head -n1); ` +
    `[ -n "$s" ] && printf %s "$s" > "${sidFile}" 2>/dev/null; true`;
  const hook = (command: string, matcher = "") =>
    [{ matcher, hooks: [{ type: "command", command }] }];
  return JSON.stringify(
    {
      hooks: {
        Notification: hook(wait, "permission_prompt"),
        PostToolUse: hook(clear),
        UserPromptSubmit: hook(clear),
        Stop: hook(clear),
        SessionStart: hook(captureSid),
      },
    },
    null,
    2,
  );
}
