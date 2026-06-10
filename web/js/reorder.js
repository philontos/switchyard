// In-session, in-memory reordering of task cards WITHIN a single repo group.
// Long-press (~400ms) on an active repo task card lifts it; it then follows the
// pointer while a placeholder shows where it will land; release drops it there.
// Pure frontend & session-only — no API, no DB. A page reload drops the custom
// order and the list falls back to the API's id-DESC default.
//
// Motion: the card scales up on pickup (CSS .dragging), siblings slide to open the
// gap via FLIP as the placeholder moves, and on release the float glides into the
// placeholder's slot before being dropped into flow for real.
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
// stays true through the drop animation too, so a poll can't yank the card out
// mid-gesture or mid-settle (mirrors isEditingTask).
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

const PRESS_MS = 400;     // hold this long before a press becomes a drag
const MOVE_TOL = 8;       // px of movement during the hold = scroll/click, abort
const SLIDE_MS = 160;     // sibling reflow / settle glide duration (keep in sync with CSS)

let listEl = null;
let card = null;            // the card under a pending or active press
let grp = null;             // the card's repo group (.grp), cached at drag start
let ph = null;              // placeholder occupying the drop slot during a drag
let lastBefore;             // current placeholder target node (or null = end) — slot-change guard
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
  if (!card || !card.isConnected || !grp) return reset();   // a poll rebuilt the list during the hold — give up
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
  // No pointer-events:none — keeping the card in the DOM is what preserves its
  // (implicit, on touch) pointer capture, which the whole float approach exists for.
  Object.assign(card.style, {
    position: "fixed", boxSizing: "border-box", width: r.width + "px",
    margin: "0", zIndex: "1000",
  });
  dragging = true;
  card.classList.add("dragging");   // CSS animates the scale-up + shadow
  grp.classList.add("reordering");
  lastBefore = undefined;
  try { card.setPointerCapture(pointerId); } catch { /* capture is a nicety; window listeners still fire */ }
  moveFloat();
  placePlaceholder();
}

function onMove(e) {
  if (e.pointerId !== pointerId) return;
  lastX = e.clientX; lastY = e.clientY;
  if (!dragging) {
    // still in the hold window — real movement means scroll/click, not a drag
    if (Math.abs(lastX - startX) > MOVE_TOL || Math.abs(lastY - startY) > MOVE_TOL) reset();
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

// Slot the placeholder among the OTHER cards of this repo by the pointer's Y vs
// each sibling's vertical midpoint. Only act when the target slot actually changes
// (else every pixel would restart the reflow animation). When it does change, FLIP
// the siblings that shift so they slide smoothly instead of snapping. The
// placeholder isn't pointer-captured, so moving it never disturbs the gesture.
function placePlaceholder() {
  const sibs = [...grp.querySelectorAll(`.task[data-repo="${card.dataset.repo}"]`)].filter(c => c !== card);
  const before = sibs.find(c => {
    const r = c.getBoundingClientRect();
    return lastY < r.top + r.height / 2;
  }) || null;
  if (before === lastBefore) return;
  lastBefore = before;
  const firsts = sibs.map(c => c.getBoundingClientRect().top);   // FLIP: positions before the move
  if (before) grp.insertBefore(ph, before);
  else if (sibs.length) sibs[sibs.length - 1].after(ph);
  else grp.appendChild(ph);
  sibs.forEach((c, i) => {                                       // invert + play each shifted sibling
    const dy = firsts[i] - c.getBoundingClientRect().top;
    if (!dy) return;
    c.style.transition = "none";
    c.style.transform = `translateY(${dy}px)`;
    requestAnimationFrame(() => {
      c.style.transition = `transform ${SLIDE_MS}ms ease`;
      c.style.transform = "";
    });
  });
}

function onUp(e) {
  if (e.pointerId !== pointerId) return;
  window.removeEventListener("pointermove", onMove);
  window.removeEventListener("pointerup", onUp);
  window.removeEventListener("pointercancel", onUp);
  if (!dragging) return reset();               // released during the hold — never became a drag
  justDragged = true;                          // the click that trails this pointerup must be eaten
  setTimeout(() => { justDragged = false; }, 0);
  settleDrop();                                // glide into the slot, then commit (dragging stays true until done)
}

// Animate the float from where it was let go into the placeholder's slot, then
// drop it into flow for real and commit. dragging stays true throughout so the
// poller can't rebuild the list mid-animation.
function settleDrop() {
  const t = ph.getBoundingClientRect();
  card.style.transition = `left ${SLIDE_MS}ms ease, top ${SLIDE_MS}ms ease, transform ${SLIDE_MS}ms ease, box-shadow ${SLIDE_MS}ms ease`;
  card.style.left = t.left + "px";
  card.style.top = t.top + "px";
  card.style.transform = "scale(1)";   // settle back down (CSS .dragging lifted it to 1.03)
  card.style.boxShadow = "none";
  let done = false;
  const fin = () => { if (done) return; done = true; finalizeDrop(); };
  card.addEventListener("transitionend", fin, { once: true });
  setTimeout(fin, SLIDE_MS + 60);      // fallback if transitionend doesn't fire
}

function finalizeDrop() {
  ph.replaceWith(card);   // land the card in the placeholder's slot
  commitOrder();
  reset();                // strip float styles + classes, drop dragging, null state
  rerender();             // re-paint from the committed order
}

function commitOrder() {
  const ids = [...grp.querySelectorAll(`.task[data-repo="${card.dataset.repo}"]`)].map(c => Number(c.dataset.id));
  orders.set(Number(card.dataset.repo), ids);
}

function onClickCapture(e) {
  if (justDragged) { e.stopPropagation(); e.preventDefault(); }
}

// Teardown shared by every exit path (hold-abort, failed begin, finalized drop):
// remove listeners, strip the float's inline styles + classes, drop the
// placeholder, and clear state. Callers that changed the order rerender after.
function reset() {
  clearTimeout(pressTimer); pressTimer = null;
  window.removeEventListener("pointermove", onMove);
  window.removeEventListener("pointerup", onUp);
  window.removeEventListener("pointercancel", onUp);
  if (card) {
    card.classList.remove("dragging");
    try { card.releasePointerCapture(pointerId); } catch { /* not captured */ }
    for (const p of ["position", "boxSizing", "width", "margin", "zIndex", "left", "top", "transition", "transform", "boxShadow"]) card.style[p] = "";
  }
  grp?.classList.remove("reordering");
  if (ph?.isConnected) ph.remove();
  card = grp = ph = null; pointerId = null; lastBefore = undefined; dragging = false;
}
