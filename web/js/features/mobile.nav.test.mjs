// Regression harness for mobile.js's history ⇄ view state machine (the 导航状态机).
// Plain node — window/document/history are minimal stubs, just enough for the nav
// layer. The contract under test exists because WebKit records a history entry's
// swipe-back snapshot at the moment you NAVIGATE AWAY from it, from whatever is
// actually on the glass. So the choreography must guarantee:
//
//   * the only pushState that leaves the LIST entry fires while the list is the
//     stably-rendered content (task open from list, or sheet open — never mid-
//     dispatch with the form still on/near the glass);
//   * dispatching from the sheet MORPHS the sheet entry into the terminal entry
//     via replaceState — no new navigation, so the list's clean snapshot survives;
//   * cancel / gesture-back consume the sheet entry and close the sheet;
//   * the legacy six-step nav holds (enter pushes one, back exits, forward
//     re-enters, ‹ consumes, task switch never double-pushes, dock-empty consumes).
import { test } from "node:test";
import assert from "node:assert/strict";

// ---- stubs (must exist before mobile.js is imported) ----
function makeClassList() {
  const s = new Set();
  return {
    add: (...c) => c.forEach((x) => s.add(x)),
    remove: (...c) => c.forEach((x) => s.delete(x)),
    toggle(c, force) { const on = force === undefined ? !s.has(c) : !!force; on ? s.add(c) : s.delete(c); return on; },
    contains: (c) => s.has(c),
  };
}
function makeEl() {
  return {
    style: {}, value: "", textContent: "", classList: makeClassList(),
    addEventListener() {}, focus() {}, blur() {}, contains: () => false,
  };
}
const els = new Map();
const el = (id) => { if (!els.has(id)) els.set(id, makeEl()); return els.get(id); };

const popstateListeners = [];
const fakeHistory = {
  entries: [{ state: null }], idx: 0, pushes: 0, replaces: 0,
  pushState(state) { this.entries.splice(this.idx + 1); this.entries.push({ state }); this.idx++; this.pushes++; },
  replaceState(state) { this.entries[this.idx] = { state }; this.replaces++; },
  back() { if (this.idx === 0) return; this.idx--; this.dispatch(); },
  forward() { if (this.idx >= this.entries.length - 1) return; this.idx++; this.dispatch(); },
  dispatch() { const e = { state: this.entries[this.idx].state }; popstateListeners.forEach((f) => f(e)); },
  get state() { return this.entries[this.idx].state; },
  top() { return this.entries[this.idx].state; },
};

globalThis.window = {
  matchMedia: () => ({ matches: true, addEventListener() {} }),   // always "mobile"
  addEventListener: (type, fn) => { if (type === "popstate") popstateListeners.push(fn); },
  visualViewport: undefined,
};
globalThis.document = {
  getElementById: el,
  body: makeEl(),
  documentElement: { style: { setProperty() {} } },
  querySelectorAll: () => [],
  createElement: makeEl,
  activeElement: null,
  addEventListener() {},
};
globalThis.history = fakeHistory;
globalThis.requestAnimationFrame = () => {};

const mob = await import("./mobile.js");
const inTermView = () => document.body.classList.contains("view-terminal");

test("mobile nav state machine: list ⇄ sheet ⇄ terminal choreography", () => {
  let sheetCloses = 0;
  mob.initMobile({ closeSheet: () => { sheetCloses++; } });
  assert.equal(fakeHistory.top()?.tdView, "list", "init stamps the base entry");

  // -- legacy six-step regression --
  mob.enterTerminal("tmp1", false);
  assert.equal(fakeHistory.pushes, 1, "entering a task pushes exactly one entry");
  assert.equal(fakeHistory.top()?.tdView, "term");
  assert.ok(inTermView(), "terminal view raised");

  mob.enterTerminal("tmp2", false);
  assert.equal(fakeHistory.pushes, 1, "task switch inside the view never double-pushes");

  fakeHistory.back();   // gesture back
  assert.equal(fakeHistory.idx, 0, "gesture back lands on the list entry");
  assert.ok(!inTermView(), "gesture back drops the terminal view");

  fakeHistory.forward();   // forward gesture round-trip
  assert.ok(inTermView(), "forward gesture re-raises the current task's view");

  mob.mobileBack();   // ‹ button consumes our entry
  assert.equal(fakeHistory.idx, 0, "programmatic exit consumed the entry");
  assert.ok(!inTermView());

  // -- sheet opens: its own entry, pushed while the list is on the glass --
  mob.sheetOpened();
  assert.equal(fakeHistory.pushes, 2, "opening the sheet pushes one entry");
  assert.equal(fakeHistory.top()?.tdView, "sheet");
  assert.equal(fakeHistory.idx, 1);

  // -- dispatch: MORPH, not push — the list entry is never navigated away from --
  mob.enterTerminal("tmp3", false);
  assert.equal(fakeHistory.pushes, 2, "dispatch must NOT push (form was just on the glass)");
  assert.equal(fakeHistory.top()?.tdView, "term", "sheet entry morphed into the term entry");
  assert.equal(fakeHistory.idx, 1, "stack depth unchanged by dispatch");
  assert.ok(inTermView());

  fakeHistory.back();   // gesture back from the dispatched task → list
  assert.equal(fakeHistory.idx, 0);
  assert.ok(!inTermView(), "back from a dispatched task lands on the list");

  // -- cancel button consumes the sheet entry --
  mob.sheetOpened();
  assert.equal(fakeHistory.idx, 1);
  const closesBefore = sheetCloses;
  mob.sheetCancelled();
  assert.equal(fakeHistory.idx, 0, "cancel consumed the sheet entry");
  assert.ok(sheetCloses > closesBefore, "popstate closed the sheet");
  mob.sheetCancelled();
  assert.equal(fakeHistory.idx, 0, "double-cancel is a no-op");

  // -- gesture back with the sheet open dismisses it --
  mob.sheetOpened();
  const closes2 = sheetCloses;
  fakeHistory.back();
  assert.ok(sheetCloses > closes2, "gesture back closes the open sheet");
  assert.equal(fakeHistory.idx, 0);
  const pushesBefore = fakeHistory.pushes;
  mob.enterTerminal("tmp4", false);
  assert.equal(fakeHistory.pushes, pushesBefore + 1, "next task entry pushes fresh (no stale bookkeeping)");
  assert.equal(fakeHistory.idx, 1);
  fakeHistory.back();

  // -- dock-empty while the sheet is open must NOT yank the sheet's entry --
  mob.sheetOpened();
  assert.equal(fakeHistory.idx, 1);
  mob.enterList();   // the onEmpty hook path
  assert.equal(fakeHistory.idx, 1, "open sheet's entry survives a dock-empty exit");
  assert.equal(fakeHistory.top()?.tdView, "sheet");
  mob.sheetCancelled();
  assert.equal(fakeHistory.idx, 0);

  // -- forward onto a stale (cancelled) sheet entry: bookkeeping only, then heals --
  fakeHistory.forward();   // back onto the popped sheet entry
  assert.equal(fakeHistory.top()?.tdView, "sheet");
  mob.enterTerminal("tmp5", false);
  assert.equal(fakeHistory.top()?.tdView, "term", "stale sheet entry is morphed, not stacked on");
  assert.equal(fakeHistory.idx, 1);
  fakeHistory.back();
  assert.ok(!inTermView());
});
