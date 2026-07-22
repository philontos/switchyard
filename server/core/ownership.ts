import type Database from "better-sqlite3";
import type { Repo, Task } from "./db.js";

type DB = Database.Database;

export function localHostId(db: DB): number | null {
  const row = db.prepare("SELECT id FROM hosts WHERE kind='local' LIMIT 1").get() as { id: number } | undefined;
  return row?.id ?? null;
}

export function listOwnedRepos(db: DB): Repo[] {
  const hostId = localHostId(db);
  if (hostId == null) return [];
  return db.prepare("SELECT * FROM repos WHERE host_id=? ORDER BY id DESC").all(hostId) as Repo[];
}

export function getOwnedRepo(db: DB, id: number | string): Repo | undefined {
  const hostId = localHostId(db);
  if (hostId == null) return undefined;
  return db.prepare("SELECT * FROM repos WHERE id=? AND host_id=?").get(id, hostId) as Repo | undefined;
}

export function listOwnedTasks(db: DB): Task[] {
  const hostId = localHostId(db);
  if (hostId == null) return [];
  return db.prepare(
    "SELECT t.* FROM tasks t WHERE " +
      "(t.kind='local' AND t.host_id=?) OR " +
      "(t.kind!='local' AND t.repo_id IN (SELECT id FROM repos WHERE host_id=?)) " +
      "ORDER BY t.id DESC",
  ).all(hostId, hostId) as Task[];
}

export function getOwnedTask(db: DB, id: number | string): Task | undefined {
  const hostId = localHostId(db);
  if (hostId == null) return undefined;
  return db.prepare(
    "SELECT t.* FROM tasks t WHERE t.id=? AND (" +
      "(t.kind='local' AND t.host_id=?) OR " +
      "(t.kind!='local' AND t.repo_id IN (SELECT id FROM repos WHERE host_id=?)))",
  ).get(id, hostId, hostId) as Task | undefined;
}

/**
 * Detach a deleted node-local provider only from tasks owned by this node.
 * Historical controller-owned remote rows are audit evidence and must not be
 * silently rewritten by an otherwise local catalog operation.
 */
export function clearProviderFromOwnedTasks(db: DB, providerId: number | string): number {
  const hostId = localHostId(db);
  if (hostId == null) return 0;
  return db.prepare(
    "UPDATE tasks SET provider_id=NULL WHERE provider_id=? AND (" +
      "(kind='local' AND host_id=?) OR " +
      "(kind!='local' AND repo_id IN (SELECT id FROM repos WHERE host_id=?)))",
  ).run(providerId, hostId, hostId).changes;
}

export interface LegacyOwnershipReport {
  local_host_id: number | null;
  remote_repos: Array<{ id: number; host_id: number | null; name: string; host_name: string | null; mirror_path: string | null }>;
  remote_tasks: Array<{ id: number; kind: string; host_id: number | null; repo_id: number; title: string; owner_host_id: number | null }>;
  remote_data_dirs: Array<{ host_id: number; host_name: string; target: string; data_dir: string }>;
  orphan_repos: Array<{ id: number; host_id: number | null; name: string; mirror_path: string | null }>;
  orphan_tasks: Array<{ id: number; kind: string; host_id: number | null; repo_id: number; title: string }>;
}

/**
 * Read-only inventory of rows created by the former controller-owned-remote
 * model. Nothing here is deleted or adopted automatically.
 */
export function legacyOwnershipReport(db: DB): LegacyOwnershipReport {
  const hostId = localHostId(db);
  const remoteRepos = hostId == null ? [] : db.prepare(
    "SELECT r.id,r.host_id,r.name,h.name AS host_name,r.mirror_path " +
      "FROM repos r LEFT JOIN hosts h ON h.id=r.host_id " +
      "WHERE r.host_id IS NOT NULL AND r.host_id!=? ORDER BY r.id",
  ).all(hostId) as LegacyOwnershipReport["remote_repos"];
  const remoteTasks = hostId == null ? [] : db.prepare(
    "SELECT t.id,t.kind,t.host_id,t.repo_id,t.title," +
      "CASE WHEN t.kind='local' THEN t.host_id ELSE r.host_id END AS owner_host_id " +
      "FROM tasks t LEFT JOIN repos r ON r.id=t.repo_id " +
      "WHERE (t.kind='local' AND t.host_id IS NOT NULL AND t.host_id!=?) " +
      "OR (t.kind!='local' AND r.host_id IS NOT NULL AND r.host_id!=?) ORDER BY t.id",
  ).all(hostId, hostId) as LegacyOwnershipReport["remote_tasks"];
  const remoteDataDirs = db.prepare(
    "SELECT id AS host_id,name AS host_name,target,data_dir FROM hosts " +
      "WHERE kind!='local' AND data_dir IS NOT NULL AND trim(data_dir)!='' ORDER BY id",
  ).all() as LegacyOwnershipReport["remote_data_dirs"];
  const orphanRepos = db.prepare(
    "SELECT r.id,r.host_id,r.name,r.mirror_path FROM repos r " +
      "LEFT JOIN hosts h ON h.id=r.host_id WHERE r.host_id IS NULL OR h.id IS NULL ORDER BY r.id",
  ).all() as LegacyOwnershipReport["orphan_repos"];
  const orphanTasks = db.prepare(
    "SELECT t.id,t.kind,t.host_id,t.repo_id,t.title FROM tasks t " +
      "LEFT JOIN hosts th ON th.id=t.host_id " +
      "LEFT JOIN repos r ON r.id=t.repo_id LEFT JOIN hosts rh ON rh.id=r.host_id " +
      "WHERE (t.kind='local' AND (t.host_id IS NULL OR th.id IS NULL)) " +
      "OR (t.kind!='local' AND (r.id IS NULL OR r.host_id IS NULL OR rh.id IS NULL)) ORDER BY t.id",
  ).all() as LegacyOwnershipReport["orphan_tasks"];
  return {
    local_host_id: hostId,
    remote_repos: remoteRepos,
    remote_tasks: remoteTasks,
    remote_data_dirs: remoteDataDirs,
    orphan_repos: orphanRepos,
    orphan_tasks: orphanTasks,
  };
}
