import pty from "node-pty";
import fs from "node:fs";

// ---------------------------------------------------------------------------
// BUG (upstream node-pty@1.1.0, macOS): every pty.spawn() permanently leaks one
// /dev/ptmx master fd. We work around it here.
//
// Where — node_modules/node-pty/src/unix/pty.cc, pty_posix_spawn():
//
//     int low_fds[3]; size_t count = 0;
//     for (; count < 3; count++) {              // reserve the low fd slots by
//       low_fds[count] = posix_openpt(O_RDWR);  //   opening throwaway ptmx fds
//       if (low_fds[count] >= STDERR_FILENO) break;
//     }
//     *master = posix_openpt(O_RDWR);           // the real master (-> term.fd)
//     ... posix_spawn the child ...
//     for (; count > 0; count--) close(low_fds[count]);   // <- off-by-one
//
// In any normal process fds 0/1/2 are open, so the FIRST posix_openpt() already
// returns a fd >= STDERR_FILENO -> break with count == 0 -> the cleanup loop
// `count > 0` runs zero times -> low_fds[0] is never closed. node-pty only hands
// *master back to JS, so this orphaned reservation fd is invisible to the
// library: kill()/destroy() reclaim *master but can never touch low_fds[0].
//
// Symptom — each web-terminal open burns one pty for good. After a few hundred
// opens the process hits kern.tty.ptmx_max (default 511) and the WHOLE machine
// can no longer allocate ptys: "forkpty: Device not configured", sudo/tmux fail
// to get a pty, no new terminals open. (Observed: one dispatcher held 478 ptmx;
// killing it dropped system-wide ptmx 518 -> 40 and the machine recovered.)
//
// Fix — pty.spawn() is synchronous, so any /dev/ptmx fd that appears across the
// call and is not the returned master IS that orphan; close it right away. It's
// pure reservation scratch node-pty meant to close itself, so closing it has
// zero effect on the live terminal (verified: it keeps reading/writing fine).
// ---------------------------------------------------------------------------

const PTMX_MAJOR = 15; // macOS /dev/ptmx character-device major number

// fstat (not a /dev/fd readdir) so the scan opens no fd of its own — a readdir's
// transient dir fd would land on the very number about to be leaked and mask it.
function ptmxFds(max = 256): Set<number> {
  const fds = new Set<number>();
  for (let fd = 3; fd < max; fd++) {
    try { if (((fs.fstatSync(fd).rdev >> 24) & 0xff) === PTMX_MAJOR) fds.add(fd); } catch {}
  }
  return fds;
}

export function spawnPty(file: string, args: string[], opts: pty.IPtyForkOptions): pty.IPty {
  const before = ptmxFds();
  const term = pty.spawn(file, args, opts);
  const masterFd = (term as unknown as { fd: number }).fd;
  for (const fd of ptmxFds()) {
    if (!before.has(fd) && fd !== masterFd) {
      try { fs.closeSync(fd); } catch {}
    }
  }
  return term;
}
