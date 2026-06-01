// Machines (hosts): the sidebar tab switcher where each machine groups its
// repos. Loads the host list, renders the tabs + the active machine's repos
// (via repoCard from repos.js), the register-machine modal, delete, and
// connectHost() which attaches the dock to a remote shell.
import { $, api } from "./dom.js";
import { toast } from "./feedback.js";
import { confirmDialog } from "./dialog.js";
import { Selects } from "./select.js";
import { state } from "./state.js";
import { repoCard } from "./repos.js";
import { paintSelection, renderTasks } from "./tasks.js";
import { openPty } from "./terminal.js";

let hostsOrder = [];   // API order: local machine first. Active machine is state.activeHostId.

// ---- machines: each machine is a sidebar group holding its repos ----
export async function loadHosts() {
  const hs = await api("/api/hosts").catch(() => null);
  if (!hs) return;
  state.hostsById = Object.fromEntries(hs.map(h => [h.id, h]));
  hostsOrder = hs.map(h => h.id);   // API order: local machine first
  renderMachines();
}
export function renderMachines() {
  if (!hostsOrder.length) return;   // hosts not loaded yet
  const hosts = hostsOrder.map(id => state.hostsById[id]).filter(Boolean);
  if (state.activeHostId == null || !state.hostsById[state.activeHostId]) {   // default to the local machine
    const first = hosts.find(h => h.kind === "local") || hosts[0];
    state.activeHostId = first ? first.id : null;
  }
  const tabs = hosts.map(h => {
    const online = h.kind === "local" || h.status === "online";
    const name = h.kind === "local" ? t("host.local") : h.name;
    return `<button class="mtab${h.id === state.activeHostId ? " active" : ""}" onclick="selectHost(${h.id})"><span class="mdot ${online ? "on" : "off"}"></span>${name}</button>`;
  }).join("");
  const add = `<button class="mtab-add" title="${t("host.new")}" onclick="openHostModal()">＋</button>`;
  $("machines").innerHTML = `<div class="mtabs">${tabs}${add}</div>${activeMachine()}`;
  paintSelection();
  renderTasks();   // task/archive lists follow the active machine — single re-render hub
}
function activeMachine() {
  const h = state.hostsById[state.activeHostId];
  if (!h) return "";
  const isLocal = h.kind === "local";
  const online = isLocal || h.status === "online";
  const mine = state.repos.filter(r => Number(r.host_id) === h.id);
  const bar = isLocal ? "" : `<div class="msub">
      <span class="mtarget">${h.target}</span>
      <button class="micon" title="${t("host.terminal")}" onclick="connectHost(${h.id})">❯_</button>
      <button class="micon" title="${t("host.del")}" onclick="delHost(${h.id})">✕</button>
    </div>`;
  return bar
    + (mine.map(r => repoCard(r, online)).join("") || `<div class="muted mempty">${t("host.noRepos")}</div>`)
    + `<button class="mreg" ${online ? "" : "disabled"} onclick="openRepoModal(${h.id})">${t("repo.new")}</button>`;
}
export function selectHost(id) { state.activeHostId = id; renderMachines(); }   // renderMachines re-renders tasks too
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
  state.selectedTaskId = null; paintSelection();
  openPty(`host=${id}`, `🖥 ${h.name}`, `· ${h.target} · ${h.session}`,
    (h.kind === "mosh" ? "mosh " : "ssh -t ") + h.target);
}
