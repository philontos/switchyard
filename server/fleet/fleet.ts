// Cross-node fleet view: assemble "what's running where" by reading each node's
// OWN truth. A node is the sole authority for its tasks, so the controller asks
// each remote node live (`ssh <node> tdsp list --json`, via aggregateNodes) at
// view time — no central store, no sync; offline = honestly unknown. The local
// node's tasks come from this controller's own DB.
//
// Pure helpers here (DB handle / plain host rows in) so they're testable against
// an in-memory sqlite; the real ssh fetch + endpoint wiring live in index.ts.
import type { Host } from "../core/db.js";

// A bootstrapped remote node we can fetch a live task list from.
export interface FleetTarget {
  id: number;
  name: string;
  target: string; // ssh target, e.g. user@host
  kind: string;
  tdsp_bin: string; // absolute path to the node's tdsp wrapper
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
    .map((h) => ({ id: h.id, name: h.name, target: h.target, kind: h.kind, tdsp_bin: h.tdsp_bin as string }));
}
