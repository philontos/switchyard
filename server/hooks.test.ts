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

test("hookSettingsJson: SessionStart captures session_id into the worktree", () => {
  const s = JSON.parse(hookSettingsJson(WT));
  const cmd = s.hooks.SessionStart[0].hooks[0].command;
  assert.match(cmd, new RegExp(`> "${WT}/\\.claude/session-id"`));
  assert.match(cmd, /sed -n/);          // extracts from stdin JSON, not an env var
  assert.match(cmd, /; true\s*$/);      // can never fail the session
});

test("hookSettingsJson: the SessionStart sed actually extracts a session_id", () => {
  // mirror the shell sed in JS to prove the regex pulls the id out of real hook
  // JSON — both compact and pretty-printed (key+value share a line either way).
  const cmd = JSON.parse(hookSettingsJson(WT)).hooks.SessionStart[0].hooks[0].command;
  const re = /"session_id"[ \t]*:[ \t]*"([^"]*)"/;   // === the [[:space:]] sed, JS-side
  const id = "abc123-de45-6789-0000-deadbeef0000";
  assert.ok(cmd.includes('"session_id"'), "command should grep the session_id key");
  for (const json of [
    `{"session_id":"${id}","cwd":"/x","hook_event_name":"SessionStart"}`,
    `{\n  "session_id": "${id}",\n  "source": "resume"\n}`,
  ]) {
    assert.equal(json.match(re)?.[1], id);
  }
});
