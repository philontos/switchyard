import { test } from "node:test";
import assert from "node:assert/strict";
import { cancelCopyMode } from "./tmux.ts";
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
