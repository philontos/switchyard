// Theme toggle — light vs dark. Mirrors i18n.js: a plain <script> (no build
// step) loaded before the app modules, exposing a global `Theme`. The actual
// colors live in css/app.css as tokens under :root and :root[data-theme="light"];
// this module just flips document.documentElement's `data-theme` and remembers
// the choice in localStorage.
//
// NO-FLASH: index.html sets `data-theme` from localStorage in an inline <head>
// script before the stylesheet applies, so the first paint is already correct.
// init() below re-derives the same value (idempotent) and is the canonical place
// the default ("dark") is defined.
//
// The terminal's colors are NOT CSS — xterm paints to a canvas from a JS theme
// object — so terminal.js can't read these tokens. The app wires Theme.onChange
// (see main.js) to re-skin open terminals on switch, paralleling I18N.onChange.

(function () {
  const KEY = "theme";
  const DEFAULT = "dark";
  // browser-chrome color per theme = each theme's --bg (see app.css tokens). Duplicated
  // here because <meta theme-color> takes a literal, not a CSS var — keep in sync.
  const CHROME = { dark: "#1a1613", light: "#f5f0e8" };

  function current() {
    return document.documentElement.dataset.theme === "light" ? "light" : "dark";
  }

  // Mirror the theme onto <meta name="theme-color"> so iOS paints its edge strips /
  // swipe-transition gutters and the address bar in the app background, not white.
  function applyChrome() {
    const m = document.querySelector('meta[name="theme-color"]');
    if (m) m.content = CHROME[current()];
  }

  function set(next) {
    if (next !== "light" && next !== "dark") return;
    if (next === current()) return;
    document.documentElement.dataset.theme = next;
    applyChrome();
    try { localStorage.setItem(KEY, next); } catch (_) {}
    if (typeof Theme.onChange === "function") Theme.onChange(next);
  }

  function toggle() { set(current() === "light" ? "dark" : "light"); }

  // Resolve the initial theme from storage before the app renders. The default
  // is dark, so existing users see no change until they opt in.
  function init() {
    let saved = null;
    try { saved = localStorage.getItem(KEY); } catch (_) {}
    document.documentElement.dataset.theme = saved === "light" ? "light" : DEFAULT;
    applyChrome();
  }

  const Theme = {
    set,
    toggle,
    init,
    onChange: null, // app sets this to re-skin terminals on switch
    get theme() { return current(); },
  };
  window.Theme = Theme;
})();
