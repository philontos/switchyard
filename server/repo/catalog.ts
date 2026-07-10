import type Database from "better-sqlite3";
import type { Repo } from "../core/db.js";
import { canonicalGitUrl } from "./git.js";

export function findRepoByGitUrl(db: Database.Database, hostId: number, gitUrl: string): Repo | undefined {
  const key = canonicalGitUrl(gitUrl);
  const repos = db.prepare(
    "SELECT * FROM repos WHERE host_id=? ORDER BY CASE status WHEN 'ready' THEN 0 WHEN 'cloning' THEN 1 ELSE 2 END, id DESC"
  ).all(hostId) as Repo[];
  return repos.find((repo) => canonicalGitUrl(repo.git_url) === key);
}
