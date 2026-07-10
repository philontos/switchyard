import test from "node:test";
import assert from "node:assert/strict";
import { controllerOnlyRepos, repoUrlKey } from "./repos.js";

test("repoUrlKey normalizes trailing slash and .git suffix", () => {
  assert.equal(repoUrlKey("git@github.com:philontos/aurelia.git/"), "git@github.com:philontos/aurelia");
});

test("controllerOnlyRepos hides node-owned and older duplicate controller repos", () => {
  const controller = [
    { id: 11, git_url: "git@github.com:philontos/aurelia.git" },
    { id: 10, git_url: "git@github.com:philontos/aurelia.git" },
    { id: 6, git_url: "git@github.com:philontos/switchyard.git" },
  ];
  const node = [{ id: 1, git_url: "git@github.com:philontos/switchyard" }];

  assert.deepEqual(controllerOnlyRepos(controller, node).map((repo) => repo.id), [11]);
});
