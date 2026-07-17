import { test } from "node:test";
import assert from "node:assert/strict";
import {
  extForMime,
  imagePasteAdapter,
  pasteGitExcludePattern,
  pasteInputText,
  pasteTargetBase,
  pastedDest,
  pasteFilename,
} from "./paste.ts";

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

test("pastedDest defaults to claude's historical .claude/pasted directory", () => {
  assert.equal(pastedDest("/wt", "paste-1.png"), "/wt/.claude/pasted/paste-1.png");
});

test("pastedDest uses the agent image-paste adapter directory", () => {
  assert.equal(pastedDest("/wt", "paste-1.png", "claude"), "/wt/.claude/pasted/paste-1.png");
  assert.equal(pastedDest("/wt", "paste-1.png", "codex"), "/wt/.codex/pasted/paste-1.png");
});

test("imagePasteAdapter isolates each agent's injected input text", () => {
  assert.equal(imagePasteAdapter("claude").storageDir, ".claude/pasted");
  assert.equal(pasteGitExcludePattern("claude"), ".claude/pasted/");
  assert.equal(pasteInputText("claude", "/wt/.claude/pasted/paste-1.png"), "/wt/.claude/pasted/paste-1.png");

  assert.equal(imagePasteAdapter("codex").storageDir, ".codex/pasted");
  assert.equal(pasteGitExcludePattern("codex"), ".codex/pasted/");
  assert.equal(
    pasteInputText("codex", "/wt/.codex/pasted/paste-1.png"),
    "Use this image as visual context: /wt/.codex/pasted/paste-1.png",
  );
});

test("pasteFilename is paste-<stamp>.<ext>", () => {
  assert.equal(pasteFilename(123, "png"), "paste-123.png");
  assert.equal(pasteFilename("abc", "jpg"), "paste-abc.jpg");
});
