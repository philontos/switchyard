// Mobile "阅读 / Reading" view. Renders a task's agent conversation — fetched from
// GET /api/tasks/:id/transcript as a normalized Entry stream — into a native,
// smooth-scrolling chat, and auto-tails new messages while it's open. Read-only: the
// shared input bar sends, and the live terminal (实时) is where you watch/act. The one
// write-ish exception is echoUser(): a just-sent message is echoed optimistically so it
// shows before the next poll; the transcript stays the source of truth (see below).
//
// Imports only dom.js. The mode plumbing runs the OTHER way (mobile.js calls
// openReading/closeReading; the empty-transcript "go live" nudge is an injected
// callback; the "去实时" button is window-bridged), so there's no import cycle.
import { $, api } from "../core/dom.js";

const POLL_MS = 2500;

let box = null;                 // #term-read scroll container
let taskId = null;              // the task being read (null = closed)
let agent = "claude";           // for the assistant role label
let source = null, cursor = 0;  // tail state: file identity + byte cursor (see server)
let lastRole = null;            // drives role-change headers
let hasContent = false;
let atBottom = true;
let timer = null;
let onEmpty = null;             // called once when a fresh load has no conversation (→ 实时)
const tools = new Map();        // tool_call id → { body, status } nodes, to fold results in
const pending = [];             // optimistic echoes awaiting their transcript entry: { nodes, text }

export function initReading(opts = {}) {
  box = $("term-read");
  onEmpty = opts.onEmpty || null;
  box.addEventListener("scroll", () => {
    atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 44;
    $("read-jump").classList.toggle("show", !atBottom);
  });
  $("read-jump").addEventListener("click", () => { atBottom = true; box.scrollTop = box.scrollHeight; $("read-jump").classList.remove("show"); });
}

// Begin (or resume) reading a task. Only real numeric task ids have a transcript;
// pending/new tasks are shown live instead, so those are ignored here.
export function openReading(id) {
  if (typeof id !== "number") return;
  if (id !== taskId) reset(id);
  stopPoll();
  tick();
  timer = setInterval(tick, POLL_MS);
}
export function closeReading() { stopPoll(); }
function stopPoll() { if (timer) { clearInterval(timer); timer = null; } }

export function scrollReadingToBottom() {
  if (!box) return;
  atBottom = true;
  box.scrollTop = box.scrollHeight;
  $("read-jump").classList.remove("show");
}

// ---- optimistic echo (乐观上屏) ----
// Sending is terminal-bound, so a message only shows once the agent writes it to the
// transcript AND the next poll picks it up — seconds of "did that go through?". echoUser
// renders it immediately instead. The echo is a pure overlay: it reuses the normal
// user-bubble markup but touches NONE of the tail state (cursor/source/lastRole/tools),
// so polling stays correct no matter what happens to the echo. settleEcho removes it
// when the real entry arrives; reset/clearRendered drop leftovers with everything else.

// Echo a just-sent user message for the task being read (no-op for any other id, so the
// caller doesn't need to know whether reading is open). Empty text = a bare Enter
// accepting some prompt's default — not a message, nothing to echo.
export function echoUser(id, text) {
  if (id !== taskId || !box) return;
  const t = String(text ?? "").trim();
  if (!t) return;
  const nodes = [roleHeader("user"), entryNode({ t: "user", text: t })];
  for (const n of nodes) box.appendChild(n);
  pending.push({ nodes, text: t });
  scrollReadingToBottom();
}

// An arriving user entry settles echoes up to and including its own: sends reach the
// agent in order, so any echo OLDER than a transcribed message will never show up (it
// answered a TUI prompt, say, and isn't a conversation message) — drop those too rather
// than let phantoms linger. No exact match (text transformed in transit) settles just
// the oldest: a transient re-render next poll beats a permanent duplicate bubble.
function settleEcho(text) {
  if (!pending.length) return;
  const t = String(text ?? "").trim();
  let i = pending.findIndex((p) => p.text === t);
  if (i < 0) i = 0;
  for (const p of pending.splice(0, i + 1)) for (const n of p.nodes) n.remove();
}

function clearPending() {
  for (const p of pending) for (const n of p.nodes) n.remove();
  pending.length = 0;
}

function reset(id) {
  taskId = id; source = null; cursor = 0; lastRole = null; hasContent = false; atBottom = true;
  tools.clear(); clearPending();
  box.innerHTML = `<div class="rd-state" id="rd-state">${esc(I18N.t("read.loading"))}</div>`;
}

// Ticks run strictly one at a time. Overlapping polls — a fetch outlasting POLL_MS on a
// slow link, or the immediate tick every openReading fires — would all ask from the same
// not-yet-advanced cursor and each append the same window (the "my message showed up 3×"
// bug). A tick arriving mid-flight coalesces into ONE follow-up run instead, so opening /
// switching during a slow fetch still refreshes promptly rather than waiting a full poll.
let busy = false, again = false;
async function tick() {
  if (busy) { again = true; return; }
  busy = true;
  try {
    const id = taskId;
    if (id == null) return;
    const q = new URLSearchParams({ since: String(cursor) });
    if (source) q.set("source", source);
    let data;
    try { data = await api(`/api/tasks/${id}/transcript?` + q.toString()); }
    catch { return; }
    if (taskId !== id) return;                                 // switched away mid-fetch
    agent = data.agent || agent;
    if (source !== null && data.source !== source) clearRendered();   // a new session started → reload
    const firstLoad = source === null;
    source = data.source;
    if (data.entries && data.entries.length) { hasContent = true; hideState(); appendAll(data.entries); }
    else if (firstLoad && !hasContent) { showState(I18N.t("read.empty")); if (onEmpty) onEmpty(); }
    cursor = data.cursor ?? cursor;
  } finally {
    busy = false;
    if (again) { again = false; tick(); }
  }
}

function clearRendered() { box.innerHTML = ""; lastRole = null; hasContent = false; tools.clear(); clearPending(); cursor = 0; }
function showState(msg) { box.innerHTML = `<div class="rd-state">${esc(msg)}</div>`; }
function hideState() { const s = box.querySelector(".rd-state"); if (s) s.remove(); }

// ---- rendering ----

function appendAll(entries) {
  for (const e of entries) {
    if (e.t === "user") settleEcho(e.text);
    if (e.t === "tool_result") { foldResult(e); continue; }
    const dr = e.t === "user" ? "user" : "assistant";
    if (dr !== lastRole) { box.appendChild(roleHeader(dr)); lastRole = dr; }
    box.appendChild(entryNode(e));
  }
  // unsettled echoes are still the newest sends — keep them below what just rendered
  // (appendChild MOVES an attached node, so this is a reorder, not a duplicate)
  for (const p of pending) for (const n of p.nodes) box.appendChild(n);
  if (atBottom) box.scrollTop = box.scrollHeight;
  else $("read-jump").classList.add("show");
}

function roleHeader(dr) {
  const d = document.createElement("div");
  d.className = "rd-role " + dr;
  const agentName = agent === "codex" ? "Codex" : agent === "kimi" ? "Kimi" : "Claude";
  d.innerHTML = dr === "user"
    ? esc(I18N.t("read.you"))
    : `<span class="rd-dot"></span>${esc(agentName)}`;
  return d;
}

function entryNode(e) {
  if (e.t === "user") {
    const d = document.createElement("div");
    d.className = "rd-msg user";
    d.innerHTML = `<div class="rd-bubble"><div class="rd-text">${mdLite(e.text)}</div></div>`;
    return d;
  }
  if (e.t === "assistant") {
    const d = document.createElement("div");
    d.className = "rd-text";
    d.innerHTML = mdLite(e.text);
    return d;
  }
  if (e.t === "thinking") {
    const d = document.createElement("details");
    d.className = "rd-blk";
    d.innerHTML = `<summary><span class="rd-caret">▶</span>💭 ${esc(I18N.t("read.thinking"))}</summary><div class="rd-blkbody rd-think">${esc(e.text)}</div>`;
    return d;
  }
  // tool_call
  const d = document.createElement("details");
  d.className = "rd-blk rd-tool";
  d.innerHTML = `<summary><span class="rd-caret">▶</span>🔧 <span class="rd-tname">${esc(e.name)}</span> <span class="rd-targ">${esc(e.arg || "")}</span><span class="rd-tstatus"></span></summary><div class="rd-blkbody"><pre class="rd-out">${esc(I18N.t("read.running"))}</pre></div>`;
  if (e.id) tools.set(e.id, { status: d.querySelector(".rd-tstatus"), out: d.querySelector(".rd-out") });
  return d;
}

// Fill a tool's result into its call block (correlated by id, possibly across polls).
// If the call hasn't been seen (rare out-of-order), render the result standalone.
function foldResult(e) {
  const t = e.id && tools.get(e.id);
  if (t) {
    t.out.textContent = e.output || I18N.t("read.noOutput");
    t.status.textContent = e.ok ? "✓" : "✗";
    t.status.classList.add(e.ok ? "ok" : "bad");
    return;
  }
  if (lastRole !== "assistant") { box.appendChild(roleHeader("assistant")); lastRole = "assistant"; }
  const d = document.createElement("details");
  d.className = "rd-blk rd-tool";
  d.innerHTML = `<summary><span class="rd-caret">▶</span>🔧 <span class="rd-tstatus ${e.ok ? "ok" : "bad"}">${e.ok ? "✓" : "✗"}</span></summary><div class="rd-blkbody"><pre class="rd-out">${esc(e.output || "")}</pre></div>`;
  box.appendChild(d);
}

// Update the "needs you" banner: shown while reading a task that is blocked on a
// permission prompt (task.waiting, the same amber-light signal the list uses). Fed by
// main.js after each task poll so reading.js stays decoupled from the task cache.
export function reflectWaiting(selId, tasks) {
  const banner = $("read-banner");
  if (!banner) return;
  const t = taskId != null && tasks ? tasks.find((x) => x.id === taskId) : null;
  const show = !!t && !!t.waiting && !document.body.classList.contains("mode-live");
  banner.classList.toggle("show", show);
}

// ---- tiny markdown: fenced code, inline code, HTML-escaped, newlines preserved ----
function esc(s) { return String(s == null ? "" : s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c])); }
function mdLite(text) {
  const parts = String(text ?? "").split("```");
  let html = "";
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 1) {
      const code = parts[i].replace(/^[a-zA-Z0-9_+-]*\n/, "");   // drop an optional language line
      html += `<pre class="rd-code"><code>${esc(code)}</code></pre>`;
    } else {
      html += `<span class="rd-p">${esc(parts[i]).replace(/`([^`\n]+)`/g, "<code>$1</code>")}</span>`;
    }
  }
  return html;
}
