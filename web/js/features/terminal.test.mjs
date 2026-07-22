import test from "node:test";
import assert from "node:assert/strict";
import { canPreviewTaskPane, pasteImageUrl } from "./terminal.js";

test("pasteImageUrl targets local task paste endpoint for numeric ids", () => {
  assert.equal(pasteImageUrl(7), "/api/tasks/7/paste-image");
});

test("pasteImageUrl targets the owning node for remote pane ids", () => {
  assert.equal(pasteImageUrl("n3:42"), "/api/nodes/3/tasks/42/paste-image");
});

test("pasteImageUrl rejects unknown string pane ids", () => {
  assert.equal(pasteImageUrl("pending-1"), null);
  assert.equal(pasteImageUrl("n3:x"), null);
});

test("preview links are owner-local until remote preview has a node protocol", () => {
  assert.equal(canPreviewTaskPane(7), true);
  assert.equal(canPreviewTaskPane("n3:42"), false);
  assert.equal(canPreviewTaskPane("pending-1"), false);
});
