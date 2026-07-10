// xterm 5.5 ships a Unicode 6 width table. Current TUIs use much newer tables,
// and a one-cell disagreement is most visible at the right edge of Codex. Keep
// the activation isolated and testable; Claude/plain shells retain xterm's
// existing behavior.
export const CODEX_UNICODE_VERSION = "11";

export function activateCodexUnicode(term, agent, addon = globalThis.Unicode11Addon) {
  if (agent !== "codex" || typeof addon?.Unicode11Addon !== "function") return false;
  term.loadAddon(new addon.Unicode11Addon());
  term.unicode.activeVersion = CODEX_UNICODE_VERSION;
  return true;
}
