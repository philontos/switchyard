import test from "node:test";
import assert from "node:assert/strict";
import { activateCodexUnicode, CODEX_UNICODE_VERSION } from "./terminal-unicode.js";

test("activates the modern width table only for Codex terminals", () => {
  class Unicode11Addon {}
  const loaded = [];
  const term = {
    unicode: { activeVersion: "6" },
    loadAddon(addon) { loaded.push(addon); },
  };

  assert.equal(activateCodexUnicode(term, "claude", { Unicode11Addon }), false);
  assert.deepEqual(loaded, []);
  assert.equal(term.unicode.activeVersion, "6");

  assert.equal(activateCodexUnicode(term, "codex", { Unicode11Addon }), true);
  assert.equal(loaded.length, 1);
  assert.ok(loaded[0] instanceof Unicode11Addon);
  assert.equal(term.unicode.activeVersion, CODEX_UNICODE_VERSION);
});

test("falls back cleanly when the vendored provider did not load", () => {
  const term = { unicode: { activeVersion: "6" }, loadAddon() { throw new Error("must not load"); } };
  assert.equal(activateCodexUnicode(term, "codex", undefined), false);
  assert.equal(term.unicode.activeVersion, "6");
});
