import path from "node:path";
import { Runner } from "../fleet/runner.js";

// Run a git command through the given machine's Runner. The env keeps git from
// hanging on an interactive SSH/host-key/credential prompt — fail fast instead.
async function git(runner: Runner, cwd: string | null, args: string[]): Promise<string> {
  return runner.exec("git", args, {
    cwd: cwd ?? undefined,
    // extras only — the Runner merges these over the (local or remote) base env.
    env: {
      GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND || "ssh -o BatchMode=yes -o ConnectTimeout=15",
      GIT_TERMINAL_PROMPT: "0",
    },
  });
}

/** Embed token into an https git url for clone/fetch/push. */
export function authUrl(gitUrl: string, token?: string | null): string {
  if (!token) return gitUrl;
  try {
    const u = new URL(gitUrl);
    if (u.protocol !== "https:") return gitUrl;
    // GitLab accepts oauth2:<token>
    u.username = "oauth2";
    u.password = token;
    return u.toString();
  } catch {
    return gitUrl;
  }
}

export function mirrorPath(dataDir: string, repoId: number, name: string): string {
  const safe = name.replace(/[^a-zA-Z0-9_.-]/g, "_");
  return path.join(dataDir, "mirrors", `${repoId}-${safe}.git`);
}

/**
 * Register a repo locally WITHOUT downloading any objects: create an empty
 * bare repo, point it at origin, and validate connectivity via ls-remote.
 * Objects for a branch are only fetched later, at dispatch time.
 */
export async function initMirror(runner: Runner, gitUrl: string, token: string | null, dest: string) {
  await runner.mkdirp(path.dirname(dest));
  if (await runner.exists(dest)) await runner.rmrf(dest);
  await git(runner, null, ["init", "--bare", dest]);
  await git(runner, dest, ["remote", "add", "origin", authUrl(gitUrl, token)]);
  await git(runner, dest, ["ls-remote", "--heads", "origin"]); // throws on bad url/auth/host
}

/** Live list of remote branches — always current, no local staleness. */
export async function listBranches(runner: Runner, mirror: string): Promise<string[]> {
  const out = await git(runner, mirror, ["ls-remote", "--heads", "origin"]);
  return out
    .split("\n")
    .map((l) => l.trim().split("\t")[1])
    .filter(Boolean)
    .map((ref) => ref.replace(/^refs\/heads\//, ""));
}

/**
 * Fetch one branch at dispatch time as a BLOBLESS partial clone
 * (--filter=blob:none): pull the full commit GRAPH but skip file blobs, which
 * git then lazily fetches from the promisor remote on checkout. This stays close
 * to a shallow clone on size/time, but — unlike the old --depth 1 — keeps real
 * ancestry, so merge-base / rebase / "is this an ancestor of master" all work
 * and finishing a task is a normal PR + merge (no bogus "unrelated histories",
 * which --depth 1's parentless boundary commit caused). The first filtered fetch
 * auto-configures origin as the promisor remote. Push/MR still work as before.
 *
 * Lands in the REMOTE-TRACKING ref `refs/remotes/origin/<branch>`, never the local
 * head `refs/heads/<branch>`: the local-head namespace is reserved for per-task
 * WORK branches, each checked out by exactly one worktree, and git refuses to
 * fetch into a checked-out ref — so writing the base there used to break dispatch
 * whenever the base was itself a live task's branch. Tracking refs are never
 * checked out, so this is always safe.
 */
export async function fetchBranch(runner: Runner, mirror: string, branch: string) {
  await git(runner, mirror, ["fetch", "--filter=blob:none", "origin", `+refs/heads/${branch}:refs/remotes/origin/${branch}`]);
}

/** Manual full refresh of all branches (the repo card's "fetch" button). Keeps
 *  the blobless filter so refreshing many branches stays light (blobs stay lazy). */
export async function fetchMirror(runner: Runner, mirror: string, gitUrl: string, token: string | null) {
  await git(runner, mirror, ["remote", "set-url", "origin", authUrl(gitUrl, token)]).catch(() => {});
  // into refs/remotes/origin/* (not local heads) for the same reason as fetchBranch:
  // a wildcard into refs/heads/* would refuse the moment any work branch is checked out.
  await git(runner, mirror, ["fetch", "--filter=blob:none", "--prune", "origin", "+refs/heads/*:refs/remotes/origin/*"]);
}

/** True if `ref` (a full refname) resolves in the mirror. */
async function refExists(runner: Runner, mirror: string, ref: string): Promise<boolean> {
  return git(runner, mirror, ["show-ref", "--verify", "--quiet", ref]).then(() => true).catch(() => false);
}

/** Low-level: create `workBranch` from `startPoint` and check it out at `dest`. */
export async function addWorktree(runner: Runner, mirror: string, dest: string, workBranch: string, startPoint: string) {
  await runner.mkdirp(path.dirname(dest));
  await git(runner, mirror, ["worktree", "add", "-b", workBranch, dest, startPoint]);
}

/**
 * Create a task's worktree from `baseBranch`. Refreshes the base's tracking ref
 * (best-effort — a purely-local base has no origin counterpart), then branches
 * the new work branch off `origin/<base>` when it exists, else off the local head
 * `<base>` (so you can fork another task's unpushed work). The base is only ever a
 * START POINT — never checked out or modified — so any number of tasks can spring
 * from the same branch, even one a live task currently has checked out.
 */
export async function addWorktreeFromBranch(
  runner: Runner, mirror: string, dest: string, workBranch: string, baseBranch: string,
) {
  await fetchBranch(runner, mirror, baseBranch).catch(() => {});
  const startPoint = (await refExists(runner, mirror, `refs/remotes/origin/${baseBranch}`))
    ? `origin/${baseBranch}`
    : baseBranch;
  await addWorktree(runner, mirror, dest, workBranch, startPoint);
}

export async function removeWorktree(runner: Runner, mirror: string, dest: string, workBranch?: string) {
  await git(runner, mirror, ["worktree", "remove", "--force", dest]).catch(async () => {
    // fall back to manual cleanup if worktree metadata is gone
    if (await runner.exists(dest)) await runner.rmrf(dest);
  });
  await git(runner, mirror, ["worktree", "prune"]).catch(() => {});
  if (workBranch) {
    await git(runner, mirror, ["branch", "-D", workBranch]).catch(() => {});
  }
}
