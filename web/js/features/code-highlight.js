// Lazy browser adapter around the pinned, self-hosted Highlight.js bundle.
// The code viewer always paints plaintext first; every failure here therefore
// degrades silently to the already-safe textContent rendering.

const ASSET_ROOT = "/vendor/highlight";
const EXTRA_LANGUAGES = new Set([
  "dockerfile", "cmake", "groovy", "dart", "elixir", "erlang", "haskell",
  "scala", "clojure", "powershell", "protobuf", "nginx", "llvm", "x86asm",
]);

let basePromise = null;
const languagePromises = new Map();

function appendScript(src) {
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = src;
    script.async = true;
    script.dataset.codeHighlightAsset = src;
    script.onload = () => resolve();
    script.onerror = () => {
      script.remove();
      reject(new Error(`Unable to load ${src}`));
    };
    document.head.append(script);
  });
}

async function loadBase() {
  if (globalThis.hljs?.highlight) return globalThis.hljs;
  if (!basePromise) {
    basePromise = appendScript(`${ASSET_ROOT}/highlight.min.js`)
      .then(() => {
        const highlighter = globalThis.hljs?.highlight ? globalThis.hljs : null;
        if (!highlighter) basePromise = null;
        return highlighter;
      })
      .catch(() => {
        basePromise = null;
        return null;
      });
  }
  return basePromise;
}

async function loadLanguage(highlighter, language) {
  if (highlighter.getLanguage(language)) return true;
  if (!EXTRA_LANGUAGES.has(language)) return false;
  if (!languagePromises.has(language)) {
    const pending = appendScript(`${ASSET_ROOT}/languages/${language}.min.js`)
      .then(() => {
        const loaded = !!highlighter.getLanguage(language);
        if (!loaded) languagePromises.delete(language);
        return loaded;
      })
      .catch(() => {
        languagePromises.delete(language);
        return false;
      });
    languagePromises.set(language, pending);
  }
  return languagePromises.get(language);
}

export async function highlightCodeToHtml(code, language) {
  try {
    const highlighter = await loadBase();
    if (!highlighter || !await loadLanguage(highlighter, language)) return null;
    return highlighter.highlight(String(code), { language, ignoreIllegals: true }).value;
  } catch {
    return null;
  }
}
