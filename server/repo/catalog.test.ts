import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { findRepoByGitUrl } from "./catalog.ts";

test("findRepoByGitUrl returns the newest matching repository on one host", () => {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE repos (id INTEGER PRIMARY KEY, host_id INTEGER, git_url TEXT, status TEXT)");
  db.prepare("INSERT INTO repos VALUES (1, 2, ?, 'ready')").run("git@github.com:philontos/aurelia.git");
  db.prepare("INSERT INTO repos VALUES (2, 2, ?, 'ready')").run("git@github.com:philontos/aurelia");
  db.prepare("INSERT INTO repos VALUES (3, 1, ?, 'ready')").run("git@github.com:philontos/aurelia.git");

  assert.equal(findRepoByGitUrl(db, 2, "git@github.com:philontos/aurelia.git/")?.id, 2);
  assert.equal(findRepoByGitUrl(db, 1, "git@github.com:philontos/aurelia.git")?.id, 3);
  db.close();
});

test("findRepoByGitUrl prefers a ready duplicate over a newer failed row", () => {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE repos (id INTEGER PRIMARY KEY, host_id INTEGER, git_url TEXT, status TEXT)");
  db.prepare("INSERT INTO repos VALUES (8, 2, ?, 'ready')").run("git@example.com:team/repo.git");
  db.prepare("INSERT INTO repos VALUES (9, 2, ?, 'error')").run("git@example.com:team/repo.git");

  assert.equal(findRepoByGitUrl(db, 2, "git@example.com:team/repo.git")?.id, 8);
  db.close();
});
