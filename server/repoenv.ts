// Wire createRepoTask's seams (prepare worktree contents, start session, clean up)
// to a concrete machine's Runner + skill library. Shared by the HTTP route (A
// dispatching, with the target host's Runner) AND the `tdsp create` verb (a node
// dispatching on itself, with its local Runner) — one orchestration, two front
// doors. The manifest-write policy is injected so each caller decides where the
// durable record lands (the owning node writes locally; the controller's route
// passes its ownership-gated writer).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { addWorktreeFromBranch, removeWorktree } from "./git.js";
import { startSession } from "./tmux.js";
import { hookSettingsJson } from "./hooks.js";
import { resolveSkills, defaultSources } from "./skills.js";
import type { Runner } from "./runner.js";
import type { RepoTaskEnv, RepoRef } from "./createtask.js";
import type Database from "better-sqlite3";

type DB = Database.Database;

/**
 * Register a repo ON this node, keyed by its mirror path — the repo-registration
 * sink. When A dispatches a repo task to a node, the node records the repo in its
 * OWN db (owned by its local host) so it can own and display the task. Idempotent:
 * a repeated dispatch of the same repo (same mirror) reuses the one row. The mirror
 * itself already lives on the node (A creates it at repo-registration time).
 */
export function repoFindOrCreate(db: DB, spec: { mirror: string; name: string; git_url: string }): RepoRef {
  const existing = db.prepare("SELECT id, name, mirror_path FROM repos WHERE mirror_path = ?").get(spec.mirror) as RepoRef | undefined;
  if (existing) return existing;
  const localHost = db.prepare("SELECT id FROM hosts WHERE kind='local'").get() as { id: number } | undefined;
  const info = db
    .prepare("INSERT INTO repos (host_id, name, git_url, mirror_path, status) VALUES (?,?,?,?,'ready')")
    .run(localHost?.id ?? null, spec.name, spec.git_url, spec.mirror);
  return { id: Number(info.lastInsertRowid), name: spec.name, mirror_path: spec.mirror };
}

// The worktree-setup step bound to a machine's Runner: create the worktree, deliver
// each skill into it, inject the per-task hooks, and keep both out of git status.
// `ns` scopes the local temp path so two controllers sharing a box don't collide.
function setupWorktreeOn(runner: Runner, ns: string): RepoTaskEnv["setupWorktree"] {
  return async ({ id, mirror, worktree, workBranch, baseBranch, skills }) => {
    // create the worktree from the base branch's latest origin tip (falls back to
    // a local head for unpushed bases). The base is only a start point, so this
    // works even when a live task currently has that branch checked out.
    await addWorktreeFromBranch(runner, mirror, worktree, workBranch, baseBranch);
    // deliver each selected skill's whole dir into the worktree's .claude/skills/
    for (const sk of skills) await runner.putDir(sk.dir, path.join(worktree, ".claude", "skills", sk.name));
    // keep delivered skills out of the repo's git status (worktree-local exclude)
    if (skills.length) {
      await runner.exec("sh", ["-c",
        `cd ${JSON.stringify(worktree)} && p=$(git rev-parse --git-path info/exclude) && grep -qxF '.claude/skills/' "$p" || printf '.claude/skills/\\n' >> "$p"`,
      ]).catch(() => {});
    }
    // inject per-task hooks so the session reports when it's blocked on a
    // permission prompt (yellow light): the hook touches/removes <wt>/.claude/waiting,
    // which the dispatcher reads back via runner.exists — same on the local box and
    // on remotes. Deliver settings.local.json through putDir (overlays the .claude
    // skills/ already there); keep both injected paths out of the repo's git status.
    const hooksTmp = path.join(os.tmpdir(), `tdsp-hooks-${ns}-${id}`, ".claude");
    fs.mkdirSync(hooksTmp, { recursive: true });
    fs.writeFileSync(path.join(hooksTmp, "settings.local.json"), hookSettingsJson(worktree));
    await runner.putDir(hooksTmp, path.join(worktree, ".claude"));
    fs.rmSync(path.dirname(hooksTmp), { recursive: true, force: true });
    await runner.exec("sh", ["-c",
      `cd ${JSON.stringify(worktree)} && p=$(git rev-parse --git-path info/exclude) && ` +
      `for f in '.claude/settings.local.json' '.claude/waiting' '.claude/session-id'; do grep -qxF "$f" "$p" || printf '%s\\n' "$f" >> "$p"; done`,
    ]).catch(() => {});
  };
}

export interface RepoEnvOpts {
  db: DB;
  ns: string;
  runner: Runner;
  /** Persist the task's durable record (owner writes locally; the HTTP route
   *  passes its ownership-gated writer). */
  writeManifest: (id: number) => void | Promise<void>;
}

/** Build a RepoTaskEnv for createRepoTask, bound to this machine's Runner +
 *  skill library. Skills resolve from THIS machine's sources — a node injects its
 *  own curated set, which is the edge-autonomy intent. */
export function buildRepoTaskEnv(opts: RepoEnvOpts): RepoTaskEnv {
  return {
    db: opts.db,
    ns: opts.ns,
    writeManifest: opts.writeManifest,
    resolveSkills: (keys) => resolveSkills(keys, defaultSources()),
    setupWorktree: setupWorktreeOn(opts.runner, opts.ns),
    startSession: (session, worktree, opening) => startSession(opts.runner, session, worktree, opening),
    removeWorktree: (mirror, worktree, workBranch) => removeWorktree(opts.runner, mirror, worktree, workBranch).then(() => {}),
  };
}
