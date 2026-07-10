// Pure lifecycle state shared by remote-card rendering and its regression test.
// Keep presentation and endpoint names out of this module: it only answers which
// action/state a task represents.
export function taskLifecycle(task) {
  const active = task.status !== "cleaned";
  const hasWorktree = !!task.hasWorktree;
  return {
    active,
    action: active ? "stop" : hasWorktree ? "removeWorktree" : "deleteRecord",
    resumable: !task.alive && hasWorktree,
    connectable: active && !!task.alive,
  };
}
