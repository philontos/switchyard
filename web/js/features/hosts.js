// Machines (hosts): col1 icon rail + col2 list. Loads the host list, renders the
// rail (renderRail) and the active machine's repos+tasks (renderList, via
// repoGroupHead from repos.js and taskCard from tasks.js), the register-machine
// modal, and delete. Shells (local + remote) live in the per-machine Shells group
// (rendered here, created via addLocalTask in tasks.js).
import { $, api } from "../core/dom.js";
import { hideLoading, showLoading, toast } from "../core/feedback.js";
import { confirmDialog } from "../core/dialog.js";
import { Selects } from "../core/select.js";
import { taskLifecycle } from "../core/task-lifecycle.js";
import { remoteFollowTasks } from "../core/host-follow.js";
import { state } from "../core/state.js";
import { repoGroupHead } from "./repos.js";
import { paintSelection, taskCard, allTasks, isEditingTask, connect,
         pendingRepoCards, pendingNodeRepoCards, pendingShellCards,
         isShadowedByPending, isShadowedByNodePending, pendingCard } from "./tasks.js";
import { detachDock, openPty, pruneNodePanes } from "./terminal.js";
import { duringAutoFollow } from "./mobile.js";
import { orderTasks, isDraggingTask } from "./reorder.js";

let hostsOrder = [];               // API order: local machine first. Active machine is state.activeHostId.
const collapsedRepos = new Set();  // collapsed repo groups (repo id) — read by renderList
let archivedOpen = false;          // is the archived section expanded
let menuHostId = null;             // remote machine whose ⚙ menu is open (null = none)
// renderList buffer: the markup last written to #m-list (+ the host it was for). An
// unchanged poll produces byte-identical markup, so we skip the DOM write — a 4s/5s
// refresh then never restarts the breathing-dot animations or churns the list.
// Invalidated (set null) whenever renderList bails mid-edit/drag, since those mutate
// #m-list out of band and the cache would otherwise wrongly believe it's in sync.
let lastListHtml = null, lastListHost = null;

// ---- machines: col1 is a vertical icon rail; col2 (renderList, added next)
// lists the active machine's repos + tasks. loadHosts/loadRepos/loadTasks all
// funnel through rerender() — the single re-render hub. ----
export async function loadHosts() {
  const hs = await api("/api/hosts").catch(() => null);
  if (!hs) return;
  state.hostsById = Object.fromEntries(hs.map(h => [h.id, h]));
  hostsOrder = hs.map(h => h.id);   // API order: local machine first
  rerender();
}
// Update a node's code in place — git pull its src (transparently follows the
// symlink to the machine's own clone) + npm install. Idempotent; the node's tdsp
// uses the new code on its next call. Long-ish, so flag in-progress + toast result.
export async function updateHost(id) {
  const h = state.hostsById[id];
  if (!h || bootstrappingHosts.has(id)) return;
  bootstrappingHosts.add(id);            // reuse the ⏳ in-progress flag
  renderList();
  toast(t("host.updating", { name: h.name }), "info");
  try {
    const r = await api(`/api/hosts/${id}/update`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    toast(/up to date/i.test(r.log || "") ? t("host.upToDate", { name: h.name }) : t("host.updated", { name: h.name }), "success");
    await loadFleet();
  } catch (e) {
    toast(String(e?.message || e), "error");
  } finally {
    bootstrappingHosts.delete(id);
    renderList();
  }
}

// Pull each node's OWN live task list (/api/fleet). Remote nodes are fetched over
// ssh by the server, so this is the cross-node "see what's running there" view.
// Best-effort: a failed load just leaves the last fleet snapshot in place.
export async function loadFleet() {
  const f = await api("/api/fleet").catch(() => null);
  if (!f) return;
  state.fleet = Object.fromEntries(f.nodes.map((n) => [n.node.id, n]));
  // drop any open node-task terminal whose session is no longer live on its node
  const keep = new Set();
  for (const n of f.nodes) {
    if (n.kind === "local") continue;
    for (const tk of n.tasks || []) if (tk.status !== "cleaned") keep.add(`n${n.node.id}:${tk.id}`);
  }
  if (pruneNodePanes(keep).includes(state.selectedTaskId)) state.selectedTaskId = null;
  renderList();
}

// An older node can still list its tasks, but it does not understand the newer
// archived-task verbs. Put the recovery action directly in view when the server
// reports that mismatch instead of leaving the raw CLI usage text as a toast.
function revealNodeUpdate(hostId, error) {
  if (error?.body?.code !== "nodeUpdateRequired") return;
  menuHostId = hostId;
  renderList();
}

// Open a remote node's task terminal: attach to its tmux session over ssh (the
// server resolves the node from ?host=). The session/title are read from the
// fleet snapshot, so the card's onclick only carries safe numeric ids.
export function connectNode(hostId, taskId) {
  const tk = state.fleet[hostId]?.tasks?.find((t) => t.id === taskId);
  if (!tk) return;
  const paneId = `n${hostId}:${taskId}`;
  state.selectedTaskId = paneId;
  // remember this machine's "current" task (its pane id) so switching back to the
  // node re-opens it instead of stranding the dock — the remote half of what
  // connect() does for local tasks via lastTaskByHost.
  state.lastTaskByHost[hostId] = paneId;
  const host = state.hostsById[hostId];
  const attach = host ? `ssh ${host.target} tmux attach -t ${tk.session}` : `tmux attach -t ${tk.session}`;
  openPty(`session=${encodeURIComponent(tk.session)}&host=${hostId}`, `#${tk.id} ${tk.title}`, attach, paneId, "", tk.agent);
  renderList();
}

// Stop a remote node's task — the server drives the node's own tdsp to kill it.
export async function stopNodeTask(hostId, taskId) {
  if (!(await confirmDialog(t("task.stopConfirm") || "Stop this task?", { title: t("task.stopTitle"), okText: t("common.stop") || "Stop", danger: true }))) return;
  try {
    await api(`/api/nodes/${hostId}/tasks/${taskId}/stop`, { method: "POST" });
    await loadFleet();
  } catch (e) {
    revealNodeUpdate(hostId, e);
    toast(String(e?.message || e), "error");
  }
}

// The archived-task lifecycle mirrors tasks.js, but the controller relays each
// operation to the node that owns the task instead of touching its own DB.
export async function removeNodeWt(hostId, taskId) {
  if (!(await confirmDialog(t("task.removeWtConfirm"), { title: t("task.removeWorktree"), okText: t("common.delete"), danger: true }))) return;
  try {
    await api(`/api/nodes/${hostId}/tasks/${taskId}/cleanup`, { method: "POST" });
    toast(t("toast.worktreeRemoved"), "success");
    await loadFleet();
  } catch (e) {
    revealNodeUpdate(hostId, e);
    toast(String(e?.message || e), "error");
  }
}

export async function resumeNodeTask(hostId, taskId) {
  showLoading(t("loading.default"));
  try {
    await api(`/api/nodes/${hostId}/tasks/${taskId}/resume`, { method: "POST" });
    toast(t("toast.resumed"), "success");
    await loadFleet();
    connectNode(hostId, taskId);
  } catch (e) {
    revealNodeUpdate(hostId, e);
    toast(t("toast.resumeFailed", { error: String(e?.message || e) }), "error", 6000);
  } finally {
    hideLoading();
  }
}

export async function deleteNodeTask(hostId, taskId) {
  try {
    await api(`/api/nodes/${hostId}/tasks/${taskId}`, { method: "DELETE" });
    await loadFleet();
  } catch (e) {
    revealNodeUpdate(hostId, e);
    toast(String(e?.message || e), "error");
  }
}

// The status dot for a remote node's task — mirrors taskCard's local dot so the
// remote breathing light reads identically: a live session breathes green, one
// blocked on a permission prompt is steady amber ("needs you"), otherwise the dot
// falls to its status colour. Prefers the node's OWN liveness (alive/waiting,
// shipped since `tdsp list` v2 — the node is the authority on its own tmux); for
// an un-updated node that ships neither, it degrades to a status guess so a
// running task still breathes instead of going dark.
function fleetDot(tk) {
  if (tk.alive !== undefined) {                 // node ships true liveness
    if (!tk.alive) return `<span class="sdot ${tk.status}" title="${tk.status}"></span>`;
    return tk.waiting
      ? `<span class="sdot waiting" title="${t("task.waiting")}"></span>`
      : `<span class="sdot live" title="live"></span>`;
  }
  // old node (no liveness on the wire): approximate from the static status string
  if (tk.status === "running") return `<span class="sdot live" title="live"></span>`;
  if (tk.status === "creating") return `<span class="sdot cloning" title="${t("task.creating")}"></span>`;
  return `<span class="sdot ${tk.status}" title="${tk.status}"></span>`;
}

// A card for a task owned by a remote node (from the fleet snapshot). Its actions
// mirror taskCard: stop while active; resume/remove-worktree/delete-record once
// archived. Only a live active session is connectable.
function fleetCard(hostId, tk) {
  const paneId = `n${hostId}:${tk.id}`;
  // selection is painted post-render by paintSelection, not baked into the markup
  // (keeps renderList's rebuild cache selection-agnostic — see pendingCard's note).
  // Same agent split as the local taskCard — the node ships `agent` in its
  // `tdsp list` payload (SELECT *). An un-updated node (no agent column) omits it
  // → defaults to claude. Colour only, no text label.
  const agent = tk.agent === "codex" || tk.agent === "kimi" ? tk.agent : "claude";
  const meta = tk.kind === "local"
    ? `<div class="muted">📂 <code>${tk.cwd || "~"}</code> <span class="tag-local">${t("local.tag")}</span></div>`
    : `<div class="muted">${tk.base_branch} → <code>${tk.work_branch}</code></div>`;
  const lifecycle = taskLifecycle(tk);
  let icon, note = "";
  if (lifecycle.action === "stop") {
    icon = { glyph: `<span class="stop-ico" aria-hidden="true"></span>`, cls: " stop", title: t("task.stopTitle"), fn: `stopNodeTask(${hostId},${tk.id})` };
  } else if (lifecycle.action === "removeWorktree") {
    icon = { glyph: "🗑", cls: "", title: t("task.removeWorktree"), fn: `removeNodeWt(${hostId},${tk.id})` };
    note = `<div class="muted">${t("task.worktreeKept")}</div>`;
  } else {
    icon = { glyph: "🗑", cls: "", title: t("task.deleteRecord"), fn: `deleteNodeTask(${hostId},${tk.id})` };
  }
  const resumeBtn = lifecycle.resumable
    ? `<button class="t-resume" title="${t("task.resumeTitle")}" onclick="event.stopPropagation();resumeNodeTask(${hostId},${tk.id})">⟳ ${t("task.resume")}</button>`
    : "";
  const codeBtn = tk.kind !== "local" && tk.hasWorktree && state.fleet[hostId]?.capabilities?.includes("code-view-v1")
    ? `<button class="card-code" title="${t("code.open")}" aria-label="${t("code.open")}" onclick="event.stopPropagation();openTaskCode(${tk.id},${hostId})"><span class="code-ico" aria-hidden="true"></span></button>`
    : "";
  const open = lifecycle.connectable ? ` clickable" onclick="connectNode(${hostId},${tk.id})` : "";
  return `<div class="card task task-${agent}${codeBtn ? " has-code" : ""}${open}" data-pane="${paneId}">
      ${codeBtn}
      <button class="card-x${icon.cls}" title="${icon.title}" aria-label="${icon.title}" onclick="event.stopPropagation();${icon.fn}">${icon.glyph}</button>
      <div class="t">${fleetDot(tk)}#${tk.id} <span class="tname">${tk.title}</span></div>
      ${meta}
      ${note}${resumeBtn}
    </div>`;
}

// machines whose bootstrap is in flight — drives the "⏳ installing…" state in the
// ⚙ menu so the (30–60s) install shows clear progress instead of dead silence.
const bootstrappingHosts = new Set();

// Install tdsp onto a remote machine (Phase 5 bootstrap), then refresh so its
// fleet status flips to reachable. Long-running (npm install on the target), so
// the menu shows an in-progress label + the button is replaced while it runs, and
// success/failure both surface as a toast.
export async function bootstrapHost(id) {
  const h = state.hostsById[id];
  if (!h || bootstrappingHosts.has(id)) return;   // ignore a double-click while running
  bootstrappingHosts.add(id);
  renderList();                       // show "⏳ installing…" immediately, keep the menu open
  toast(t("host.bootstrapping", { name: h.name }), "info");
  try {
    await api(`/api/hosts/${id}/bootstrap`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    toast(t("host.bootstrapped", { name: h.name }), "success");
    await loadFleet();
  } catch (e) {
    toast(String(e?.message || e), "error");
  } finally {
    bootstrappingHosts.delete(id);
    renderList();
  }
}

export function rerender() {
  if (!hostsOrder.length) return;   // hosts not loaded yet
  const hosts = hostsOrder.map(id => state.hostsById[id]).filter(Boolean);
  if (state.activeHostId == null || !state.hostsById[state.activeHostId]) {   // default to the local machine
    const first = hosts.find(h => h.kind === "local") || hosts[0];
    state.activeHostId = first ? first.id : null;
  }
  renderRail(hosts, blockedHosts());
  renderList();   // paints selection itself (every render path does)
}
// Machines with a task blocked on a permission prompt (alive + waiting). This is
// how the per-task yellow ("needs you") gets pulled up to the machine's rail dot.
// A task's machine is its host_id (shells) or its repo's host_id (repo tasks).
function blockedHosts() {
  const blocked = new Set();
  const local = Object.values(state.hostsById).find(h => h.kind === "local");
  if (local && allTasks().some(tk => tk.alive && tk.waiting)) blocked.add(local.id);
  for (const [hostId, fleet] of Object.entries(state.fleet)) {
    if (fleet?.kind !== "local" && fleet?.tasks?.some(tk => tk.alive && tk.waiting)) blocked.add(Number(hostId));
  }
  return blocked;
}
function renderRail(hosts, blocked) {
  const icon = h => {
    const online = h.kind === "local" || h.status === "online";
    const glyph = h.kind === "local" ? "🖥" : "▦";
    // offline wins (you can't act on it); else amber if a task here needs you; else green
    const waiting = online && blocked.has(h.id);
    const dotClass = !online ? "off" : waiting ? "waiting" : "on";
    const base = h.kind === "local" ? t("host.local") : `${h.name} · ${h.target}`;
    const title = waiting ? `${base} ${t("host.blocked")}` : base;
    return `<button class="rchip${h.id === state.activeHostId ? " active" : ""}" title="${title}" onclick="selectHost(${h.id})"><span class="rdot ${dotClass}"></span>${glyph}</button>`;
  };
  $("m-rail").innerHTML = hosts.map(icon).join("")
    + `<button class="rchip add" title="${t("host.new")}" onclick="openHostModal()">＋</button>`;
}
// duringAutoFollow: on mobile, tapping a machine chip must stay on the LIST view.
// followHostTask re-attaches the dock to that machine's last task (to keep it
// warm), which would otherwise trip the list→terminal jump — so suppress it here.
export function selectHost(id) { state.activeHostId = id; menuHostId = null; rerender(); duringAutoFollow(() => followHostTask(id)); }

// On a user-initiated machine switch, point the dock at THIS machine's task so
// col3 never keeps showing the previous machine's session. Preference order,
// matching what's visibly connectable in renderList (active + alive; archived is
// never connectable): the last task opened here → the first connectable task in
// list order (repos in sidebar order, then shells) → nothing, fall back to the
// empty state. Only selectHost triggers this — the 5s poll's rerender() doesn't,
// so a background refresh never yanks the dock around.
// the task id inside a node-pane memory ("n<host>:<id>"), or null if the stored
// value isn't one (e.g. a plain numeric id left over from a local task).
function nodePaneTaskId(hostId, mem) {
  const prefix = `n${hostId}:`;
  return typeof mem === "string" && mem.startsWith(prefix) ? Number(mem.slice(prefix.length)) : null;
}
function followHostTask(hostId) {
  // A bootstrapped remote shows the node's OWN tasks (fleet view), which live in
  // state.fleet, not the local task cache — so follow those: its remembered pane
  // (lastTaskByHost holds a pane id for a node, not a numeric id), then the first
  // live one, then nothing. Same preference order as the local path below, so a
  // remote machine restores its dock just like a local one. An un-updated node
  // ships no `alive`, so treat such tasks as connectable rather than hiding them.
  const host = state.hostsById[hostId];
  const fl = state.fleet[hostId];
  const nodeTasks = remoteFollowTasks(host, fl);
  if (nodeTasks) {
    const liveNode = tk => tk.status !== "cleaned" && (tk.alive ?? true);
    const remId = nodePaneTaskId(hostId, state.lastTaskByHost[hostId]);
    const remembered = remId != null ? nodeTasks.find(tk => tk.id === remId) : null;
    if (remembered && liveNode(remembered)) { connectNode(hostId, remembered.id); return; }
    const first = nodeTasks.find(liveNode);
    if (first) { connectNode(hostId, first.id); return; }
    state.selectedTaskId = null;
    detachDock();
    paintSelection();
    return;
  }

  const tasks = allTasks();
  const connectable = tk => tk.status !== "cleaned" && tk.alive;

  const remembered = tasks.find(tk => tk.id === state.lastTaskByHost[hostId]);
  if (remembered && connectable(remembered)) { connect(remembered.id); return; }

  for (const r of state.repos) {
    const mine = orderTasks(r.id, tasks.filter(tk => tk.repo_id === r.id && connectable(tk)));
    if (mine.length) { connect(mine[0].id); return; }
  }
  const shell = tasks.find(tk => tk.kind === "local" && tk.host_id === hostId && connectable(tk));
  if (shell) { connect(shell.id); return; }

  state.selectedTaskId = null;
  detachDock();
  paintSelection();
}

const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (ch) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
}[ch]));

export async function delNodeRepo(hostId, repoId) {
  if (!await confirmDialog(t("repo.delConfirm"), { title: t("repo.delTitle"), okText: t("common.delete"), danger: true })) return;
  try {
    await api(`/api/nodes/${hostId}/repos/${repoId}`, { method: "DELETE" });
  } catch (error) {
    if (!(error.status === 409 && error.body?.liveCount > 0)) return toast(error.message, "error");
    if (!await confirmDialog(t("repo.forceDelConfirm", { count: error.body.liveCount }),
      { title: t("repo.delTitle"), okText: t("common.delete"), danger: true })) return;
    try { await api(`/api/nodes/${hostId}/repos/${repoId}?force=1`, { method: "DELETE" }); }
    catch (forced) { return toast(forced.message, "error"); }
  }
  await loadFleet();
}

// col2: machine header (name + ＋register-repo + remote ⚙ menu) then collapsible
// repo groups with nested tasks, the local quick-task group (local machine), and
// a collapsed archived section. Task loop vars are named `tk` — `t` is the global
// i18n function and must not be shadowed here.
// Selection is NOT part of the generated markup (see fleetCard/pendingCard notes),
// so it must be painted after EVERY render path — including the byte-identical
// skip, where the DOM stands but the selection may have moved. Wrapping here
// covers all callers (toggleRepo, loadFleet, the ⚙ menu, …), not just rerender().
function renderList() {
  renderListHtml();
  paintSelection();
}
function renderListHtml() {
  // An inline rename input lives inside #m-list as a raw DOM node (not in the
  // template), so rebuilding innerHTML would destroy it and steal focus. Bail
  // while editing — this is the single chokepoint every re-render path passes
  // through, so loadHosts (5s), loadRepos, and a language switch can't wipe it.
  // The rail/selection in rerender() still refresh; finish() re-renders on exit.
  // Same bail while a card is mid-drag (reorder.js) — a poll must not rebuild
  // #m-list and yank the dragged node; cleanup() re-renders once on drop.
  if (isEditingTask() || isDraggingTask()) { lastListHtml = null; return; }
  const h = state.hostsById[state.activeHostId];
  if (!h) { $("m-list").innerHTML = ""; lastListHtml = ""; lastListHost = null; return; }
  const isLocal = h.kind === "local";
  const online = isLocal || h.status === "online";
  const tasks = allTasks();
  const fl = state.fleet[h.id];
  const remoteReady = !isLocal && fl?.ok && !fl.needsUpdate;

  const gear = isLocal ? ""
    : `<button class="mh-gear" title="${t("host.manage")}" onclick="event.stopPropagation();toggleHostMenu(${h.id})">⚙</button>`;
  const canAddRepo = isLocal || remoteReady;
  const newRepo = `<button class="mh-act" ${canAddRepo ? "" : "disabled"} onclick="openRepoModal(${h.id})">＋${t("repo.repoWord")}</button>`;
  // fleet/bootstrap status for this remote machine: bootstrapped+reachable shows a
  // live task count; reachable-but-not-installed offers a one-click Bootstrap; an
  // unreachable/erroring node says so. Read from the last /api/fleet snapshot.
  let fleetRow = "";
  if (!isLocal) {
    if (bootstrappingHosts.has(h.id)) {
      fleetRow = `<div class="mh-fleet">⏳ ${t("host.installing")}</div>`;
    } else if (fl?.ok && fl.needsUpdate) {
      fleetRow = `<div class="mh-fleet off">⚠ ${t("host.outdated")}</div>`;
    } else if (fl?.ok) {
      fleetRow = `<div class="mh-fleet">🛰 ${t("host.liveTasks", { n: fl.tasks?.length ?? 0 })}</div>`;
    } else if (fl?.reason === "notBootstrapped") {
      fleetRow = `<button class="mh-boot" onclick="bootstrapHost(${h.id})">⬇ ${t("host.bootstrap")}</button>`;
    } else if (fl) {
      fleetRow = `<div class="mh-fleet off">⚠ ${t("host." + (fl.reason || "error"))}</div>`;
    } else {
      // no fleet snapshot yet for this remote → still let the user kick off install
      fleetRow = `<button class="mh-boot" onclick="bootstrapHost(${h.id})">⬇ ${t("host.bootstrap")}</button>`;
    }
  }
  // an installed + reachable node can be updated in place (git pull its src)
  const updateRow = (!isLocal && state.fleet[h.id]?.ok && !bootstrappingHosts.has(h.id))
    ? `<button class="mh-update" onclick="updateHost(${h.id})"><span class="sync-icon" aria-hidden="true"></span>${t("host.update")}</button>` : "";
  const menu = (menuHostId === h.id) ? `<div class="mh-menu">
      <div class="mh-target">${h.target}</div>
      ${fleetRow}
      ${updateRow}
      <button class="danger" onclick="delHost(${h.id})">${t("host.del")}</button>
    </div>` : "";
  const header = `<div class="mh"><span class="mh-ic">${isLocal ? "🖥" : "▦"}</span><span class="mh-name">${isLocal ? t("host.local") : h.name}</span>${gear}${newRepo}${menu}</div>`;
  let content = "";
  if (isLocal) {
    const repoBlocks = state.repos.map(r => {
      const collapsed = collapsedRepos.has(r.id);
      const mine = orderTasks(r.id, tasks.filter(tk => tk.kind !== "local" && tk.repo_id === r.id && tk.status !== "cleaned" && !isShadowedByPending(tk)));
      const pend = pendingRepoCards(r.id).map(pendingCard).join("");
      const cards = pend + mine.map(tk => taskCard(tk, true)).join("");
      const body = collapsed ? pend : (cards || `<div class="grp-empty">${t("repo.noTasks")}</div>`);
      return `<div class="grp${collapsed ? "" : " open"}">${repoGroupHead(r, true, collapsed, mine)}${body}</div>`;
    }).join("") || `<div class="muted mempty">${t("host.noRepos")}</div>`;
    const shells = tasks.filter(tk => tk.kind === "local" && tk.status !== "cleaned" && !isShadowedByPending(tk));
    const shellCards = pendingShellCards(h.id).map(pendingCard).join("") + shells.map(tk => taskCard(tk, true)).join("");
    const shellBlock = `<div class="grp open"><div class="grp-head static"><span class="grp-name">${t("list.localGroup")}</span>
        <button class="grp-act" title="${t("local.new")}" onclick="event.stopPropagation();addLocalTask()">＋</button></div>
        ${shellCards || `<div class="grp-empty">${t("local.none")}</div>`}</div>`;
    const archived = tasks.filter(tk => tk.status === "cleaned");
    const archBlock = `<div class="grp${archivedOpen ? " open" : ""}"><div class="grp-head" onclick="toggleArchived()">
        <span class="grp-name">${t("list.archived")}</span><span class="muted">${archived.length ? `(${archived.length})` : ""}</span></div>
        ${archivedOpen ? (archived.map(tk => taskCard(tk, true)).join("") || `<div class="grp-empty">${t("empty.archTitle")}</div>`) : ""}</div>`;
    content = repoBlocks + shellBlock + archBlock;
  } else if (fl?.ok) {
    const all = fl.tasks || [];
    const live = all.filter(tk => tk.status !== "cleaned");
    const repos = fl.repos || [];
    const known = new Set(repos.map(r => r.id));
    const canCode = fl.capabilities?.includes("code-view-v1");
    const repoGroups = repos.map(r => {
      const ready = !r.status || r.status === "ready";
      const pend = pendingNodeRepoCards(h.id, r.id).map(pendingCard).join("");
      const mine = live.filter(tk => tk.kind === "repo" && tk.repo_id === r.id && !isShadowedByNodePending(h.id, tk));
      const cards = pend + mine.map(tk => fleetCard(h.id, tk)).join("");
      const code = canCode && ready
        ? `<button class="grp-code" title="${t("code.open")}" onclick="event.stopPropagation();openRepoCode(${r.id},${h.id})"><span class="code-ico" aria-hidden="true"></span></button>` : "";
      const del = remoteReady ? `<button class="grp-del" title="${t("repo.delTitle")}" onclick="event.stopPropagation();delNodeRepo(${h.id},${r.id})">🗑</button>` : "";
      const add = remoteReady && ready ? `<button class="grp-act" title="${t("node.newTask")}" onclick="event.stopPropagation();openNodeTaskModal(${h.id},${r.id})">＋</button>` : "";
      const status = r.status && r.status !== "ready" ? `<span class="grp-status ${r.status === "error" ? "error" : ""}">${esc(r.status)}</span>` : "";
      return `<div class="grp open"><div class="grp-head static"><span class="grp-name">📦 ${esc(r.name)}</span><span class="grp-repo-id">#${Number(r.id)}</span>${status}${code}${del}${add}</div>
        ${cards || `<div class="grp-empty">${t("repo.noTasks")}</div>`}${r.error ? `<div class="grp-error-detail">${esc(r.error)}</div>` : ""}</div>`;
    }).join("") || `<div class="muted mempty">${t("host.noRepos")}</div>`;
    const nodeShells = live.filter(tk => tk.kind === "local" && !isShadowedByNodePending(h.id, tk));
    const shellCards = pendingShellCards(h.id).map(pendingCard).join("") + nodeShells.map(tk => fleetCard(h.id, tk)).join("");
    const addShell = remoteReady ? `<button class="grp-act" title="${t("local.new")}" onclick="event.stopPropagation();addNodeShell(${h.id})">＋</button>` : "";
    const shellGroup = `<div class="grp open"><div class="grp-head static"><span class="grp-name">${t("list.localGroup")}</span>${addShell}</div>${shellCards || `<div class="grp-empty">${t("local.none")}</div>`}</div>`;
    const orphans = live.filter(tk => tk.kind === "repo" && !known.has(tk.repo_id));
    const orphanGroup = orphans.length
      ? `<div class="grp open"><div class="grp-head static"><span class="grp-name">🛰 ${t("node.group")}</span></div>${orphans.map(tk => fleetCard(h.id, tk)).join("")}</div>` : "";
    const archived = all.filter(tk => tk.status === "cleaned");
    const archBlock = `<div class="grp${archivedOpen ? " open" : ""}"><div class="grp-head" onclick="toggleArchived()">
        <span class="grp-name">${t("list.archived")}</span><span class="muted">${archived.length ? `(${archived.length})` : ""}</span></div>
        ${archivedOpen ? (archived.map(tk => fleetCard(h.id, tk)).join("") || `<div class="grp-empty">${t("empty.archTitle")}</div>`) : ""}</div>`;
    content = repoGroups + shellGroup + orphanGroup + archBlock;
  } else {
    const reason = fl?.reason === "notBootstrapped" ? "notBootstrapped" : (fl?.reason || "error");
    content = `<div class="grp open"><div class="grp-head static"><span class="grp-name">🛰 ${t("node.group")}</span></div><div class="grp-empty">⚠ ${t("host." + reason)}</div></div>`;
  }

  const html = header + content;
  // Buffer: nothing changed since the last write → leave the DOM alone. The markup
  // is a pure function of the render state (host, tasks, fleet, selection, collapse/
  // menu flags), so identical markup means an identical list; rewriting it would only
  // restart animations and flicker. paintSelection() still runs after us (rerender)
  // to keep the highlight exact even on a skipped rebuild.
  if (html === lastListHtml && lastListHost === state.activeHostId) return;
  lastListHtml = html;
  lastListHost = state.activeHostId;
  $("m-list").innerHTML = html;
}
export function toggleRepo(id) { collapsedRepos.has(id) ? collapsedRepos.delete(id) : collapsedRepos.add(id); renderList(); }
// Force a repo group open (no re-render — the caller renders). Used on dispatch so a
// just-created task's placeholder card is visible even if its group was collapsed.
export function expandRepo(id) { collapsedRepos.delete(id); }
export function toggleArchived() { archivedOpen = !archivedOpen; renderList(); }
export function toggleHostMenu(id) { menuHostId = (menuHostId === id) ? null : id; renderList(); }

// Close the ⚙ (machine) menu on any outside click. Its trigger's own handler
// stops propagation, so a click on it never reaches here (it toggles instead);
// a click anywhere else dismisses the menu.
export function initHostMenuDismiss() {
  document.addEventListener("click", (e) => {
    if (menuHostId != null && !e.target.closest(".mh-menu") && !e.target.closest(".mh-gear")) { menuHostId = null; renderList(); }
  });
}
export function openHostModal() { $("host-modal").style.display = "flex"; setTimeout(() => $("h-name").focus(), 30); }
export function closeHostModal() { $("host-modal").style.display = "none"; }
export async function addHost() {
  const body = {
    name: $("h-name").value.trim(), target: $("h-target").value.trim(),
    kind: Selects["h-kind"].value,
    profile: $("h-profile").value.trim(),
  };
  if (!body.name || !body.target) return toast(t("host.required"), "error");
  await api("/api/hosts", { method: "POST", headers: {"content-type":"application/json"}, body: JSON.stringify(body) });
  $("h-name").value = ""; $("h-target").value = ""; $("h-profile").value = "";
  closeHostModal();
  toast(t("host.added"), "success");
  loadHosts();
}
export async function delHost(id){ if(!await confirmDialog(t("host.delConfirm"),{title:t("host.del"),okText:t("common.delete"),danger:true}))return; await api(`/api/hosts/${id}`,{method:"DELETE"}); loadHosts(); }
