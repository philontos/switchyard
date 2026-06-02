// Repos: loading the list, rendering a repo card, the register-repo modal, and
// delete. loadRepos() re-renders the machine sidebar (repos live grouped under
// their host), so this module imports renderMachines from hosts.js — and
// hosts.js imports repoCard from here. That import cycle is fine: both are
// hoisted functions only called at runtime, never during module evaluation.
import { $, api } from "./dom.js";
import { toast } from "./feedback.js";
import { confirmDialog } from "./dialog.js";
import { state } from "./state.js";
import { rerender } from "./hosts.js";

let repoHostId = null;   // which machine the register-repo modal targets

export async function loadRepos() {
  const r = await api("/api/repos").catch(() => null);
  if (!r) return; // server transiently down — stay quiet, poller will retry
  state.repos = r;
  rerender();
}
// `online` = is this repo's machine reachable. Dispatch runs ON the machine, so
// it's disabled when offline (mirrors the "new repo" button). Delete stays
// enabled — the server refuses it when offline (host.offline toast), so it never
// dead-ends a machine you must bring online first to clean up.
export function repoCard(r, online = true) {
  return `
    <div class="card repo">
      <button class="repo-del" title="${t("repo.delTitle")}" onclick="delRepo(${r.id})">✕</button>
      <div class="t"><span class="sdot ${r.status}" title="${r.status}"></span>${r.name}</div>
      <div class="muted url">${r.git_url}</div>
      ${r.error ? `<div class="muted err">${r.error}</div>` : ""}
      ${r.status === "ready" ? `<button class="disp" ${online ? "" : "disabled"} onclick="openTaskModal(${r.id})">${t("task.dispatch")}</button>` : ""}
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
