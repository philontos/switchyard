import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { initSchema } from "../core/schema.ts";
import type { Runner } from "../fleet/runner.ts";
import { pasteImageIntoOwnedTask } from "./paste-service.ts";

test("image paste refuses a remote filesystem runner", async () => {
  const db = new Database(":memory:");
  initSchema(db, { didMigrate: false, legacyDir: "/legacy", dataDir: "/data" });
  const remote = { kind: "ssh" } as Runner;
  const result = await pasteImageIntoOwnedTask(db, remote, "node", 7, "image/png", Buffer.from("png"));
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.message || "", /node that owns/);
});
