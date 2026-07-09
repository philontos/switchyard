import { test } from "node:test";
import assert from "node:assert/strict";
import { cancelCopyMode, ensureSessionOptions, pasteText, pasteSubmit, killSession, startSession, hasSession } from "./tmux.ts";
import type { Runner } from "../fleet/runner.ts";

// Minimal Runner double that records every exec() call. The other interface
// methods are never hit by the code under test, so they're inert stubs.
function fakeRunner(exec?: Runner["exec"]) {
  const calls: { file: string; args: string[] }[] = [];
  const runner = {
    kind: "local",
    dataDir: "/tmp",
    exec: exec ?? (async (file: string, args: string[]) => {
      calls.push({ file, args });
      if (file === "git" && args.includes("--git-dir")) return "/mirror/worktrees/1-49\n";
      if (file === "git" && args.includes("--git-common-dir")) return "/mirror\n";
      return "";
    }),
    async mkdirp() {},
    async exists() { return false; },
    async rmrf() {},
    async putDir() {},
    ptySpec(file: string, args: string[]) { return { file, args }; },
  } as unknown as Runner;
  return { runner, calls };
}

test("cancelCopyMode sends the copy-mode cancel command, never a literal key", async () => {
  const { runner, calls } = fakeRunner();
  await cancelCopyMode(runner, "tdsp-1-x");
  assert.equal(calls.length, 1);
  // -X cancel is a copy-mode COMMAND (exits the mode); a literal `q` would be
  // typed into the prompt when not in copy-mode. This guards that distinction.
  assert.deepEqual(calls[0], { file: "tmux", args: ["send-keys", "-t", "tdsp-1-x", "-X", "cancel"] });
});

test("cancelCopyMode swallows runner errors (not-in-copy-mode is a harmless no-op)", async () => {
  const { runner } = fakeRunner(async () => { throw new Error("not in a mode"); });
  await cancelCopyMode(runner, "tdsp-1-x"); // must not throw
});

test("ensureSessionOptions keeps exited panes readable and enables tmux mouse scroll", async () => {
  const { runner, calls } = fakeRunner();
  await ensureSessionOptions(runner, "tdsp-1-x");
  assert.deepEqual(calls, [
    { file: "tmux", args: ["set-option", "-t", "tdsp-1-x", "remain-on-exit", "on"] },
    { file: "tmux", args: ["set-option", "-t", "tdsp-1-x", "mouse", "on"] },
  ]);
});

test("pasteText bracketed-pastes via a named buffer (no trailing newline -> no submit)", async () => {
  const { runner, calls } = fakeRunner();
  await pasteText(runner, "tdsp-1-x", "/wt/.claude/pasted/paste-1.png");
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], { file: "tmux", args: ["set-buffer", "-b", "tdsp-paste", "--", "/wt/.claude/pasted/paste-1.png"] });
  // -p = bracketed paste (so claude attaches it as an image), -d removes the buffer after
  assert.deepEqual(calls[1], { file: "tmux", args: ["paste-buffer", "-t", "tdsp-1-x", "-b", "tdsp-paste", "-p", "-d"] });
});

test("pasteSubmit bracketed-pastes text, then sends a real Enter", async () => {
  const { runner, calls } = fakeRunner();
  await pasteSubmit(runner, "tdsp-1-x", "hello\nworld");
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[0], { file: "tmux", args: ["set-buffer", "-b", "tdsp-paste", "--", "hello\nworld"] });
  assert.deepEqual(calls[1], { file: "tmux", args: ["paste-buffer", "-t", "tdsp-1-x", "-b", "tdsp-paste", "-p", "-d"] });
  assert.deepEqual(calls[2], { file: "tmux", args: ["send-keys", "-t", "tdsp-1-x", "Enter"] });
});

test("pasteSubmit with empty text only sends Enter", async () => {
  const { runner, calls } = fakeRunner();
  await pasteSubmit(runner, "tdsp-1-x", "");
  assert.deepEqual(calls, [{ file: "tmux", args: ["send-keys", "-t", "tdsp-1-x", "Enter"] }]);
});

// killSession is the LAST line of defense for every cleanup/archive/kill path.
// tmux parses an empty `-t` target as "the current/most-recent session" and
// kills it — so a failed task (whose session column is "") must never reach the
// command, or it tears down whatever session you're actively using.
test("killSession does NOT issue kill-session for an empty session", async () => {
  const { runner, calls } = fakeRunner();
  await killSession(runner, "");
  assert.equal(calls.length, 0);
});

test("killSession does NOT issue kill-session for a whitespace-only session", async () => {
  const { runner, calls } = fakeRunner();
  await killSession(runner, "   ");
  assert.equal(calls.length, 0);
});

test("killSession targets the session by exact match (=), so a name can't prefix-collide", async () => {
  const { runner, calls } = fakeRunner();
  await killSession(runner, "tdsp-1-x");
  assert.equal(calls.length, 1);
  // "=" forces an exact-match target; without it tmux prefix-matches, so "tdsp-1"
  // could kill "tdsp-12". The leading "=" guards against that.
  assert.deepEqual(calls[0], { file: "tmux", args: ["kill-session", "-t", "=tdsp-1-x"] });
});

test("hasSession checks by exact match (=), so 'tdsp-1' isn't reported live by 'tdsp-12'", async () => {
  const { runner, calls } = fakeRunner();
  await hasSession(runner, "tdsp-1");
  assert.deepEqual(calls[0], { file: "tmux", args: ["has-session", "-t", "=tdsp-1"] });
});

test("startSession passes the prompt as claude's opening message", async () => {
  const { runner, calls } = fakeRunner();
  await startSession(runner, "tdsp-1-x", "/wt", "do the thing");
  assert.deepEqual(calls[0], { file: "tmux", args: ["new-session", "-d", "-s", "tdsp-1-x", "-c", "/wt", "claude", "do the thing"] });
});

test("startSession({ continue: true }) runs claude --continue and ignores any prompt", async () => {
  const { runner, calls } = fakeRunner();
  // resume must reattach to the prior conversation (claude stores it by cwd), so it
  // launches `claude --continue` and must NOT re-inject the original opening prompt.
  await startSession(runner, "tdsp-1-x", "/wt", "the original opening prompt", { continue: true });
  assert.deepEqual(calls[0], { file: "tmux", args: ["new-session", "-d", "-s", "tdsp-1-x", "-c", "/wt", "claude", "--continue"] });
});

test("startSession injects opts.env as an `env K=V ... claude` prefix (alternate provider)", async () => {
  const { runner, calls } = fakeRunner();
  // tmux new-session won't carry arbitrary env into the session, so the vars are
  // set ON the claude process via a prepended `env` command, BEFORE the prompt.
  await startSession(runner, "tdsp-1-x", "/wt", "do it", {
    env: { ANTHROPIC_BASE_URL: "https://open.bigmodel.cn/api/anthropic", ANTHROPIC_MODEL: "glm-4.6" },
  });
  assert.deepEqual(calls[0], { file: "tmux", args: [
    "new-session", "-d", "-s", "tdsp-1-x", "-c", "/wt",
    "env", "ANTHROPIC_BASE_URL=https://open.bigmodel.cn/api/anthropic", "ANTHROPIC_MODEL=glm-4.6",
    "claude", "do it",
  ] });
});

test("startSession({ continue, env }) injects env before claude --continue (resume keeps the backend)", async () => {
  const { runner, calls } = fakeRunner();
  await startSession(runner, "tdsp-1-x", "/wt", null, {
    continue: true, env: { ANTHROPIC_AUTH_TOKEN: "tok" },
  });
  assert.deepEqual(calls[0], { file: "tmux", args: [
    "new-session", "-d", "-s", "tdsp-1-x", "-c", "/wt",
    "env", "ANTHROPIC_AUTH_TOKEN=tok", "claude", "--continue",
  ] });
});

test("startSession drops empty/blank env values (no `env` prefix when nothing to inject)", async () => {
  const { runner, calls } = fakeRunner();
  // a provider that only fills some fields must not emit empty K= pairs, and an
  // all-empty env must launch claude exactly as the no-env path does.
  await startSession(runner, "tdsp-1-x", "/wt", "go", { env: { ANTHROPIC_BASE_URL: "", ANTHROPIC_MODEL: "" } });
  assert.deepEqual(calls[0], { file: "tmux", args: ["new-session", "-d", "-s", "tdsp-1-x", "-c", "/wt", "claude", "go"] });
});

test("startSession(agent='codex') launches codex full-access with the prompt", async () => {
  const { runner, calls } = fakeRunner();
  // codex runs full-access (`-a on-request -s danger-full-access`) so tasks can
  // push / run gh / reach the network; the git metadata dirs are still passed as
  // extra writable roots (a no-op with the sandbox off, kept for uniformity).
  await startSession(runner, "tdsp-1-x", "/wt", "do it", { agent: "codex" });
  assert.deepEqual(calls.at(-3), { file: "tmux", args: [
    "new-session", "-d", "-s", "tdsp-1-x", "-c", "/wt",
    "codex", "-a", "on-request", "-s", "danger-full-access",
    "--add-dir", "/mirror/worktrees/1-49", "--add-dir", "/mirror", "do it",
  ] });
});

test("startSession(agent='codex', continue) resumes with `codex resume --last`", async () => {
  const { runner, calls } = fakeRunner();
  // codex resumes the most-recent conversation in this cwd — the opening prompt
  // is NOT re-sent, mirroring claude --continue.
  await startSession(runner, "tdsp-1-x", "/wt", "the original prompt", { agent: "codex", continue: true });
  assert.deepEqual(calls.at(-3), { file: "tmux", args: [
    "new-session", "-d", "-s", "tdsp-1-x", "-c", "/wt",
    "codex", "-a", "on-request", "-s", "danger-full-access",
    "--add-dir", "/mirror/worktrees/1-49", "--add-dir", "/mirror", "resume", "--last",
  ] });
});

test("startSession(agent='codex', model) passes -m <model> before the prompt", async () => {
  const { runner, calls } = fakeRunner();
  await startSession(runner, "tdsp-1-x", "/wt", "go", { agent: "codex", model: "gpt-5.4" });
  assert.deepEqual(calls.at(-3), { file: "tmux", args: [
    "new-session", "-d", "-s", "tdsp-1-x", "-c", "/wt",
    "codex", "-a", "on-request", "-s", "danger-full-access",
    "--add-dir", "/mirror/worktrees/1-49", "--add-dir", "/mirror", "-m", "gpt-5.4", "go",
  ] });
});
