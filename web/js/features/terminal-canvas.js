// The classic script exposes @xterm/addon-canvas as globalThis.CanvasAddon.
// Keep activation isolated so a missing script or unsupported canvas context can
// fall back to xterm's DOM renderer without preventing terminal creation.
export function activateCanvasRenderer(term, addon = globalThis.CanvasAddon) {
  if (typeof addon?.CanvasAddon !== "function") return false;
  try {
    term.loadAddon(new addon.CanvasAddon());
    return true;
  } catch {
    return false;
  }
}
