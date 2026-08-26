import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { activateCanvasRenderer } from "./terminal-canvas.js";

const terminalSource = readFileSync(new URL("./terminal.js", import.meta.url), "utf8");

test("loads the canvas renderer addon", () => {
  class CanvasAddon {}
  const loaded = [];
  const term = { loadAddon(addon) { loaded.push(addon); } };

  assert.equal(activateCanvasRenderer(term, { CanvasAddon }), true);
  assert.equal(loaded.length, 1);
  assert.ok(loaded[0] instanceof CanvasAddon);
});

test("leaves the DOM renderer active when the canvas script is unavailable", () => {
  const term = { loadAddon() { throw new Error("must not load"); } };
  assert.equal(activateCanvasRenderer(term, undefined), false);
});

test("falls back when canvas activation fails", () => {
  class CanvasAddon {}
  const term = { loadAddon() { throw new Error("2D context unavailable"); } };
  assert.equal(activateCanvasRenderer(term, { CanvasAddon }), false);
});

test("enables glyph rescaling and activates canvas only after term.open", () => {
  assert.match(terminalSource, /rescaleOverlappingGlyphs:\s*true/);
  assert.ok(terminalSource.indexOf("term.open(pane)") < terminalSource.indexOf("activateCanvasRenderer(term)"));
});
