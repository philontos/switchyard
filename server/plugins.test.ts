import { test } from "node:test";
import assert from "node:assert/strict";
import { parseAvailable, installPlan } from "./plugins.ts";

test("parseAvailable maps available + flags installed", () => {
  const json = JSON.stringify({
    installed: [{ id: "superpowers@claude-plugins-official" }],
    available: [
      { pluginId: "foo@claude-plugins-official", name: "foo", description: "d", marketplaceName: "claude-plugins-official" },
      { pluginId: "superpowers@claude-plugins-official", name: "superpowers", description: "s", marketplaceName: "claude-plugins-official" },
    ],
  });
  assert.deepEqual(parseAvailable(json), [
    { pluginId: "foo@claude-plugins-official", name: "foo", description: "d", marketplace: "claude-plugins-official", installed: false },
    { pluginId: "superpowers@claude-plugins-official", name: "superpowers", description: "s", marketplace: "claude-plugins-official", installed: true },
  ]);
});

test("parseAvailable tolerates missing sections / bad json", () => {
  assert.deepEqual(parseAvailable("{}"), []);
  assert.deepEqual(parseAvailable("not json"), []);
});

test("installPlan = marketplace add + install under the dispatcher CLAUDE_CONFIG_DIR", () => {
  const p = installPlan("foo@claude-plugins-official");
  assert.ok(p.env.CLAUDE_CONFIG_DIR?.endsWith("claude-config"), "sets CLAUDE_CONFIG_DIR");
  assert.deepEqual(p.steps, [
    ["plugin", "marketplace", "add", "anthropics/claude-plugins-official"],
    ["plugin", "install", "foo@claude-plugins-official"],
  ]);
});
