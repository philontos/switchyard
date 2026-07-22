// Wire createRepoTask's seams (prepare worktree contents, start session, clean up)
// to the owning node's local Runner + skill library. Both the node's HTTP route
// and its `tdsp create` verb use this builder locally; a controller reaches it by
// invoking the target node's verb, never by supplying a RemoteRunner.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { addWorktreeFromBranch, removeWorktree } from "./git.js";
import { startSession } from "../session/tmux.js";
import { agentCaps } from "../session/agent.js";
import { hookSettingsJson } from "../skills/hooks.js";
import { resolveSkills, defaultSources } from "../skills/skills.js";
import type { Runner } from "../fleet/runner.js";
import type { RepoTaskEnv } from "../task/createtask.js";
import type Database from "better-sqlite3";

type DB = Database.Database;

// The worktree-setup step bound to a machine's Runner: create the worktree, deliver
// each skill into it, inject the per-task hooks, and keep both out of git status.
// `ns` scopes the local temp path so two Switchyard instances sharing a box do not collide.
function setupWorktreeOn(runner: Runner, ns: string): RepoTaskEnv["setupWorktree"] {
  return async ({ id, mirror, worktree, workBranch, baseBranch, skills, agent }) => {
    // create the worktree from the base branch's latest origin tip (falls back to
    // a local head for unpushed bases). The base is only a start point, so this
    // works even when a live task currently has that branch checked out.
    await addWorktreeFromBranch(runner, mirror, worktree, workBranch, baseBranch);
    // Capture the immutable start point before skills/hooks are delivered and,
    // crucially, before the agent can create commits. Code preview diffs against
    // this SHA rather than HEAD, so a committed task never appears "clean".
    const baseCommit = (await runner.exec("git", ["rev-parse", "HEAD"], { cwd: worktree })).trim();
    if (!baseCommit) throw new Error("could not resolve task base commit");
    // Skills delivery and the waiting-hook both ride claude's .claude/ conventions;
    // codex shares neither, so it opts out of both (agentCaps). codex also has no
    // yellow-light hook — the dispatcher can't see a codex approval pause (see agentArgv).
    const caps = agentCaps(agent ?? "claude");
    if (caps.injectSkills) {
      // deliver each selected skill's whole dir into the worktree's .claude/skills/
      for (const sk of skills) await runner.putDir(sk.dir, path.join(worktree, ".claude", "skills", sk.name));
      // keep delivered skills out of the repo's git status (worktree-local exclude)
      if (skills.length) {
        await runner.exec("sh", ["-c",
          `cd ${JSON.stringify(worktree)} && p=$(git rev-parse --git-path info/exclude) && grep -qxF '.claude/skills/' "$p" || printf '.claude/skills/\\n' >> "$p"`,
        ]).catch(() => {});
      }
    }
    if (caps.injectHooks) {
      // inject per-task hooks so the session reports when it's blocked on a
      // permission prompt (yellow light): the hook touches/removes <wt>/.claude/waiting,
      // which this owning node reads back locally. Deliver settings.local.json
      // through putDir (overlays the .claude
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
    }
    return baseCommit;
  };
}

export interface RepoEnvOpts {
  db: DB;
  ns: string;
  runner: Runner;
  /** Persist the task's durable record on the owning node. */
  writeManifest: (id: number) => void | Promise<void>;
}

/** Build a RepoTaskEnv for createRepoTask, bound to this machine's Runner +
 *  skill library. Skills resolve from THIS machine's sources — a node injects its
 *  own curated set, which is the edge-autonomy intent. */
export function buildRepoTaskEnv(opts: RepoEnvOpts): RepoTaskEnv {
  if (opts.runner.kind !== "local") {
    throw new Error("Repository task environments must be built on the owning node");
  }
  return {
    db: opts.db,
    ns: opts.ns,
    writeManifest: opts.writeManifest,
    resolveSkills: (keys) => resolveSkills(keys, defaultSources()),
    setupWorktree: setupWorktreeOn(opts.runner, opts.ns),
    startSession: (session, worktree, opening, sopts) => startSession(opts.runner, session, worktree, opening, sopts),
    removeWorktree: (mirror, worktree, workBranch) => removeWorktree(opts.runner, mirror, worktree, workBranch).then(() => {}),
  };
}
