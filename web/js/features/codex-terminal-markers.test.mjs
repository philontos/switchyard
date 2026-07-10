import test from "node:test";
import assert from "node:assert/strict";
import {
  createCodexUserMarkerOverlay,
  isCodexUserMessageLine,
} from "./codex-terminal-markers.js";

function cell(text = "", { bold = false, dim = false } = {}) {
  return { getChars: () => text, isBold: () => bold, isDim: () => dim };
}
function line(...cells) { return { getCell: (x) => cells[x] ?? cell() }; }

const historical = () => line(
  cell("›", { bold: true, dim: true }), cell("", { bold: true, dim: true }), cell("旧"),
);
const current = () => line(
  cell("›", { bold: true }), cell("", { bold: true }), cell("新"),
);
const composer = () => line(
  cell("›", { bold: true }), cell(""), cell("U", { dim: true }),
);

test("recognizes rendered current and historical Codex user rows", () => {
  assert.equal(isCodexUserMessageLine(historical()), true);
  assert.equal(isCodexUserMessageLine(current()), true);
  // tmux may omit the visually irrelevant style of a blank cell on repaint;
  // the dim historical arrow remains sufficient and semantic.
  assert.equal(isCodexUserMessageLine(line(
    cell("›", { bold: true, dim: true }), cell(""), cell("旧"),
  )), true);
});

test("rejects composer, assistant, literal arrows, and malformed near misses", () => {
  const misses = [
    composer(),
    line(cell("•", { dim: true }), cell(""), cell("a")),
    line(cell("›"), cell(""), cell("literal")),
    line(cell("›", { bold: true }), cell("x", { bold: true }), cell("body")),
    line(cell("›", { bold: true }), cell("", { bold: true }), cell("U", { dim: true })),
  ];
  for (const candidate of misses) assert.equal(isCodexUserMessageLine(candidate), false);
});

function fakeElement(ownerDocument) {
  return {
    ownerDocument, className: "", style: {}, children: [], parentNode: null,
    appendChild(child) { child.parentNode = this; this.children.push(child); },
    remove() {
      if (this.parentNode) this.parentNode.children = this.parentNode.children.filter((child) => child !== this);
      this.parentNode = null;
    },
  };
}

function fakeTerminal(lines) {
  const document = { createElement: () => fakeElement(document) };
  const screen = fakeElement(document);
  screen.getBoundingClientRect = () => ({ width: 800, height: 60 });
  const buffer = { viewportY: 0, length: lines.length, getLine: (y) => lines[y] };
  const term = {
    rows: lines.length, cols: 80,
    buffer: { active: buffer },
    element: { querySelector: (selector) => selector === ".xterm-screen" ? screen : null },
  };
  return { term, buffer, screen };
}

test("overlays only user markers, deduplicates scans, and removes stale rows", () => {
  const lines = [historical(), composer(), current()];
  const { term, screen } = fakeTerminal(lines);
  const overlay = createCodexUserMarkerOverlay(term);

  overlay.scan();
  const layer = screen.children[0];
  assert.equal(layer.className, "codex-user-marker-layer");
  assert.equal(layer.children.length, 2);
  assert.deepEqual(layer.children.map((el) => ({ top: el.style.top, width: el.style.width, height: el.style.height })), [
    { top: "0px", width: "20px", height: "20px" },
    { top: "40px", width: "20px", height: "20px" },
  ]);

  overlay.scan();
  assert.equal(layer.children.length, 2, "repeat scans do not stack overlays");

  lines[0] = composer();
  overlay.scan();
  assert.equal(layer.children.length, 1, "an overwritten live row loses its overlay");
  assert.equal(layer.children[0].style.top, "40px");

  overlay.dispose();
  assert.equal(screen.children.length, 0);
});
