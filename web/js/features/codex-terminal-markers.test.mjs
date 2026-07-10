import test from "node:test";
import assert from "node:assert/strict";
import {
  codexUserMessageRows,
  createCodexUserMarkerOverlay,
  isCodexUserMessageContinuationLine,
  isCodexUserMessageLine,
} from "./codex-terminal-markers.js";

function cell(text = "", { bold = false, dim = false } = {}) {
  return { getChars: () => text, isBold: () => bold, isDim: () => dim };
}
function line(...cells) {
  return { length: cells.length, isWrapped: false, getCell: (x) => cells[x] ?? cell() };
}
function wrapped(...cells) {
  return { ...line(...cells), isWrapped: true };
}

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

test("accepts continuation shapes only as context after a strict user row", () => {
  const indented = line(cell(), cell(), cell("continued"));
  const terminalWrapped = wrapped(cell("continued"));
  const dimOnly = line(cell(), cell(), cell("tool", { dim: true }));
  assert.equal(isCodexUserMessageContinuationLine(indented), true);
  assert.equal(isCodexUserMessageContinuationLine(terminalWrapped), true);
  assert.equal(isCodexUserMessageContinuationLine(dimOnly), false);

  const standalone = { getLine: (row) => [indented, terminalWrapped][row] };
  assert.deepEqual(codexUserMessageRows(standalone, 0, 2), [], "continuations never start a user block");
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
  screen.getBoundingClientRect = () => ({ width: 800, height: lines.length * 20 });
  const buffer = { viewportY: 0, length: lines.length, getLine: (y) => lines[y] };
  const events = {};
  const subscription = (name, callback) => {
    events[name] = callback;
    return { dispose() { delete events[name]; } };
  };
  const term = {
    rows: lines.length, cols: 80,
    buffer: { active: buffer },
    element: { querySelector: (selector) => selector === ".xterm-screen" ? screen : null },
    onScroll: (callback) => subscription("scroll", callback),
    onResize: (callback) => subscription("resize", callback),
  };
  return { term, buffer, screen, events };
}

test("overlays full submitted-message rows, including continuations, without generalizing", () => {
  const lines = [
    historical(),
    line(cell(), cell(), cell("historical continuation")),
    composer(),
    current(),
    wrapped(cell("wrapped continuation")),
    line(cell("•", { dim: true }), cell(), cell("assistant")),
  ];
  const { term, screen, events } = fakeTerminal(lines);
  const overlay = createCodexUserMarkerOverlay(term);

  overlay.scan();
  const layer = screen.children[0];
  assert.equal(layer.className, "codex-user-marker-layer");
  assert.equal(layer.children.length, 4);
  assert.deepEqual(layer.children.map((el) => ({ className: el.className, top: el.style.top, width: el.style.width, height: el.style.height })), [
    { className: "codex-user-marker is-first", top: "0px", width: "800px", height: "20px" },
    { className: "codex-user-marker is-last", top: "20px", width: "800px", height: "20px" },
    { className: "codex-user-marker is-first", top: "60px", width: "800px", height: "20px" },
    { className: "codex-user-marker is-last", top: "80px", width: "800px", height: "20px" },
  ]);

  overlay.scan();
  assert.equal(layer.children.length, 4, "repeat scans do not stack overlays");

  lines[0] = composer();
  events.scroll();
  assert.equal(layer.children.length, 2, "a continuation left without a strict start is not highlighted");
  assert.deepEqual(layer.children.map((el) => el.style.top), ["60px", "80px"]);

  overlay.dispose();
  assert.equal(screen.children.length, 0);
  assert.deepEqual(events, {}, "dispose removes xterm event subscriptions");
});
