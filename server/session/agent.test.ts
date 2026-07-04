import { test } from "node:test";
import assert from "node:assert/strict";
import { agentArgv, agentCaps, asAgentKind } from "./agent.ts";

// ---- asAgentKind: only 'codex' opts in; everything else is the default 'claude' ----
test("asAgentKind returns 'codex' only for the exact 'codex' string", () => {
  assert.equal(asAgentKind("codex"), "codex");
  assert.equal(asAgentKind("claude"), "claude");
  assert.equal(asAgentKind(""), "claude");
  assert.equal(asAgentKind(undefined), "claude", "a missing agent defaults to claude");
  assert.equal(asAgentKind("CODEX"), "claude", "unknown/garbage falls back to claude, never throws");
});

// ---- agentCaps: skills + the yellow-light hook are Claude-only ----
test("agentCaps: claude injects skills and the waiting-hook", () => {
  assert.deepEqual(agentCaps("claude"), { injectSkills: true, injectHooks: true });
});
test("agentCaps: codex injects neither (no .claude/skills, no hook mechanism)", () => {
  assert.deepEqual(agentCaps("codex"), { injectSkills: false, injectHooks: false });
});

// ---- agentArgv: claude (unchanged from the historical hardcoded launch) ----
test("agentArgv claude with a prompt is `claude <prompt>`", () => {
  assert.deepEqual(agentArgv("claude", { prompt: "do the thing" }), ["claude", "do the thing"]);
});
test("agentArgv claude with no prompt is just `claude`", () => {
  assert.deepEqual(agentArgv("claude", {}), ["claude"]);
  assert.deepEqual(agentArgv("claude", { prompt: "" }), ["claude"]);
  assert.deepEqual(agentArgv("claude", { prompt: "   " }), ["claude"], "a blank prompt is not passed");
});
test("agentArgv claude resume is `claude --continue`, ignoring any prompt", () => {
  assert.deepEqual(agentArgv("claude", { prompt: "opening", resume: true }), ["claude", "--continue"]);
});
test("agentArgv claude ignores model (claude's model rides the provider env, not -m)", () => {
  assert.deepEqual(agentArgv("claude", { prompt: "go", model: "glm-4.6" }), ["claude", "go"]);
});

// ---- agentArgv: codex (full-access: -a on-request -s danger-full-access, so tasks can push/gh/network) ----
test("agentArgv codex with a prompt is full-access + the prompt", () => {
  assert.deepEqual(agentArgv("codex", { prompt: "build it" }), [
    "codex", "-a", "on-request", "-s", "danger-full-access", "build it",
  ]);
});
test("agentArgv codex with no prompt is full-access with no trailing message", () => {
  assert.deepEqual(agentArgv("codex", {}), ["codex", "-a", "on-request", "-s", "danger-full-access"]);
  assert.deepEqual(agentArgv("codex", { prompt: "  " }), ["codex", "-a", "on-request", "-s", "danger-full-access"]);
});
test("agentArgv codex with a model inserts -m <model> before the prompt", () => {
  assert.deepEqual(agentArgv("codex", { prompt: "go", model: "gpt-5.4" }), [
    "codex", "-a", "on-request", "-s", "danger-full-access", "-m", "gpt-5.4", "go",
  ]);
});
test("agentArgv codex adds writable git dirs via --add-dir", () => {
  assert.deepEqual(agentArgv("codex", { prompt: "go", addDirs: ["/mirror/worktrees/1", "/mirror"] }), [
    "codex", "-a", "on-request", "-s", "danger-full-access",
    "--add-dir", "/mirror/worktrees/1", "--add-dir", "/mirror", "go",
  ]);
});
test("agentArgv codex resume keeps the same sandbox policy, ignoring prompt and model", () => {
  assert.deepEqual(agentArgv("codex", { prompt: "opening", model: "gpt-5.4", resume: true }), [
    "codex", "-a", "on-request", "-s", "danger-full-access", "resume", "--last",
  ]);
});
