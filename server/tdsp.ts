// The `tdsp` entrypoint: a thin wiring shell. All decision logic lives in
// runCli (cli.ts) with IO injected, so this file just supplies the real handles.
//
// Note we set process.exitCode instead of calling process.exit(): one-shot verbs
// (list / create-local) let the event loop drain and exit naturally; `serve`
// boots a listening server that holds the loop open, so the process stays alive —
// an explicit exit() would kill the server it just started.
import os from "node:os";
import { runCli } from "./cli.js";
import { db } from "./db.js";
import { NS, DATA_DIR } from "./paths.js";
import { localRunner } from "./runner.js";
import { startShellSession } from "./tmux.js";
import { createLocalTask } from "./createtask.js";

// Ensure child processes (tmux/git/claude) find Homebrew binaries regardless of
// how tdsp was launched — a bare non-interactive ssh PATH otherwise can't resolve
// tmux and the shell session fails. Mirrors the same hardening in index.ts; the
// one-shot verbs don't import index.ts, so they need it here too.
for (const p of ["/opt/homebrew/bin", "/usr/local/bin"]) {
  if (!(process.env.PATH || "").split(":").includes(p)) process.env.PATH = `${p}:${process.env.PATH || ""}`;
}

process.exitCode = await runCli(process.argv.slice(2), {
  db,
  out: (s) => process.stdout.write(s + "\n"),
  err: (s) => process.stderr.write(s + "\n"),
  serve: () => import("./index.js"),
  createLocal: (opts) =>
    createLocalTask(
      {
        db,
        home: os.homedir(),
        ns: NS,
        dataDir: DATA_DIR,
        cwdExists: (cwd) => localRunner.exists(cwd),
        startShell: (session, cwd) => startShellSession(localRunner, session, cwd),
      },
      opts,
    ),
});
