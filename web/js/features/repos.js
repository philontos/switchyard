// Repos: loading the list, rendering a repo group header, the register-repo
// modal, and delete. loadRepos() re-renders via rerender() in hosts.js — and
// hosts.js imports repoGroupHead from here. That import cycle is fine: both are
// hoisted functions only called at runtime, never during module evaluation.
import { $, api } from "../core/dom.js";
import { toast } from "../core/feedback.js";
import { confirmDialog } from "../core/dialog.js";
import { state } from "../core/state.js";
import { rerender } from "./hosts.js";

let repoHostId = null;   // which machine the register-repo modal targets

export async function loadRepos() {
  const r = await api("/api/repos").catch(() => null);
  if (!r) return; // server transiently down — stay quiet, poller will retry
  state.repos = r;
  rerender();
}
// A repo is a collapsible group header in col2; its tasks are nested under it by
// renderList (hosts.js). `online` = is this repo's machine reachable — dispatch
// runs ON the machine, so its ＋ is disabled when offline. Delete stays enabled
// (the server refuses it when offline, so it never dead-ends a machine you must
// bring online first to clean up). `collapsed` selects the open/closed styling
// (renderList toggles `.open` on the wrapping `.grp`); it omits the task body
// when collapsed.
//
// Two right-edge actions: dispatch ＋ is pinned last (the right edge), so it lines
// up with the local-task ＋ in the group below; delete is a 🗑 that reveals on row
// hover, in a slot just left of ＋ — the slot is always reserved, so ＋ never
// shifts. Dispatch (＋) only exists when ready, so a cloning/erroring repo offers
// just the hover 🗑 — delete is its only available action there.
//
// Status read: `ready` shows NO dot while expanded — the nested task cards carry
// the live dots, so a repo dot here would just duplicate them. Collapsed, those
// cards are hidden, so the head takes over: a muted task count plus summary dots
// (amber if any hidden task waits on a permission prompt, green if any is live —
// the cards' own classes, so the colors read identically). `cloning` shows a
// breathing amber dot; `error` washes the head faint red + shows a "!".
export function repoGroupHead(r, online, collapsed, tasks = []) {
  const dot = r.status === "cloning" ? `<span class="sdot cloning" title="${r.status}"></span>` : "";
  const disp = r.status === "ready"
    ? `<button class="grp-act" title="${t("task.dispatch")}" ${online ? "" : "disabled"} onclick="event.stopPropagation();openTaskModal(${r.id})">＋</button>` : "";
  const summary = collapsed && tasks.length
    ? `<span class="muted">(${tasks.length})</span>`
      + (tasks.some(tk => tk.alive && tk.waiting) ? `<span class="sdot waiting" title="${t("task.waiting")}"></span>` : "")
      + (tasks.some(tk => tk.alive && !tk.waiting) ? `<span class="sdot live" title="live"></span>` : "")
    : "";
  return `<div class="grp-head${r.status === "error" ? " err" : ""}" onclick="toggleRepo(${r.id})">
    ${dot}
    <span class="grp-name">${r.name}</span>
    ${summary}
    ${r.error ? `<span class="grp-err" title="${r.error}">!</span>` : ""}
    <button class="grp-del" title="${t("repo.delTitle")}" onclick="event.stopPropagation();delRepo(${r.id})">🗑</button>
    ${disp}
  </div>`;
}
// Plain delete refuses (409) if the repo still has running tasks — then we offer
// a force delete that tears them (sessions + worktrees) down with the repo.
export async function delRepo(id) {
  if (!await confirmDialog(t("repo.delConfirm"), { title: t("repo.delTitle"), okText: t("common.delete"), danger: true })) return;
  try {
    await api(`/api/repos/${id}`, { method: "DELETE" });
  } catch (e) {
    if (!(e.status === 409 && e.body && e.body.liveCount > 0)) { toast(e.message, "error"); return; }
    if (!await confirmDialog(t("repo.forceDelConfirm", { count: e.body.liveCount }),
          { title: t("repo.delTitle"), okText: t("common.delete"), danger: true })) return;
    try { await api(`/api/repos/${id}?force=1`, { method: "DELETE" }); }
    catch (e2) { toast(e2.message, "error"); return; }
  }
  loadRepos();
}

export function openRepoModal(hostId) {
  repoHostId = hostId ?? null;   // which machine this repo registers on
  const h = state.hostsById[hostId];
  $("rm-host").textContent = h ? (h.kind === "local" ? t("host.local") : h.name) : "";
  $("repo-modal").style.display = "flex";
  setTimeout(() => $("r-name").focus(), 30);
}
export function closeRepoModal() { $("repo-modal").style.display = "none"; }

export async function addRepo() {
  const body = {
    name: $("r-name").value.trim(), git_url: $("r-url").value.trim(),
    token: $("r-token").value.trim(),
    default_branch: $("r-default").value.trim() || "main",
    host_id: repoHostId,
  };
  if (!body.name || !body.git_url) return toast(t("toast.repoFieldsRequired"), "error");
  await api("/api/repos", { method: "POST", headers: {"content-type":"application/json"}, body: JSON.stringify(body) });
  ["r-name","r-url","r-token","r-default"].forEach(i => $(i).value = "");
  closeRepoModal();
  toast(t("toast.repoRegistered"), "success");
  loadRepos();
}
