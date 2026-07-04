// Machines (hosts): col1 icon rail + col2 list. Loads the host list, renders the
// rail (renderRail) and the active machine's repos+tasks (renderList, via
// repoGroupHead from repos.js and taskCard from tasks.js), the register-machine
// modal, and delete. Shells (local + remote) live in the per-machine Shells group
// (rendered here, created via addLocalTask in tasks.js).
import { $, api } from "../core/dom.js";
import { toast } from "../core/feedback.js";
import { confirmDialog } from "../core/dialog.js";
import { Selects } from "../core/select.js";
import { state } from "../core/state.js";
import { repoGroupHead } from "./repos.js";
import { paintSelection, taskCard, allTasks, isEditingTask, connect,
         pendingRepoCards, pendingNodeRepoCards, pendingShellCards,
         isShadowedByPending, isShadowedByNodePending, pendingCard } from "./tasks.js";
import { detachDock, openPty, pruneNodePanes } from "./terminal.js";
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
  for (const n of f.nodes) for (const tk of n.tasks || []) if (tk.status !== "cleaned") keep.add(`n${n.node.id}:${tk.id}`);
  pruneNodePanes(keep);
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
  openPty(`session=${encodeURIComponent(tk.session)}&host=${hostId}`, `#${tk.id} ${tk.title}`, "", attach, paneId, "");
  renderList();
}

// Stop a remote node's task — the server drives the node's own tdsp to kill it.
export async function stopNodeTask(hostId, taskId) {
  if (!(await confirmDialog(t("task.stopConfirm") || "Stop this task?", { title: t("task.stopTitle"), okText: t("common.stop") || "Stop", danger: true }))) return;
  try {
    await api(`/api/nodes/${hostId}/tasks/${taskId}/stop`, { method: "POST" });
    await loadFleet();
  } catch (e) {
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

// A card for a task running ON a remote node (from the fleet snapshot). Connect
// attaches over ssh; the corner ⏹ stops it via the node. data-pane keys it for
// paintSelection (so its selected state survives a refresh instead of flickering
// off), and fleetDot gives it the same breathing/needs-you light a local card has.
function fleetCard(hostId, tk) {
  const paneId = `n${hostId}:${tk.id}`;
  const sel = paneId === state.selectedTaskId ? " selected" : "";
  // Same agent split as the local taskCard — the node ships `agent` in its
  // `tdsp list` payload (SELECT *), so a remote Codex task reads identically to a
  // local one. An un-updated node (no agent column) omits it → defaults to claude.
  // Colour only (task-claude / task-codex accent bar + tint), no text label.
  const agent = tk.agent === "codex" ? "codex" : "claude";
  const meta = tk.kind === "local"
    ? `<div class="muted">📂 <code>${tk.cwd || "~"}</code> <span class="tag-local">${t("local.tag")}</span></div>`
    : `<div class="muted">${tk.base_branch} → <code>${tk.work_branch}</code></div>`;
  return `<div class="card task task-${agent}${sel} clickable" data-pane="${paneId}" onclick="connectNode(${hostId},${tk.id})">
      <button class="card-x" title="${t("task.stopTitle")}" onclick="event.stopPropagation();stopNodeTask(${hostId},${tk.id})">⏹</button>
      <div class="t">${fleetDot(tk)}#${tk.id} <span class="tname">${tk.title}</span></div>
      ${meta}
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
  renderList();
  paintSelection();
}
// Machines with a task blocked on a permission prompt (alive + waiting). This is
// how the per-task yellow ("needs you") gets pulled up to the machine's rail dot.
// A task's machine is its host_id (shells) or its repo's host_id (repo tasks).
function blockedHosts() {
  const hostOf = Object.fromEntries(state.repos.map(r => [r.id, Number(r.host_id)]));
  const blocked = new Set();
  for (const tk of allTasks()) {
    if (!(tk.alive && tk.waiting)) continue;
    const hid = tk.host_id ?? hostOf[tk.repo_id];
    if (hid != null) blocked.add(hid);
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
export function selectHost(id) { state.activeHostId = id; menuHostId = null; rerender(); followHostTask(id); }

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
  if (host && host.kind !== "local" && fl?.ok) {
    const nodeTasks = fl.tasks || [];
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

  for (const r of state.repos.filter(r => Number(r.host_id) === hostId)) {
    const mine = orderTasks(r.id, tasks.filter(tk => tk.repo_id === r.id && connectable(tk)));
    if (mine.length) { connect(mine[0].id); return; }
  }
  const shell = tasks.find(tk => tk.kind === "local" && tk.host_id === hostId && connectable(tk));
  if (shell) { connect(shell.id); return; }

  state.selectedTaskId = null;
  detachDock();
  paintSelection();
}

// col2: machine header (name + ＋register-repo + remote ⚙ menu) then collapsible
// repo groups with nested tasks, the local quick-task group (local machine), and
// a collapsed archived section. Task loop vars are named `tk` — `t` is the global
// i18n function and must not be shadowed here.
function renderList() {
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
  const hostOf = Object.fromEntries(state.repos.map(r => [r.id, Number(r.host_id)]));

  const gear = isLocal ? ""
    : `<button class="mh-gear" title="${t("host.manage")}" onclick="event.stopPropagation();toggleHostMenu(${h.id})">⚙</button>`;
  const newRepo = `<button class="mh-act" ${online ? "" : "disabled"} onclick="openRepoModal(${h.id})">＋${t("repo.repoWord")}</button>`;
  // fleet/bootstrap status for this remote machine: bootstrapped+reachable shows a
  // live task count; reachable-but-not-installed offers a one-click Bootstrap; an
  // unreachable/erroring node says so. Read from the last /api/fleet snapshot.
  const fl = state.fleet[h.id];
  let fleetRow = "";
  if (!isLocal) {
    if (bootstrappingHosts.has(h.id)) {
      fleetRow = `<div class="mh-fleet">⏳ ${t("host.installing")}</div>`;
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
    ? `<button class="mh-update" onclick="updateHost(${h.id})">⟳ ${t("host.update")}</button>` : "";
  const menu = (menuHostId === h.id) ? `<div class="mh-menu">
      <div class="mh-target">${h.target}</div>
      ${fleetRow}
      ${updateRow}
      <button class="danger" onclick="delHost(${h.id})">${t("host.del")}</button>
    </div>` : "";
  const header = `<div class="mh"><span class="mh-ic">${isLocal ? "🖥" : "▦"}</span><span class="mh-name">${isLocal ? t("host.local") : h.name}</span>${gear}${newRepo}${menu}</div>`;

  const repos = state.repos.filter(r => Number(r.host_id) === h.id);
  const repoBlocks = repos.map(r => {
    // an in-flight create expands its own group (addTask), so pending cards are never
    // hidden by a collapsed body; still render them when collapsed, just in case.
    const collapsed = collapsedRepos.has(r.id);
    const mine = orderTasks(r.id, tasks.filter(tk => tk.repo_id === r.id && tk.status !== "cleaned" && !isShadowedByPending(tk)));
    const pend = pendingRepoCards(r.id).map(pendingCard).join("");   // newest-on-top, like new real tasks
    const cards = pend + mine.map(tk => taskCard(tk, online)).join("");
    const body = collapsed ? pend
      : (cards || `<div class="grp-empty">${t("repo.noTasks")}</div>`);
    // `.open` (expanded) is what shows the state now — a left accent bar + faint
    // wash on the whole group, in place of the old ▸/▾ caret glyph.
    return `<div class="grp${collapsed ? "" : " open"}">${repoGroupHead(r, online, collapsed, mine)}${body}</div>`;
    // "no repos" only for the local machine — a remote node's own repos render in
    // the node section below, so the message would be misleading there.
  }).join("") || (isLocal ? `<div class="muted mempty">${t("host.noRepos")}</div>` : "");

  // every machine (local + remote) gets a Shells group: bare tmux shells you can
  // open many of, persistent like tasks. ＋ is disabled while the machine is offline.
  const shells = tasks.filter(tk => tk.kind === "local" && tk.host_id === h.id && tk.status !== "cleaned" && !isShadowedByPending(tk));
  const pendShells = pendingShellCards(h.id).map(pendingCard).join("");
  const shellCards = pendShells + shells.map(tk => taskCard(tk, online)).join("");
  const addShell = `<button class="grp-act" title="${t("local.new")}" ${online ? "" : "disabled"} onclick="event.stopPropagation();addLocalTask(${h.id})">＋</button>`;
  const shellBlock = `<div class="grp open"><div class="grp-head static">
      <span class="grp-name">${t("list.localGroup")}</span>${addShell}</div>
      ${shellCards || `<div class="grp-empty">${t("local.none")}</div>`}</div>`;

  // Remote nodes: a group showing the tasks the NODE itself reports (its own live
  // truth, fetched over ssh — includes anything dispatched here under the sink
  // model). Legacy tasks recorded in THIS controller's db stay in the repo groups
  // above; these are a separate, clearly-labelled source. Local machine: skipped
  // (its tasks already render above).
  // Remote node: the node's OWN repos + tasks (live, over ssh). Each node repo is a
  // group (like the local repo groups) with a ＋ to dispatch a task to it — using
  // the node's existing mirror, no re-registration here. The node's shells + any
  // repo task whose repo isn't listed fall into a "🛰 节点任务" catch-all.
  let nodeBlock = "", nodeArchBlock = "";
  if (!isLocal) {
    const fl = state.fleet[h.id];
    if (fl?.ok) {
      const all = fl.tasks || [];
      const live = all.filter(tk => tk.status !== "cleaned");
      const repos = fl.repos || [];
      const known = new Set(repos.map(r => r.id));
      const repoGroups = repos.map(r => {
        // optimistic placeholders (newest-on-top) render ahead of the node's real
        // cards; the matching real 'creating' card is shadowed until the POST resolves.
        const pend = pendingNodeRepoCards(h.id, r.id).map(pendingCard).join("");
        const mine = live.filter(tk => tk.kind === "repo" && tk.repo_id === r.id && !isShadowedByNodePending(h.id, tk));
        const cards = pend + mine.map(tk => fleetCard(h.id, tk)).join("");
        const body = cards || `<div class="grp-empty">${t("repo.noTasks")}</div>`;
        const add = `<button class="grp-act" title="${t("node.newTask")}" onclick="event.stopPropagation();openNodeTaskModal(${h.id},${r.id})">＋</button>`;
        return `<div class="grp open"><div class="grp-head static"><span class="grp-name">📦 ${r.name}</span>${add}</div>${body}</div>`;
      }).join("");
      // the node's own shells, with a ＋ that opens a new shell ON the node
      const pendShells = pendingShellCards(h.id).map(pendingCard).join("");
      const nodeShells = live.filter(tk => tk.kind === "local" && !isShadowedByNodePending(h.id, tk));
      const addShell = `<button class="grp-act" title="${t("local.new")}" onclick="event.stopPropagation();addNodeShell(${h.id})">＋</button>`;
      const shellCards = pendShells + nodeShells.map(tk => fleetCard(h.id, tk)).join("");
      const shellGroup = `<div class="grp open"><div class="grp-head static"><span class="grp-name">${t("list.localGroup")}</span>${addShell}</div>${shellCards || `<div class="grp-empty">${t("local.none")}</div>`}</div>`;
      // repo tasks whose repo the node didn't list — rare safety net
      const orphans = live.filter(tk => tk.kind === "repo" && !known.has(tk.repo_id));
      const orphanGroup = orphans.length
        ? `<div class="grp open"><div class="grp-head static"><span class="grp-name">🛰 ${t("node.group")}</span></div>${orphans.map(tk => fleetCard(h.id, tk)).join("")}</div>`
        : "";
      nodeBlock = repoGroups + shellGroup + orphanGroup;
      // the node's OWN archived (cleaned) tasks — its truth, not A's db
      const arch = all.filter(tk => tk.status === "cleaned");
      nodeArchBlock = `<div class="grp${archivedOpen ? " open" : ""}"><div class="grp-head" onclick="toggleArchived()">
          <span class="grp-name">${t("list.archived")}</span>
          <span class="muted">${arch.length ? `(${arch.length})` : ""}</span></div>
          ${archivedOpen ? (arch.map(tk => fleetCard(h.id, tk)).join("") || `<div class="grp-empty">${t("empty.archTitle")}</div>`) : ""}</div>`;
    } else if (fl && fl.reason && fl.reason !== "notBootstrapped") {
      nodeBlock = `<div class="grp open"><div class="grp-head static"><span class="grp-name">🛰 ${t("node.group")}</span></div><div class="grp-empty">⚠ ${t("host." + fl.reason)}</div></div>`;
    }
  }

  const archived = tasks.filter(tk => tk.status === "cleaned" && (tk.host_id ?? hostOf[tk.repo_id]) === h.id);
  const archBlock = `<div class="grp${archivedOpen ? " open" : ""}"><div class="grp-head" onclick="toggleArchived()">
      <span class="grp-name">${t("list.archived")}</span>
      <span class="muted">${archived.length ? `(${archived.length})` : ""}</span></div>
      ${archivedOpen ? (archived.map(tk => taskCard(tk, online)).join("") || `<div class="grp-empty">${t("empty.archTitle")}</div>`) : ""}</div>`;

  // A bootstrapped, reachable remote shows ONE coherent view — the node's own live
  // truth (nodeBlock). The legacy A's-db sections (repoBlocks/shellBlock/archBlock)
  // belong to the old model and would double up with the fleet, so they're hidden.
  // The local machine and not-yet-bootstrapped remotes keep the classic layout.
  const isFleetView = !isLocal && state.fleet[h.id]?.ok;
  const html = isFleetView
    ? header + nodeBlock + nodeArchBlock
    : header + repoBlocks + shellBlock + nodeBlock + archBlock;
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
  };
  if (!body.name || !body.target) return toast(t("host.required"), "error");
  await api("/api/hosts", { method: "POST", headers: {"content-type":"application/json"}, body: JSON.stringify(body) });
  $("h-name").value = ""; $("h-target").value = "";
  closeHostModal();
  toast(t("host.added"), "success");
  loadHosts();
}
export async function delHost(id){ if(!await confirmDialog(t("host.delConfirm"),{title:t("host.del"),okText:t("common.delete"),danger:true}))return; await api(`/api/hosts/${id}`,{method:"DELETE"}); loadHosts(); }
