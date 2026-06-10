// Machines (hosts): col1 icon rail + col2 list. Loads the host list, renders the
// rail (renderRail) and the active machine's repos+tasks (renderList, via
// repoGroupHead from repos.js and taskCard from tasks.js), the register-machine
// modal, and delete. Shells (local + remote) live in the per-machine Shells group
// (rendered here, created via addLocalTask in tasks.js).
import { $, api } from "./dom.js";
import { toast } from "./feedback.js";
import { confirmDialog } from "./dialog.js";
import { Selects } from "./select.js";
import { state } from "./state.js";
import { repoGroupHead } from "./repos.js";
import { paintSelection, taskCard, allTasks, isEditingTask } from "./tasks.js";
import { orderTasks, isDraggingTask } from "./reorder.js";

let hostsOrder = [];               // API order: local machine first. Active machine is state.activeHostId.
const collapsedRepos = new Set();  // collapsed repo groups (repo id) — read by renderList
let archivedOpen = false;          // is the archived section expanded
let menuHostId = null;             // remote machine whose ⚙ menu is open (null = none)

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
export function selectHost(id) { state.activeHostId = id; menuHostId = null; rerender(); }

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
  if (isEditingTask() || isDraggingTask()) return;
  const h = state.hostsById[state.activeHostId];
  if (!h) { $("m-list").innerHTML = ""; return; }
  const isLocal = h.kind === "local";
  const online = isLocal || h.status === "online";
  const tasks = allTasks();
  const hostOf = Object.fromEntries(state.repos.map(r => [r.id, Number(r.host_id)]));

  const gear = isLocal ? ""
    : `<button class="mh-gear" title="${t("host.manage")}" onclick="event.stopPropagation();toggleHostMenu(${h.id})">⚙</button>`;
  const newRepo = `<button class="mh-act" ${online ? "" : "disabled"} onclick="openRepoModal(${h.id})">＋${t("repo.repoWord")}</button>`;
  const menu = (menuHostId === h.id) ? `<div class="mh-menu">
      <div class="mh-target">${h.target}</div>
      <button class="danger" onclick="delHost(${h.id})">${t("host.del")}</button>
    </div>` : "";
  const header = `<div class="mh"><span class="mh-ic">${isLocal ? "🖥" : "▦"}</span><span class="mh-name">${isLocal ? t("host.local") : h.name}</span>${gear}${newRepo}${menu}</div>`;

  const repos = state.repos.filter(r => Number(r.host_id) === h.id);
  const repoBlocks = repos.map(r => {
    const collapsed = collapsedRepos.has(r.id);
    const mine = orderTasks(r.id, tasks.filter(tk => tk.repo_id === r.id && tk.status !== "cleaned"));
    const body = collapsed ? ""
      : (mine.map(tk => taskCard(tk, online)).join("") || `<div class="grp-empty">${t("repo.noTasks")}</div>`);
    // `.open` (expanded) is what shows the state now — a left accent bar + faint
    // wash on the whole group, in place of the old ▸/▾ caret glyph.
    return `<div class="grp${collapsed ? "" : " open"}">${repoGroupHead(r, online, collapsed, mine)}${body}</div>`;
  }).join("") || `<div class="muted mempty">${t("host.noRepos")}</div>`;

  // every machine (local + remote) gets a Shells group: bare tmux shells you can
  // open many of, persistent like tasks. ＋ is disabled while the machine is offline.
  const shells = tasks.filter(tk => tk.kind === "local" && tk.host_id === h.id && tk.status !== "cleaned");
  const addShell = `<button class="grp-act" title="${t("local.new")}" ${online ? "" : "disabled"} onclick="event.stopPropagation();addLocalTask(${h.id})">＋</button>`;
  const shellBlock = `<div class="grp open"><div class="grp-head static">
      <span class="grp-name">${t("list.localGroup")}</span>${addShell}</div>
      ${shells.map(tk => taskCard(tk, online)).join("") || `<div class="grp-empty">${t("local.none")}</div>`}</div>`;

  const archived = tasks.filter(tk => tk.status === "cleaned" && (tk.host_id ?? hostOf[tk.repo_id]) === h.id);
  const archBlock = `<div class="grp${archivedOpen ? " open" : ""}"><div class="grp-head" onclick="toggleArchived()">
      <span class="grp-name">${t("list.archived")}</span>
      <span class="muted">${archived.length ? `(${archived.length})` : ""}</span></div>
      ${archivedOpen ? (archived.map(tk => taskCard(tk, online)).join("") || `<div class="grp-empty">${t("empty.archTitle")}</div>`) : ""}</div>`;

  $("m-list").innerHTML = header + repoBlocks + shellBlock + archBlock;
}
export function toggleRepo(id) { collapsedRepos.has(id) ? collapsedRepos.delete(id) : collapsedRepos.add(id); renderList(); }
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
