// The websocket side: route HTTP upgrades (preview HMR vs the /pty terminal),
// and relay a browser terminal to a task's tmux session over a locally-spawned
// pty (attaching locally, or via ssh/mosh for a remote task). Lifted verbatim
// from index.ts; attachWs() takes the http server so index.ts stays the entry.
import type { Server } from "node:http";
import { WebSocketServer } from "ws";
import pty from "node-pty";
import { spawnPty } from "../session/pty.js";
import { attachCommand } from "../session/attach.js";
import { parsePreviewHost, handlePreviewUpgrade } from "../preview/preview.js";
import { resolvePreviewUpstream } from "./preview.js";
import { db, Task, Host } from "../core/db.js";
import { runnerFor, localRunner, type Runner } from "../fleet/runner.js";
import { cancelCopyMode, ensureSessionOptions, pasteSubmit } from "../session/tmux.js";
import { tr, langFromQuery } from "../core/i18n.js";
import { taskHost, getHost, SSH_BIN, MOSH_BIN, TMUX_BIN, SESSION_RE } from "./context.js";

const wss = new WebSocketServer({ noServer: true });

wss.on("connection", async (ws, req) => {
  const url = new URL(req.url || "", "http://localhost");
  const session = url.searchParams.get("session");
  const lang = langFromQuery(url.searchParams.get("lang"));

  // attach the relay to a task's tmux session, on whichever machine the task
  // lives: local tmux, or ssh/mosh into the remote and attach there. node-pty
  // spawns the client locally; the shell/tmux/files all live ON that machine.
  if (!session || !SESSION_RE.test(session)) { ws.close(1008, "invalid target"); return; }
  const task = db.prepare("SELECT * FROM tasks WHERE session=?").get(session) as Task | undefined;
  // A fleet session lives on another node and isn't in THIS controller's db. The
  // client (rendering it under that node) passes ?host=<id>, so we can still
  // ssh-attach to it. The host must be a known remote — never trust the hint to
  // reach an arbitrary box. Falls back to the task's own host for local sessions.
  let host = task ? taskHost(task) : undefined;
  if (!task) {
    const hintId = Number(url.searchParams.get("host"));
    if (Number.isInteger(hintId)) host = getHost.get(hintId) as Host | undefined;
  }
  const { file, args, label } = attachCommand(host, session, { ssh: SSH_BIN, mosh: MOSH_BIN, tmux: TMUX_BIN });
  // the session whose copy/scroll mode we cancel on attach, so this client lands
  // on the live prompt no matter what mode a previous client left the pane in.
  const cancelRunner: Runner = host ? runnerFor(host) : localRunner;
  const cancelSession = session;

  // multiple clients can attach independently (tmux/ssh both handle this)
  let term: pty.IPty;
  try {
    term = spawnPty(file, args, {
      name: "xterm-256color",
      cols: 120,
      rows: 32,
      cwd: process.env.HOME,
      env: process.env as Record<string, string>,
    });
  } catch (e: any) {
    // spawn failure must not crash the server — report on the socket and bail
    try { ws.send(`\r\n\x1b[31m${tr(lang, "session.attachFailed", { session: label, error: e.message })}\x1b[0m\r\n`); } catch {}
    ws.close();
    return;
  }

  // Register every relay listener synchronously, before the first await below.
  // The browser sends its initial \0resize as soon as the WebSocket opens; if we
  // await tmux setup first, that message can arrive with no listener and the PTY
  // stays at its 120x32 bootstrap size until the browser is resized again.
  term.onData((data) => {
    if (ws.readyState === ws.OPEN) ws.send(data);
  });
  term.onExit(() => {
    if (ws.readyState === ws.OPEN) ws.close();
  });

  ws.on("message", (raw) => {
    const msg = raw.toString();
    if (msg.startsWith("\x00resize:")) {
      const [, dims] = msg.split(":");
      const [cols, rows] = dims.split("x").map(Number);
      if (cols && rows) term.resize(cols, rows);
      return;
    }
    if (msg.startsWith("\x00submit:")) {
      let text = "";
      try { text = JSON.parse(msg.slice("\x00submit:".length)).text || ""; } catch {}
      pasteSubmit(cancelRunner, cancelSession, text).catch(() => {});
      return;
    }
    term.write(msg);
  });

  ws.on("close", () => {
    // detach (don't kill the tmux session) by sending the tmux detach key isn't
    // reliable here; killing the attach client process is enough.
    term.kill();
  });

  // Normalize the session after the relay is live, then nudge the pane out of
  // copy/scroll mode so this client lands on the current prompt.
  await ensureSessionOptions(cancelRunner, cancelSession);
  if (cancelRunner) cancelCopyMode(cancelRunner, cancelSession);
});

export function attachWs(server: Server) {
server.on("upgrade", (req, socket, head) => {
  if (parsePreviewHost(req.headers.host)) {
    handlePreviewUpgrade(req, socket, head, resolvePreviewUpstream);
    return;
  }
  const { pathname } = new URL(req.url || "", "http://localhost");
  if (pathname === "/pty") {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
    return;
  }
  socket.destroy();
});
}
