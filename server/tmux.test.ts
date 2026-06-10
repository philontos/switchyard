import { test } from "node:test";
import assert from "node:assert/strict";
import { cancelCopyMode, pasteText, killSession, startSession, hasSession } from "./tmux.ts";
import type { Runner } from "./runner.ts";

// Minimal Runner double that records every exec() call. The other interface
// methods are never hit by the code under test, so they're inert stubs.
function fakeRunner(exec?: Runner["exec"]) {
  const calls: { file: string; args: string[] }[] = [];
  const runner = {
    kind: "local",
    dataDir: "/tmp",
    exec: exec ?? (async (file: string, args: string[]) => { calls.push({ file, args }); return ""; }),
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

test("pasteText bracketed-pastes via a named buffer (no trailing newline -> no submit)", async () => {
  const { runner, calls } = fakeRunner();
  await pasteText(runner, "tdsp-1-x", "/wt/.claude/pasted/paste-1.png");
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], { file: "tmux", args: ["set-buffer", "-b", "tdsp-paste", "--", "/wt/.claude/pasted/paste-1.png"] });
  // -p = bracketed paste (so claude attaches it as an image), -d removes the buffer after
  assert.deepEqual(calls[1], { file: "tmux", args: ["paste-buffer", "-t", "tdsp-1-x", "-b", "tdsp-paste", "-p", "-d"] });
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
