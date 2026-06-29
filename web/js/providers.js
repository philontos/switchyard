// Providers: alternate model backends for claude (e.g. GLM via its
// Anthropic-compatible endpoint). All UI lives inside the dispatch modal — a
// per-task picker for the backend, plus an inline panel to add/remove backends.
// Adding one is GATED on a green format+reachability check: the server probes
// the endpoint exactly the way claude will call it at runtime, so green ==
// claude can reach the model. The picker remembers the last pick (localStorage),
// so once you choose a backend, later dispatches default to it until you switch.
import { $, api } from "./dom.js";
import { toast } from "./feedback.js";
import { Selects } from "./select.js";

const LS_KEY = "tdsp.providerId";   // remember the last-picked backend across opens
let providers = [];                  // cached list (id-DESC, from the server)
let validated = false;               // green light: the current panel inputs passed the check

// ---- the per-task picker (custom select mounted on #t-provider) ----

// "Anthropic 默认" (value 0 == default login) + every configured provider,
// defaulting to the last-picked one if it still exists.
function paintSelect() {
  const sel = Selects["t-provider"];
  if (!sel) return;
  const opts = [{ value: 0, label: t("provider.default") }, ...providers.map((p) => ({ value: p.id, label: p.name }))];
  const saved = Number(localStorage.getItem(LS_KEY) || 0);
  const want = opts.some((o) => o.value === saved) ? saved : 0;
  sel.setOptions(opts, want);
}

// the chosen backend id for the new task (null == default claude login)
export function selectedProviderId() {
  const v = Number(Selects["t-provider"]?.value || 0);
  return v > 0 ? v : null;
}

// onChange for the picker: remember the pick so the next dispatch defaults to it
export function onProviderChange(v) {
  localStorage.setItem(LS_KEY, String(Number(v) || 0));
}

// repaint from the cached list (no refetch) — used on a language switch so the
// "Anthropic 默认" label re-localizes.
export function repaintProviders() {
  paintSelect();
  renderList();
}

// ---- the inline add/remove panel ----

export function toggleProviderPanel() {
  const el = $("prov-panel");
  const show = el.style.display === "none";
  el.style.display = show ? "block" : "none";
  if (show) { resetPanel(); setTimeout(() => $("pv-name").focus(), 30); }
}

function resetPanel() {
  for (const id of ["pv-name", "pv-url", "pv-token", "pv-model", "pv-fast"]) $(id).value = "";
  setValidated(false);
  setStatus("", "");
}

// green/red light. Save unlocks only on a green check AND a non-empty name;
// editing any connection field drops back to red (a saved config must be the
// exact one that passed the probe).
function setValidated(ok) { validated = ok; syncSave(); }
function syncSave() { $("pv-add").disabled = !(validated && $("pv-name").value.trim()); }
function setStatus(text, cls) {
  const el = $("pv-status");
  el.textContent = text;
  el.className = "pv-status " + (cls || "");
}

// editing a connection field invalidates the prior green check; the name doesn't
// affect reachability, so it only re-evaluates the save gate.
export function onPanelInput(field) {
  if (field !== "name") setValidated(false);
  syncSave();
}

function panelBody() {
  return {
    name: $("pv-name").value.trim(),
    base_url: $("pv-url").value.trim(),
    auth_token: $("pv-token").value.trim(),
    model: $("pv-model").value.trim(),
    small_fast_model: $("pv-fast").value.trim(),
  };
}

// format + reachability probe (no save). Green unlocks the save button.
export async function testProvider() {
  setStatus(t("provider.testing"), "testing");
  $("pv-test").disabled = true;
  try {
    await api("/api/providers/test", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(panelBody()) });
    setStatus(t("provider.reachable"), "ok");
    setValidated(true);
  } catch (e) {
    setStatus(e.message, "bad");
    setValidated(false);
  } finally {
    $("pv-test").disabled = false;
  }
}

export async function addProvider() {
  if (!validated) return;   // the button is disabled, but keep the invariant explicit
  try {
    await api("/api/providers", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(panelBody()) });
    await refreshProviders();
    const newest = providers[0];   // id-DESC → the one we just added
    if (newest) { Selects["t-provider"].set(newest.id); onProviderChange(newest.id); }
    resetPanel();
    $("prov-panel").style.display = "none";
    toast(t("provider.added"), "success");
  } catch (e) {
    toast(e.message, "error");
  }
}

export async function delProvider(id) {
  try {
    await api(`/api/providers/${id}`, { method: "DELETE" });
    await refreshProviders();
  } catch (e) { toast(e.message, "error"); }
}

// fetch + repaint both the picker and the manage list
export async function refreshProviders() {
  providers = await api("/api/providers").catch(() => []);
  paintSelect();
  renderList();
}

function renderList() {
  const box = $("pv-list");
  if (!box) return;
  box.innerHTML = providers.length
    ? providers.map((p) => `<div class="pv-row">
        <span class="pv-nm">${p.name}</span><span class="pv-mdl">${p.model || ""}</span>
        <button class="pv-del" title="${t("common.delete")}" onclick="delProvider(${p.id})">🗑</button>
      </div>`).join("")
    : `<div class="muted">${t("provider.none")}</div>`;
}
