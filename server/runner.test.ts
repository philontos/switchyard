import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { localRunner, sshForwardArgs } from "./runner.ts";

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

test("LocalRunner.putFile copies a single file, creating parent dirs", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pf-"));
  const src = path.join(tmp, "a.png");
  fs.writeFileSync(src, "PNGDATA");
  const dest = path.join(tmp, "out", "nested", "b.png"); // parents don't exist yet
  await localRunner.putFile(src, dest);
  assert.equal(fs.readFileSync(dest, "utf8"), "PNGDATA");
});

test("sshForwardArgs: forwards to the remote's localhost so sshd picks IPv4/IPv6", () => {
  const args = sshForwardArgs("phil@10.10.0.2", 41000, 5173);
  const i = args.indexOf("-L");
  assert.notEqual(i, -1, "should pass a -L forward");
  // local end is bound IPv4 (the dispatcher owns it); the remote target is
  // `localhost` (NOT 127.0.0.1) so the remote sshd resolves it and connects to
  // whichever loopback family the dev server bound (vite defaults to ::1).
  assert.equal(args[i + 1], "127.0.0.1:41000:localhost:5173");
  assert.equal(args[0], "-N");                 // detached, no remote command
  assert.equal(args[args.length - 1], "phil@10.10.0.2");
});
