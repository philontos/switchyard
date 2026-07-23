import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  authorizeSwitchyardKey,
  ensureSshIdentity,
  normalizeSshPublicKey,
  removeSwitchyardKey,
} from "./ssh-identity.ts";

test("a Switchyard instance gets a stable dedicated Ed25519 identity", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tdsp-ssh-id-"));
  const first = await ensureSshIdentity(path.join(tmp, "data"), "abc12345");
  const second = await ensureSshIdentity(path.join(tmp, "data"), "abc12345");
  assert.equal(first.publicKey, second.publicKey);
  assert.match(first.publicKey, /^ssh-ed25519 \S+ switchyard-node:abc12345$/);
  assert.equal(fs.statSync(first.privateKeyPath).mode & 0o777, 0o600);
});

test("authorized_keys upserts and removes only one managed peer line", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tdsp-auth-"));
  const identity = await ensureSshIdentity(path.join(tmp, "identity"), "peer1234");
  const sshDir = path.join(tmp, ".ssh");
  fs.mkdirSync(sshDir);
  fs.writeFileSync(path.join(sshDir, "authorized_keys"), "ssh-ed25519 AAAA existing@example\n");

  assert.equal(authorizeSwitchyardKey(identity.publicKey, "peer1234", tmp).changed, true);
  assert.equal(authorizeSwitchyardKey(identity.publicKey, "peer1234", tmp).changed, false);
  const installed = fs.readFileSync(path.join(sshDir, "authorized_keys"), "utf8");
  assert.match(installed, /existing@example/);
  assert.equal((installed.match(/switchyard-node:peer1234/g) || []).length, 1);

  assert.equal(removeSwitchyardKey("peer1234", tmp).changed, true);
  assert.equal(fs.readFileSync(path.join(sshDir, "authorized_keys"), "utf8"), "ssh-ed25519 AAAA existing@example\n");
});

test("public-key normalization rejects injected lines and unsupported key types", () => {
  assert.throws(() => normalizeSshPublicKey("ssh-ed25519 AAAA x\ncommand=bad", "peer1234"));
  assert.throws(() => normalizeSshPublicKey("ssh-rsa AAAA x", "peer1234"));
});
