// One live xterm.js terminal PER task, all kept alive. openPty() shows a task's
// pane (creating it on first open); switching cards just toggles which pane is
// visible — no teardown, no reconnect, no flicker. Each pane owns its own xterm
// instance + WebSocket, and the socket stays open in the background, so a
// backgrounded session keeps streaming and a switch-back is instant. Panes are
// disposed when their task goes away (archive / cleanup / delete / vanished from
// the list — see disposePty/prunePanes, called from tasks.js). The live-pane set
// is therefore bounded by the set of active tasks; no separate eviction needed.
// Terminal/FitAddon are the globals from the vendored xterm scripts.
import { $ } from "./dom.js";
import { toast } from "./feedback.js";

// taskId -> { id, pane, term, fit, ws, query, title, desc, attach }
const panes = new Map();
let activeId = null;   // the task whose pane is currently visible (null = none)

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
  if (p.ws && p.ws.readyState === 1) p.ws.send("\x00resize:" + p.term.cols + "x" + p.term.rows);
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

  // linkify localhost URLs the session prints (e.g. a dev server's
  // "Local: http://localhost:5173") and open them in the side preview on click,
  // instead of navigating the browser to the user's OWN (empty) localhost.
  try { term.registerLinkProvider(localhostLinks(term, id)); } catch {}

  const p = { id, pane, term, fit, ws: null, query, title: "", desc: "", attach: "", claude: "" };

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
  ws.onopen = () => { if (activeId === p.id) { try { p.fit.fit(); } catch {} } sendResize(p); };
  ws.onmessage = (e) => p.term.write(typeof e.data === "string" ? e.data : "");
  ws.onclose = () => p.term.write(`\r\n\x1b[90m${I18N.t("term.disconnected")}\x1b[0m\r\n`);
}

// Make a pane the visible one: hide every other pane, show this one, refit (it
// may have been display:none and unmeasurable), repaint, refresh the dock bar
// and grab the keyboard.
function showPane(p) {
  for (const o of panes.values()) o.pane.style.display = o === p ? "block" : "none";
  activeId = p.id;
  hideTermEmpty();
  applyBar(p);
  try { p.fit.fit(); } catch {}
  try { p.term.refresh(0, p.term.rows - 1); } catch {}   // canvas can blank while hidden
  sendResize(p);
  p.term.focus();
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
  for (const o of panes.values()) o.pane.style.display = "none";
  activeId = null;
  showTermEmpty();
}

// The terminal column is permanent (col3); the empty-state overlay shows when no
// pane is attached. showPane() hides it; disposing the last/active pane re-shows it.
export function showTermEmpty() { $("term-empty").classList.remove("hidden"); }
function hideTermEmpty() { $("term-empty").classList.add("hidden"); }

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
  for (const id of [...panes.keys()]) if (!keepIds.has(id)) { disposePty(id); dropped.push(id); }
  return dropped;
}
