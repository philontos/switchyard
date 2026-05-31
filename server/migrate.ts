import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { db, Repo, Task } from "./db.js";

// After the ./data -> ~/.task-dispatcher move, git's worktree links still hold
// the old absolute paths (the worktree's .git file and the mirror's gitdir
// pointer), so the worktrees show as "prunable" and break. `git worktree
// repair`, given the new paths, fixes both directions. Best-effort and
// idempotent — repairing already-correct links is a no-op.
export function repairWorktrees() {
  const repos = db.prepare("SELECT * FROM repos WHERE mirror_path IS NOT NULL").all() as Repo[];
  for (const repo of repos) {
    if (!repo.mirror_path || !fs.existsSync(repo.mirror_path)) continue;
    const tasks = db.prepare("SELECT * FROM tasks WHERE repo_id = ?").all(repo.id) as Task[];
    const paths = tasks.map((t) => t.worktree_path).filter((p) => p && fs.existsSync(p));
    if (!paths.length) continue;
    try {
      execFileSync("git", ["-C", repo.mirror_path, "worktree", "repair", ...paths], { stdio: "ignore" });
    } catch {
      // a repair failure must not block startup
    }
  }
}
