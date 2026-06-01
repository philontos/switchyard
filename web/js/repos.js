// Repos: loading the list, rendering a repo card, the register-repo modal, and
// delete. loadRepos() re-renders the machine sidebar (repos live grouped under
// their host), so this module imports renderMachines from hosts.js — and
// hosts.js imports repoCard from here. That import cycle is fine: both are
// hoisted functions only called at runtime, never during module evaluation.
import { $, api } from "./dom.js";
import { toast } from "./feedback.js";
import { confirmDialog } from "./dialog.js";
import { state } from "./state.js";
import { renderMachines } from "./hosts.js";

let repoHostId = null;   // which machine the register-repo modal targets

export async function loadRepos() {
  const r = await api("/api/repos").catch(() => null);
  if (!r) return; // server transiently down — stay quiet, poller will retry
  state.repos = r;
  renderMachines();
}
export function repoCard(r) {
  return `
    <div class="card repo">
      <button class="repo-del" title="${t("repo.delTitle")}" onclick="delRepo(${r.id})">✕</button>
      <div class="t"><span class="sdot ${r.status}" title="${r.status}"></span>${r.name}</div>
      <div class="muted url">${r.git_url}</div>
      ${r.error ? `<div class="muted err">${r.error}</div>` : ""}
      ${r.status === "ready" ? `<button class="disp" onclick="openTaskModal(${r.id})">${t("task.dispatch")}</button>` : ""}
    </div>`;
}
export async function delRepo(id){ if(!await confirmDialog(t("repo.delConfirm"),{title:t("repo.delTitle"),okText:t("common.delete"),danger:true}))return; await api(`/api/repos/${id}`,{method:"DELETE"}); loadRepos(); }

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
