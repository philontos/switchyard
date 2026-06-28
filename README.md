# Task Dispatcher

> A web console that turns "handing a coding task to Claude Code" into dealing out a card. Each task runs a **real, interactive Claude** inside its own git worktree + tmux session, and you drop straight into that terminal from the browser to watch it work and take over anytime. Many tasks run in parallel without stepping on each other, and every machine on your network is a first-class node you can dispatch to and watch from one page.

## Architecture: edge autonomy

The whole system is built on one idea: **every machine runs the same program and owns its own work.**

- **One command, `tdsp`, on every machine.** `tdsp serve` opens the web console; the same command also takes one-shot verbs (`list`, `create`, `stop`, …). The machine you sit at and the machine you reach over ssh run the exact same code.
- **Each machine is the sole authority for the tasks that run on it.** A task's truth — its database row plus a per-task manifest file — lives on the machine where the task actually runs, right next to its tmux session and git worktree. There is **no central ledger**: every node records only its own tasks, and they're all equal.
- **You see other machines by asking them, live.** Open the console on any machine and it shows that machine's own tasks instantly. To see another node, it runs `ssh <node> tdsp list` on demand and merges the answer — so what you see is the node's current truth, and a node that's offline shows as *unreachable*, never stale.
- **You drive other machines through their own program.** Dispatching a task to a remote is `ssh <node> tdsp create …`; the remote builds the worktree, starts tmux, and records the task **on itself**. The controller never reaches into another machine's data — it asks the node to act and the node owns the result.
- **The terminal is direct.** The web terminal attaches to the real Claude in a real tmux — locally via `tmux attach`, remotely via `ssh -t <node> tmux attach`. Nothing sits in the keystroke path, so typing latency is just the network.

The payoff: sit at any machine and see everything it runs; reach any other over ssh; no single point owns the truth, and there's nothing to keep in sync.

## Keywords: small · fast · edge-native · Claude native

- **Small** — 4 runtime dependencies, zero build step. The server runs straight under `tsx`, the frontend is native ES Modules; clone, `npm i`, and you're up.
- **Fast** — task terminals stay **resident**, so switching is instant — no reconnect, no redraw. Pulling code is pure git (blobless partial clone + lazy file fetch) and burns zero Claude tokens.
- **Edge-native** — every machine is a self-contained node that owns its tasks. The web layer reads each node's own live truth; nothing is mirrored or synced behind your back.
- **Claude native** — the web terminal attaches to the real claude inside a real tmux. Permission prompts, follow-up questions, and slash commands all work as-is — no wrapper, no rewritten interaction.
- **State passthrough** — running / ready / cloning / errored each get a status dot. When a session is parked on a permission confirmation waiting for you, a Claude Code **native hook** flips the card to a **yellow light** that says "your turn" — same mechanism local and remote.

## What it solves

- Let AI work several features at once without clobbering each other's working directory or interrupting one another.
- Watch and control all those sessions in **one place**, instead of juggling terminal tabs and memorizing tmux names.
- Spread work across machines (your laptop + a remote server / GPU box) but drive them all from one web page — with each machine genuinely owning what runs on it.

## Features

- **Tasks as cards** — dispatching = pick a repo / branch + one opening instruction; it auto-creates the worktree, starts tmux, and runs claude.
- **Real TUI, not a wrapper** — permission prompts, follow-up questions, and slash commands all work. The web terminal attaches to the same tmux, so you can `tmux attach` from your own terminal too and share the session both ways.
- **Parallel isolation** — every task gets its own worktree; multiple task terminals stay **resident**, so switching is instant with no reconnect and no redraw.
- **Fleet view** — every machine on the network managed as one page. Each node's repos and tasks are read live over ssh, grouped by repo; a node that's offline or not yet set up says so.
- **Dispatch anywhere** — pick a remote node's repo and dispatch; the task is created and owned on that node, and you connect / watch / stop it from your console.
- **Skill injection** — at dispatch time, check off Claude skills (official plugins; install them first via "Skills" in the top-right) and pull them straight into the task's worktree.
- **Dark / light + bilingual (EN/中文)** — toggle in the top-right; your choice is remembered.
- **Zero frontend build** — native HTML / CSS / ES Modules + self-hosted xterm, no bundling step.

## Install (once per machine)

Every machine that runs tasks gets the code once plus a global `tdsp` command.

**Prerequisites:** Node 22+, and `git` / `tmux` / `claude` reachable from a non-interactive shell. Run the preflight once to validate and auto-fix PATH:

```sh
./scripts/setup.sh          # validates claude / tmux / git, writes any missing PATH dirs into ~/.zshenv (idempotent, backs up to .bak)
./scripts/setup.sh --check  # show what it would change, write nothing
```

> Why it matters: the dispatcher launches each task with `zsh -c 'claude …'` — a non-interactive shell that only reads `~/.zshenv`. If `claude` isn't on that PATH the pane dies with `command not found`. Fixing PATH in `~/.zshenv` is the reliable place.

Then set up the machine:

```sh
git clone <repo-url> switchyard && cd switchyard
npm install
npm run tdsp -- install     # install the global `tdsp` command for this machine
```

`tdsp install` points `~/.task-dispatcher/src` at this clone and writes a launcher at `~/.task-dispatcher/bin/tdsp` (plus a convenience link at `~/.local/bin/tdsp`). After it, you can type `tdsp …` from anywhere — make sure `~/.local/bin` is on your PATH:

```sh
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc   # then reopen the shell
```

Start the console:

```sh
tdsp serve        # or: npm start   →  http://localhost:4500  (PORT configurable)
```

## Using it

1. **Add a repo** — name + git url (GitHub / GitLab; supply a token for an https private repo, blank for SSH). It registers and clones; status goes `ready`.
2. **Dispatch a task** — pick a repo → base branch → title + opening instruction → (optional) extra skills. It creates the worktree and starts the session.
3. **Enter the terminal** — the right pane auto-connects; "Enter terminal" on a card reconnects anytime. You're talking to the real claude.
4. **Wrap up** — archive (kill session, keep worktree) / clean up (kill session + delete worktree) / delete (remove the record).

> No repo? Use a **local quick task** (a "shell"): a bare tmux shell in a directory on the machine; you `cd` and run claude or anything. Same list / connect / archive flow.

### Adding a remote machine

1. **Register it** — name + ssh target (e.g. `user@host`) in the console. A background prober shows its online status.
2. **Install tdsp on it** — open the machine's ⚙ menu and click **Install tdsp**. One click sets it up over ssh: it clones the code there (or reuses a clone it already has) and installs the launcher.
   - A machine that already runs its own console has a clone — run `npm run tdsp -- install` there once instead, so it reuses that clone (no second copy), then click Install in the console to register it as ready.
3. **Use it** — the machine now shows its own repos and live tasks, grouped by repo. Dispatch by picking one of **its** repos (＋ on the repo group) or open a shell on it (＋ on its Shells group). The task is created on that machine and owned by it; you connect, watch, and stop it from your console — all relayed over ssh.

## tdsp commands

The same `tdsp` runs on every machine; the controller invokes the one-shot verbs on a remote over `ssh <node> tdsp …`.

| command | what it does |
|---|---|
| `tdsp serve` | start the web console (the persistent server) |
| `tdsp list` | print this machine's tasks + repos as JSON |
| `tdsp create-local` | open a bare shell task on this machine |
| `tdsp create` | create a repo task on this machine (driven by the controller) |
| `tdsp stop <id>` | stop one of this machine's tasks |
| `tdsp install` | set up the global `tdsp` for this machine from its clone |

## Notes

- **Security** — the service **binds loopback `127.0.0.1` only by default**, so the LAN can't reach it. To expose it you must set `HOST=0.0.0.0` explicitly (at which point the web terminal hands a shell to anyone who can reach the port, so **add your own auth / reverse proxy — never expose it raw on the public internet**). For remote access, prefer an ssh tunnel: `ssh -L 4500:localhost:4500 host`. Reaching other nodes uses your ssh keys (login = authorization); no new ports or protocols are opened. Tokens are stored **in plaintext** in sqlite — local personal use only.
- **Terminal feel** — give claude full-screen rendering (`/tui fullscreen` in the session, or `{"tui":"fullscreen"}` in `~/.claude/settings.json`, per machine) to pin the input box, keep scrolling smooth, and stop horizontal jumping.

## Structure

```
server/                REST API + /pty WebSocket; the tdsp CLI; git / tmux / pty / ssh Runner orchestration
  tdsp.ts              the tdsp entrypoint (serve + one-shot verbs)
  cli.ts               verb dispatch + the cross-node read contract (list/aggregate)
  createtask.ts        task-creation core (shared by the HTTP route and the CLI)
  fleet.ts             cross-node fleet view assembly
  bootstrap.ts         per-machine install + the one-click remote setup
  taskmanifest.ts      per-task manifest = the edge-resident truth
web/                   board + xterm terminal (native ES Modules, no build)
scripts/setup.sh       preflight: validate claude/tmux/git, fix PATH in ~/.zshenv
~/.task-dispatcher/    per machine:
  src                  pointer to this machine's clone (real clone or symlink)
  bin/tdsp             the global launcher → src
  <namespace>/         this machine's own data: mirrors/ worktrees/ tasks/ dispatcher.db
```

> The server and frontend each carry their own zh/en string dictionary (`server/i18n.ts`, `web/i18n.js`), the single source of truth for that layer. For the finer data model and node semantics, see the source comments.
