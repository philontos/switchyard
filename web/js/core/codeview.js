// Pure helpers for the read-only code explorer. Kept DOM-free so path/tree and
// diff classification behavior can be regression-tested in Node.
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
