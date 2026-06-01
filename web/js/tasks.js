// Tasks: the dispatch-task modal, the live/archived card lists, task lifecycle
// (archive / remove-worktree / delete), and connect() which attaches the dock
// to a task's tmux session. paintSelection() reflects the currently-open card
// and is shared with hosts.js (a remote shell clears the task selection).
import { $, api } from "./dom.js";
import { toast, showLoading, hideLoading } from "./feedback.js";
import { confirmDialog } from "./dialog.js";
import { Selects } from "./select.js";
import { state } from "./state.js";
import { openPty } from "./terminal.js";

let taskRepoId = null, branchReq = null, tasksById = {};

// reflect the current selection onto the cards already in the DOM (no refetch)
export function paintSelection() {
  document.querySelectorAll("#tasks .task, #archived .task").forEach(el => {
    el.classList.toggle("selected", Number(el.dataset.id) === state.selectedTaskId);
  });
}

export function connect(id) {
  const t = tasksById[id];
  if (!t) return;
  state.selectedTaskId = id; paintSelection();
  openPty(`session=${encodeURIComponent(t.session)}`,
    `#${t.id} ${t.title}`, t.prompt ? `· ${t.prompt}` : "", "tmux attach -t " + t.session);
}

export function openTaskModal(repoId) {
  const repo = state.repos.find(r => r.id === repoId && r.status === "ready");
  if (!repo) return toast(t("toast.repoNotReady"), "error");
  taskRepoId = repoId;
  $("tm-repo").textContent = repo.name;
  $("t-title").value = ""; $("t-prompt").value = "";   // fresh form each open
  $("task-modal").style.display = "flex";
  loadBranches();
  loadDispatchOptions();
  setTimeout(() => $("t-title").focus(), 30);
}
export function closeTaskModal() { $("task-modal").style.display = "none"; }

// preset dropdown + extra-skill checkboxes for the dispatch modal. Both reset
// each open; dispatch works fine even if these fail to load (no preset).
async function loadDispatchOptions() {
  const none = { value: "", label: t("task.presetNone") };
  Selects["t-preset"].setOptions([none], "");
  $("t-skills").innerHTML = "";
  try {
    const [presets, skills] = await Promise.all([api("/api/presets"), api("/api/skills")]);
    Selects["t-preset"].setOptions([none, ...presets.map(p => ({ value: String(p.id), label: p.name }))], "");
    $("t-skills").innerHTML = skills.length
      ? skills.map(s => `<label class="skopt"><input type="checkbox" value="${s.key}"> ${s.name} <span class="sksrc">${s.source}</span></label>`).join("")
      : `<div class="muted">${t("skill.none")}</div>`;
  } catch (e) { /* leave defaults — a task can still be dispatched without a preset */ }
}
function selectedExtraSkills() {
  return [...document.querySelectorAll("#t-skills input:checked")].map(i => i.value);
}

async function loadBranches() {
  const id = taskRepoId;
  if (!id) { Selects["t-base"].setOptions([]); return; }
  branchReq?.abort();                         // drop any in-flight request from a previous switch
  const ctl = branchReq = new AbortController();
  Selects["t-base"].setLoading(t("task.loadingBranches"));
  try {
    const branches = await api(`/api/repos/${id}/branches`, { signal: ctl.signal });
    const repo = state.repos.find(r=>r.id==id);
    Selects["t-base"].setOptions(branches.map(b => ({ value: b, label: b })), repo?.default_branch);
  } catch(e){
    if (e.name === "AbortError") return;       // superseded by a newer switch — leave the latest in charge
    Selects["t-base"].setOptions([{ value: "", label: e.message }]);
  }
}

export async function addTask() {
  const body = {
    repo_id: Number(taskRepoId), base_branch: Selects["t-base"].value,
    title: $("t-title").value.trim(), prompt: $("t-prompt").value,
    preset_id: Selects["t-preset"].value ? Number(Selects["t-preset"].value) : null,
    extra_skills: selectedExtraSkills(),
  };
  if (!body.repo_id || !body.base_branch || !body.title) return toast(t("toast.taskFieldsRequired"), "error");
  showLoading(t("loading.creatingWorktree"));
  try {
    const r = await api("/api/tasks", { method:"POST", headers:{"content-type":"application/json"}, body: JSON.stringify(body) });
    $("t-title").value = ""; $("t-prompt").value = "";
    closeTaskModal();
    showTab("live");
    toast(t("toast.taskDispatched", { session: r.session }), "success");
    await loadTasks();
    connect(r.id);
  } catch (e) {
    toast(t("toast.dispatchFailed", { error: e.message }), "error", 6000);
  } finally {
    hideLoading();
  }
}

function taskCard(t) {
  const active = t.status !== "cleaned";
  // one corner action per state — stop (active) / cleanup (cleaned)
  // NOTE: the param is `t` (the task), so it shadows the global t() — use I18N.t here.
  let icon, note = "";
  if (active) {
    icon = { glyph: "⏹", title: I18N.t("task.stopTitle"), fn: `archive(${t.id})` };
  } else if (t.hasWorktree) {
    icon = { glyph: "🗑", title: I18N.t("task.removeWorktree"), fn: `removeWt(${t.id})` };
    note = `<div class="muted">${I18N.t("task.worktreeKept")}</div>`;
  } else {
    icon = { glyph: "🗑", title: I18N.t("task.deleteRecord"), fn: `deleteTask(${t.id})` };
  }
  const head = `<div class="t">${t.alive ? `<span class="sdot live" title="live"></span>` : `<span class="sdot ${t.status}" title="${t.status}"></span>`}#${t.id} ${t.title}</div>
    <div class="muted">${t.base_branch} → <code>${t.work_branch}</code></div>
    ${t.mr_url ? `<div><a href="${t.mr_url}" target="_blank" onclick="event.stopPropagation()">MR ↗</a></div>` : ""}`;
  const open = active ? ` clickable" onclick="connect(${t.id})` : "";
  const sel = t.id === state.selectedTaskId ? " selected" : "";
  return `<div class="card task${sel}${open}" data-id="${t.id}">
    <button class="card-x" title="${icon.title}" onclick="event.stopPropagation();${icon.fn}">${icon.glyph}</button>
    ${head}${note}
  </div>`;
}

export async function loadTasks() {
  const tasks = await api("/api/tasks").catch(() => null);
  if (!tasks) return;
  tasksById = Object.fromEntries(tasks.map(t => [t.id, t]));
  const live = tasks.filter(t => t.status !== "cleaned");
  const archived = tasks.filter(t => t.status === "cleaned");
  $("tasks").innerHTML = live.map(taskCard).join("") ||
    emptyState("🗂️", t("empty.liveTitle"), t("empty.liveHint"));
  $("archived").innerHTML = archived.map(taskCard).join("") ||
    emptyState("📦", t("empty.archTitle"), t("empty.archHint"));
  $("arch-count").textContent = archived.length ? `(${archived.length})` : "";
}
function emptyState(icon, title, hint) {
  return `<div class="empty"><div class="empty-ic">${icon}</div><div>${title}</div>${hint ? `<div class="empty-hint">${hint}</div>` : ""}</div>`;
}
export async function archive(id){
  if(!await confirmDialog(t("task.killConfirm"),{title:t("task.killTitle"),okText:t("dialog.ok"),danger:true}))return;
  await api(`/api/tasks/${id}/archive`,{method:"POST"});
  if (id === state.selectedTaskId) state.selectedTaskId = null;
  toast(t("toast.killed"),"success"); loadTasks();
}
export async function removeWt(id){
  if(!await confirmDialog(t("task.removeWtConfirm"),{title:t("task.removeWorktree"),okText:t("common.delete"),danger:true}))return;
  await api(`/api/tasks/${id}/cleanup`,{method:"POST"});
  toast(t("toast.worktreeRemoved"),"success"); loadTasks();
}
export function deleteTask(id){ if (id === state.selectedTaskId) state.selectedTaskId = null; api(`/api/tasks/${id}`,{method:"DELETE"}).then(loadTasks).catch(e=>toast(e.message,"error")); }
export function showTab(tab){
  document.querySelectorAll(".tab").forEach(b => b.classList.toggle("active", b.dataset.tab === tab));
  $("tasks").hidden = tab !== "live";
  $("archived").hidden = tab !== "arch";
}
