export function repoUrlKey(repo) {
  return String(repo?.git_url ?? repo ?? "").trim().replace(/\/+$/, "").replace(/\.git$/i, "");
}

export function controllerOnlyRepos(controllerRepos, nodeRepos) {
  const seen = new Set(nodeRepos.map(repoUrlKey).filter(Boolean));
  return controllerRepos.filter((repo) => {
    const key = repoUrlKey(repo);
    if (!key) return true;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
