import { test } from "node:test";
import assert from "node:assert/strict";
import { quoteNodeArg, runNodeCommand } from "./nodeclient.ts";

test("node command arguments are safely single-quoted for ssh", () => {
  assert.equal(quoteNodeArg("plain text"), "'plain text'");
  assert.equal(quoteNodeArg("it's safe"), "'it'\\''s safe'");
});

test("node transport refuses a remote without Switchyard", async () => {
  const result = await runNodeCommand({ kind: "ssh", target: "dev@example", tdsp_bin: null }, ["list", "--json"]);
  assert.equal(result.ok, false);
  assert.match(result.stderr, /Switchyard installed/);
});
