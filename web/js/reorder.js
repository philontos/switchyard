// In-session, in-memory reordering of task cards WITHIN a single repo group.
// Long-press (~400ms) on an active repo task card lifts it; dragging among its
// siblings reorders live; release commits. Pure frontend & session-only — no API,
// no DB. A page reload drops the custom order and the list falls back to the
// API's id-DESC default.
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
let pressTimer = null;
let pointerId = null;
let startX = 0, startY = 0;
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
  startX = e.clientX; startY = e.clientY;
  pressTimer = setTimeout(beginDrag, PRESS_MS);
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
  window.addEventListener("pointercancel", onUp);
}

function beginDrag() {
  pressTimer = null;
  if (!card || !card.isConnected) return cleanup();   // a poll rebuilt the list during the hold — give up
  dragging = true;
  card.classList.add("dragging");
  card.closest(".grp")?.classList.add("reordering");
}

function onMove(e) {
  if (e.pointerId !== pointerId) return;
  if (!dragging) {
    // still in the hold window — real movement means scroll/click, not a drag
    if (Math.abs(e.clientX - startX) > MOVE_TOL || Math.abs(e.clientY - startY) > MOVE_TOL) cleanup();
    return;
  }
  e.preventDefault();   // suppress text selection during the drag
  const grp = card.closest(".grp");
  if (!grp) return;
  // siblings = the OTHER active task cards of the SAME repo (constrains to this group)
  const sibs = [...grp.querySelectorAll(`.task[data-repo="${card.dataset.repo}"]`)].filter(c => c !== card);
  const before = sibs.find(c => {
    const r = c.getBoundingClientRect();
    return e.clientY < r.top + r.height / 2;
  });
  if (before) grp.insertBefore(card, before);
  else if (sibs.length) sibs[sibs.length - 1].after(card);   // past the last → append within the group
}

function onUp(e) {
  if (e.pointerId !== pointerId) return;
  if (dragging) {
    commitOrder();
    justDragged = true;                          // the click that trails this pointerup must be eaten
    setTimeout(() => { justDragged = false; }, 0);
  }
  cleanup();
}

function commitOrder() {
  const grp = card.closest(".grp");
  if (!grp) return;
  const ids = [...grp.querySelectorAll(`.task[data-repo="${card.dataset.repo}"]`)].map(c => Number(c.dataset.id));
  orders.set(Number(card.dataset.repo), ids);
}

function onClickCapture(e) {
  if (justDragged) { e.stopPropagation(); e.preventDefault(); }
}

function cleanup() {
  clearTimeout(pressTimer); pressTimer = null;
  if (card) {
    card.classList.remove("dragging");
    card.closest(".grp")?.classList.remove("reordering");
  }
  const wasDragging = dragging;
  card = null; pointerId = null; dragging = false;
  window.removeEventListener("pointermove", onMove);
  window.removeEventListener("pointerup", onUp);
  window.removeEventListener("pointercancel", onUp);
  if (wasDragging) rerender();   // re-paint from state so the DOM matches the committed order exactly
}
