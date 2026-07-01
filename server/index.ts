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

// ensure child processes (git/tmux/glab/pty) find Homebrew/usr-local binaries
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
const server = createServer(app);
attachWs(server);

if (DID_MIGRATE) repairWorktrees(); // fix git worktree links after the ./data move
startLivenessLoop();                // background ssh probe of remote machines
syncReposManifest();                // bootstrap repos.json from the current catalog on boot
// adopt any task manifests on disk this DB is missing (recover a wiped db / own
// tasks present locally), then backfill manifests for every task we own so the
// on-disk catalog mirrors the table.
adoptTaskManifests(db, readTaskManifests(DATA_DIR));
for (const { id } of db.prepare("SELECT id FROM tasks").all() as { id: number }[]) syncTaskManifest(id);

const PORT = Number(process.env.PORT || 4500);
// Bind loopback by default — the web terminal is a live shell, so don't expose
// it on the LAN unless explicitly asked. Set HOST=0.0.0.0 to listen on all
// interfaces (then put auth / a reverse proxy in front), or use an ssh tunnel
// (ssh -L 4500:localhost:4500 host) for remote access.
const HOST = process.env.HOST || "127.0.0.1";
server.listen(PORT, HOST, () => {
  console.log(`task-dispatcher on http://${HOST}:${PORT}`);
});
