// Machines (hosts): the sidebar tab switcher where each machine groups its
// repos. Loads the host list, renders the tabs + the active machine's repos
// (via repoCard from repos.js), the register-machine modal, delete, and
// connectHost() which attaches the dock to a remote shell.
import { $, api } from "./dom.js";
import { toast } from "./feedback.js";
import { confirmDialog } from "./dialog.js";
import { Selects } from "./select.js";
import { state } from "./state.js";
import { paintSelection } from "./tasks.js";
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
