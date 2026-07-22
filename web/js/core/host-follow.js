// Select the data source for machine-switch dock following. A remote machine
// always owns this branch, even while offline or not bootstrapped: an empty
// remote snapshot must never fall through to the controller's local task cache.
export function remoteFollowTasks(host, fleet) {
  if (!host || host.kind === "local") return null;
  return fleet?.ok ? (fleet.tasks || []) : [];
}
