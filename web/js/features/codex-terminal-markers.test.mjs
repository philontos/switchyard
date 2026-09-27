import test from "node:test";
import assert from "node:assert/strict";
import {
  codexUserMessageBlocks,
  createCodexUserMarkerOverlay,
  isCodexUserMessageContinuationLine,
  isCodexUserMessageLine,
  normalizeCodexUserMessage,
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
function buffer(lines) {
  return { viewportY: 0, length: lines.length, getLine: (row) => lines[row] };
}

const historical = (text = "旧") => line(
  cell("›", { bold: true, dim: true }), cell("", { bold: true, dim: true }), cell(text),
);
const current = (text = "新") => line(
  cell("›", { bold: true }), cell("", { bold: true }), cell(text),
);
const composer = () => line(
  cell("›", { bold: true }), cell(""), cell("U", { dim: true }),
);
const continuation = (text) => line(cell(), cell(), cell(text));

test("recognizes submitted Codex rows but rejects the live composer and near misses", () => {
  assert.equal(isCodexUserMessageLine(historical()), true);
  assert.equal(isCodexUserMessageLine(current()), true);
  assert.equal(isCodexUserMessageLine(current("")), true, "an empty first logical line is valid");
  assert.equal(isCodexUserMessageLine(line(
    cell("›", { bold: true, dim: true }), cell(""), cell("旧"),
  )), true, "historical arrow remains sufficient when tmux drops blank-cell style");

  const misses = [
    composer(),
    line(cell("•", { dim: true }), cell(""), cell("assistant")),
    line(cell("›"), cell(""), cell("literal")),
    line(cell("›", { bold: true }), cell("x", { bold: true }), cell("body")),
    line(cell("›", { bold: true }), cell("", { bold: true }), cell("hint", { dim: true })),
  ];
  for (const candidate of misses) assert.equal(isCodexUserMessageLine(candidate), false);
});

test("accepts continuation shapes only as block context", () => {
  assert.equal(isCodexUserMessageContinuationLine(continuation("continued")), true);
  assert.equal(isCodexUserMessageContinuationLine(wrapped(cell("continued"))), true);
  assert.equal(isCodexUserMessageContinuationLine(continuation("")), false);
  assert.equal(isCodexUserMessageContinuationLine(line(
    cell(), cell(), cell("tool", { dim: true }),
  )), false);

  const standalone = buffer([continuation("indented"), wrapped(cell("wrapped"))]);
  assert.deepEqual(codexUserMessageBlocks(standalone, 0, 2), [], "continuations never start a user block");
});

test("keeps internal blank lines in one block but excludes Codex's trailing separators", () => {
  const lines = [
    historical("第一段"),
    continuation("继续"),
    line(),
    line(),
    continuation("第二段"),
    line(),
    line(),
    line(cell("•", { dim: true }), cell(), cell("assistant")),
  ];
  const confirmed = new Set([normalizeCodexUserMessage("第一段继续\n\n第二段")]);
  assert.deepEqual(codexUserMessageBlocks(buffer(lines), 0, lines.length, confirmed), [{
    firstBufferRow: 0,
    row: 0,
    rowCount: 5,
    normalizedText: normalizeCodexUserMessage("第一段继续第二段"),
    confirmed: true,
  }]);
});

test("uses the transcript as semantic confirmation and fails closed on a mismatch", () => {
  const lines = [current("release"), continuation("now"), line(), line()];
  const actual = normalizeCodexUserMessage("release now");
  const block = codexUserMessageBlocks(buffer(lines), 0, lines.length, new Set([actual]))[0];
  assert.equal(block.confirmed, true);

  const mismatch = codexUserMessageBlocks(
    buffer(lines), 0, lines.length, new Set([normalizeCodexUserMessage("other input")]),
  )[0];
  assert.equal(mismatch.confirmed, false);
});

test("finds a confirmed message whose first row is above the viewport", () => {
  const lines = [
    historical("one"), continuation("two"), line(), continuation("three"),
    line(), line(), line(cell("•", { dim: true }), cell(), cell("answer")),
  ];
  const confirmed = new Set([normalizeCodexUserMessage("one two three")]);
  assert.deepEqual(codexUserMessageBlocks(buffer(lines), 2, 3, confirmed), [{
    firstBufferRow: 0,
    row: 0,
    rowCount: 2,
    normalizedText: normalizeCodexUserMessage("one two three"),
    confirmed: true,
  }]);
});

function fakeElement(ownerDocument) {
  return {
    ownerDocument, className: "", style: {}, children: [], parentNode: null, attributes: {},
    appendChild(child) { child.parentNode = this; this.children.push(child); },
    setAttribute(name, value) { this.attributes[name] = value; },
    remove() {
      if (this.parentNode) this.parentNode.children = this.parentNode.children.filter((child) => child !== this);
      this.parentNode = null;
    },
  };
}

function fakeTerminal(lines) {
  let nextFrame = 1;
  const frames = new Map();
  const defaultView = {
    requestAnimationFrame(callback) { const id = nextFrame++; frames.set(id, callback); return id; },
    cancelAnimationFrame(id) { frames.delete(id); },
  };
  const document = { defaultView, createElement: () => fakeElement(document) };
  const screen = fakeElement(document);
  screen.getBoundingClientRect = () => ({ width: 800, height: lines.length * 20 });
  const active = buffer(lines);
  const events = {};
  const subscription = (name, callback) => {
    events[name] = callback;
    return { dispose() { delete events[name]; } };
  };
  const element = {
    ownerDocument: document,
    querySelector: (selector) => selector === ".xterm-screen" ? screen : null,
  };
  const term = {
    rows: lines.length, cols: 80,
    buffer: { active }, element,
    onScroll: (callback) => subscription("scroll", callback),
    onResize: (callback) => subscription("resize", callback),
  };
  const flushFrame = () => {
    const queued = [...frames.values()];
    frames.clear();
    for (const callback of queued) callback();
  };
  return { term, active, screen, events, frames, flushFrame };
}

test("renders one stable marker per confirmed message and batches repaint scans", () => {
  const lines = [
    historical("first"), continuation("line"), line(), continuation("last"),
    line(), line(),
    current("second"),
    line(cell("•", { dim: true }), cell(), cell("assistant")),
  ];
  const { term, screen, events, frames, flushFrame } = fakeTerminal(lines);
  const unknown = [];
  const overlay = createCodexUserMarkerOverlay(term, { onUnconfirmed: (text) => unknown.push(text) });

  overlay.setUserMessages(["first line last", "second"]);
  events.scroll();
  events.resize();
  assert.equal(frames.size, 1, "a repaint burst schedules only one reconciliation");
  flushFrame();

  const layer = screen.children[0];
  assert.equal(layer.className, "codex-user-marker-layer");
  assert.equal(layer.attributes["aria-hidden"], "true");
  assert.deepEqual(layer.children.map((el) => ({ className: el.className, top: el.style.top, height: el.style.height })), [
    { className: "codex-user-marker", top: "0px", height: "80px" },
    { className: "codex-user-marker", top: "120px", height: "20px" },
  ]);
  assert.deepEqual(unknown, []);

  overlay.setUserMessages(["second"]);
  flushFrame();
  assert.equal(layer.children.length, 1, "an unconfirmed candidate loses its marker");
  assert.equal(layer.children[0].style.top, "120px");
  assert.deepEqual(unknown, [normalizeCodexUserMessage("first line last")]);

  overlay.schedule();
  assert.equal(frames.size, 1);
  overlay.dispose();
  assert.equal(frames.size, 0, "dispose cancels the pending animation frame");
  assert.equal(screen.children.length, 0);
  assert.deepEqual(events, {}, "dispose removes xterm event subscriptions");
});
