import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { initSchema } from "../core/schema.ts";
import { providerSummaries, providersForList } from "./providers.ts";

test("provider picker summaries never expose credentials or endpoints", () => {
  const db = new Database(":memory:");
  initSchema(db, { didMigrate: false, legacyDir: "/legacy", dataDir: "/data" });
  db.prepare(
    "INSERT INTO providers (id,name,base_url,auth_token,model,small_fast_model) VALUES (1,'GLM','https://provider.example','secret','glm-5','glm-fast')",
  ).run();
  assert.deepEqual(providersForList(db), [{ id: 1, name: "GLM", model: "glm-5" }]);
});

test("provider summaries strip secrets from an older node's full provider rows", () => {
  const rows = [{
    id: 7,
    name: "Remote GLM",
    model: "glm-5",
    base_url: "https://provider.example",
    auth_token: "remote-secret",
    small_fast_model: "glm-fast",
  }];
  assert.deepEqual(providerSummaries(rows), [{ id: 7, name: "Remote GLM", model: "glm-5" }]);
  assert.equal(providerSummaries({ providers: rows }).length, 0);
});
