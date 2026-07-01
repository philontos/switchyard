// The `tdsp` entrypoint: a thin wiring shell. All decision logic lives in
// runCli (cli.ts) with IO injected, so this file just supplies the real handles.
//
// Note we set process.exitCode instead of calling process.exit(): one-shot verbs
// (list / create-local) let the event loop drain and exit naturally; `serve`
// boots a listening server that holds the loop open, so the process stays alive —
// an explicit exit() would kill the server it just started.
import os from "node:os";
import path from "node:path";
import { runCli } from "./cli.js";
import { db, type Task } from "./db.js";
import { NS, DATA_DIR, ROOT } from "./paths.js";
import { applyInstall } from "./bootstrap.js";
import { localRunner } from "./runner.js";
import { startShellSession, killSession, listSessions } from "./tmux.js";
import { createLocalTask, createRepoTask, stopTask } from "./createtask.js";
import { listBranches } from "./git.js";
import { buildRepoTaskEnv, repoFindOrCreate } from "./repoenv.js";
import { writeTaskManifest } from "./taskmanifest.js";

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
  serve: async () => {
    await import("./index.js");
  },
  // This node's own task liveness, for `tdsp list`. The node is the sole authority
  // for its tmux server + worktrees, so it computes the same three signals the
  // controller computes for local tasks in GET /api/tasks — green when the session
  // is alive, yellow when it's blocked on a permission prompt — and ships them so a
  // remote card lights up identically. One `tmux list-sessions` covers every task
  // (set membership) instead of an exec per task.
  liveness: async (tasks) => {
    const live = new Set(await listSessions(localRunner));
    const out = new Map<number, { alive: boolean; hasWorktree: boolean; waiting: boolean }>();
    for (const t of tasks) {
      const cleaned = t.status === "cleaned";
      const hasWt = !!t.worktree_path && (await localRunner.exists(t.worktree_path).catch(() => false));
      out.set(t.id, {
        alive: !cleaned && !!t.session && live.has(t.session),
        hasWorktree: hasWt,
        waiting:
          !cleaned && hasWt && (await localRunner.exists(path.join(t.worktree_path, ".claude/waiting")).catch(() => false)),
      });
    }
    return out;
  },
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
  // a node dispatching a repo task ON ITSELF: register the repo locally, then run
  // the shared orchestration with the LOCAL runner. As the owner, it writes the
  // manifest to its own data dir (no ownership gate needed).
  createRepo: (spec) =>
    createRepoTask(
      buildRepoTaskEnv({
        db,
        ns: NS,
        runner: localRunner,
        writeManifest: (id) => writeTaskManifest(DATA_DIR, db.prepare("SELECT * FROM tasks WHERE id=?").get(id) as Task),
      }),
      repoFindOrCreate(db, { mirror: spec.mirror, name: spec.name, git_url: spec.git_url }),
      { baseBranch: spec.base, title: spec.title, prompt: spec.prompt, extraSkills: spec.skills },
    ),
  // stop one of THIS node's tasks: kill its session, mark cleaned, re-manifest.
  stop: (id) =>
    stopTask(
      {
        db,
        killSession: (session) => killSession(localRunner, session),
        writeManifest: (tid) => writeTaskManifest(DATA_DIR, db.prepare("SELECT * FROM tasks WHERE id=?").get(tid) as Task),
      },
      id,
    ),
  // set up THIS machine's global tdsp from its clone (point src here + the wrapper)
  install: () => {
    const p = applyInstall(os.homedir(), ROOT);
    return { src: p.src, binPath: p.binPath, localBin: p.localBin, clone: ROOT };
  },
  // live branches for one of this machine's mirrors (git ls-remote on the mirror)
  branches: async (mirror) => {
    try {
      return { ok: true, branches: await listBranches(localRunner, mirror) };
    } catch (e: any) {
      return { ok: false, error: String(e?.message || e) };
    }
  },
});
