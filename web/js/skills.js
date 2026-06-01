// Skills management: install Claude Code skills from the official plugin
// marketplace. Browse available plugins, pick a target (global ~/.claude or
// dispatcher-local), install. Installed plugins' skills then show up in the
// dispatch/preset skill lists (server scans both locations).
import { $, api } from "./dom.js";
import { toast, showLoading, hideLoading } from "./feedback.js";
import { Selects } from "./select.js";

let available = [];   // [{pluginId,name,description,marketplace,installed}]

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

export function openSkillsModal() {
  $("skills-modal").style.display = "flex";
  $("sk-filter").value = "";
  loadAvailablePlugins();
}
export function closeSkillsModal() { $("skills-modal").style.display = "none"; }

async function loadAvailablePlugins() {
  $("sk-list").innerHTML = `<div class="muted" style="padding:8px 2px">${t("skill.loading")}</div>`;
  try {
    available = await api("/api/plugins/available");
    renderList("");
  } catch (e) {
    $("sk-list").innerHTML = `<div class="muted" style="padding:8px 2px">${t("skill.loadFailed")}</div>`;
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
    : `<div class="muted" style="padding:8px 2px">${t("skill.availableEmpty")}</div>`;
}
export function filterSkillList(v) { renderList(v); }

export async function installPluginUI(i) {
  const p = available[i];
  if (!p) return;
  const target = Selects["sk-target"].value || "global";
  showLoading(t("skill.installing"));
  try {
    await api("/api/plugins/install", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ pluginId: p.pluginId, target }),
    });
    toast(t("skill.installedToast", { name: p.name }), "success");
  } catch (e) {
    toast(e.message, "error", 6000);
  } finally {
    hideLoading();
  }
}
