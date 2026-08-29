// Session-local ordering for active task cards. Repository ids are allocated by
// each node independently, so an order key must include the owning node as well
// as the repo id or two machines with repo #1 would share an order accidentally.
const orders = new Map(); // orderKey -> [taskId, ...]

export function repoOrderKey(hostId, repoId) {
  return hostId == null ? `local:${repoId}` : `node:${hostId}:repo:${repoId}`;
}

// Apply a repo group's custom order to its incoming id-DESC task list. Newly
// dispatched tasks aren't in the remembered order yet, so they remain at the top.
export function orderTasks(orderKey, tasks) {
  const order = orders.get(orderKey);
  if (!order) return tasks;
  const rank = new Map(order.map((id, index) => [id, index]));
  return [...tasks].sort((a, b) =>
    (rank.has(a.id) ? rank.get(a.id) : -1) - (rank.has(b.id) ? rank.get(b.id) : -1));
}

export function rememberTaskOrder(orderKey, taskIds) {
  orders.set(orderKey, [...taskIds]);
}
