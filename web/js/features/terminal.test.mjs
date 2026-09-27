import test from "node:test";
import assert from "node:assert/strict";
import { pasteImageUrl, transcriptUrl } from "./terminal.js";

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

test("transcriptUrl targets the task's owning node", () => {
  assert.equal(transcriptUrl(7), "/api/tasks/7/transcript");
  assert.equal(transcriptUrl("n3:42"), "/api/nodes/3/tasks/42/transcript");
  assert.equal(transcriptUrl("pending-1"), null);
});
