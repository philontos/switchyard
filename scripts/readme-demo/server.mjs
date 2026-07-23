import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import QRCode from "qrcode";
import { WebSocketServer } from "ws";
import {
  discovery,
  fleet,
  hosts,
  onboarding,
  providers,
  repos,
  skills,
  tasks,
  terminalFrame,
  transcript,
} from "./data.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../..");
const WEB = path.join(ROOT, "web");

export async function startDemoServer(port = 0) {
  const app = express();
  app.use(express.json());

  app.get("/api/repos", (_req, res) => res.json(repos));
  app.get("/api/repos/:id/branches", (_req, res) =>
    res.json(["main", "develop", "release/next"]));
  app.get("/api/tasks", (_req, res) => res.json(tasks));
  app.get("/api/hosts", (_req, res) => res.json(hosts));
  app.get("/api/fleet", (_req, res) => res.json(fleet));
  app.get("/api/providers", (_req, res) => res.json(providers));
  app.get("/api/skills", (_req, res) => res.json(skills));
  app.get("/api/network/discovery", (_req, res) => res.json(discovery));
  app.get("/api/onboarding/status", (_req, res) => {
    res.setHeader("cache-control", "no-store");
    res.json(onboarding);
  });
  app.post("/api/onboarding/mobile/check-in", (_req, res) =>
    res.json({ ok: true, verified_at: "2026-07-23T09:12:00.000Z" }));
  app.get("/api/onboarding/mobile-qr.svg", async (_req, res) => {
    const svg = await QRCode.toString(onboarding.phone.url, {
      type: "svg",
      errorCorrectionLevel: "M",
      margin: 2,
      width: 256,
      color: { dark: "#1a1613", light: "#ffffff" },
    });
    res.type("image/svg+xml").send(svg);
  });
  app.get("/api/tasks/:id/transcript", (req, res) => {
    const since = Number(req.query.since || 0);
    res.json(since > 0 ? { ...transcript, entries: [] } : transcript);
  });

  app.use(express.static(WEB, { etag: false, lastModified: false, maxAge: 0 }));

  const server = createServer(app);
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url || "/", "http://127.0.0.1");
    if (url.pathname !== "/pty") return socket.destroy();
    wss.handleUpgrade(request, socket, head, (ws) => wss.emit("connection", ws, request));
  });
  wss.on("connection", (ws, request) => {
    const url = new URL(request.url || "/", "http://127.0.0.1");
    let sent = false;
    const send = () => {
      if (sent || ws.readyState !== ws.OPEN) return;
      sent = true;
      ws.send(terminalFrame(url.searchParams.get("session")));
    };
    ws.on("message", (raw) => {
      if (String(raw).startsWith("\u0000resize:")) send();
    });
    const timer = setTimeout(send, 350);
    timer.unref();
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("demo server did not bind");
  return {
    port: address.port,
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve) => {
      for (const client of wss.clients) client.terminate();
      wss.close();
      server.close(resolve);
    }),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const requested = Number(process.env.PORT || 14600);
  const demo = await startDemoServer(requested);
  console.log(`Switchyard README demo on ${demo.url}`);
}
