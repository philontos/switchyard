import { test } from "node:test";
import assert from "node:assert/strict";
import { hookSettingsJson } from "./hooks.ts";

const WT = "/home/u/.task-dispatcher/worktrees/3-9";

test("hookSettingsJson: Notification touches the worktree marker on a permission prompt", () => {
  const s = JSON.parse(hookSettingsJson(WT));
  const n = s.hooks.Notification[0];
  assert.equal(n.matcher, "permission_prompt");
  assert.equal(n.hooks[0].type, "command");
  assert.match(n.hooks[0].command, /^touch /);
  assert.match(n.hooks[0].command, new RegExp(`${WT}/\\.claude/waiting`));
});

test("hookSettingsJson: PostToolUse / UserPromptSubmit / Stop remove the marker", () => {
  const s = JSON.parse(hookSettingsJson(WT));
  for (const ev of ["PostToolUse", "UserPromptSubmit", "Stop"]) {
    assert.ok(s.hooks[ev], `missing ${ev}`);
    const cmd = s.hooks[ev][0].hooks[0].command;
    assert.match(cmd, /^rm -f /);
    assert.match(cmd, new RegExp(`${WT}/\\.claude/waiting`));
  }
});

test("hookSettingsJson: the same marker path is used for wait and clear", () => {
  const s = JSON.parse(hookSettingsJson(WT));
  const path = (c: string) => c.match(/"([^"]+)"/)![1];
  assert.equal(path(s.hooks.Notification[0].hooks[0].command), `${WT}/.claude/waiting`);
  assert.equal(path(s.hooks.Stop[0].hooks[0].command), `${WT}/.claude/waiting`);
});

test("hookSettingsJson: hook command can never fail the claude session", () => {
  const s = JSON.parse(hookSettingsJson(WT));
  assert.match(s.hooks.Notification[0].hooks[0].command, /\|\| true\s*$/);
  assert.match(s.hooks.Stop[0].hooks[0].command, /\|\| true\s*$/);
});
