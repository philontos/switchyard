// Preset management: the #preset-modal lists existing presets (with delete) and
// holds the "new preset" form — name + description + opening-prompt template +
// a checkbox list of skills to reference (source:name keys from /api/skills).
// Presets are global (not per-machine); the dispatch modal (tasks.js) reads them.
import { $, api } from "./dom.js";
import { toast } from "./feedback.js";
import { confirmDialog } from "./dialog.js";

export function openPresetModal() {
  $("preset-modal").style.display = "flex";
  $("p-name").value = ""; $("p-desc").value = ""; $("p-prompt").value = "";
  loadPresetList();
  loadPresetSkills();
  setTimeout(() => $("p-name").focus(), 30);
}
export function closePresetModal() { $("preset-modal").style.display = "none"; }

async function loadPresetList() {
  const presets = await api("/api/presets").catch(() => []);
  $("preset-list").innerHTML = presets.length
    ? presets.map(p => {
        const n = (JSON.parse(p.skill_refs || "[]") || []).length;
        return `<div class="prow"><span class="pname">${p.name}</span><span class="pmeta">${n} skills</span><button class="prow-x" title="${t("preset.delTitle")}" onclick="delPreset(${p.id})">✕</button></div>`;
      }).join("")
    : `<div class="muted" style="padding:2px 2px 8px">${t("preset.empty")}</div>`;
}

async function loadPresetSkills() {
  const skills = await api("/api/skills").catch(() => []);
  $("p-skills").innerHTML = skills.length
    ? skills.map(s => `<label class="skopt"><input type="checkbox" value="${s.key}"> ${s.name} <span class="sksrc">${s.source}</span></label>`).join("")
    : `<div class="muted">${t("skill.none")}</div>`;
}

export async function addPreset() {
  const name = $("p-name").value.trim();
  if (!name) return toast(t("preset.required"), "error");
  const skill_refs = [...document.querySelectorAll("#p-skills input:checked")].map(i => i.value);
  await api("/api/presets", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, description: $("p-desc").value.trim(), dispatch_prompt: $("p-prompt").value, skill_refs }),
  });
  toast(t("preset.added"), "success");
  $("p-name").value = ""; $("p-desc").value = ""; $("p-prompt").value = "";
  document.querySelectorAll("#p-skills input:checked").forEach(i => (i.checked = false));
  loadPresetList();
}

export async function delPreset(id) {
  if (!await confirmDialog(t("preset.delConfirm"), { title: t("preset.delTitle"), okText: t("common.delete"), danger: true })) return;
  await api(`/api/presets/${id}`, { method: "DELETE" });
  loadPresetList();
}
