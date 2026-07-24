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
// The app keeps AT MOST ONE history entry above the {tdView:"list"} base, so the
// platform back action — iOS's native edge swipe-right, Android's back gesture/button —
// pops it and lands on the list, with the browser's own transition and zero custom
// gesture math (which would fight xterm's touch handling). navEntry tracks what that
// single entry currently represents: the full-screen dispatch SHEET or the TERMINAL
// view. Programmatic exits (the ‹ button, the dock emptying, a sheet cancel) consume
// it via history.back(), whose popstate then no-ops, so stale entries never pile up.
//
// WHY the sheet is a history entry at all: WebKit records the swipe-back snapshot of
// the entry being LEFT at navigate-away time, from whatever the UI process actually
// has on the glass — not from what JS has painted. Any pushState that fires moments
// after the full-screen sheet closes therefore races keyboard dismissal + layer-tree
// IPC, and the list entry's snapshot can capture the FORM (the one-frame ghost on
// swipe-back). So navigation away from the list entry only ever happens while the
// list is STABLY on screen: opening the sheet pushes (list on glass for seconds),
// and dispatching MORPHS sheet→term via replaceState — no new navigation, so the
// list's clean snapshot survives untouched. No paint-waiting, no race.
let navEntry = null;   // null | "sheet" | "term" — our single extra entry, if any
let onSheetClose = null;   // injected by main.js (closes the dispatch modal) — avoids a tasks.js import cycle

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
  // If the dispatch sheet's entry is on the stack (or any entry of ours), MORPH it
  // instead of pushing: replaceState leaves the list entry — and its clean snapshot —
  // completely alone, and keeps the stack at one entry above base.
  if (entering) {
    try {
      if (navEntry) history.replaceState({ tdView: "term" }, "");
      else history.pushState({ tdView: "term" }, "");
      navEntry = "term";
    } catch {}
  }
  showTermView();
}
// exit the view without touching history — the popstate half of the work
function exitTermView() { document.body.classList.remove("view-terminal"); closeReading(); }
export function enterList() {
  exitTermView();
  // Consume only OUR terminal entry. An open sheet's entry stays put: the dock
  // emptying (a background dispatch failing, say) while the user is mid-form must
  // not pop the sheet out from under them.
  if (navEntry === "term") { navEntry = null; try { history.back(); } catch {} }
}

// The dispatch sheet opens: claim the history entry NOW, while the list is still the
// stably-rendered content (the caller flips the sheet visible right after — same
// push-then-flip order the terminal entry uses). Desktop (wide) never pushes.
export function sheetOpened() {
  if (!isOn()) return;
  try {
    if (navEntry) history.replaceState({ tdView: "sheet" }, "");   // defensive: never stack a 2nd entry
    else history.pushState({ tdView: "sheet" }, "");
    navEntry = "sheet";
  } catch {}
}
// Cancel paths only (取消 button / Esc / platform back): consume the sheet's entry; the
// popstate that back() fires re-closes the (already closed) sheet, a no-op. Dispatch
// must NOT come here — enterTerminal morphs the entry instead of popping it.
export function sheetCancelled() {
  if (navEntry !== "sheet") return;
  navEntry = null;
  try { history.back(); } catch {}
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
function setKeysOpen(open) {
  $("term-input").classList.toggle("keys-open", open);
  $("ti-float").setAttribute("aria-expanded", String(open));
  return open;
}

function toggleKeysManually() {
  const open = setKeysOpen(!$("term-input").classList.contains("keys-open"));
  keysAutoOpened = false;
  keysSuppressed = !open && lastWaiting;
}

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
  if (waiting && !open && !keysSuppressed) { setKeysOpen(true); keysAutoOpened = true; }
  else if (!waiting && open && keysAutoOpened) { setKeysOpen(false); keysAutoOpened = false; }
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

export function initMobile({ closeSheet } = {}) {
  onSheetClose = closeSheet || null;
  document.body.classList.toggle("mobile", isOn());
  MQ.addEventListener("change", () => {
    document.body.classList.toggle("mobile", isOn());
    if (!isOn()) enterList();   // crossing back to desktop: drop the view flag
  });

  // Platform back gesture ⇄ view stack (see navEntry above). The base entry is stamped
  // so a pop back onto it is recognizable; a FORWARD gesture onto our term entry re-opens
  // the current task's view, so back-then-forward round-trips like a native nav stack.
  try { history.replaceState({ tdView: "list" }, ""); } catch {}
  window.addEventListener("popstate", (e) => {
    const v = e.state && e.state.tdView;
    if (v === "term") {
      navEntry = "term";
      if (isOn() && curDockId != null) showTermView();
    } else if (v === "sheet") {
      // Forward gesture onto a cancelled sheet's entry. Don't resurrect the form —
      // just bookkeep: the next enterTerminal morphs this entry, a back pops it.
      navEntry = "sheet";
    } else {
      navEntry = null;
      if (onSheetClose) onSheetClose();   // gesture-back with the sheet open dismisses it
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
  // Fixed keyboard control: pointerdown keeps textarea focus / the soft keyboard;
  // detail=0 covers keyboard and switch-control activation without double-toggling.
  const keysToggle = $("ti-float");
  keysToggle.addEventListener("pointerdown", (e) => {
    if (e.isPrimary === false || (e.button != null && e.button !== 0)) return;
    e.preventDefault();
    toggleKeysManually();
  });
  keysToggle.addEventListener("click", (e) => { if (e.detail === 0) toggleKeysManually(); });
  // quick keys: fire on pointerdown + preventDefault so tapping a key does NOT
  // blur the text field — the keyboard stays up across taps.
  document.querySelectorAll("#term-input .ti-key").forEach((b) => {
    b.addEventListener("pointerdown", (e) => { e.preventDefault(); sendToActive(KEYS[b.dataset.k]); });
  });
}
