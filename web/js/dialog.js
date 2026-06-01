// Promise-based confirm / prompt dialog backed by the #dialog modal in
// index.html. confirmDialog()/promptDialog() resolve when the user picks an
// action; the module wires the OK/Cancel buttons and backdrop/Enter handling
// once at load time.
import { $ } from "./dom.js";

let dlgResolve = null;
function openDialog({ title = "", message = "", input = false, value = "", okText, danger = false }) {
  okText = okText || t("dialog.ok");
  return new Promise((resolve) => {
    dlgResolve = resolve;
    $("dlg-title").textContent = title;
    $("dlg-title").style.display = title ? "" : "none";
    $("dlg-msg").textContent = message;
    const inp = $("dlg-input");
    inp.style.display = input ? "" : "none";
    if (input) { inp.value = value; setTimeout(() => { inp.focus(); inp.select(); }, 30); }
    const ok = $("dlg-ok");
    ok.textContent = okText;
    ok.className = danger ? "danger" : "";
    $("dialog").style.display = "flex";
  });
}
export function closeDialog(result) {
  $("dialog").style.display = "none";
  const r = dlgResolve; dlgResolve = null;
  if (r) r(result);
}
export function confirmDialog(message, opts = {}) { return openDialog({ message, ...opts }).then(Boolean); }
export function promptDialog(message, value = "", opts = {}) {
  return openDialog({ message, input: true, value, ...opts });
}
$("dlg-ok").onclick = () => closeDialog($("dlg-input").style.display === "none" ? true : $("dlg-input").value);
$("dlg-cancel").onclick = () => closeDialog(null);
$("dialog").addEventListener("click", (e) => { if (e.target.id === "dialog") closeDialog(null); });
$("dlg-input").addEventListener("keydown", (e) => { if (e.key === "Enter") $("dlg-ok").click(); });
