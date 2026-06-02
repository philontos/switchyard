// The xterm.js terminal + its collapsible bottom dock, and openPty() — the
// generic "attach the terminal to a /pty target" entry point used by both task
// sessions (tasks.js) and remote-host shells (hosts.js). Terminal/FitAddon are
// the globals from the vendored xterm scripts. term/fit/ws are private to this
// module; nothing else needs them.
import { $ } from "./dom.js";

let term, fit, ws;

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
  try { fit.fit(); } catch {}
  window.addEventListener("resize", () => { try { fit.fit(); sendResize(); } catch {} });
  term.onData(d => ws && ws.readyState === 1 && ws.send(d));
  // 点击 dock 外侧(如上方的任务区/标题栏)自动折叠终端 —— 不必特地去点 ▾ 开关。
  // capture 阶段触发: 点任务卡片时先折叠, 紧接着卡片自己的 connect()->openPty()->
  // expandDock() 又把它展开, 净效果是切到新会话且终端保持打开; 而点击真正的空白
  // 区域没有后续 expand, 就只剩折叠。有选区时跳过, 不打断划词(松手即复制)的操作。
  document.addEventListener("click", (e) => {
    const d = $("dock");
    if (d.classList.contains("collapsed") || d.contains(e.target)) return;
    if (String(window.getSelection() || "")) return;
    d.classList.add("collapsed");
    renderDockToggle();
  }, true);
}
function sendResize() {
  if (ws && ws.readyState === 1) ws.send("\x00resize:" + term.cols + "x" + term.rows);
}
export function renderDockToggle() {
  const collapsed = $("dock").classList.contains("collapsed");
  $("dock-toggle").textContent = (collapsed ? "▴ " : "▾ ") + t("term.label");
}
function expandDock() {
  $("dock").classList.remove("collapsed");
  renderDockToggle();
  setTimeout(() => { try { fit.fit(); sendResize(); } catch {} }, 160);
}
export function toggleDock() {
  const d = $("dock");
  if (d.classList.contains("collapsed")) expandDock();
  else { d.classList.add("collapsed"); renderDockToggle(); }
}

// open the terminal dock against a /pty target (local session or remote host)
export function openPty(query, title, desc, attach) {
  if (ws) { ws.close(); ws = null; }
  expandDock();
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
  // grab the keyboard so arrows/typing go straight into the session — expandDock()
  // above already un-hid #term (it's display:none while collapsed), so it's focusable.
  term.focus();
}
