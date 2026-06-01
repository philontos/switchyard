// Cross-module mutable state. These three fields are read/written by more than
// one feature module, so they live on a single shared object instead of as
// module-local lets:
//   repos          — the repo list (loaded by repos.js; read by hosts.js & tasks.js)
//   hostsById      — machine map (loaded by hosts.js; read by repos.js)
//   selectedTaskId — the card currently open in the terminal dock (tasks ↔ hosts)
//   activeHostId   — the machine tab in focus; filters both the sidebar repos
//                    (hosts.js) AND the task/archive lists (tasks.js)
// Each module's own private state (term/fit/ws, branchReq, taskRepoId, …) stays
// local to that module. This module imports nothing, so it can't form a cycle.
export const state = {
  repos: [],
  hostsById: {},
  selectedTaskId: null,
  activeHostId: null,
};
