import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { parsePreviewHost, sanitizePreviewHeaders, rewriteLocation, createPreviewMiddleware, handlePreviewUpgrade, tcpProbe, createForwardRegistry } from "./preview.js";

// parsePreviewHost is the gate: it both classifies a request as a preview AND
// pins it to one (task, port). Anything it doesn't recognize must fall through
// to the normal dashboard/app — and it must never hand back an arbitrary
// host:port (the proxy would otherwise become an open relay under HOST=0.0.0.0).

test("parsePreviewHost: t<task>-<port>.localhost → { taskId, port }", () => {
  assert.deepEqual(parsePreviewHost("t12-5173.localhost"), { taskId: 12, port: 5173 });
});

test("parsePreviewHost: tolerates the dispatcher port suffix on the Host header", () => {
  assert.deepEqual(parsePreviewHost("t12-5173.localhost:4500"), { taskId: 12, port: 5173 });
});

test("parsePreviewHost: rejects the dashboard's own host", () => {
  assert.equal(parsePreviewHost("localhost:4500"), null);
  assert.equal(parsePreviewHost("127.0.0.1:4500"), null);
});

test("parsePreviewHost: rejects a non-.localhost domain (never proxy to the internet)", () => {
  assert.equal(parsePreviewHost("t12-5173.evil.com"), null);
  assert.equal(parsePreviewHost("t12-5173.localhost.evil.com"), null);
});

test("parsePreviewHost: rejects non-numeric task or port", () => {
  assert.equal(parsePreviewHost("tabc-5173.localhost"), null);
  assert.equal(parsePreviewHost("t12-xyz.localhost"), null);
});

test("parsePreviewHost: rejects an out-of-range port", () => {
  assert.equal(parsePreviewHost("t12-0.localhost"), null);
  assert.equal(parsePreviewHost("t12-70000.localhost"), null);
});

test("parsePreviewHost: handles undefined / empty / junk", () => {
  assert.equal(parsePreviewHost(undefined), null);
  assert.equal(parsePreviewHost(""), null);
  assert.equal(parsePreviewHost("garbage"), null);
});

// --- response sanitizing: the previewed app must be iframe-able no matter what
// frame-busting headers its dev server sets, since we control the proxy. ---

test("sanitizePreviewHeaders: drops X-Frame-Options", () => {
  const out = sanitizePreviewHeaders({ "content-type": "text/html", "x-frame-options": "DENY" });
  assert.equal(out["x-frame-options"], undefined);
  assert.equal(out["content-type"], "text/html");
});

test("sanitizePreviewHeaders: strips only frame-ancestors from CSP, keeps the rest", () => {
  const out = sanitizePreviewHeaders({
    "content-security-policy": "default-src 'self'; frame-ancestors 'none'; img-src *",
  });
  assert.equal(out["content-security-policy"], "default-src 'self'; img-src *");
});

test("sanitizePreviewHeaders: drops CSP entirely when frame-ancestors was its only directive", () => {
  const out = sanitizePreviewHeaders({ "content-security-policy": "frame-ancestors 'none'" });
  assert.equal(out["content-security-policy"], undefined);
});

test("sanitizePreviewHeaders: leaves unrelated headers untouched", () => {
  const out = sanitizePreviewHeaders({ "set-cookie": ["a=1", "b=2"], "cache-control": "no-cache" });
  assert.deepEqual(out["set-cookie"], ["a=1", "b=2"]);
  assert.equal(out["cache-control"], "no-cache");
});

// --- redirect rewriting: an absolute Location back to the upstream loopback
// port must point at the preview origin so the browser stays in the iframe. ---

test("rewriteLocation: absolute loopback redirect → preview origin, path preserved", () => {
  assert.equal(
    rewriteLocation("http://127.0.0.1:5173/app?x=1", 5173, "t12-5173.localhost:4500"),
    "http://t12-5173.localhost:4500/app?x=1",
  );
  assert.equal(
    rewriteLocation("http://localhost:5173/app", 5173, "t12-5173.localhost:4500"),
    "http://t12-5173.localhost:4500/app",
  );
});

test("rewriteLocation: a relative redirect is left unchanged", () => {
  assert.equal(rewriteLocation("/login", 5173, "t12-5173.localhost:4500"), "/login");
});

test("rewriteLocation: an external absolute redirect is left unchanged", () => {
  assert.equal(
    rewriteLocation("https://accounts.google.com/o", 5173, "t12-5173.localhost:4500"),
    "https://accounts.google.com/o",
  );
});

test("rewriteLocation: loopback but a different port is left unchanged", () => {
  assert.equal(rewriteLocation("http://127.0.0.1:9999/x", 5173, "t12-5173.localhost:4500"), "http://127.0.0.1:9999/x");
});

// --- the proxy itself: a real upstream "dev server" + real sockets, with the
// task→upstream resolver injected so no DB is involved. ---

function listen(handler: http.RequestListener): Promise<{ server: http.Server; port: number }> {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => resolve({ server, port: (server.address() as any).port }));
  });
}

function fetchVia(port: number, headers: Record<string, string>): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: "/", headers }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

test("preview proxy: forwards to the upstream, rewrites Host, strips frame-busting", async () => {
  const upstream = await listen((req, res) => {
    res.writeHead(200, { "content-type": "text/plain", "x-frame-options": "DENY" });
    res.end("upstream saw Host=" + req.headers.host);
  });
  // resolver points every preview at our fake upstream (stands in for 127.0.0.1:<remotePort>)
  const mw = createPreviewMiddleware(async () => ({ host: "127.0.0.1", port: upstream.port }));
  const proxy = await listen((req, res) => mw(req, res, () => { res.statusCode = 404; res.end("not preview"); }));
  try {
    const r = await fetchVia(proxy.port, { host: "t1-5173.localhost" });
    assert.equal(r.status, 200);
    assert.equal(r.headers["x-frame-options"], undefined);     // stripped → iframe-able
    assert.match(r.body, /upstream saw Host=127\.0\.0\.1:5173/); // upstream got the remote port, not the proxy's
  } finally {
    upstream.server.close(); proxy.server.close();
  }
});

test("preview proxy: a non-preview Host falls through to next()", async () => {
  const mw = createPreviewMiddleware(async () => ({ host: "127.0.0.1", port: 1 }));
  const proxy = await listen((req, res) => mw(req, res, () => { res.statusCode = 404; res.end("not preview"); }));
  try {
    const r = await fetchVia(proxy.port, { host: "localhost" });
    assert.equal(r.status, 404);
    assert.equal(r.body, "not preview");
  } finally { proxy.server.close(); }
});

test("preview proxy: an unresolvable task yields its error status, never proxies", async () => {
  const mw = createPreviewMiddleware(async () => ({ error: "no such task", status: 404 }));
  const proxy = await listen((req, res) => mw(req, res, () => { res.statusCode = 500; res.end("should not reach next"); }));
  try {
    const r = await fetchVia(proxy.port, { host: "t9-5173.localhost" });
    assert.equal(r.status, 404);
    assert.match(r.body, /no such task/);
  } finally { proxy.server.close(); }
});

// --- WebSocket upgrade (vite HMR): route by Host, dial the upstream, replay the
// handshake with the Host rewritten to the remote port. Raw TCP upstream so we
// assert the exact bytes without a full WS handshake. ---

test("handlePreviewUpgrade: dials upstream and replays the handshake with rewritten Host", async () => {
  let received = "";
  const upstream = net.createServer((sock) => sock.on("data", (d) => { received += d.toString(); }));
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", () => r()));
  const upPort = (upstream.address() as any).port;

  const proxy = http.createServer((_req, res) => res.end());
  proxy.on("upgrade", (req, socket, head) =>
    handlePreviewUpgrade(req, socket, head, async () => ({ host: "127.0.0.1", port: upPort })));
  await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", () => r()));
  const proxyPort = (proxy.address() as any).port;

  const client = net.connect(proxyPort, "127.0.0.1");
  await new Promise<void>((r) => client.on("connect", () => r()));
  client.write(
    "GET /ws HTTP/1.1\r\n" +
    "Host: t1-5173.localhost\r\n" +
    "Upgrade: websocket\r\n" +
    "Connection: Upgrade\r\n" +
    "Sec-WebSocket-Key: abc123\r\n\r\n",
  );
  await new Promise((r) => setTimeout(r, 100));
  try {
    assert.match(received, /^GET \/ws HTTP\/1\.1\r\n/);     // method + path replayed
    assert.match(received, /\r\nhost: 127\.0\.0\.1:5173\r\n/i); // Host rewritten to the remote port
    assert.match(received, /sec-websocket-key: abc123/i);   // client handshake key forwarded intact
  } finally {
    client.destroy(); proxy.close(); upstream.close();
  }
});

test("handlePreviewUpgrade: a non-preview Host is dropped, not proxied", async () => {
  const proxy = http.createServer((_req, res) => res.end());
  let resolverCalled = false;
  proxy.on("upgrade", (req, socket, head) =>
    handlePreviewUpgrade(req, socket, head, async () => { resolverCalled = true; return { host: "127.0.0.1", port: 1 }; }));
  await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", () => r()));
  const proxyPort = (proxy.address() as any).port;

  const client = net.connect(proxyPort, "127.0.0.1");
  await new Promise<void>((r) => client.on("connect", () => r()));
  const closed = new Promise<void>((r) => client.on("close", () => r()));
  client.write("GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
  await closed; // the proxy must destroy the socket
  try {
    assert.equal(resolverCalled, false);
  } finally { proxy.close(); }
});

// --- reachability probe: lets the check endpoint say "nothing on :<port>"
// instead of handing the iframe a blank/refused page. ---

test("tcpProbe: true when a port is listening, false when it isn't", async () => {
  const srv = net.createServer();
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  const port = (srv.address() as any).port;
  assert.equal(await tcpProbe("127.0.0.1", port, 1000), true);
  await new Promise<void>((r) => srv.close(() => r()));
  assert.equal(await tcpProbe("127.0.0.1", port, 1000), false);
});

// --- ssh -L forward registry: at most one forward per (host, remotePort),
// reused across requests, torn down after idle. spawn is injected. ---

test("forward registry: spawns once per (host,port) and reuses the local port", async () => {
  let spawns = 0;
  const reg = createForwardRegistry(async (_t, remotePort) => { spawns++; return { localPort: 40000 + remotePort, close() {} }; }, 10000);
  const a = await reg.acquire({ id: 1, target: "h" }, 5173);
  const b = await reg.acquire({ id: 1, target: "h" }, 5173);
  assert.equal(a, 45173);
  assert.equal(b, 45173);
  assert.equal(spawns, 1);
});

test("forward registry: distinct (host,port) keys each get their own forward", async () => {
  let spawns = 0;
  const reg = createForwardRegistry(async () => { spawns++; return { localPort: 40000 + spawns, close() {} }; }, 10000);
  await reg.acquire({ id: 1, target: "h" }, 5173);
  await reg.acquire({ id: 2, target: "h2" }, 5173); // different host
  await reg.acquire({ id: 1, target: "h" }, 3000);  // different port
  assert.equal(spawns, 3);
});

test("forward registry: tears the forward down after idle", async () => {
  let closed = false;
  const reg = createForwardRegistry(async () => ({ localPort: 41000, close() { closed = true; } }), 20);
  await reg.acquire({ id: 1, target: "h" }, 5173);
  await new Promise((r) => setTimeout(r, 70));
  assert.equal(closed, true);
});

test("forward registry: a failed spawn isn't cached (next acquire retries)", async () => {
  let attempts = 0;
  const reg = createForwardRegistry(async () => { attempts++; if (attempts === 1) throw new Error("ssh down"); return { localPort: 42000, close() {} }; }, 10000);
  await assert.rejects(() => reg.acquire({ id: 1, target: "h" }, 5173));
  const p = await reg.acquire({ id: 1, target: "h" }, 5173); // retries, succeeds
  assert.equal(p, 42000);
  assert.equal(attempts, 2);
});
