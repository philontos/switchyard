// The `tdsp` entrypoint: a thin wiring shell. All decision logic lives in
// runCli (cli.ts) with IO injected, so this file just supplies the real handles.
//
// Note we set process.exitCode instead of calling process.exit(): one-shot verbs
// (list) let the event loop drain and exit naturally; `serve` boots a listening
// server that holds the loop open, so the process stays alive — an explicit
// exit() would kill the server it just started.
import { runCli } from "./cli.js";
import { db } from "./db.js";

process.exitCode = await runCli(process.argv.slice(2), {
  db,
  out: (s) => process.stdout.write(s + "\n"),
  err: (s) => process.stderr.write(s + "\n"),
  serve: () => import("./index.js"),
});
