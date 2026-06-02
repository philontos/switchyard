// Per-task Claude Code hooks, injected into the worktree's
// .claude/settings.local.json at dispatch. They let a session report when it is
// blocked on the user (a tool permission prompt → the card's yellow light) and
// when it resumes — by touching / removing a marker file IN ITS OWN WORKTREE
// (.claude/waiting). The dispatcher reads that marker's existence back through
// the Runner (local fs on the controller, `ssh test -e` on a remote), so the
// exact same mechanism drives the light for the local box and every remote host.
//
// Why a file and not an HTTP ping: the session runs ON its machine, which for a
// remote task can't reach the dispatcher's localhost. A file the session writes
// locally and the dispatcher polls over its existing ssh channel needs zero new
// network plumbing — and the UI is poll-based anyway (no latency lost).

/**
 * settings.local.json content for one task, given the worktree's ABSOLUTE path
 * on the target machine. The hook command can never fail the session (`|| true`)
 * and touches only a local file (no network, no timeout needed).
 *   Notification (permission_prompt) → touch .claude/waiting   (yellow)
 *   PostToolUse / UserPromptSubmit / Stop → rm -f .claude/waiting
 *                              (a tool ran / user replied / turn ended → cleared)
 */
export function hookSettingsJson(worktreePath: string): string {
  const marker = `${worktreePath}/.claude/waiting`;
  const wait = `touch "${marker}" >/dev/null 2>&1 || true`;
  const clear = `rm -f "${marker}" >/dev/null 2>&1 || true`;
  const hook = (command: string, matcher = "") =>
    [{ matcher, hooks: [{ type: "command", command }] }];
  return JSON.stringify(
    {
      hooks: {
        Notification: hook(wait, "permission_prompt"),
        PostToolUse: hook(clear),
        UserPromptSubmit: hook(clear),
        Stop: hook(clear),
      },
    },
    null,
    2,
  );
}
