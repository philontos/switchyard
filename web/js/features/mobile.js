// Mobile / touch adaptation layer. On a wide screen this is inert — isOn() is
// false, so main.js's view hooks no-op and the classic three-column grid stands
// untouched. On a narrow screen (≤760px, matching the CSS breakpoint) it drives a
// master-detail two-view model (machine/repo LIST ⇄ full-screen TERMINAL), keeps
// the quick-input bar glued above the iOS soft keyboard via the visualViewport
// API, and routes every terminal keystroke through that bar.
//
// Imports one-way from terminal.js (sendToActive / fitActiveNow); terminal.js
// never imports this module — instead main.js injects our enter/exit callbacks
// via setViewHooks(), so there's no import cycle.
import { $ } from "../core/dom.js";
import { sendToActive, fitActiveNow } from "./terminal.js";

const MQ = window.matchMedia("(max-width: 760px)");
export function isOn() { return MQ.matches; }

// A machine switch (selectHost → followHostTask) connects a task purely to keep
// the terminal dock warm for that machine. On mobile that must NOT navigate away
// from the list the user just tapped into, so we suppress the list→terminal jump
// while followHostTask runs. Everything it calls (connect/connectNode → openPty →
// showPane) is synchronous, so a simple flag around the call is race-free.
let autoFollow = false;
export function autoFollowing() { return autoFollow; }
export function duringAutoFollow(fn) {
  autoFollow = true;
  try { return fn(); } finally { autoFollow = false; }
}

// Per-task input drafts. The quick-input bar is ONE shared field, so entering a
// task must swap the field to that task's own unsent text — typing half a command
// for task A then switching to B must not leak A's text into B (and back to A must
// bring it back). Saved on the way out, restored on the way in, keyed by the dock id
// (a real task id, or a pending temp id). enterTerminal fires on every task open/
// switch (via the onShow hook), so it's the one chokepoint that sees the swap.
const drafts = new Map();
let draftId = null;
function swapDraft(id) {
  if (id === draftId) return;
  const f = $("ti-field");
  if (draftId !== null) drafts.set(draftId, f.value);   // stash the outgoing task's text
  f.value = drafts.get(id) || "";                       // restore the incoming task's (or blank)
  draftId = id;
}

export function enterTerminal(id) {
  swapDraft(id);                // give this task its own input buffer before it's shown
  document.body.classList.add("view-terminal");
  syncViewport();               // fix --vvh/--vvt before the fixed termcol paints
  // the term column was display:none in list view, so its pane couldn't be
  // measured — refit once it's laid out (next frame).
  requestAnimationFrame(fitActiveNow);
}
export function enterList() { document.body.classList.remove("view-terminal"); }
export function mobileBack() { enterList(); }   // term-bar ‹ back button (bridged in main.js)

// Bind the terminal view to the VISUAL viewport, not the layout viewport. On iOS
// the soft keyboard overlays the page without resizing the layout viewport, so a
// bottom-anchored input bar would hide behind it. Publishing visualViewport's
// height/offset as CSS vars lets .termcol size itself to the *visible* region, so
// the input bar always sits right above the keyboard (and xterm refits into what
// space is left). Falls back to 100dvh via the CSS var default when unavailable.
function syncViewport() {
  const vv = window.visualViewport;
  if (!vv) return;
  const s = document.documentElement.style;
  s.setProperty("--vvh", vv.height + "px");
  s.setProperty("--vvt", vv.offsetTop + "px");
}

// control sequences for the quick-key row (things a soft keyboard can't type)
const KEYS = { enter: "\r", esc: "\x1b", int: "\x03", up: "\x1b[A", down: "\x1b[B", tab: "\t" };

// Send the buffered line to the terminal, then Enter, and keep the field focused
// so the keyboard stays up for the next line. An empty field just sends Enter
// (handy for accepting a prompt's default).
function sendLine() {
  const f = $("ti-field");
  sendToActive(f.value ? f.value + "\r" : "\r");
  f.value = "";
  f.focus();
}

export function initMobile() {
  document.body.classList.toggle("mobile", isOn());
  MQ.addEventListener("change", () => {
    document.body.classList.toggle("mobile", isOn());
    if (!isOn()) enterList();   // crossing back to desktop: drop the view flag
  });

  const vv = window.visualViewport;
  if (vv) { vv.addEventListener("resize", syncViewport); vv.addEventListener("scroll", syncViewport); }
  syncViewport();

  // quick-input bar: field + Send (Enter in the field also sends)
  $("ti-send").addEventListener("click", sendLine);
  $("ti-field").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); sendLine(); } });
  // quick keys: fire on pointerdown + preventDefault so tapping a key does NOT
  // blur the text field — the keyboard stays up across taps.
  document.querySelectorAll("#term-input .ti-key").forEach((b) => {
    b.addEventListener("pointerdown", (e) => { e.preventDefault(); sendToActive(KEYS[b.dataset.k]); });
  });
}
