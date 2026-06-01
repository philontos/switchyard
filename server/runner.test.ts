import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { localRunner } from "./runner.ts";

test("LocalRunner.putDir copies a directory tree", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pd-"));
  const src = path.join(tmp, "src");
  fs.mkdirSync(path.join(src, "sub"), { recursive: true });
  fs.writeFileSync(path.join(src, "SKILL.md"), "hi");
  fs.writeFileSync(path.join(src, "sub", "x.sh"), "#!/bin/sh\n");
  const dest = path.join(tmp, "out", "skill");      // parent does not exist yet
  await localRunner.putDir(src, dest);
  assert.equal(fs.readFileSync(path.join(dest, "SKILL.md"), "utf8"), "hi");
  assert.ok(fs.existsSync(path.join(dest, "sub", "x.sh")));
});
