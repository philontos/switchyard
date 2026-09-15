import test from "node:test";
import assert from "node:assert/strict";
import { pasteImageUrl } from "./terminal.js";
import { mountTerminalImeGuard } from "./terminal-ime.js";

const flushTimers = () => new Promise((resolve) => setTimeout(resolve, 10));

function event(type, properties = {}) {
  const value = new Event(type);
  for (const [key, property] of Object.entries(properties)) {
    Object.defineProperty(value, key, { value: property });
  }
  return value;
}

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

test("IME guard preserves a composition commit before clearing xterm's textarea", async () => {
  const textarea = new EventTarget();
  textarea.value = "";
  const committed = [];
  // xterm registers this listener first and reads the committed value from a
  // zero-delay timer. The guard must leave it intact until that timer runs.
  textarea.addEventListener("compositionend", () => {
    setTimeout(() => committed.push(textarea.value), 0);
  });
  const guard = mountTerminalImeGuard({ options: { screenReaderMode: false } }, textarea);

  textarea.dispatchEvent(event("compositionstart"));
  textarea.value = "adapter";
  textarea.dispatchEvent(event("compositionend"));
  await flushTimers();

  assert.deepEqual(committed, ["adapter"]);
  assert.equal(textarea.value, "");
  guard.dispose();
});

test("IME guard recognizes CapsLock from the DOM composition lifecycle", async () => {
  const textarea = new EventTarget();
  textarea.value = "nihao";
  const guard = mountTerminalImeGuard({ options: { screenReaderMode: false } }, textarea);
  // Some IMEs replace keyCode 20 with the generic composition keyCode 229,
  // while leaving the physical code intact.
  const capsLock = event("keydown", { code: "CapsLock", keyCode: 229, isComposing: false });

  textarea.dispatchEvent(event("compositionstart"));
  assert.equal(guard.shouldIgnoreKeydown(capsLock), true);

  textarea.dispatchEvent(event("compositionend"));
  assert.equal(guard.shouldIgnoreKeydown(capsLock), true, "also guard xterm's deferred commit window");
  await flushTimers();
  assert.equal(guard.shouldIgnoreKeydown(capsLock), false);
  guard.dispose();
});

test("IME guard clears accumulated committed input after keyup", async () => {
  const textarea = new EventTarget();
  textarea.value = "already sent terminal text";
  const guard = mountTerminalImeGuard({ options: { screenReaderMode: false } }, textarea);

  textarea.dispatchEvent(event("keyup"));
  await flushTimers();

  assert.equal(textarea.value, "");
  guard.dispose();
});

test("IME guard retains textarea content in screen-reader mode", async () => {
  const textarea = new EventTarget();
  textarea.value = "accessible terminal text";
  const guard = mountTerminalImeGuard({ options: { screenReaderMode: true } }, textarea);

  textarea.dispatchEvent(event("keyup"));
  await flushTimers();

  assert.equal(textarea.value, "accessible terminal text");
  guard.dispose();
});

test("IME guard preserves browser-reported CapsLock protection when cleanup is disabled", () => {
  const guard = mountTerminalImeGuard({}, null, { enabled: false });

  assert.equal(guard.shouldIgnoreKeydown(event("keydown", {
    key: "CapsLock",
    keyCode: 20,
    isComposing: true,
  })), true);
  assert.equal(guard.shouldIgnoreKeydown(event("keydown", {
    key: "CapsLock",
    keyCode: 20,
    isComposing: false,
  })), false);
});
