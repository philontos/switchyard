// Machines (hosts): col1 icon rail + col2 list. Loads the host list, renders the
// rail (renderRail) and the active machine's repos+tasks (renderList, via
// repoGroupHead from repos.js and taskCard from tasks.js), the register-machine
// modal, delete, and connectHost() which attaches the terminal to a remote shell.
import { $, api } from "./dom.js";
import { toast } from "./feedback.js";
import { confirmDialog } from "./dialog.js";
import { Selects } from "./select.js";
import { state } from "./state.js";
import { repoGroupHead } from "./repos.js";
import { paintSelection, taskCard, allTasks } from "./tasks.js";
import { openPty } from "./terminal.js";

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
  renderRail(hosts);
  renderList();
  paintSelection();
}
function renderRail(hosts) {
  const icon = h => {
    const online = h.kind === "local" || h.status === "online";
    const glyph = h.kind === "local" ? "🖥" : "▦";
    const title = h.kind === "local" ? t("host.local") : `${h.name} · ${h.target}`;
    return `<button class="rchip${h.id === state.activeHostId ? " active" : ""}" title="${title}" onclick="selectHost(${h.id})"><span class="rdot ${online ? "on" : "off"}"></span>${glyph}</button>`;
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
      <div class="mh-target">${h.target} · ${h.session}</div>
      <button onclick="connectHost(${h.id})">${t("host.shell")}</button>
      <button class="danger" onclick="delHost(${h.id})">${t("host.del")}</button>
    </div>` : "";
  const header = `<div class="mh"><span class="mh-name">${isLocal ? t("host.local") : h.name}</span>${gear}${newRepo}${menu}</div>`;

  const repos = state.repos.filter(r => Number(r.host_id) === h.id);
  const repoBlocks = repos.map(r => {
    const collapsed = collapsedRepos.has(r.id);
    const mine = tasks.filter(tk => tk.repo_id === r.id && tk.status !== "cleaned");
    const body = collapsed ? ""
      : (mine.map(tk => taskCard(tk, online)).join("") || `<div class="grp-empty">${t("repo.noTasks")}</div>`);
    return `<div class="grp">${repoGroupHead(r, online, collapsed)}${body}</div>`;
  }).join("") || `<div class="muted mempty">${t("host.noRepos")}</div>`;

  let localBlock = "";
  if (isLocal) {
    const locals = tasks.filter(tk => tk.kind === "local" && tk.host_id === h.id && tk.status !== "cleaned");
    const add = `<button class="grp-act" title="${t("local.new")}" onclick="event.stopPropagation();addLocalTask()">＋</button>`;
    localBlock = `<div class="grp"><div class="grp-head static">
        <span class="grp-caret"></span><span class="grp-name">${t("list.localGroup")}</span>${add}</div>
        ${locals.map(tk => taskCard(tk, online)).join("") || `<div class="grp-empty">${t("local.none")}</div>`}</div>`;
  }

  const archived = tasks.filter(tk => tk.status === "cleaned" && (tk.host_id ?? hostOf[tk.repo_id]) === h.id);
  const archBlock = `<div class="grp"><div class="grp-head" onclick="toggleArchived()">
      <span class="grp-caret">${archivedOpen ? "▾" : "▸"}</span>
      <span class="grp-name">${t("list.archived")}</span>
      <span class="muted">${archived.length ? `(${archived.length})` : ""}</span></div>
      ${archivedOpen ? (archived.map(tk => taskCard(tk, online)).join("") || `<div class="grp-empty">${t("empty.archTitle")}</div>`) : ""}</div>`;

  $("m-list").innerHTML = header + repoBlocks + localBlock + archBlock;
}
export function toggleRepo(id) { collapsedRepos.has(id) ? collapsedRepos.delete(id) : collapsedRepos.add(id); renderList(); }
export function toggleArchived() { archivedOpen = !archivedOpen; renderList(); }
export function toggleHostMenu(id) { menuHostId = (menuHostId === id) ? null : id; renderList(); }
export function openHostModal() { $("host-modal").style.display = "flex"; setTimeout(() => $("h-name").focus(), 30); }
export function closeHostModal() { $("host-modal").style.display = "none"; }
export async function addHost() {
  const body = {
    name: $("h-name").value.trim(), target: $("h-target").value.trim(),
    kind: Selects["h-kind"].value, session: $("h-session").value.trim() || "main",
  };
  if (!body.name || !body.target) return toast(t("host.required"), "error");
  await api("/api/hosts", { method: "POST", headers: {"content-type":"application/json"}, body: JSON.stringify(body) });
  $("h-name").value = ""; $("h-target").value = ""; $("h-session").value = "";
  closeHostModal();
  toast(t("host.added"), "success");
  loadHosts();
}
export async function delHost(id){ if(!await confirmDialog(t("host.delConfirm"),{title:t("host.del"),okText:t("common.delete"),danger:true}))return; await api(`/api/hosts/${id}`,{method:"DELETE"}); loadHosts(); }

export function connectHost(id) {
  const h = state.hostsById[id];
  if (!h) return;
  state.selectedTaskId = null; menuHostId = null;
  renderList(); paintSelection();   // close the ⚙ menu + drop any task highlight
  openPty(`host=${id}`, `🖥 ${h.name}`, `· ${h.target} · ${h.session}`,
    (h.kind === "mosh" ? "mosh " : "ssh -t ") + h.target);
}
