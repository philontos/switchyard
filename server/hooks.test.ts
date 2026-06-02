import { test } from "node:test";
import assert from "node:assert/strict";
import { hookSettingsJson } from "./hooks.ts";

test("hookSettingsJson: Notification sets 'wait', matched to permission prompts", () => {
  const s = JSON.parse(hookSettingsJson(42, 4500));
  const n = s.hooks.Notification[0];
  assert.equal(n.matcher, "permission_prompt");
  assert.equal(n.hooks[0].type, "command");
  assert.match(n.hooks[0].command, /\/api\/tasks\/42\/hook\/wait/);
  assert.match(n.hooks[0].command, /localhost:4500/);
});

test("hookSettingsJson: PostToolUse / UserPromptSubmit / Stop clear the wait", () => {
  const s = JSON.parse(hookSettingsJson(7, 4500));
  for (const ev of ["PostToolUse", "UserPromptSubmit", "Stop"]) {
    assert.ok(s.hooks[ev], `missing ${ev}`);
    assert.match(s.hooks[ev][0].hooks[0].command, /\/api\/tasks\/7\/hook\/clear/);
  }
});

test("hookSettingsJson: hook command can never fail the claude session", () => {
  const s = JSON.parse(hookSettingsJson(1, 4500));
  assert.match(s.hooks.Notification[0].hooks[0].command, /\|\| true\s*$/);
});
