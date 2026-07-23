import { test } from "node:test";
import assert from "node:assert/strict";
import { agentArgv, asAgentKind } from "./agent.ts";

// ---- asAgentKind: only known exact strings opt in; everything else defaults to 'claude' ----
test("asAgentKind returns known agents only for exact strings", () => {
  assert.equal(asAgentKind("codex"), "codex");
  assert.equal(asAgentKind("kimi"), "kimi");
  assert.equal(asAgentKind("claude"), "claude");
  assert.equal(asAgentKind(""), "claude");
  assert.equal(asAgentKind(undefined), "claude", "a missing agent defaults to claude");
  assert.equal(asAgentKind("CODEX"), "claude", "unknown/garbage falls back to claude, never throws");
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

// ---- agentArgv: kimi (interactive TUI; start prompt is submitted by tmux after launch) ----
test("agentArgv kimi starts the interactive TUI in auto mode without passing prompt as -p", () => {
  assert.deepEqual(agentArgv("kimi", { prompt: "build it" }), ["kimi", "--auto"]);
});
test("agentArgv kimi with a model inserts -m <model>", () => {
  assert.deepEqual(agentArgv("kimi", { prompt: "go", model: "kimi-code/kimi-for-coding" }), [
    "kimi", "--auto", "-m", "kimi-code/kimi-for-coding",
  ]);
});
test("agentArgv kimi adds extra dirs via --add-dir", () => {
  assert.deepEqual(agentArgv("kimi", { addDirs: ["/mirror/worktrees/1", "/mirror"] }), [
    "kimi", "--auto", "--add-dir", "/mirror/worktrees/1", "--add-dir", "/mirror",
  ]);
});
test("agentArgv kimi resume uses --continue and ignores prompt/model", () => {
  assert.deepEqual(agentArgv("kimi", { prompt: "opening", model: "x", resume: true }), [
    "kimi", "--auto", "--continue",
  ]);
});
