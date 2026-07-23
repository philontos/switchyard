import { test } from "node:test";
import assert from "node:assert/strict";
import { attachCommand } from "./attach.ts";

const BINS = { ssh: "/usr/bin/ssh", mosh: "/opt/homebrew/bin/mosh", tmux: "/opt/homebrew/bin/tmux" };
const host = (kind: string, target: string) => ({ kind, target }) as any;

test("attachCommand: no host (plain local session) attaches via tmux", () => {
  const r = attachCommand(undefined, "tdsp-1-x", BINS);
  assert.equal(r.file, BINS.tmux);
  assert.deepEqual(r.args, ["attach", "-t", "tdsp-1-x"]);
});

test("attachCommand: a local-kind host also attaches via tmux", () => {
  const r = attachCommand(host("local", ""), "tdsp-2-x", BINS);
  assert.equal(r.file, BINS.tmux);
  assert.deepEqual(r.args, ["attach", "-t", "tdsp-2-x"]);
});

test("attachCommand: ssh host sshes in and attaches there", () => {
  const r = attachCommand(host("ssh", "me@box"), "tdsp-3-x", BINS);
  assert.equal(r.file, BINS.ssh);
  assert.deepEqual(r.args, ["-t", "me@box", "exec tmux attach -t tdsp-3-x"]);
});

test("attachCommand: a discovered host uses the managed identity without a prompt", () => {
  const r = attachCommand({ ...host("ssh", "me@box"), managed_ssh: 1, ssh_port: 22 }, "tdsp-3-x", BINS);
  assert.equal(r.file, BINS.ssh);
  assert.ok(r.args.includes("IdentitiesOnly=yes"));
  assert.ok(r.args.includes("StrictHostKeyChecking=accept-new"));
  assert.deepEqual(r.args.slice(-3), ["-t", "me@box", "exec tmux attach -t tdsp-3-x"]);
});

test("attachCommand: mosh host attaches via mosh", () => {
  const r = attachCommand(host("mosh", "me@box"), "tdsp-4-x", BINS);
  assert.equal(r.file, BINS.mosh);
  assert.deepEqual(r.args, ["me@box", "--", "sh", "-c", "exec tmux attach -t tdsp-4-x"]);
});
