// xterm keeps committed text in its hidden textarea so screen readers can read
// it. On macOS, that becomes dangerous around an IME input-source switch:
// WebKit (and some IMEs in Chromium) can deliver a keyCode=229 fallback after
// the textarea has changed, and xterm 5.x may then emit the whole accumulated
// value through onData instead of only the new character.
//
// Keep the workaround outside the vendored/minified xterm bundle. Clearing is
// deferred until xterm's own compositionend timer has consumed the committed
// text. It is disabled in screen-reader mode, where the accumulated value is an
// intentional accessibility surface.
export function mountTerminalImeGuard(term, textarea, { enabled = true } = {}) {
  const isComposingCapsLock = (event) => {
    const isCapsLock = event.code === "CapsLock"
      || event.key === "CapsLock"
      || event.keyCode === 20;
    return event.type === "keydown" && isCapsLock && event.isComposing;
  };

  if (!enabled || !textarea) {
    // Preserve the original browser-reported composition safeguard even where
    // the macOS-specific textarea cleanup is not installed.
    return { shouldIgnoreKeydown: isComposingCapsLock, dispose() {} };
  }

  let composing = false;
  let settling = false;
  let settleTimer = null;
  let clearTimer = null;
  let disposed = false;

  const cancelTimer = (timer) => {
    if (timer !== null) clearTimeout(timer);
  };

  const scheduleClear = () => {
    if (disposed || composing || settling || term.options?.screenReaderMode) return;
    cancelTimer(clearTimer);
    clearTimer = setTimeout(() => {
      clearTimer = null;
      if (!disposed && !composing && !settling && !term.options?.screenReaderMode) {
        textarea.value = "";
      }
    }, 0);
  };

  const onCompositionStart = () => {
    composing = true;
    settling = false;
    cancelTimer(settleTimer);
    settleTimer = null;
    cancelTimer(clearTimer);
    clearTimer = null;
  };

  const onCompositionEnd = () => {
    composing = false;
    settling = true;
    cancelTimer(settleTimer);
    // xterm schedules its composition commit from its compositionend listener.
    // Our listener was registered later, so this timer runs after that commit;
    // scheduleClear adds one more turn to keep that ordering explicit.
    settleTimer = setTimeout(() => {
      settleTimer = null;
      settling = false;
      scheduleClear();
    }, 0);
  };

  const onKeyUp = () => scheduleClear();

  textarea.addEventListener("compositionstart", onCompositionStart);
  textarea.addEventListener("compositionend", onCompositionEnd);
  textarea.addEventListener("keyup", onKeyUp);

  return {
    // Do not trust KeyboardEvent.isComposing alone: macOS can report false for
    // the CapsLock event that ends/switches a Pinyin composition. The DOM
    // composition lifecycle and the short post-composition settling window are
    // stable enough to prevent xterm from prematurely finalizing it twice.
    shouldIgnoreKeydown(event) {
      const isCapsLock = event.code === "CapsLock"
        || event.key === "CapsLock"
        || event.keyCode === 20;
      return isComposingCapsLock(event)
        || (event.type === "keydown" && isCapsLock && (composing || settling));
    },
    dispose() {
      disposed = true;
      cancelTimer(settleTimer);
      cancelTimer(clearTimer);
      textarea.removeEventListener("compositionstart", onCompositionStart);
      textarea.removeEventListener("compositionend", onCompositionEnd);
      textarea.removeEventListener("keyup", onKeyUp);
    },
  };
}
