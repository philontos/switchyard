// In-session, in-memory reordering of task cards WITHIN a single repo group.
// Long-press (~400ms) on an active repo task card lifts it; it then follows the
// pointer while a placeholder shows where it will land; release drops it there.
// Pure frontend & session-only — no API, no DB. A page reload drops the custom
// order and the list falls back to the API's id-DESC default.
//
// Why the card floats instead of being re-inserted live: on touch the pointerdown
// target holds an IMPLICIT pointer capture, and removing that node from the DOM
// (which insertBefore does, even for a same-slot move) releases the capture and
// kills the pointer stream — the drag dies on the first move. So the dragged card
// stays put in the DOM as a position:fixed float (capture preserved) and only a
// non-captured placeholder is moved among the siblings.
//
// State (orders) lives here so hosts.js renderList() can apply it on every paint
// and the 4s/5s pollers can rebuild #m-list freely between drags. isDraggingTask()
// lets renderList bail mid-gesture (mirrors isEditingTask) so a poll can't yank
// the card out from under an active drag.
import { rerender } from "./hosts.js";

const orders = new Map();   // repoId -> [taskId, ...] in user-chosen order
let dragging = false;

export function isDraggingTask() { return dragging; }

// Apply a repo group's custom order to its (incoming id-DESC) active-task list.
// Tasks dispatched this session that aren't in the saved order float to the top
// (keeps "newest on top"); saved ids that have since disappeared just drop out.
// Stable sort preserves the incoming order among same-rank (unknown) tasks.
export function orderTasks(repoId, tasks) {
  const ord = orders.get(repoId);
  if (!ord) return tasks;
  const rank = new Map(ord.map((id, i) => [id, i]));
  return [...tasks].sort((a, b) =>
    (rank.has(a.id) ? rank.get(a.id) : -1) - (rank.has(b.id) ? rank.get(b.id) : -1));
}

const PRESS_MS = 400;   // hold this long before a press becomes a drag
const MOVE_TOL = 8;     // px of movement during the hold = scroll/click, abort

let listEl = null;
let card = null;            // the card under a pending or active press
let grp = null;             // the card's repo group (.grp), cached at drag start
let ph = null;              // placeholder occupying the drop slot during a drag
let pressTimer = null;
let pointerId = null;
let startX = 0, startY = 0; // pointerdown position (for the hold tolerance check)
let lastX = 0, lastY = 0;   // latest pointer position (drives the float + placeholder)
let grabDX = 0, grabDY = 0; // pointer offset within the card when the drag began
let justDragged = false;    // true briefly after a drop, to swallow the trailing click

export function initReorder() {
  listEl = document.getElementById("m-list");
  if (!listEl) return;
  listEl.addEventListener("pointerdown", onDown);
  // Capture phase: a drop's trailing click must die before it reaches the card's
  // inline onclick="connect(...)" and opens the terminal.
  listEl.addEventListener("click", onClickCapture, true);
}

function onDown(e) {
  if (dragging || pressTimer || e.button || !e.isPrimary) return;   // primary button/pointer only
  const el = e.target.closest(".task[data-repo]");                  // only active repo task cards carry data-repo
  if (!el || e.target.closest(".card-x, .tname-edit")) return;      // not the corner action / rename input
  card = el;
  pointerId = e.pointerId;
  startX = lastX = e.clientX; startY = lastY = e.clientY;
  pressTimer = setTimeout(beginDrag, PRESS_MS);
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
  window.addEventListener("pointercancel", onUp);
}

function beginDrag() {
  pressTimer = null;
  grp = card?.closest(".grp");
  if (!card || !card.isConnected || !grp) return cleanup();   // a poll rebuilt the list during the hold — give up
  const r = card.getBoundingClientRect();
  grabDX = lastX - r.left; grabDY = lastY - r.top;
  // placeholder holds the card's slot (same box) while the card floats free
  ph = document.createElement("div");
  ph.className = "task-ph";
  ph.style.height = r.height + "px";
  card.before(ph);
  // float the card: fixed (viewport coords — no transformed ancestor) so it
  // escapes the list's overflow clip and tracks the pointer; margins zeroed so
  // the explicit left/top isn't double-counted; border-box so width == rect.width.
  // NB: no pointer-events:none — the card keeps its (implicit, on touch) pointer
  // capture precisely because we never remove it from the DOM; releasing capture
  // is what the whole float approach exists to avoid.
  Object.assign(card.style, {
    position: "fixed", boxSizing: "border-box", width: r.width + "px",
    margin: "0", zIndex: "1000",
  });
  dragging = true;
  card.classList.add("dragging");
  grp.classList.add("reordering");
  try { card.setPointerCapture(pointerId); } catch { /* capture is a nicety; window listeners still fire */ }
  moveFloat();
  placePlaceholder();
}

function onMove(e) {
  if (e.pointerId !== pointerId) return;
  lastX = e.clientX; lastY = e.clientY;
  if (!dragging) {
    // still in the hold window — real movement means scroll/click, not a drag
    if (Math.abs(lastX - startX) > MOVE_TOL || Math.abs(lastY - startY) > MOVE_TOL) cleanup();
    return;
  }
  e.preventDefault();   // suppress text selection during the drag
  moveFloat();
  placePlaceholder();
}

// follow the pointer, keeping the same grab point under it
function moveFloat() {
  card.style.left = (lastX - grabDX) + "px";
  card.style.top = (lastY - grabDY) + "px";
}

// slot the placeholder among the OTHER cards of this repo by the pointer's Y vs
// each sibling's vertical midpoint. The placeholder isn't pointer-captured, so
// moving it (unlike moving the card) never disturbs the gesture.
function placePlaceholder() {
  const sibs = [...grp.querySelectorAll(`.task[data-repo="${card.dataset.repo}"]`)].filter(c => c !== card);
  const before = sibs.find(c => {
    const r = c.getBoundingClientRect();
    return lastY < r.top + r.height / 2;
  });
  if (before) grp.insertBefore(ph, before);
  else if (sibs.length) sibs[sibs.length - 1].after(ph);
  else grp.appendChild(ph);
}

function onUp(e) {
  if (e.pointerId !== pointerId) return;
  if (dragging) {
    ph.replaceWith(card);                        // land the card in the placeholder's slot
    commitOrder();
    justDragged = true;                          // the click that trails this pointerup must be eaten
    setTimeout(() => { justDragged = false; }, 0);
  }
  cleanup();
}

function commitOrder() {
  const ids = [...grp.querySelectorAll(`.task[data-repo="${card.dataset.repo}"]`)].map(c => Number(c.dataset.id));
  orders.set(Number(card.dataset.repo), ids);
}

function onClickCapture(e) {
  if (justDragged) { e.stopPropagation(); e.preventDefault(); }
}

function cleanup() {
  clearTimeout(pressTimer); pressTimer = null;
  const wasDragging = dragging;
  if (card) {
    card.classList.remove("dragging");
    try { card.releasePointerCapture(pointerId); } catch { /* not captured */ }
    // wipe the float styles (rerender rebuilds the node anyway, but reset so an
    // aborted/cancelled drag never leaves a stranded fixed-position card)
    for (const p of ["position", "boxSizing", "width", "margin", "zIndex", "left", "top"]) card.style[p] = "";
  }
  grp?.classList.remove("reordering");
  if (ph?.isConnected) ph.remove();
  card = grp = ph = null; pointerId = null; dragging = false;
  window.removeEventListener("pointermove", onMove);
  window.removeEventListener("pointerup", onUp);
  window.removeEventListener("pointercancel", onUp);
  if (wasDragging) rerender();   // re-paint from state so the DOM matches the committed order exactly
}
