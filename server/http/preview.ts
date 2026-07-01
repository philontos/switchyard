// Web-preview wiring: resolve a task's dev-server port to a concrete upstream
// (local loopback, or a remote reached through an on-demand ssh -L forward).
// The proxy middleware (app.ts) and the HMR websocket upgrade (ws.ts) share the
// single `resolvePreviewUpstream` exported here, so the forward registry is one
// instance. Lifted verbatim out of index.ts.
import net from "node:net";
import { spawn as spawnChild } from "node:child_process";
import { sshForwardArgs } from "../fleet/runner.js";
import { tcpProbe, createForwardRegistry, type PreviewResolution, type ForwardHandle } from "../preview/preview.js";
import { type Task } from "../core/db.js";
import { getTask, taskHost, SSH_BIN } from "./context.js";

// ---------- web preview ----------
// Reach a task's dev server (127.0.0.1:<port> ON its machine). Local tasks the
// frontend hits directly; remote tasks are reverse-proxied through a t<task>-
// <port>.localhost origin (see preview.ts) whose upstream is an ssh -L forward.

// a free loopback port for an ssh -L forward's local end
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => { const p = (srv.address() as { port: number }).port; srv.close(() => resolve(p)); });
  });
}
async function waitListening(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await tcpProbe("127.0.0.1", port, 500)) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}
// one ssh -N -L forward per (remote host, remote port), riding the shared
// ControlMaster; the registry tears it down after idle.
const forwards = createForwardRegistry(async (target, remotePort): Promise<ForwardHandle> => {
  const localPort = await freePort();
  const child = spawnChild(SSH_BIN, sshForwardArgs(target.target, localPort, remotePort), { stdio: "ignore" });
  child.on("error", () => {});
  if (!(await waitListening(localPort, 5000))) { child.kill(); throw new Error("ssh -L not ready"); }
  return { localPort, close: () => { try { child.kill(); } catch {} } };
});

// A dev server may bind IPv4 (127.0.0.1) or IPv6 (::1) loopback — vite binds ::1
// by default on macOS. Pick whichever family is actually listening (or null).
// Cached briefly so a page load's burst of proxied requests doesn't re-probe.
const lbCache = new Map<number, { host: string; exp: number }>();
async function loopbackHostFor(port: number): Promise<string | null> {
  const c = lbCache.get(port);
  if (c && c.exp > Date.now()) return c.host;
  let host: string | null = null;
  if (await tcpProbe("127.0.0.1", port, 1500)) host = "127.0.0.1";
  else if (await tcpProbe("::1", port, 1500)) host = "::1";
  if (host) lbCache.set(port, { host, exp: Date.now() + 5000 });
  return host;
}

// Resolve a preview to its upstream. Resolves ONLY to a live task's own loopback
// <port> (local) or that port reached via an ssh forward (remote) — never an
// arbitrary host:port, so the proxy can't become an open relay under
// HOST=0.0.0.0. `error` is a human-readable line: previews open in a plain
// browser tab, so on failure the proxy serves this text as the page.
type PreviewTarget =
  | { kind: "local" | "ssh"; host: string; port: number }
  | { error: true; reason: string; status: number };
async function previewTarget(taskId: number, port: number): Promise<PreviewTarget> {
  const task = getTask.get(taskId) as Task | undefined;
  if (!task || task.status === "cleaned") return { error: true, reason: `Preview: task ${taskId} not found or archived.`, status: 404 };
  const host = taskHost(task);
  if (!host || host.kind === "local") {
    const lb = await loopbackHostFor(port); // 127.0.0.1 or ::1, whichever is listening
    if (!lb) return { error: true, reason: `Preview: nothing is listening on port ${port} (dev server not up yet?).`, status: 404 };
    return { kind: "local", host: lb, port };
  }
  if (host.status !== "online") return { error: true, reason: `Preview: machine "${host.name}" is offline.`, status: 502 };
  try {
    const localPort = await forwards.acquire({ id: host.id, target: host.target }, port);
    return { kind: "ssh", host: "127.0.0.1", port: localPort };
  } catch {
    return { error: true, reason: `Preview: couldn't open the ssh forward to "${host.name}".`, status: 502 };
  }
}

// the proxy just needs the upstream host:port (or an error message + status)
export async function resolvePreviewUpstream(taskId: number, port: number): Promise<PreviewResolution> {
  const t = await previewTarget(taskId, port);
  return "error" in t ? { error: t.reason, status: t.status } : { host: t.host, port: t.port };
}
