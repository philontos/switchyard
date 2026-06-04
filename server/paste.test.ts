import { test } from "node:test";
import assert from "node:assert/strict";
import { extForMime, pasteTargetBase, pastedDest, pasteFilename } from "./paste.ts";

test("extForMime maps known image mimes, strips params, is case-insensitive", () => {
  assert.equal(extForMime("image/png"), "png");
  assert.equal(extForMime("image/jpeg"), "jpg");
  assert.equal(extForMime("image/jpg"), "jpg");
  assert.equal(extForMime("image/gif"), "gif");
  assert.equal(extForMime("image/webp"), "webp");
  assert.equal(extForMime("IMAGE/PNG; charset=binary"), "png"); // params + casing
});

test("extForMime rejects non-images and empties", () => {
  assert.equal(extForMime("text/plain"), null);
  assert.equal(extForMime("application/octet-stream"), null);
  assert.equal(extForMime(""), null);
  assert.equal(extForMime(null), null);
  assert.equal(extForMime(undefined), null);
});

test("pasteTargetBase prefers worktree_path, falls back to cwd, else null", () => {
  assert.equal(pasteTargetBase({ worktree_path: "/wt", cwd: null }), "/wt");
  assert.equal(pasteTargetBase({ worktree_path: "", cwd: "/home/x" }), "/home/x"); // local task
  assert.equal(pasteTargetBase({ worktree_path: "   ", cwd: "/home/x" }), "/home/x");
  assert.equal(pasteTargetBase({ worktree_path: "", cwd: null }), null);
  assert.equal(pasteTargetBase({ worktree_path: "", cwd: "" }), null);
});

test("pastedDest lands under <base>/.claude/pasted", () => {
  assert.equal(pastedDest("/wt", "paste-1.png"), "/wt/.claude/pasted/paste-1.png");
});

test("pasteFilename is paste-<stamp>.<ext>", () => {
  assert.equal(pasteFilename(123, "png"), "paste-123.png");
  assert.equal(pasteFilename("abc", "jpg"), "paste-abc.jpg");
});
