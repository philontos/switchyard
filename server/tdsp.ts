// The `tdsp` entrypoint: a thin wiring shell. All decision logic lives in
// runCli (cli.ts) with IO injected, so this file just supplies the real handles.
//
// Note we set process.exitCode instead of calling process.exit(): one-shot verbs
// (list / create-local) let the event loop drain and exit naturally; `serve`
// boots a listening server that holds the loop open, so the process stays alive —
// an explicit exit() would kill the server it just started.
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { runCli } from "./task/cli.js";
import { db, type Provider, type Task } from "./core/db.js";
import { NS, DATA_DIR, ROOT } from "./core/paths.js";
import { applyInstall } from "./fleet/bootstrap.js";
import { localRunner } from "./fleet/runner.js";
import { startSession, startShellSession, hasSession, killSession, listSessions } from "./session/tmux.js";
import { createLocalTask, createRepoTask, stopTask } from "./task/createtask.js";
import { cleanupTask, deleteTaskRecord, resumeTask } from "./task/lifecycle.js";
import { asAgentKind } from "./session/agent.js";
import { listBranches, removeWorktree } from "./repo/git.js";
import { buildRepoTaskEnv, repoFindOrCreate } from "./repo/repoenv.js";
import { removeTaskManifest, writeTaskManifest } from "./task/taskmanifest.js";
import { checkProvider, insertCheckedProvider, listProviders, providerEnv } from "./provider/providers.js";

// Ensure child processes (tmux/git/claude) find Homebrew binaries regardless of
// how tdsp was launched — a bare non-interactive ssh PATH otherwise can't resolve
// tmux and the shell session fails. Mirrors the same hardening in index.ts; the
// one-shot verbs don't import index.ts, so they need it here too.
for (const p of ["/opt/homebrew/bin", "/usr/local/bin"]) {
  if (!(process.env.PATH || "").split(":").includes(p)) process.env.PATH = `${p}:${process.env.PATH || ""}`;
}

function ipv4ToNumber(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return null;
    const v = Number(part);
    if (v < 0 || v > 255) return null;
    n = (n << 8) + v;
  }
  return n >>> 0;
}

function localIpv4s(): string[] {
  return Object.values(os.networkInterfaces())
    .flatMap((infos) => infos || [])
    .filter((info) => info.family === "IPv4" && !info.internal)
    .map((info) => info.address);
}

function ipv4InCidr(ip: string, cidr: string): boolean {
  const [base, prefixText] = cidr.split("/");
  const prefix = Number(prefixText);
  const ipNum = ipv4ToNumber(ip);
  const baseNum = ipv4ToNumber(base);
  if (ipNum == null || baseNum == null || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) return false;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (ipNum & mask) === (baseNum & mask);
}

function findLocalIpInCidr(cidr: string): string | null {
  const ips = localIpv4s();
  return ips.find((ip) => ipv4InCidr(ip, cidr)) || null;
}

process.exitCode = await runCli(process.argv.slice(2), {
  db,
  out: (s) => process.stdout.write(s + "\n"),
  err: (s) => process.stderr.write(s + "\n"),
  serve: async (opts) => {
    process.env.TDSP_RESTART_ARGS = JSON.stringify(process.argv.slice(2));
    if (opts?.hosts?.length) process.env.HOSTS = opts.hosts.join(",");
    else if (opts?.host) process.env.HOST = opts.host;

    if (opts?.hostCidr != null) {
      if (!opts.hostCidr) throw new Error("serve: --host-cidr requires a CIDR range, for example 10.10.0.0/24");
      const hostIp = findLocalIpInCidr(opts.hostCidr);
      if (!hostIp) throw new Error(`serve: no local IPv4 address found in ${opts.hostCidr}`);
      const hosts = [...new Set(["127.0.0.1", hostIp, ...(process.env.HOSTS || "").split(",").filter(Boolean)])];
      process.env.HOSTS = hosts.join(",");
      delete process.env.HOST;
    }

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
  createRepo: (spec) => {
    const provider = spec.provider_id ? db.prepare("SELECT * FROM providers WHERE id=?").get(spec.provider_id) as any : undefined;
    return createRepoTask(
      buildRepoTaskEnv({
        db,
        ns: NS,
        runner: localRunner,
        writeManifest: (id) => writeTaskManifest(DATA_DIR, db.prepare("SELECT * FROM tasks WHERE id=?").get(id) as Task),
      }),
      repoFindOrCreate(db, { mirror: spec.mirror, name: spec.name, git_url: spec.git_url }),
      {
        baseBranch: spec.base,
        title: spec.title,
        prompt: spec.prompt,
        extraSkills: spec.skills,
        providerId: provider ? spec.provider_id ?? null : null,
        env: providerEnv(provider),
        agent: asAgentKind(spec.agent),
        model: spec.model ?? null,
      },
    );
  },
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
  // archived-task actions run on the owning node for the same reason as stop:
  // its DB, worktree and provider configuration are all node-local truth.
  resume: (id) =>
    resumeTask(
      {
        db,
        exists: (target) => localRunner.exists(target),
        hasSession: (session) => hasSession(localRunner, session),
        startSession: async (task) => {
          const provider = task.provider_id
            ? (db.prepare("SELECT * FROM providers WHERE id=?").get(task.provider_id) as Provider | undefined)
            : undefined;
          await startSession(localRunner, task.session, task.worktree_path, null, {
            continue: true,
            env: providerEnv(provider),
            agent: asAgentKind(task.agent),
            model: task.agent_model,
          });
        },
        writeManifest: (tid) => writeTaskManifest(DATA_DIR, db.prepare("SELECT * FROM tasks WHERE id=?").get(tid) as Task),
      },
      id,
    ),
  cleanup: (id) =>
    cleanupTask(
      {
        db,
        killSession: (session) => killSession(localRunner, session),
        removeWorktree: (mirror, worktree, workBranch) => removeWorktree(localRunner, mirror, worktree, workBranch),
        writeManifest: (tid) => writeTaskManifest(DATA_DIR, db.prepare("SELECT * FROM tasks WHERE id=?").get(tid) as Task),
      },
      id,
    ),
  deleteTask: (id) =>
    deleteTaskRecord(
      {
        db,
        exists: (target) => localRunner.exists(target),
        removeManifest: (tid) => removeTaskManifest(DATA_DIR, tid),
      },
      id,
    ),
  // set up THIS machine's global tdsp from its clone (point src here + the wrapper)
  install: () => {
    const p = applyInstall(os.homedir(), ROOT);
    return { src: p.src, binPath: p.binPath, localBin: p.localBin, clone: ROOT };
  },
  // pull the canonical install (the clone behind ~/.task-dispatcher/src) to the
  // latest code and refresh deps. --ff-only so a locally-diverged clone fails
  // loud instead of silently merging; a running serve keeps the old code until
  // it's restarted.
  update: async () => {
    const src = path.join(os.homedir(), ".task-dispatcher", "src");
    let clone: string;
    try {
      clone = fs.realpathSync(src);
    } catch {
      return { ok: false as const, error: `no install at ${src} — run \`npm run tdsp -- install\` from a clone first` };
    }
    try {
      await localRunner.exec("git", ["-C", clone, "pull", "--ff-only"]);
      await localRunner.exec("npm", ["install", "--no-fund", "--no-audit"], { cwd: clone });
      const head = (await localRunner.exec("git", ["-C", clone, "log", "-1", "--format=%h %s"])).trim();
      return { ok: true as const, clone, head };
    } catch (e: any) {
      return { ok: false as const, error: String(e?.stderr || e?.message || e).trim() };
    }
  },
  // live branches for one of this machine's mirrors (git ls-remote on the mirror)
  branches: async (mirror) => {
    try {
      return { ok: true, branches: await listBranches(localRunner, mirror) };
    } catch (e: any) {
      return { ok: false, error: String(e?.message || e) };
    }
  },
  providersList: () => listProviders(db),
  providersTest: (body) => checkProvider(body),
  providersCreate: (body) => insertCheckedProvider(db, body),
  providersDelete: async (id) => {
    db.prepare("UPDATE tasks SET provider_id=NULL WHERE provider_id=?").run(id);
    db.prepare("DELETE FROM providers WHERE id=?").run(id);
    return { ok: true as const };
  },
});
