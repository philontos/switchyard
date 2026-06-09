// Per-task web preview. A page/dev-server a task starts on its machine's
// 127.0.0.1:<port> is reached by giving each preview its OWN origin —
// `t<taskId>-<port>.localhost:<dispatcherPort>` — and reverse-proxying it under
// the dispatcher. Own-origin (vs a path prefix) means the proxy passes paths
// 1:1, so the app lives at its real root and every URL it emits resolves
// correctly (relative, root-absolute, HMR websocket). See the design spec.

import http from "node:http";
import net from "node:net";

// Matches a preview Host header: `t<taskId>-<port>.localhost` with an optional
// `:<dispatcherPort>` suffix. The leading `t` + the `.localhost` anchor keep
// this from ever matching the dashboard's own host or an internet domain.
const HOST_RE = /^t(\d+)-(\d+)\.localhost(?::\d+)?$/;

// Classify a request by its Host header AND pin it to one (task, port). Returns
// null for anything unrecognized so the caller falls through to the normal
// dashboard/app — and never yields an arbitrary host:port, so the proxy can't
// become an open relay when the dispatcher is exposed via HOST=0.0.0.0.
export function parsePreviewHost(host: string | undefined): { taskId: number; port: number } | null {
  if (!host) return null;
  const m = HOST_RE.exec(host);
  if (!m) return null;
  const taskId = Number(m[1]);
  const port = Number(m[2]);
  if (port < 1 || port > 65535) return null;
  return { taskId, port };
}

// Drop the `frame-ancestors` directive from a CSP value, keeping the others.
// Returns "" if nothing is left, so the caller can drop the header entirely.
function stripFrameAncestors(csp: string): string {
  return csp
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s && !/^frame-ancestors\b/i.test(s))
    .join("; ");
}

// Make an upstream response iframe-able: we own the proxy, so a dev server's
// frame-busting headers don't get the final say. Strips X-Frame-Options and the
// CSP frame-ancestors directive; everything else passes through untouched.
// Input keys are the lowercased ones Node hands back on `res.headers`.
export function sanitizePreviewHeaders(
  headers: Record<string, string | string[] | undefined>,
): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (v === undefined) continue;
    const key = k.toLowerCase();
    if (key === "x-frame-options") continue;
    if (key === "content-security-policy") {
      const csp = stripFrameAncestors(Array.isArray(v) ? v.join(", ") : v);
      if (csp) out[k] = csp;
      continue;
    }
    out[k] = v;
  }
  return out;
}

// Keep a redirect inside the preview iframe: if the app 30x's to an absolute URL
// pointing back at the upstream loopback port, swap the host for the preview
// origin. Relative redirects and genuinely external ones are left alone.
export function rewriteLocation(location: string, remotePort: number, previewHost: string): string {
  let u: URL;
  try {
    u = new URL(location); // throws on a relative location → leave it as-is
  } catch {
    return location;
  }
  const loopback = u.hostname === "127.0.0.1" || u.hostname === "localhost";
  if (loopback && Number(u.port) === remotePort) {
    return `http://${previewHost}${u.pathname}${u.search}${u.hash}`;
  }
  return location;
}

export type PreviewUpstream = { host: string; port: number };
export type PreviewResolution = PreviewUpstream | { error: string; status: number };
// task → upstream host:port (or an error). Injected so the proxy stays DB-free
// and testable; index.ts wires it to the real task/host lookup.
export type PreviewResolver = (taskId: number, port: number) => Promise<PreviewResolution>;

// Express/Node middleware: if the Host is a preview, reverse-proxy it to the
// resolved upstream; otherwise next() so the normal dashboard/app handles it.
export function createPreviewMiddleware(resolve: PreviewResolver) {
  return (req: http.IncomingMessage, res: http.ServerResponse, next: () => void): void => {
    const host = req.headers.host;
    const pv = parsePreviewHost(host);
    if (!pv) { next(); return; }
    resolve(pv.taskId, pv.port)
      .then((up) => {
        if ("error" in up) { res.statusCode = up.status; res.end(up.error); return; }
        proxyHttp(req, res, up, pv.port, host!);
      })
      .catch((e) => {
        if (!res.headersSent) res.statusCode = 502;
        res.end("preview error: " + (e?.message ?? e));
      });
  };
}

// One HTTP request → the upstream loopback port. The upstream Host is set to
// 127.0.0.1:<remotePort> (what the dev server expects — satisfies vite/webpack
// host allowlists); the response is made iframe-able; an absolute redirect back
// to the upstream is pointed at the preview origin.
function proxyHttp(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  up: PreviewUpstream,
  remotePort: number,
  previewHost: string,
): void {
  const upstream = http.request(
    {
      host: up.host,
      port: up.port,
      method: req.method,
      path: req.url,
      headers: { ...req.headers, host: `127.0.0.1:${remotePort}` },
    },
    (upRes) => {
      const headers = sanitizePreviewHeaders(upRes.headers);
      const loc = headers["location"];
      if (typeof loc === "string") headers["location"] = rewriteLocation(loc, remotePort, previewHost);
      res.writeHead(upRes.statusCode ?? 502, headers);
      upRes.pipe(res);
    },
  );
  upstream.on("error", (e: Error) => {
    if (!res.headersSent) res.statusCode = 502;
    res.end("preview upstream error: " + e.message);
  });
  req.pipe(upstream);
}

// WebSocket (e.g. vite HMR) upgrade for a preview Host: dial the upstream
// loopback port, replay the client's handshake with the Host rewritten, then
// pipe both directions. The client's Sec-WebSocket-Key is forwarded intact, so
// the upstream computes the right Accept and the browser sees a valid handshake.
export function handlePreviewUpgrade(
  req: http.IncomingMessage,
  clientSocket: net.Socket,
  head: Buffer,
  resolve: PreviewResolver,
): void {
  const pv = parsePreviewHost(req.headers.host);
  if (!pv) { clientSocket.destroy(); return; }
  resolve(pv.taskId, pv.port)
    .then((up) => {
      if ("error" in up) { clientSocket.end(`HTTP/1.1 ${up.status} Preview Error\r\n\r\n`); return; }
      const upstream = net.connect(up.port, up.host, () => {
        const headers = { ...req.headers, host: `127.0.0.1:${pv.port}` };
        let raw = `${req.method} ${req.url} HTTP/1.1\r\n`;
        for (const [k, v] of Object.entries(headers)) {
          if (v == null) continue;
          for (const val of Array.isArray(v) ? v : [v]) raw += `${k}: ${val}\r\n`;
        }
        upstream.write(raw + "\r\n");
        if (head && head.length) upstream.write(head);
        upstream.pipe(clientSocket);
        clientSocket.pipe(upstream);
      });
      upstream.on("error", () => clientSocket.destroy());
      clientSocket.on("error", () => upstream.destroy());
    })
    .catch(() => clientSocket.destroy());
}

// Quick TCP reachability probe — lets the preview-check endpoint report a precise
// "nothing listening on :<port>" instead of handing the iframe a refused page.
export function tcpProbe(host: string, port: number, timeoutMs = 2000): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port });
    const done = (ok: boolean) => { sock.destroy(); resolve(ok); };
    sock.setTimeout(timeoutMs);
    sock.once("connect", () => done(true));
    sock.once("timeout", () => done(false));
    sock.once("error", () => done(false));
  });
}

export interface ForwardTarget { id: number; target: string; }
export interface ForwardHandle { localPort: number; close(): void; }
export type ForwardSpawner = (target: ForwardTarget, remotePort: number) => Promise<ForwardHandle>;

// Keeps at most one ssh -L forward per (host, remotePort), reused across requests
// and torn down after `idleMs` of no use. Spawning is injected so the lifecycle
// is testable without real ssh. Concurrent acquires share one in-flight spawn; a
// failed spawn isn't cached, so the next acquire retries.
export function createForwardRegistry(spawn: ForwardSpawner, idleMs = 60000) {
  const fwds = new Map<string, { handleP: Promise<ForwardHandle>; timer?: ReturnType<typeof setTimeout> }>();
  async function acquire(target: ForwardTarget, remotePort: number): Promise<number> {
    const key = `${target.id}:${remotePort}`;
    let e = fwds.get(key);
    if (!e) { e = { handleP: spawn(target, remotePort) }; fwds.set(key, e); }
    let handle: ForwardHandle;
    try {
      handle = await e.handleP;
    } catch (err) {
      fwds.delete(key); // don't cache a failed spawn
      throw err;
    }
    if (e.timer) clearTimeout(e.timer);
    e.timer = setTimeout(() => { try { handle.close(); } catch {} fwds.delete(key); }, idleMs);
    e.timer.unref?.();
    return handle.localPort;
  }
  return { acquire };
}
