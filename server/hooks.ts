// Per-task Claude Code hooks, injected into the worktree's
// .claude/settings.local.json at dispatch. They let a session report when it is
// blocked on the user (a tool permission prompt → the card's yellow light) and
// when it resumes — by POSTing to /api/tasks/:id/hook/{wait,clear}. The intent
// is encoded in the URL (which event fired), so the server never has to parse a
// version-specific hook payload.

/**
 * settings.local.json content for one task. The hook command can never fail the
 * session (`|| true`); a short timeout keeps it from blocking the TUI.
 *   Notification (permission_prompt) → wait      (yellow)
 *   PostToolUse / UserPromptSubmit / Stop → clear (a tool ran / user replied /
 *                                                  turn ended → no longer blocked)
 */
export function hookSettingsJson(taskId: number, port: number): string {
  const post = (state: "wait" | "clear") =>
    `curl -s -m 2 -X POST http://localhost:${port}/api/tasks/${taskId}/hook/${state} >/dev/null 2>&1 || true`;
  const hook = (state: "wait" | "clear", matcher = "") =>
    [{ matcher, hooks: [{ type: "command", command: post(state) }] }];
  return JSON.stringify(
    {
      hooks: {
        Notification: hook("wait", "permission_prompt"),
        PostToolUse: hook("clear"),
        UserPromptSubmit: hook("clear"),
        Stop: hook("clear"),
      },
    },
    null,
    2,
  );
}
