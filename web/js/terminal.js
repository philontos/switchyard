// The xterm.js terminal + its collapsible bottom dock, and openPty() — the
// generic "attach the terminal to a /pty target" entry point used by both task
// sessions (tasks.js) and remote-host shells (hosts.js). Terminal/FitAddon are
// the globals from the vendored xterm scripts. term/fit/ws are private to this
// module; nothing else needs them.
import { $ } from "./dom.js";
import { toast } from "./feedback.js";

let term, fit, ws;
let pasteTaskId = null;   // the task whose session is attached (null for host shells)

export function initTerm() {
  term = new Terminal({
    fontSize: 13, fontFamily: "Menlo, monospace", cursorBlink: true,
    theme: { background: "#1a1613", foreground: "#ddd4c8", cursor: "#d97757", cursorAccent: "#1a1613", selectionBackground: "#d9775740" },
    macOptionClickForcesSelection: true,   // mac: Option+拖拽 强制本地选区(绕开 TUI 鼠标模式)
    rightClickSelectsWord: true,
  });
  fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open($("term"));
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
  // text — upload it to the attached task; the server lands it on that machine
  // and bracketed-pastes the path into claude, which attaches it as [Image #N].
  // Text pastes fall through to xterm untouched. Only active for a TASK session.
  term.element.addEventListener("paste", onPasteImage, true);
  try { fit.fit(); } catch {}
  window.addEventListener("resize", () => { try { fit.fit(); sendResize(); } catch {} });
  term.onData(d => ws && ws.readyState === 1 && ws.send(d));
}
function sendResize() {
  if (ws && ws.readyState === 1) ws.send("\x00resize:" + term.cols + "x" + term.rows);
}

// Intercept an image paste (screenshot in clipboard) and route it to the task;
// non-image (text) pastes are left for xterm. getAsFile() must run synchronously
// inside the event, so we grab the File first, then upload async.
function onPasteImage(e) {
  if (!pasteTaskId) return;                       // host shell / nothing attached
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
  uploadPasteImage(pasteTaskId, file);
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
    term.focus();
  } catch (err) {
    toast(I18N.t("toast.pasteFailed", { error: err.message }), "error", 6000);
  }
}
// The terminal is permanent (col3); the empty-state overlay shows when nothing
// is attached. openPty() hides it; clearing a selection re-shows it.
export function showTermEmpty() { $("term-empty").classList.remove("hidden"); }
function hideTermEmpty() { $("term-empty").classList.add("hidden"); }

// open the terminal dock against a /pty target (local session or remote host)
export function openPty(query, title, desc, attach, taskId = null) {
  pasteTaskId = taskId;   // image-paste targets this task (null for host shells)
  if (ws) { ws.close(); ws = null; }
  hideTermEmpty();
  term.reset();
  // dynamic content, not a localized label — drop the static i18n binding so a
  // language switch won't overwrite the title back to "Not connected".
  $("term-title").removeAttribute("data-i18n");
  $("term-title").textContent = title;
  $("term-desc").textContent = desc || "";
  $("term-desc").title = desc || "";       // full text on hover
  $("term-attach").textContent = attach || "";
  const proto = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${proto}://${location.host}/pty?${query}&lang=${I18N.lang}`);
  ws.onopen = () => { fit.fit(); sendResize(); };
  ws.onmessage = (e) => term.write(typeof e.data === "string" ? e.data : "");
  ws.onclose = () => term.write(`\r\n\x1b[90m${I18N.t("term.disconnected")}\x1b[0m\r\n`);
  // grab the keyboard so arrows/typing go straight into the session
  term.focus();
}
