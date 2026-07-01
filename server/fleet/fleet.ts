// Cross-node fleet view: assemble "what's running where" by reading each node's
// OWN truth. A node is the sole authority for its tasks, so the controller asks
// each remote node live (`ssh <node> tdsp list --json`, via aggregateNodes) at
// view time — no central store, no sync; offline = honestly unknown. The local
// node's tasks come from this controller's own DB.
//
// Pure helpers here (DB handle / plain host rows in) so they're testable against
// an in-memory sqlite; the real ssh fetch + endpoint wiring live in index.ts.
import type Database from "better-sqlite3";
import type { Task, Host } from "../core/db.js";

type DB = Database.Database;

// A bootstrapped remote node we can fetch a live task list from.
export interface FleetTarget {
  id: number;
  name: string;
  target: string; // ssh target, e.g. user@host
  bin: string; // absolute path to the node's tdsp wrapper
}

/**
 * The remote nodes worth fetching from: not the local machine, and already
 * bootstrapped (a tdsp_bin is recorded). Remotes without a wrapper yet are left
 * out here — the endpoint reports them separately as "not bootstrapped" rather
 * than silently dropping them.
 */
export function fleetTargets(hosts: Host[]): FleetTarget[] {
  return hosts
    .filter((h) => h.kind !== "local" && !!h.tdsp_bin)
    .map((h) => ({ id: h.id, name: h.name, target: h.target, bin: h.tdsp_bin as string }));
}

/**
 * This controller's recorded tasks for one machine: local-kind tasks carry
 * host_id directly; repo tasks inherit their repo's host. Mirrors the frontend's
 * hostOfTask grouping so the local node's slice of the fleet view matches the UI.
 */
export function tasksForHost(db: DB, hostId: number): Task[] {
  return db
    .prepare(
      "SELECT * FROM tasks WHERE host_id = ? " +
        "OR (host_id IS NULL AND repo_id IN (SELECT id FROM repos WHERE host_id = ?)) " +
        "ORDER BY id DESC",
    )
    .all(hostId, hostId) as Task[];
}
