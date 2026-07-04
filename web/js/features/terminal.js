// One live xterm.js terminal PER task, all kept alive. openPty() shows a task's
// pane (creating it on first open); switching cards just toggles which pane is
// visible — no teardown, no reconnect, no flicker. Each pane owns its own xterm
// instance + WebSocket, and the socket stays open in the background, so a
// backgrounded session keeps streaming and a switch-back is instant. Panes are
// disposed when their task goes away (archive / cleanup / delete / vanished from
// the list — see disposePty/prunePanes, called from tasks.js). The live-pane set
// is therefore bounded by the set of active tasks; no separate eviction needed.
// Terminal/FitAddon are the globals from the vendored xterm scripts.
import { $ } from "../core/dom.js";
import { toast } from "../core/feedback.js";

// taskId -> { id, pane, term, fit, ws, query, title, desc, attach, resizeKey }
const panes = new Map();
let activeId = null;   // the task whose pane is currently visible (null = none)

// Mobile master-detail hooks (injected by main.js so terminal.js never imports
// mobile.js — that would be a cycle, since mobile.js imports from here). onShow
// fires when a pane/placeholder becomes the dock content (→ switch to the
// terminal view); onEmpty fires when the dock clears (→ back to the list view).
// Both are no-ops on desktop.
let onShow = null, onEmpty = null;
export function setViewHooks(show, empty) { onShow = show; onEmpty = empty; }

// Send raw bytes to the currently-visible pane's socket. Drives the mobile
// quick-input bar (text line + control-key row); no-op if nothing's attached or
// the socket isn't open. Returns whether the data was sent.
export function sendToActive(data) {
  const p = activeId != null ? panes.get(activeId) : null;
  if (p && p.ws && p.ws.readyState === 1) { p.ws.send(data); return true; }
  return false;
}

// Refit the visible pane synchronously (then repaint). Called after the mobile
// view flips to terminal — the pane was display:none in list view and couldn't be
// measured, so its column count is stale until we re-fit against the now-visible box.
export function fitActiveNow() {
  const p = activeId != null ? panes.get(activeId) : null;
  if (p) { try { p.fit.fit(); sendResize(p); p.term.refresh(0, p.term.rows - 1); } catch {} }
}

// xterm paints to a canvas from a JS theme object, so it can't read the CSS
// tokens in app.css — it carries its own light/dark pair. Kept in sync with the
// --bg / --term-fg / --accent values for each theme. termTheme() picks by the
// global Theme (falls back to dark before theme.js loads).
const TERM_THEMES = {
  dark:  { background: "#1a1613", foreground: "#ddd4c8", cursor: "#d97757", cursorAccent: "#1a1613", selectionBackground: "#d9775740" },
  light: { background: "#fbf8f2", foreground: "#3a322a", cursor: "#c2603f", cursorAccent: "#fbf8f2", selectionBackground: "#c2603f33" },
};
function termTheme() { return TERM_THEMES[(window.Theme && Theme.theme) || "dark"]; }

// Re-skin every live pane on a theme switch (xterm 5.x: assign options.theme).
export function applyTermTheme() {
  for (const p of panes.values()) { try { p.term.options.theme = termTheme(); } catch {} }
}

// Re-fit the visible pane (background panes can't be measured while display:none,
// and are re-fit when next shown). Coalesced to one fit per frame: rAF both
// batches a burst of resize notifications and defers the measurement until after
// layout has settled, so we never fit against a half-laid-out box.
let fitQueued = false;
function fitActive() {
  if (fitQueued) return;
  fitQueued = true;
  requestAnimationFrame(() => {
    fitQueued = false;
    const p = activeId != null ? panes.get(activeId) : null;
    if (p) { try { p.fit.fit(); sendResize(p); } catch {} }
  });
}

export function initTerm() {
  window.addEventListener("resize", fitActive);
  // A one-shot fit (showPane / ws.onopen) can run before the layout is final and
  // over-count columns; xterm then renders wider than the visible box, so the
  // right edge is clipped and typing there pushes the cursor — and the whole
  // page — sideways. Re-fitting whenever #term's box actually changes (first
  // paint settling, a scrollbar toggling, browser zoom, window resize) keeps the
  // column count matched to the real width, so neither happens.
  try { new ResizeObserver(fitActive).observe($("term")); } catch {}
  // manual preview-port fallback (for when the printed link isn't auto-detected)
  $("prev-go").addEventListener("click", goPreviewPort);
  $("prev-port").addEventListener("keydown", (e) => { if (e.key === "Enter") goPreviewPort(); });
  // click the Claude session-id chip → copy the full uuid (dataset.sid, never the
  // possibly-truncated visible text) to the clipboard.
  $("term-claude").addEventListener("click", () => {
    const sid = $("term-claude").dataset.sid;
    if (!sid) return;
    navigator.clipboard.writeText(sid)
      .then(() => toast(I18N.t("toast.claudeCopied"), "success"))
      .catch(() => {});
  });
}

function sendResize(p) {
  if (!p.ws || p.ws.readyState !== 1) return;
  const key = p.term.cols + "x" + p.term.rows;
  // iOS Safari can emit several resize/visualViewport/ResizeObserver events while
  // the terminal overlay settles. Re-sending the same dimensions makes tmux/TUIs
  // repaint whole screens with no layout benefit, which reads as terminal flicker.
  if (p.resizeKey === key) return;
  p.resizeKey = key;
  p.ws.send("\x00resize:" + key);
}

// Mobile: let a one-finger vertical drag over the terminal SCROLL it. xterm only
// touch-scrolls while the app hasn't enabled mouse reporting; a TUI like claude turns
// mouse reporting ON, so otherwise every drag is forwarded to the app as a mouse drag
// and the buffer never moves — you can't read back. We translate the drag into `wheel`
// events dispatched onto xterm, whose wheel path does the right thing in every mode:
// forwards a wheel escape to a mouse-mode app (claude scrolls its own view), sends
// arrow keys to a non-wheel alt-screen app, or scrolls the scrollback in a plain shell.
// getLinesScrolled accumulates the pixel deltas into whole rows, so per-move dispatch
// is smooth, not jumpy. preventDefault stops iOS from raising the synthetic mouse
// events (no stray clicks/selection) and from rubber-banding the page. We dispatch on
// .xterm-screen so the event bubbles up to xterm's listener wherever it sits.
//
// The move handler runs in the CAPTURE phase and stopPropagation()s, so xterm's own
// touchmove (a descendant listener) never fires — otherwise, in a plain shell where
// xterm DOES touch-scroll the viewport, its scroll would stack on top of ours and the
// buffer would fly twice as fast. touchstart is left to propagate so a plain tap still
// reaches xterm (selection); only a drag is claimed for scrolling.
//
// Flick inertia: a bare 1:1 drag stops dead on lift-off, which reads as sluggish. We
// carry the release velocity into a decaying rAF loop that keeps emitting wheel deltas,
// so a flick coasts like native momentum scrolling; a new touch cancels it.
//
// Two things keep it smooth across phones. (1) Velocity is an EMA of the per-move speed,
// so a slow final micro-move before lift-off doesn't kill the fling. (2) Both the coast
// distance and the friction decay are computed against the REAL elapsed frame time, not
// a fixed 16ms — a 120Hz ProMotion iPhone (≈8ms/frame) then coasts exactly as far as a
// 60Hz one, instead of decaying twice as fast and feeling short/floaty.
function mountTouchScroll(pane) {
  const sink = pane.querySelector(".xterm-screen") || pane;
  const emit = (dy) => sink.dispatchEvent(new WheelEvent("wheel", { deltaY: dy, deltaMode: 0, bubbles: true, cancelable: true }));
  const FRICTION = 0.9975;                   // velocity decay PER MILLISECOND (≈0.96 over a 16.7ms frame)
  let lastY = 0, lastT = 0, vel = 0, tracking = false, raf = 0, prevT = 0;
  const stopFling = () => { if (raf) { cancelAnimationFrame(raf); raf = 0; } };
  pane.addEventListener("touchstart", (e) => {
    stopFling();                             // a fresh touch halts any coasting scroll
    tracking = e.touches.length === 1;       // single finger only — a pinch isn't a scroll
    if (tracking) { lastY = e.touches[0].clientY; lastT = e.timeStamp; vel = 0; }
  }, { passive: true });
  pane.addEventListener("touchmove", (e) => {
    if (!tracking || e.touches.length !== 1) return;
    const y = e.touches[0].clientY, dy = lastY - y;   // finger up → dy>0 → scroll toward newer content
    const dt = Math.max(1, e.timeStamp - lastT);
    lastY = y; lastT = e.timeStamp;
    if (!dy) return;
    vel = vel * 0.7 + (dy / dt) * 0.3;       // smoothed px/ms — a stable release velocity for the fling
    e.preventDefault();
    e.stopPropagation();                     // keep xterm's own touch-scroll from double-driving
    emit(dy);
  }, { passive: false, capture: true });
  pane.addEventListener("touchend", () => {
    if (!tracking) return;
    tracking = false;
    if (Math.abs(vel) < 0.05) return;        // a slow/held release doesn't coast (px/ms)
    prevT = 0;
    const step = (now) => {
      const dt = prevT ? Math.min(32, now - prevT) : 16;   // real frame time; clamp a stalled frame
      prevT = now;
      emit(vel * dt);
      vel *= Math.pow(FRICTION, dt);
      raf = Math.abs(vel) > 0.02 ? requestAnimationFrame(step) : 0;
    };
    raf = requestAnimationFrame(step);
  }, { passive: true });
}

// Build a fresh terminal pane for a task: its own xterm + FitAddon + copy/paste
// /keystroke wiring, mounted (hidden) into the #term stack. The socket is opened
// separately by ensureSocket(); show happens via showPane().
function createPane(id, query) {
  const pane = document.createElement("div");
  pane.className = "term-pane";
  pane.style.display = "none";
  pane.dataset.task = String(id);
  $("term").appendChild(pane);

  const term = new Terminal({
    fontSize: 13, fontFamily: "Menlo, monospace", cursorBlink: true,
    theme: termTheme(),
    macOptionClickForcesSelection: true,   // mac: Option+拖拽 强制本地选区(绕开 TUI 鼠标模式)
    rightClickSelectsWord: true,
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(pane);

  // mobile: all input goes through the on-screen quick-input bar, so make xterm's
  // hidden helper textarea readOnly + inputmode=none. Tapping the terminal then
  // scrolls/selects the buffer without raising the iOS soft keyboard (a readOnly
  // field doesn't trigger it) — no double-keyboard, no layout jump. And a one-finger
  // drag scrolls (mountTouchScroll) — xterm's own touch-scroll is dead here because
  // claude keeps mouse reporting on.
  if (document.body.classList.contains("mobile")) {
    const ta = pane.querySelector(".xterm-helper-textarea");
    if (ta) { ta.readOnly = true; ta.setAttribute("inputmode", "none"); }
    mountTouchScroll(pane);
  }

  // linkify localhost URLs the session prints (e.g. a dev server's
  // "Local: http://localhost:5173") and open them in the side preview on click,
  // instead of navigating the browser to the user's OWN (empty) localhost.
  try { term.registerLinkProvider(localhostLinks(term, id)); } catch {}

  const p = { id, pane, term, fit, ws: null, query, title: "", desc: "", attach: "", claude: "", resizeKey: "" };

  // claude TUI 开了鼠标上报,普通拖拽会被转发给应用; Shift/Option 拖拽走本地选区,松手即复制
  term.element.addEventListener("mouseup", () => {
    const s = term.getSelection();
    if (s) navigator.clipboard.writeText(s).catch(() => {});
  });
  // 键盘复制: mac=Cmd+C, 其他=Ctrl+Shift+C; 仅在有选区时拦截,避免吃掉 ^C(SIGINT)
  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== "keydown") return true;
    // 组字途中按 CapsLock(macOS 切换中/英输入法的常用键)时,xterm 的 keydown 处理会先于
    // compositionHelper 跑:它不在 229/Shift/Ctrl/Alt 的"忽略"名单里,于是被当成提交键,
    // _finalizeComposition(false) 先把组字内容上屏一次;紧接着系统真正的 compositionend
    // 又上屏一次 → 同一段拼音发两遍("nihao" 变 "ni haonihao")。CapsLock 和那几个修饰键
    // 一样不该结束组字,组字途中直接吃掉它,让上屏只走 compositionend 一条路。
    if (e.isComposing && e.keyCode === 20) return false;
    const isMac = navigator.platform.toUpperCase().includes("MAC");
    const isCopy = isMac ? (e.metaKey && e.code === "KeyC") : (e.ctrlKey && e.shiftKey && e.code === "KeyC");
    if (isCopy && term.hasSelection()) {
      navigator.clipboard.writeText(term.getSelection()).catch(() => {});
      return false;
    }
    return true;
  });
  // Cmd/Ctrl+V with an image in the clipboard: don't let xterm paste binary as
  // text — upload it to THIS pane's task; the server lands it on that machine and
  // bracketed-pastes the path into claude, which attaches it as [Image #N]. Text
  // pastes fall through to xterm untouched.
  term.element.addEventListener("paste", (e) => onPasteImage(e, id), true);
  // keystrokes → this pane's own socket
  term.onData(d => p.ws && p.ws.readyState === 1 && p.ws.send(d));

  panes.set(id, p);
  return p;
}

// Open the pane's socket if it isn't already live. Deliberately does NOT reset
// the terminal — the existing (frozen) content stays put and the fresh tmux
// attach repaints over it, so a reconnect never flashes to black.
function ensureSocket(p) {
  if (p.ws && (p.ws.readyState === 0 || p.ws.readyState === 1)) return;   // CONNECTING/OPEN
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws = p.ws = new WebSocket(`${proto}://${location.host}/pty?${p.query}&lang=${I18N.lang}`);
  p.resizeKey = "";       // a new pty needs one initial size even if dimensions match the old socket
  ws.onopen = () => { if (activeId === p.id) { try { p.fit.fit(); } catch {} } sendResize(p); };
  ws.onmessage = (e) => p.term.write(typeof e.data === "string" ? e.data : "");
  ws.onclose = () => p.term.write(`\r\n\x1b[90m${I18N.t("term.disconnected")}\x1b[0m\r\n`);
}

// Make a pane the visible one: hide every other pane, show this one, refit (it
// may have been display:none and unmeasurable), repaint, refresh the dock bar
// and grab the keyboard.
function showPane(p) {
  if (onShow) onShow(p.id);   // mobile: flip to the terminal view BEFORE fitting, so the
                          // pane's box is visible (measurable) when p.fit.fit() runs
                          // — and hand over the id so the quick-input swaps to this task's draft
  hidePendingView();   // a real pane takes over the dock → drop any placeholder overlay
  for (const o of panes.values()) o.pane.style.display = o === p ? "block" : "none";
  activeId = p.id;
  hideTermEmpty();
  applyBar(p);
  try { p.fit.fit(); } catch {}
  try { p.term.refresh(0, p.term.rows - 1); } catch {}   // canvas can blank while hidden
  sendResize(p);
  // on mobile the keyboard is driven by the quick-input field, not the terminal —
  // don't focus the (readOnly) xterm textarea, which would just fight for focus.
  if (!document.body.classList.contains("mobile")) p.term.focus();
}

function applyBar(p) {
  // dynamic content, not a localized label — drop the static i18n binding so a
  // language switch won't overwrite the title back to "Not connected".
  $("term-title").removeAttribute("data-i18n");
  $("term-title").textContent = p.title;
  $("term-desc").textContent = p.desc;
  $("term-desc").title = p.desc;           // full text on hover
  $("term-attach").textContent = p.attach;
  applyClaude(p.claude);
}

// Fill (or hide) the Claude-session-id chip. The raw id is stashed in dataset.sid
// so the click handler copies the FULL uuid even when the bar truncated it; title
// shows it complete on hover. Empty (local shell tasks, or claude not booted) hides.
function applyClaude(sid) {
  const el = $("term-claude");
  if (sid) {
    el.dataset.sid = sid;
    el.textContent = "claude: " + sid;
    el.title = sid + " — " + I18N.t("term.claudeCopy");
    el.style.display = "";
  } else {
    delete el.dataset.sid;
    el.textContent = "";
    el.style.display = "none";
  }
}

// Update a task's stored Claude session id and, if it's the visible pane, the bar.
// Called from the task poll so the chip appears as soon as claude writes its id,
// without waiting for a reconnect.
export function setClaudeSession(taskId, sid) {
  const p = panes.get(taskId);
  if (!p || p.claude === (sid || "")) return;
  p.claude = sid || "";
  if (activeId === taskId) applyClaude(p.claude);
}

// Intercept an image paste (screenshot in clipboard) and route it to the pane's
// task; non-image (text) pastes are left for xterm. getAsFile() must run
// synchronously inside the event, so we grab the File first, then upload async.
function onPasteImage(e, taskId) {
  const items = e.clipboardData && e.clipboardData.items;
  if (!items) return;
  let file = null;
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (it.kind === "file" && it.type.startsWith("image/")) { file = it.getAsFile(); break; }
  }
  if (!file) return;                              // not an image → let xterm paste text
  e.preventDefault();
  e.stopPropagation();
  uploadPasteImage(taskId, file);
}

async function uploadPasteImage(taskId, blob) {
  try {
    const res = await fetch(`/api/tasks/${taskId}/paste-image`, {
      method: "POST",
      headers: { "content-type": blob.type || "image/png", "X-Lang": I18N.lang },
      body: blob,
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      throw new Error(j.error || res.statusText);
    }
    toast(I18N.t("toast.pasteOk"), "success");
    panes.get(taskId)?.term.focus();
  } catch (err) {
    toast(I18N.t("toast.pasteFailed", { error: err.message }), "error", 6000);
  }
}

// Detach the dock from any task WITHOUT tearing panes down: hide every pane and
// show the empty state. Used when switching to a machine that has no connectable
// task — the backgrounded panes stay alive for an instant switch back.
export function detachDock() {
  hidePendingView();
  for (const o of panes.values()) o.pane.style.display = "none";
  activeId = null;
  showTermEmpty();
}

// The terminal column is permanent (col3); the empty-state overlay shows when no
// pane is attached. showPane() hides it; disposing the last/active pane re-shows it.
export function showTermEmpty() { if (onEmpty) onEmpty(); $("term-empty").classList.remove("hidden"); }
function hideTermEmpty() { $("term-empty").classList.add("hidden"); }

// ---- pending creation windows ----
// A task being created has no tmux session yet, so it can't own a real pane. While
// the POST is in flight we drop a lightweight placeholder into the #term stack: a
// spinner that the success path swaps for the live terminal, or an inline error on
// failure. These live OUTSIDE the panes Map (which is keyed by real task id and
// pruned by loadTasks) — keyed by a client temp id instead, so a stray placeholder
// is never mistaken for a real task. Concurrency: many creations can be in flight,
// but only the newest placeholder is shown; the rest resolve in the background
// (success → a normal card; failure → a toast) without stealing the dock.
const pending = new Map();   // tmpId -> { el }
let activePending = null;    // tmpId of the placeholder currently shown (or null)

// Hide every placeholder without destroying it (in-flight ones must survive to
// resolve). Called when a real pane / empty state takes over the dock.
function hidePendingView() {
  for (const v of pending.values()) v.el.style.display = "none";
  activePending = null;
}

// Paint the shared dock bar for a placeholder (no real pane object to read from).
function pendingBar(title, desc) {
  $("term-title").removeAttribute("data-i18n");
  $("term-title").textContent = title;
  $("term-desc").textContent = desc || "";
  $("term-desc").title = desc || "";
  $("term-attach").textContent = "";
  applyClaude("");
}

// Open a spinner placeholder for a just-submitted creation and make it the visible
// dock view. text = the loading line (e.g. "Creating worktree…").
export function openPending(tmpId, title, desc, text) {
  if (onShow) onShow(tmpId);   // mobile: a just-dispatched task takes the dock → terminal view
  const el = document.createElement("div");
  el.className = "term-pane pending";
  el.dataset.pending = String(tmpId);
  el.innerHTML = `<div class="pending-box"><div class="spinner"></div><div class="pending-text"></div></div>`;
  el.querySelector(".pending-text").textContent = text;
  $("term").appendChild(el);
  pending.set(tmpId, { el, title, desc });   // keep title/desc so showPending() can restore the bar
  for (const o of panes.values()) o.pane.style.display = "none";
  for (const [k, v] of pending) v.el.style.display = k === tmpId ? "flex" : "none";
  activeId = null;
  activePending = tmpId;
  hideTermEmpty();
  pendingBar(title, desc);
}

// Re-show an existing placeholder as the dock view — e.g. clicking its still-loading
// list card after switching away to another pane. Returns false if it's already
// resolved (gone from the map), so the caller can no-op. The spinner/error markup is
// whatever openPending/failPending last left in the element; only the bar is restored.
export function showPending(tmpId) {
  const pe = pending.get(tmpId);
  if (!pe) return false;
  if (onShow) onShow(tmpId);   // mobile: re-showing a still-loading card → terminal view
  for (const o of panes.values()) o.pane.style.display = "none";
  for (const [k, v] of pending) v.el.style.display = k === tmpId ? "flex" : "none";
  activeId = null;
  activePending = tmpId;
  hideTermEmpty();
  pendingBar(pe.title, pe.desc);
  return true;
}

export function pendingIsActive(tmpId) { return activePending === tmpId; }

// Swap a placeholder's spinner for an inline error + dismiss button. Returns false
// if the placeholder is already gone (caller falls back to a toast).
export function failPending(tmpId, message) {
  const pe = pending.get(tmpId);
  if (!pe) return false;
  pe.el.innerHTML = `<div class="pending-box error">
      <div class="pending-title"></div>
      <div class="pending-err"></div>
      <button class="pending-x"></button>
    </div>`;
  pe.el.querySelector(".pending-title").textContent = I18N.t("term.creationFailed");
  pe.el.querySelector(".pending-err").textContent = message || "";
  const x = pe.el.querySelector(".pending-x");
  x.textContent = I18N.t("term.dismiss");
  x.onclick = () => closePending(tmpId);
  return true;
}

// Destroy a placeholder. If it was the visible one, fall back to the empty state.
export function closePending(tmpId) {
  const pe = pending.get(tmpId);
  if (!pe) return;
  pending.delete(tmpId);
  pe.el.remove();
  if (activePending === tmpId) { activePending = null; showTermEmpty(); }
}

// ---- web preview ----
// A localhost link the session prints (e.g. a dev server's "Local:
// http://localhost:5173") is opened in a NEW BROWSER TAB pointed at the
// dispatcher's proxy origin (t<task>-<port>.localhost), which reverse-proxies to
// the dev server on the task's machine. The new tab rides the SAME path you
// reach the dashboard by (direct, or an `ssh -L 4500` tunnel), so it works
// whether the dispatcher is local or remote — and the browser handles
// *.localhost + IPv4/IPv6 itself. A bare localhost:<port> would instead hit the
// BROWSER's own machine, which is wrong whenever you aren't sitting at the box.
const LOCALHOST_URL = /https?:\/\/(?:localhost|127\.0\.0\.1):(\d{1,5})(?:\/[^\s"'`]*)?/g;

function previewUrl(taskId, port) {
  const proto = location.protocol === "https:" ? "https" : "http";
  const portSuffix = location.port ? ":" + location.port : "";
  return `${proto}://t${taskId}-${port}.localhost${portSuffix}/`;
}

function openPreviewTab(taskId, port) {
  window.open(previewUrl(taskId, port), "_blank", "noopener");
}

function localhostLinks(term, taskId) {
  return {
    provideLinks(y, callback) {
      const line = term.buffer.active.getLine(y - 1);
      if (!line) { callback(undefined); return; }
      const text = line.translateToString(false);
      const links = [];
      LOCALHOST_URL.lastIndex = 0;
      let m;
      while ((m = LOCALHOST_URL.exec(text)) !== null) {
        const port = Number(m[1]);
        if (port < 1 || port > 65535) continue;
        const start = m.index;
        links.push({
          text: m[0],
          range: { start: { x: start + 1, y }, end: { x: start + m[0].length, y } },
          activate: () => openPreviewTab(taskId, port),
        });
      }
      callback(links.length ? links : undefined);
    },
  };
}

// manual fallback: a port typed into the term bar opens the active task's page
// in a new tab — for when the printed link is wrapped/truncated in a TUI.
function goPreviewPort() {
  const port = Number($("prev-port").value);
  if (activeId != null && port >= 1 && port <= 65535) openPreviewTab(activeId, port);
}

// Attach the dock to a task's session: reuse its live pane if we have one (just
// show it — instant, no reconnect), else build a new pane. Either way refresh the
// dock bar (title/desc may have changed, e.g. after a rename) and ensure a socket.
export function openPty(query, title, desc, attach, taskId = null, claude = "") {
  if (taskId == null) return;
  let p = panes.get(taskId);
  if (!p) p = createPane(taskId, query);
  else p.query = query;                  // session normally unchanged; keep it fresh
  p.title = title; p.desc = desc || ""; p.attach = attach || ""; p.claude = claude || "";
  showPane(p);
  ensureSocket(p);
}

// Tear down a task's pane: close its socket, dispose the xterm, drop the DOM node.
// Null the onclose first so the closing socket doesn't write "disconnected" into a
// terminal we're disposing. If it was the visible pane, fall back to the empty state.
export function disposePty(id) {
  const p = panes.get(id);
  if (!p) return;
  panes.delete(id);
  try { if (p.ws) { p.ws.onclose = null; p.ws.onmessage = null; p.ws.close(); } } catch {}
  try { p.term.dispose(); } catch {}
  p.pane.remove();
  if (activeId === id) { activeId = null; showTermEmpty(); }
}

// Drop every pane whose task is no longer keepable (gone from the list, or its
// session was killed). Called from loadTasks() with the still-attachable ids.
// Returns the disposed ids so the caller can clear a stale selection.
export function prunePanes(keepIds) {
  const dropped = [];
  // only numeric-id panes are this controller's own tasks (loadTasks drives this).
  // String-id panes belong to remote NODES (fleet tasks) and are pruned separately
  // by pruneNodePanes — the 4s task poll must not tear them down.
  for (const id of [...panes.keys()]) if (typeof id === "number" && !keepIds.has(id)) { disposePty(id); dropped.push(id); }
  return dropped;
}

// Prune fleet (remote-node) panes — those keyed by a string id — whose session is
// no longer live on its node. Driven by loadFleet (the slower cross-node poll), so
// it stays disjoint from prunePanes' own-task lifecycle. Returns the dropped ids.
export function pruneNodePanes(keepKeys) {
  const dropped = [];
  for (const id of [...panes.keys()]) if (typeof id === "string" && !keepKeys.has(id)) { disposePty(id); dropped.push(id); }
  return dropped;
}
