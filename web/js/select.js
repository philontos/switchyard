// Minimal custom <select> component (the framework-free dropdown used for the
// base-branch and host-kind pickers). csMount(id) turns an empty .cs container
// into a select; the live instances are registered in `Selects` keyed by id so
// other modules can drive them (setOptions / setLoading / value / repaint).
import { $ } from "./dom.js";

export const Selects = {};

export function csMount(id, onChange) {
  const root = $(id);
  root.innerHTML = `<button type="button" class="cs-trigger"><span class="cs-label ph"></span><span class="cs-caret">▾</span></button><div class="cs-menu" hidden></div>`;
  const trigger = root.querySelector(".cs-trigger"),
        label = root.querySelector(".cs-label"),
        menu = root.querySelector(".cs-menu");
  // ph lives on self so a language switch can update it via repaint()
  const self = { options: [], value: null, onChange, ph: root.dataset.ph || t("cs.placeholder") };

  function paint() {
    const cur = self.options.find(o => o.value === self.value);
    label.textContent = cur ? cur.label : self.ph;
    label.classList.toggle("ph", !cur);
    menu.innerHTML = self.options.length
      ? self.options.map(o => `<div class="cs-opt ${o.value === self.value ? "sel" : ""}" data-v="${encodeURIComponent(o.value)}">${o.label}<span class="ck">✓</span></div>`).join("")
      : `<div class="cs-empty">${t("cs.empty")}</div>`;
  }
  self.repaint = paint;
  function open() { if (!self.options.length) return; root.classList.add("open"); menu.hidden = false; }
  function close() { root.classList.remove("open"); menu.hidden = true; }

  trigger.addEventListener("click", e => { e.stopPropagation(); root.classList.contains("open") ? close() : open(); });
  menu.addEventListener("click", e => {
    const el = e.target.closest(".cs-opt"); if (!el || !el.dataset.v) return;
    self.set(decodeURIComponent(el.dataset.v)); close();
    if (self.onChange) self.onChange(self.value);
  });

  self.set = v => {
    const opt = self.options.find(o => String(o.value) === String(v));
    self.value = opt ? opt.value : self.value;
    paint();
  };
  self.setOptions = (opts, selected) => {
    self.options = opts;
    const want = opts.find(o => String(o.value) === String(selected))
              || opts.find(o => o.value === self.value) || opts[0];
    self.value = want ? want.value : null;
    paint();
  };
  self.close = close;
  self.setLoading = text => {
    self.options = []; self.value = null; close();
    label.innerHTML = `<span class="cs-spin"></span>${text || t("cs.loading")}`;
    label.classList.add("ph");
  };
  paint();
  Selects[id] = self;
  return self;
}
document.addEventListener("click", () => Object.values(Selects).forEach(s => s.close()));
