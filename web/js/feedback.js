// Transient, app-wide user feedback: toast notifications + the global loading
// overlay. No state beyond the DOM nodes already present in index.html.
import { $ } from "./dom.js";

// ---- toast ----
export function toast(msg, type = "info", ms = 3500) {
  const el = document.createElement("div");
  el.className = "toast " + type;
  el.textContent = msg;
  $("toasts").appendChild(el);
  const close = () => { el.classList.add("out"); setTimeout(() => el.remove(), 250); };
  el.addEventListener("click", close);
  setTimeout(close, ms);
}

// ---- global loading overlay ----
export function showLoading(text) { $("loading-text").textContent = text || t("loading.default"); $("loading").classList.add("on"); }
export function hideLoading() { $("loading").classList.remove("on"); }
