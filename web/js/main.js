// App entry point (loaded as <script type="module"> after the i18n + vendored
// xterm globals are in place). Responsibilities:
//   1. bridge module functions onto window so the inline onclick="…" handlers
//      in index.html's markup and the card templates keep working unchanged;
//   2. wire language-switch re-rendering;
//   3. run the boot sequence (init terminal + selects, first data load);
//   4. register global listeners (modal backdrop / Esc) and pollers.
import { $ } from "./dom.js";
import { toast } from "./feedback.js";
import { closeDialog } from "./dialog.js";
import { Selects, csMount } from "./select.js";
import { initTerm, renderDockToggle, toggleDock } from "./terminal.js";
import { state } from "./state.js";
import { loadRepos, openRepoModal, closeRepoModal, addRepo, delRepo } from "./repos.js";
import { loadHosts, selectHost, openHostModal, closeHostModal, addHost, delHost, connectHost } from "./hosts.js";
import { loadTasks, addTask, archive, removeWt, deleteTask, showTab, connect, openTaskModal, closeTaskModal } from "./tasks.js";
import { openPresetModal, closePresetModal, addPreset, delPreset } from "./presets.js";

// ---- inline-onclick bridge ----
// Every function referenced by an onclick="…" attribute (static markup in
// index.html + the strings built in repoCard/taskCard/renderMachines) must be
// global, since ES module scope is not. This is the single, auditable place
// that exposes them. (I18N is already global, set by i18n.js.)
Object.assign(window, {
  // tasks
  showTab, addTask, openTaskModal, closeTaskModal, connect, archive, removeWt, deleteTask,
  // repos
  delRepo, openRepoModal, closeRepoModal, addRepo,
  // hosts
  selectHost, openHostModal, closeHostModal, addHost, delHost, connectHost,
  // terminal
  toggleDock,
  // presets
  openPresetModal, closePresetModal, addPreset, delPreset,
});

// global safety net: surface uncaught API errors as toasts
window.addEventListener("unhandledrejection", (e) => {
  toast(String(e.reason?.message || e.reason || t("toast.opFailed")), "error");
});

// ---- i18n wiring ----
function renderSwitcher() { $("lang-toggle").textContent = I18N.lang === "zh" ? "EN" : "中"; }
// re-render everything not covered by data-i18n attributes when the language flips
I18N.onChange = () => {
  renderSwitcher();
  renderDockToggle();
  const sel = Selects["t-base"];
  if (sel) { sel.ph = t("task.branchPh"); sel.repaint && sel.repaint(); }
  loadRepos();
  loadHosts();
  loadTasks();
};

I18N.init();         // resolve locale from localStorage / browser before first t()
I18N.applyStatic();  // fill all data-i18n / data-i18n-ph markup
renderSwitcher();

function dismissBoot() { const b = $("boot"); if (b) b.classList.add("done"); }
try { initTerm(); } catch (e) { console.error("terminal init failed:", e); }
renderDockToggle();
$("t-base").dataset.ph = t("task.branchPh");   // localized placeholder for the branch select
csMount("t-base");
csMount("t-preset").setOptions([{ value: "", label: t("task.presetNone") }], "");   // populated per open
csMount("h-kind").setOptions([{ value: "ssh", label: "ssh" }, { value: "mosh", label: "mosh" }]);
// reveal the UI once the first data render lands — a smooth fade, not an abrupt pop-in
Promise.allSettled([loadRepos(), loadHosts(), loadTasks()]).then(dismissBoot);
setTimeout(dismissBoot, 2500);   // failsafe so a slow/hung fetch never traps the spinner
setInterval(loadTasks, 4000);
setInterval(loadHosts, 5000);   // refresh machine liveness dots
// close modals on backdrop click / Esc
$("repo-modal").addEventListener("click", e => { if (e.target.id === "repo-modal") closeRepoModal(); });
$("task-modal").addEventListener("click", e => { if (e.target.id === "task-modal") closeTaskModal(); });
$("host-modal").addEventListener("click", e => { if (e.target.id === "host-modal") closeHostModal(); });
$("preset-modal").addEventListener("click", e => { if (e.target.id === "preset-modal") closePresetModal(); });
document.addEventListener("keydown", e => {
  if (e.key !== "Escape") return;
  if (document.querySelector(".cs.open")) { Object.values(Selects).forEach(s => s.close()); return; }
  if ($("dialog").style.display === "flex") closeDialog(null);
  else { closeRepoModal(); closeTaskModal(); closeHostModal(); closePresetModal(); }
});
// poll repos so cloning -> ready (and clone errors) show up without manual refresh
setInterval(() => { if (state.repos.some(r => r.status === "cloning")) loadRepos(); }, 2000);
