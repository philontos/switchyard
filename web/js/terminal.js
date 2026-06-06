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

export function initTerm() {
  // Only the visible pane tracks the window size; background panes are re-fit
  // when they're next shown (they can't be measured while display:none anyway).
  window.addEventListener("resize", () => {
    const p = activeId != null ? panes.get(activeId) : null;
    if (p) { try { p.fit.fit(); sendResize(p); } catch {} }
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
    theme: { background: "#1a1613", foreground: "#ddd4c8", cursor: "#d97757", cursorAccent: "#1a1613", selectionBackground: "#d9775740" },
    macOptionClickForcesSelection: true,   // mac: Option+拖拽 强制本地选区(绕开 TUI 鼠标模式)
    rightClickSelectsWord: true,
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(pane);

  const p = { id, pane, term, fit, ws: null, query, title: "", desc: "", attach: "" };

  // claude TUI 开了鼠标上报,普通拖拽会被转发给应用; Shift/Option 拖拽走本地选区,松手即复制
  term.element.addEventListener("mouseup", () => {
    const s = term.getSelection();
    if (s) navigator.clipboard.writeText(s).catch(() => {});
  });
  // 键盘复制: mac=Cmd+C, 其他=Ctrl+Shift+C; 仅在有选区时拦截,避免吃掉 ^C(SIGINT)
  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== "keydown") return true;
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

// The terminal column is permanent (col3); the empty-state overlay shows when no
// pane is attached. showPane() hides it; disposing the last/active pane re-shows it.
export function showTermEmpty() { $("term-empty").classList.remove("hidden"); }
function hideTermEmpty() { $("term-empty").classList.add("hidden"); }

// Attach the dock to a task's session: reuse its live pane if we have one (just
// show it — instant, no reconnect), else build a new pane. Either way refresh the
// dock bar (title/desc may have changed, e.g. after a rename) and ensure a socket.
export function openPty(query, title, desc, attach, taskId = null) {
  if (taskId == null) return;
  let p = panes.get(taskId);
  if (!p) p = createPane(taskId, query);
  else p.query = query;                  // session normally unchanged; keep it fresh
  p.title = title; p.desc = desc || ""; p.attach = attach || "";
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
