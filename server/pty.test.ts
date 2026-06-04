import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { spawnPty } from "./pty.ts";

// Count THIS process's open /dev/ptmx master fds. macOS encodes a pty master as a
// character device with major number 15; fstat opens no fd, so the scan can't
// perturb the very fd it's trying to measure (a /dev/fd readdir would).
function ptmxCount(max = 256): number {
  let n = 0;
  for (let fd = 3; fd < max; fd++) {
    try { if (((fs.fstatSync(fd).rdev >> 24) & 0xff) === 15) n++; } catch {}
  }
  return n;
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

// node-pty 1.1.0 leaks one /dev/ptmx per spawn on macOS (off-by-one in
// pty_posix_spawn). Opening a few hundred terminals fills kern.tty.ptmx_max and
// the whole machine can no longer allocate ptys. spawnPty must reclaim it.
test("spawnPty does not leak a /dev/ptmx fd per spawn", async () => {
  // warm up node-pty's one-time process-resident fd, then take the baseline
  const warm = spawnPty("sleep", ["1"], {});
  warm.kill();
  await wait(1000);
  const base = ptmxCount();

  const N = 8;
  const terms = [];
  for (let i = 0; i < N; i++) {
    const t = spawnPty("sleep", ["1000"], { name: "xterm-256color", cols: 80, rows: 24 });
    t.onData(() => {}); // flowing mode, exactly like the live /pty bridge
    terms.push(t);
  }
  for (const t of terms) t.kill();

  // node-pty closes a killed master ~200ms after exit — poll until they drain
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline && ptmxCount() > base + 1) await wait(100);

  const leaked = ptmxCount() - base;
  assert.ok(leaked <= 1, `leaked ${leaked} /dev/ptmx fd(s) across ${N} spawns`);
});
