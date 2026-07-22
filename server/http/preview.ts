// Web-preview wiring: resolve an owner-local task's dev-server port to a
// concrete loopback upstream.
// The proxy middleware (app.ts) and the HMR websocket upgrade (ws.ts) share the
// single `resolvePreviewUpstream` exported here, so the forward registry is one
// instance. Lifted verbatim out of index.ts.
import { tcpProbe, type PreviewResolution } from "../preview/preview.js";
import { type Task } from "../core/db.js";
import { getTask } from "./context.js";

// ---------- web preview ----------
// Remote preview will be added as an explicit node-local command/stream. It must
// not be resurrected by looking up a historical remote task row and opening an
// SSH port forward from the controller.

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

// Resolve a preview ONLY for a task owned by this node. getTask is owner-filtered,
// so historical remote rows cannot be turned into controller-side filesystem or
// network operations.
type PreviewTarget =
  | { host: string; port: number }
  | { error: true; reason: string; status: number };
async function previewTarget(taskId: number, port: number): Promise<PreviewTarget> {
  const task = getTask.get(taskId) as Task | undefined;
  if (!task || task.status === "cleaned") return { error: true, reason: `Preview: task ${taskId} not found or archived.`, status: 404 };
  const lb = await loopbackHostFor(port); // 127.0.0.1 or ::1, whichever is listening
  if (!lb) return { error: true, reason: `Preview: nothing is listening on port ${port} (dev server not up yet?).`, status: 404 };
  return { host: lb, port };
}

// the proxy just needs the upstream host:port (or an error message + status)
export async function resolvePreviewUpstream(taskId: number, port: number): Promise<PreviewResolution> {
  const t = await previewTarget(taskId, port);
  return "error" in t ? { error: t.reason, status: t.status } : { host: t.host, port: t.port };
}
