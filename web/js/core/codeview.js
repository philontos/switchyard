// Pure helpers for the read-only code explorer. Kept DOM-free so path/tree,
// file presentation, and diff classification behavior can be regression-tested
// in Node.

export const MAX_HIGHLIGHT_BYTES = 256 * 1024;
export const MAX_HIGHLIGHT_LINES = 20000;
export const MAX_STRUCTURED_JSON_BYTES = 256 * 1024;

const FILE_NAME_LANGUAGES = new Map([
  ["dockerfile", "dockerfile"],
  ["containerfile", "dockerfile"],
  ["makefile", "makefile"],
  ["gnumakefile", "makefile"],
  ["cmakelists.txt", "cmake"],
  ["jenkinsfile", "groovy"],
  ["gemfile", "ruby"],
  ["rakefile", "ruby"],
  ["vagrantfile", "ruby"],
  ["podfile", "ruby"],
  ["readme", "markdown"],
  ["changelog", "markdown"],
  ["contributing", "markdown"],
  ["procfile", "bash"],
  ["cargo.lock", "ini"],
  ["gradlew", "bash"],
  [".bashrc", "bash"],
  [".bash_profile", "bash"],
  [".zshrc", "bash"],
  [".profile", "bash"],
  ["nginx.conf", "nginx"],
]);

const EXTENSION_LANGUAGES = new Map([
  ["js", "javascript"], ["mjs", "javascript"], ["cjs", "javascript"], ["jsx", "javascript"],
  ["ts", "typescript"], ["mts", "typescript"], ["cts", "typescript"], ["tsx", "typescript"],
  ["css", "css"], ["scss", "scss"], ["sass", "scss"], ["less", "less"],
  ["html", "xml"], ["htm", "xml"], ["xhtml", "xml"], ["xml", "xml"], ["svg", "xml"],
  ["vue", "xml"], ["svelte", "xml"], ["astro", "xml"], ["plist", "xml"],
  ["json", "json"], ["jsonc", "json"], ["json5", "json"], ["jsonl", "json"],
  ["geojson", "json"], ["ipynb", "json"], ["har", "json"], ["webmanifest", "json"],
  ["md", "markdown"], ["markdown", "markdown"], ["mdown", "markdown"],
  ["yaml", "yaml"], ["yml", "yaml"], ["toml", "ini"], ["ini", "ini"], ["cfg", "ini"],
  ["conf", "ini"], ["properties", "ini"],
  ["sh", "bash"], ["bash", "bash"], ["zsh", "bash"], ["ksh", "bash"], ["fish", "bash"],
  ["py", "python"], ["pyw", "python"], ["rb", "ruby"], ["php", "php"],
  ["c", "c"], ["h", "c"], ["cpp", "cpp"], ["cc", "cpp"], ["cxx", "cpp"],
  ["hpp", "cpp"], ["hh", "cpp"], ["hxx", "cpp"], ["cs", "csharp"],
  ["java", "java"], ["kt", "kotlin"], ["kts", "kotlin"], ["go", "go"], ["rs", "rust"],
  ["swift", "swift"], ["m", "objectivec"], ["mm", "objectivec"], ["sql", "sql"],
  ["graphql", "graphql"], ["gql", "graphql"], ["lua", "lua"],
  ["pl", "perl"], ["pm", "perl"], ["r", "r"], ["vb", "vbnet"],
  ["wat", "wasm"], ["wast", "wasm"],
  ["gradle", "groovy"], ["groovy", "groovy"], ["dart", "dart"],
  ["ex", "elixir"], ["exs", "elixir"], ["erl", "erlang"], ["hrl", "erlang"],
  ["hs", "haskell"], ["lhs", "haskell"], ["scala", "scala"], ["sc", "scala"],
  ["clj", "clojure"], ["cljs", "clojure"], ["cljc", "clojure"], ["edn", "clojure"],
  ["ps1", "powershell"], ["psm1", "powershell"], ["psd1", "powershell"],
  ["proto", "protobuf"], ["cmake", "cmake"], ["ll", "llvm"],
  ["asm", "x86asm"], ["s", "x86asm"],
]);

const LANGUAGE_LABELS = new Map([
  ["plaintext", "Text"], ["javascript", "JavaScript"], ["typescript", "TypeScript"],
  ["xml", "HTML / XML"], ["json", "JSON"], ["markdown", "Markdown"],
  ["yaml", "YAML"], ["ini", "INI / TOML"], ["bash", "Shell"],
  ["python", "Python"], ["ruby", "Ruby"], ["php", "PHP"],
  ["c", "C"], ["cpp", "C++"], ["csharp", "C#"], ["java", "Java"],
  ["kotlin", "Kotlin"], ["go", "Go"], ["rust", "Rust"], ["swift", "Swift"],
  ["objectivec", "Objective-C"], ["sql", "SQL"], ["graphql", "GraphQL"],
  ["lua", "Lua"], ["perl", "Perl"], ["r", "R"], ["vbnet", "VB.NET"],
  ["wasm", "WebAssembly"], ["css", "CSS"], ["scss", "SCSS"], ["less", "Less"],
  ["dockerfile", "Dockerfile"], ["makefile", "Makefile"], ["cmake", "CMake"],
  ["groovy", "Groovy"], ["dart", "Dart"], ["elixir", "Elixir"],
  ["erlang", "Erlang"], ["haskell", "Haskell"], ["scala", "Scala"],
  ["clojure", "Clojure"], ["powershell", "PowerShell"], ["protobuf", "Protocol Buffers"],
  ["nginx", "Nginx"], ["llvm", "LLVM"], ["x86asm", "Assembly"],
]);

const STRICT_JSON_EXTENSIONS = new Set(["json", "geojson", "ipynb", "har", "webmanifest"]);

function basename(path) {
  return String(path || "").split("/").at(-1) || "";
}

export function classifyCodePath(path) {
  const name = basename(path);
  const lower = name.toLowerCase();
  const extension = lower.includes(".") ? lower.slice(lower.lastIndexOf(".") + 1) : "";
  let language = FILE_NAME_LANGUAGES.get(lower);
  if (!language && /^(dockerfile|containerfile)(\.|$)/.test(lower)) language = "dockerfile";
  if (!language && /^makefile(\.|$)/.test(lower)) language = "makefile";
  if (!language && (lower === ".env" || lower.startsWith(".env."))) language = "bash";
  language ||= EXTENSION_LANGUAGES.get(extension) || "plaintext";
  return {
    kind: language === "json" && STRICT_JSON_EXTENSIONS.has(extension) ? "json" : "code",
    language,
    label: LANGUAGE_LABELS.get(language) || language,
  };
}

export function codeLineCount(content) {
  const text = String(content || "");
  if (!text) return 1;
  let count = 1;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) count++;
  if (text.endsWith("\n")) count--;
  return Math.max(1, count);
}

export function canHighlightCode(content, size, language) {
  if (!language || language === "plaintext" || Number(size) > MAX_HIGHLIGHT_BYTES) return false;
  return codeLineCount(content) <= MAX_HIGHLIGHT_LINES;
}

export function parseStructuredJson(content, size) {
  if (Number(size) > MAX_STRUCTURED_JSON_BYTES) return { ok: false, reason: "tooLarge" };
  try { return { ok: true, value: JSON.parse(String(content)) }; }
  catch { return { ok: false, reason: "invalid" }; }
}

export function buildFileTree(paths) {
  const root = { name: "", path: "", dirs: new Map(), files: [] };
  for (const raw of paths || []) {
    const parts = String(raw).split("/").filter(Boolean);
    if (!parts.length) continue;
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const name = parts[i];
      const dirPath = node.path ? `${node.path}/${name}` : name;
      if (!node.dirs.has(name)) node.dirs.set(name, { name, path: dirPath, dirs: new Map(), files: [] });
      node = node.dirs.get(name);
    }
    node.files.push({ name: parts.at(-1), path: String(raw) });
  }
  return root;
}

export function sortedTreeChildren(node) {
  return {
    dirs: [...node.dirs.values()].sort((a, b) => a.name.localeCompare(b.name)),
    files: [...node.files].sort((a, b) => a.name.localeCompare(b.name)),
  };
}

export function diffLineKind(line) {
  if (line.startsWith("@@")) return "hunk";
  if (line.startsWith("diff --git") || line.startsWith("index ") || /^(new|deleted) file mode /.test(line)
      || line.startsWith("similarity index") || line.startsWith("rename from") || line.startsWith("rename to")) return "meta";
  if (line.startsWith("+++") || line.startsWith("---")) return "header";
  if (line.startsWith("+")) return "add";
  if (line.startsWith("-")) return "del";
  return "context";
}
