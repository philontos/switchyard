import fs from "node:fs";
import path from "node:path";
import { db, Repo } from "../core/db.js";
import { DATA_DIR, MANIFEST_PATH } from "../core/paths.js";

// repos.json — a machine's self-describing list of registered repos. Metadata
// ONLY: never the token. Keeping the secret out of an on-disk manifest matters
// even more once these get written on remote machines too. With a fixed layout
// + this manifest, any controller that reaches a machine can reconstruct its
// catalog (and reconcile a wiped local DB against what's actually on disk).
export interface RepoManifestEntry {
  id: number;
  name: string;
  git_url: string;
  default_branch: string;
  project_path: string | null;
  mirror: string | null; // path relative to DATA_DIR, e.g. "mirrors/7-ug.git"
  created_at: string;
}

export function reposManifest(repos: Repo[]): { version: number; repos: RepoManifestEntry[] } {
  return {
    version: 1,
    repos: repos.map((r) => ({
      id: r.id,
      name: r.name,
      git_url: r.git_url,
      default_branch: r.default_branch,
      project_path: r.project_path,
      mirror: r.mirror_path ? path.relative(DATA_DIR, r.mirror_path) : null,
      created_at: r.created_at,
    })),
  };
}

// Rewrite the manifest from the current repos table. Call after register/delete
// (and once at startup) so repos.json always mirrors the catalog.
export function syncReposManifest() {
  const repos = db.prepare("SELECT * FROM repos ORDER BY id").all() as Repo[];
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(reposManifest(repos), null, 2));
}
