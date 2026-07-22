// Skills management: install Claude Code skills from the official plugin
// marketplace into the dispatcher's private library. Browse available plugins,
// install. Installed plugins' skills then show up in the dispatch skill list
// (server scans ~/.task-dispatcher, never the user's ~/.claude).
import { $, api } from "../core/dom.js";
import { toast, showLoading, hideLoading } from "../core/feedback.js";
import { state } from "../core/state.js";

let available = [];   // [{pluginId,name,description,marketplace,installed}]
let targetHostId = null;
let loadVersion = 0;

function endpoint(path) {
  const host = state.hostsById[targetHostId];
  return host && host.kind !== "local" ? `/api/nodes/${host.id}/plugins${path}` : `/api/plugins${path}`;
}

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

export function openSkillsModal() {
  targetHostId = state.activeHostId;
  $("skills-modal").style.display = "flex";
  $("sk-filter").value = "";
  loadAvailablePlugins();
}
export function closeSkillsModal() { loadVersion++; $("skills-modal").style.display = "none"; }

async function loadAvailablePlugins() {
  const version = ++loadVersion;
  $("sk-list").innerHTML = `<div class="pg-state"><span class="pg-spin"></span>${t("skill.loading")}</div>`;
  try {
    const next = await api(endpoint("/available"));
    if (version !== loadVersion) return;
    available = next;
    renderList("");
  } catch (e) {
    if (version !== loadVersion) return;
    $("sk-list").innerHTML = `<div class="pg-state">${t("skill.loadFailed")}</div>`;
  }
}

function renderList(filter) {
  const f = (filter || "").trim().toLowerCase();
  const rows = available.filter(p =>
    !f || p.name.toLowerCase().includes(f) || (p.description || "").toLowerCase().includes(f));
  $("sk-list").innerHTML = rows.length
    ? rows.map(p => {
        const i = available.indexOf(p);
        return `<div class="pgrow">
          <div class="pgmain"><div class="pgname">${esc(p.name)}</div><div class="muted pgdesc">${esc(p.description)}</div></div>
          <button class="pginstall" onclick="installPluginUI(${i})">${t("skill.install")}</button>
        </div>`;
      }).join("")
    : `<div class="pg-state">${t("skill.availableEmpty")}</div>`;
}
export function filterSkillList(v) { renderList(v); }

export async function installPluginUI(i) {
  const p = available[i];
  if (!p) return;
  showLoading(t("skill.installing"));
  try {
    await api(endpoint("/install"), {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ pluginId: p.pluginId }),
    });
    toast(t("skill.installedToast", { name: p.name }), "success");
  } catch (e) {
    toast(e.message, "error", 6000);
  } finally {
    hideLoading();
  }
}
