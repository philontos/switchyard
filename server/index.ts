// Entry point: harden PATH for spawned children, build the app + http server,
// attach the websocket bridge, run one-time boot reconciliation, then listen.
// All the substance moved into ./http/* and the domain folders — this file is
// just the composition root.
import { createServer } from "node:http";
import { db } from "./core/db.js";
import { DID_MIGRATE, DATA_DIR } from "./core/paths.js";
import { repairWorktrees } from "./core/migrate.js";
import { startLivenessLoop } from "./fleet/liveness.js";
import { syncReposManifest } from "./repo/manifest.js";
import { readTaskManifests, adoptTaskManifests } from "./task/taskmanifest.js";
import { syncTaskManifest } from "./http/context.js";
import { createApp } from "./http/app.js";
import { attachWs } from "./http/ws.js";
import { listOwnedTasks } from "./core/ownership.js";
import { restoreKeepAwake } from "./onboarding/power.js";

// ensure child processes (git/tmux/pty) find Homebrew/usr-local binaries
// regardless of how the server was launched (a stripped PATH otherwise breaks
// tmux/pty with "posix_spawnp failed").
for (const p of ["/opt/homebrew/bin", "/usr/local/bin"]) {
  if (!(process.env.PATH || "").split(":").includes(p)) {
    process.env.PATH = `${p}:${process.env.PATH || ""}`;
  }
}
// never let a single bad pty/connection take down the whole server
process.on("uncaughtException", (e) => console.error("[uncaught]", e));
process.on("unhandledRejection", (e) => console.error("[unhandledRejection]", e));

const app = createApp();

if (DID_MIGRATE) repairWorktrees(); // fix git worktree links after the ./data move
syncReposManifest();                // bootstrap repos.json from the current catalog on boot
// adopt any task manifests on disk this DB is missing (recover a wiped db / own
// tasks present locally), then backfill manifests for every task we own so the
// on-disk catalog mirrors the table.
adoptTaskManifests(db, readTaskManifests(DATA_DIR));
for (const { id } of listOwnedTasks(db)) syncTaskManifest(id);

const PORT = Number(process.env.PORT || 4500);
// Bind loopback by default — the web terminal is a live shell, so don't expose
// it on the LAN unless explicitly asked. Set HOST=0.0.0.0 to listen on all
// interfaces (then put auth / a reverse proxy in front), set HOSTS=a,b to bind
// multiple selected addresses, or use an ssh tunnel (ssh -L 4500:localhost:4500
// host) for remote access.
const HOSTS = (process.env.HOSTS || process.env.HOST || "127.0.0.1")
  .split(",")
  .map((h) => h.trim())
  .filter(Boolean);
const uniqueHosts = [...new Set(HOSTS)];
const servers = uniqueHosts.map((host) => {
  const server = createServer(app);
  attachWs(server);
  return { host, server };
});

try {
  // Do not resolve the tdsp `serve` command until every requested listener has
  // actually bound. In particular, EADDRINUSE must reject startup so the
  // lifecycle record is released instead of claiming that a broken server is
  // running.
  for (const { host, server } of servers) {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => reject(error);
      server.once("error", onError);
      server.listen(PORT, host, () => {
        server.off("error", onError);
        console.log(`task-dispatcher on http://${host}:${PORT}`);
        resolve();
      });
    });
  }
  // Background work begins only after every listener is ready. A failed bind
  // therefore cannot leave a probe timer or caffeinate child keeping a broken
  // startup process alive.
  startLivenessLoop();
  restoreKeepAwake(db);
} catch (error) {
  for (const { server } of servers) {
    if (server.listening) server.close();
  }
  throw error;
}
