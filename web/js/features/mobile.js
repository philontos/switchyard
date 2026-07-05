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
import { toast } from "../core/feedback.js";
import { state } from "../core/state.js";
import { sendToActive, submitToActive, fitActiveNow } from "./terminal.js";
import { openReading, closeReading, scrollReadingToBottom, echoUser } from "./reading.js";

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
  autoGrow(f);                                          // resize to the restored text (may be multiline)
  draftId = id;
}

// The dock's current task id (real number, or a pending temp id). Reading only applies
// to a real task; a pending/new one lands in the live terminal so you watch it start.
let curDockId = null;
// Whether the dock task HAS a transcript to read (agent tasks yes; a bare SHELL has
// none — main.js resolves kind at the hook and passes this in). When false, the
// 阅读|实时 toggle is hidden entirely (body.no-read) and the view is pinned to 实时.
let curCanRead = false;

// ---- platform back gesture ⇄ view stack ----
// Entering the terminal view pushes ONE history entry, so the platform back action —
// iOS's native edge swipe-right, Android's back gesture/button — pops it and lands on
// the list. That gives the "swipe right to leave the page" feel with the browser's own
// transition, and zero custom gesture math (which would fight xterm's touch handling).
// pushedNav tracks whether our entry is on the stack; programmatic exits (the ‹ button,
// the dock emptying, a breakpoint flip) consume it via history.back(), whose popstate
// then no-ops (the view is already gone), so stale entries never pile up.
let pushedNav = false;

// Raise the terminal view for curDockId (no history push, no draft swap) — shared by
// enterTerminal and the forward-gesture popstate re-entry.
function showTermView() {
  document.body.classList.add("view-terminal");
  document.body.classList.toggle("no-read", !curCanRead);   // shells: hide the 阅读|实时 toggle
  // Landing: a readable (agent) task opens in 阅读 (openReading auto-nudges to 实时 if it
  // has no conversation yet); a shell / pending / node task opens straight in 实时.
  setMode(curCanRead ? "read" : "live");
  syncViewport();               // fix --vvh/--vvt before the fixed termcol paints
  // the term column was display:none in list view, so its pane couldn't be
  // measured — refit once it's laid out (next frame).
  requestAnimationFrame(fitActiveNow);
}

export function enterTerminal(id, canRead = typeof id === "number") {
  swapDraft(id);                // give this task its own input buffer before it's shown
  if (id !== curDockId) resetKeysEpisode();   // suppression is per task+prompt, not global
  curDockId = id;
  curCanRead = !!canRead;
  const entering = !document.body.classList.contains("view-terminal");   // vs. a task switch within the view
  // Push BEFORE flipping the view: WebKit associates the outgoing entry's swipe-back
  // snapshot with what's on screen around pushState time. Pushing while the LIST is
  // still the rendered state gives the back-gesture a correct dark under-layer;
  // flip-then-push risked a wrong/blank snapshot — the white sliver that flashed at
  // the left edge during the gesture (button exits never animate, hence never flashed).
  if (entering && !pushedNav) {
    try { history.pushState({ tdView: "term" }, ""); pushedNav = true; } catch {}
  }
  showTermView();
}
// exit the view without touching history — the popstate half of the work
function exitTermView() { document.body.classList.remove("view-terminal"); closeReading(); }
export function enterList() {
  exitTermView();
  if (pushedNav) { pushedNav = false; try { history.back(); } catch {} }
}
export function mobileBack() { enterList(); }   // term-bar ‹ back button (bridged in main.js)

// Flip the .termcol overlay between the reading pane and the live terminal. Reading is
// the default (no .mode-live); 实时 shows xterm and needs a refit (it was display:none).
// Bridged to window as setReadMode for the toggle + banner onclick handlers.
export function setMode(m) {
  const live = m === "live" || !curCanRead;   // a shell has no reading pane — pinned to 实时
  document.body.classList.toggle("mode-live", live);
  $("tm-read")?.classList.toggle("on", !live);
  $("tm-live")?.classList.toggle("on", live);
  if (live) { closeReading(); requestAnimationFrame(fitActiveNow); }
  else if (typeof curDockId === "number") openReading(curDockId);
}

// ---- quick-key auto-expand on a permission prompt ----
// main.js feeds the task poll here (same cadence as the reading banner). While the
// dock task is blocked on a permission prompt — the amber-light signal, driven by
// Claude Code's own notification hook — the key row pops open so the answer digits
// are one tap away, and the digits tint amber (.keys-urgent). The signal only ever
// drives VISIBILITY; what the keys send never depends on it, so a stale/early flag
// costs at most a needlessly open row. A row the user closes mid-prompt stays
// closed for that prompt (we don't fight the user); the next prompt may pop again.
let keysAutoOpened = false;   // we opened the row (so we also close it when the prompt resolves)
let keysSuppressed = false;   // user closed it during this prompt — don't re-open until the next one
let lastWaiting = false;
function resetKeysEpisode() { keysAutoOpened = false; keysSuppressed = false; lastWaiting = false; }

// Whether the dock task is blocked on a permission prompt. Local tasks come from the
// polled list (numeric id); a remote node's pane id looks like "n<host>:<task>" and
// its waiting ships in the fleet snapshot — remote tasks pop the row like local ones.
function dockWaiting(tasks) {
  if (typeof curDockId === "number") {
    const t = tasks ? tasks.find((x) => x.id === curDockId) : null;
    return !!(t && t.alive && t.waiting);
  }
  const m = typeof curDockId === "string" ? /^n(\d+):(\d+)$/.exec(curDockId) : null;
  const tk = m ? state.fleet[Number(m[1])]?.tasks?.find((x) => x.id === Number(m[2])) : null;
  return !!(tk && tk.alive && tk.waiting);
}

export function reflectKeysWaiting(tasks) {
  const bar = $("term-input");
  const waiting = isOn() && document.body.classList.contains("view-terminal") && dockWaiting(tasks);
  bar.classList.toggle("keys-urgent", waiting);
  if (waiting && !lastWaiting) keysSuppressed = false;   // a fresh prompt lifts the old suppression
  const open = bar.classList.contains("keys-open");
  if (waiting && !open && !keysSuppressed) { bar.classList.add("keys-open"); keysAutoOpened = true; }
  else if (!waiting && open && keysAutoOpened) { bar.classList.remove("keys-open"); keysAutoOpened = false; }
  lastWaiting = waiting;
}

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

// single raw keystrokes for the quick-key row — sent as-is to the pty, exactly like
// a hardware key press; no Enter is appended to any of them. The digits are literal
// characters: claude's numbered permission prompts select AND confirm on the bare
// digit, so 1/2/3 answer an authorization in one tap. Outside a prompt a stray digit
// merely types that character wherever focus is (delete it and move on) — the keys
// carry no semantics of their own, which is what keeps this path unbreakable.
const KEYS = { 1: "1", 2: "2", 3: "3", enter: "\r", esc: "\x1b", int: "\x03", up: "\x1b[A", down: "\x1b[B" };

// The compose field is a <textarea> that grows with its content. Size it to fit the
// text, capped at TI_MAX (past which it scrolls) — the CSS max-height matches. Reset to
// 'auto' first so scrollHeight reflects the current content, not the last taller size.
const TI_MAX = 160;
function autoGrow(f) {
  f.style.height = "auto";
  f.style.height = Math.min(TI_MAX, f.scrollHeight) + "px";
}

// Send the composed text, then Enter, and keep the field focused so the keyboard stays
// up. Empty field → a bare Enter (accept a prompt's default). A MULTILINE value goes as
// one server-side tmux paste so a TUI takes it as a single input instead of submitting
// at every newline; a real tmux send-keys Enter then fires it.
function sendLine() {
  const f = $("ti-field");
  const v = f.value;
  if (!submitToActive(v)) {
    toast(I18N.t("toast.termReconnecting"), "info");
    f.focus();
    return;
  }
  if (!document.body.classList.contains("mode-live")) {
    if (typeof curDockId === "number") echoUser(curDockId, v);   // show it now; the poll settles it
    scrollReadingToBottom();
  }
  f.value = "";
  autoGrow(f);          // shrink back to one row
  f.focus();
}

export function initMobile() {
  document.body.classList.toggle("mobile", isOn());
  MQ.addEventListener("change", () => {
    document.body.classList.toggle("mobile", isOn());
    if (!isOn()) enterList();   // crossing back to desktop: drop the view flag
  });

  // Platform back gesture ⇄ view stack (see pushedNav above). The base entry is stamped
  // so a pop back onto it is recognizable; a FORWARD gesture onto our term entry re-opens
  // the current task's view, so back-then-forward round-trips like a native nav stack.
  try { history.replaceState({ tdView: "list" }, ""); } catch {}
  window.addEventListener("popstate", (e) => {
    if (e.state && e.state.tdView === "term") {
      pushedNav = true;
      if (isOn() && curDockId != null) showTermView();
    } else {
      pushedNav = false;
      if (document.body.classList.contains("view-terminal")) exitTermView();
    }
  });

  const vv = window.visualViewport;
  if (vv) { vv.addEventListener("resize", syncViewport); vv.addEventListener("scroll", syncViewport); }
  syncViewport();

  // quick-input bar: Send fires the composed text; the field grows as you type (Enter
  // just inserts a newline now — Send, not Enter, submits).
  const field = $("ti-field");
  $("ti-send").addEventListener("click", sendLine);
  field.addEventListener("input", () => autoGrow(field));
  // Fn: toggle the quick-key popover. pointerdown + preventDefault keeps the field
  // focused (keyboard stays up); it's sticky — stays open until Fn is tapped again.
  // A manual toggle takes ownership from the auto-expand: closing it while a prompt
  // is still waiting suppresses re-opening for that prompt.
  $("ti-fn").addEventListener("pointerdown", (e) => {
    e.preventDefault();
    const open = $("term-input").classList.toggle("keys-open");
    keysAutoOpened = false;
    keysSuppressed = !open && lastWaiting;
  });
  // quick keys: fire on pointerdown + preventDefault so tapping a key does NOT
  // blur the text field — the keyboard stays up across taps.
  document.querySelectorAll("#term-input .ti-key").forEach((b) => {
    b.addEventListener("pointerdown", (e) => { e.preventDefault(); sendToActive(KEYS[b.dataset.k]); });
  });
}
