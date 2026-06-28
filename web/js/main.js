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
import { initTerm, showTermEmpty, applyTermTheme } from "./terminal.js";
import { state } from "./state.js";
import { loadRepos, openRepoModal, closeRepoModal, addRepo, delRepo } from "./repos.js";
import { loadHosts, selectHost, openHostModal, closeHostModal, addHost, delHost, toggleRepo, toggleArchived, toggleHostMenu, initHostMenuDismiss } from "./hosts.js";
import { loadTasks, addTask, archive, removeWt, deleteTask, resume, connect, openTaskModal, closeTaskModal, addLocalTask, renameTask, focusPending } from "./tasks.js";
import { openSkillsModal, closeSkillsModal, installPluginUI, filterSkillList } from "./skills.js";
import { initReorder } from "./reorder.js";
import { refreshProviders, repaintProviders, onProviderChange, toggleProviderPanel, onPanelInput, testProvider, addProvider, delProvider } from "./providers.js";

// ---- inline-onclick bridge ----
// Every function referenced by an onclick="…" attribute (static markup in
// index.html + the strings built in repoGroupHead/taskCard/renderList) must be
// global, since ES module scope is not. This is the single, auditable place
// that exposes them. (I18N is already global, set by i18n.js.)
Object.assign(window, {
  // tasks
  addTask, openTaskModal, closeTaskModal, connect, archive, removeWt, deleteTask, resume,
  addLocalTask, renameTask, focusPending,
  // repos
  delRepo, openRepoModal, closeRepoModal, addRepo,
  // hosts
  selectHost, openHostModal, closeHostModal, addHost, delHost,
  toggleRepo, toggleArchived, toggleHostMenu,
  // skills (official-plugin install)
  openSkillsModal, closeSkillsModal, installPluginUI, filterSkillList,
  // providers (alternate model backends — picker + inline add/remove panel)
  toggleProviderPanel, onPanelInput, testProvider, addProvider, delProvider,
});

// global safety net: surface uncaught API errors as toasts
window.addEventListener("unhandledrejection", (e) => {
  toast(String(e.reason?.message || e.reason || t("toast.opFailed")), "error");
});

// ---- i18n wiring ----
function renderSwitcher() { $("lang-toggle").textContent = I18N.lang === "zh" ? "EN" : "中"; }
// theme toggle: icon = destination (☀️ → light, 🌙 → dark), title localized.
function renderThemeToggle() {
  const toLight = Theme.theme === "dark";
  $("theme-toggle").textContent = toLight ? "☀️" : "🌙";
  $("theme-toggle").title = t(toLight ? "theme.toLight" : "theme.toDark");
}
// re-render everything not covered by data-i18n attributes when the language flips
I18N.onChange = () => {
  renderSwitcher();
  renderThemeToggle();   // its title is localized
  const sel = Selects["t-base"];
  if (sel) { sel.ph = t("task.branchPh"); sel.repaint && sel.repaint(); }
  const pv = Selects["t-provider"];
  if (pv) { pv.ph = t("provider.default"); }
  repaintProviders();   // re-localize the "Anthropic 默认" option + manage list
  loadRepos();
  loadHosts();
  loadTasks();
};
// theme switch: relabel the button + re-skin the (canvas-painted) terminal,
// which can't pick up the CSS-token swap on its own.
Theme.onChange = () => { renderThemeToggle(); applyTermTheme(); };

I18N.init();         // resolve locale from localStorage / browser before first t()
I18N.applyStatic();  // fill all data-i18n / data-i18n-ph markup
renderSwitcher();
renderThemeToggle();

function dismissBoot() { const b = $("boot"); if (b) b.classList.add("done"); }
try { initTerm(); } catch (e) { console.error("terminal init failed:", e); }
showTermEmpty();
initHostMenuDismiss();   // close the machine ⚙ menu on any outside click
initReorder();           // long-press drag-to-reorder of repo task cards (session-only)
$("t-base").dataset.ph = t("task.branchPh");   // localized placeholder for the branch select
csMount("t-base");
csMount("h-kind").setOptions([{ value: "ssh", label: "ssh" }, { value: "mosh", label: "mosh" }]);
$("t-provider").dataset.ph = t("provider.default");   // model-backend picker
csMount("t-provider", onProviderChange);
// reveal the UI once the first data render lands — a smooth fade, not an abrupt pop-in
Promise.allSettled([loadRepos(), loadHosts(), loadTasks(), refreshProviders()]).then(dismissBoot);
setTimeout(dismissBoot, 2500);   // failsafe so a slow/hung fetch never traps the spinner
setInterval(loadTasks, 4000);
setInterval(loadHosts, 5000);   // refresh machine liveness dots
// close modals on backdrop click / Esc
$("repo-modal").addEventListener("click", e => { if (e.target.id === "repo-modal") closeRepoModal(); });
$("task-modal").addEventListener("click", e => { if (e.target.id === "task-modal") closeTaskModal(); });
$("host-modal").addEventListener("click", e => { if (e.target.id === "host-modal") closeHostModal(); });
$("skills-modal").addEventListener("click", e => { if (e.target.id === "skills-modal") closeSkillsModal(); });
document.addEventListener("keydown", e => {
  if (e.key !== "Escape") return;
  if (document.querySelector(".cs.open")) { Object.values(Selects).forEach(s => s.close()); return; }
  if ($("dialog").style.display === "flex") closeDialog(null);
  else { closeRepoModal(); closeTaskModal(); closeHostModal(); closeSkillsModal(); }
});
// poll repos so cloning -> ready (and clone errors) show up without manual refresh
setInterval(() => { if (state.repos.some(r => r.status === "cloning")) loadRepos(); }, 2000);
