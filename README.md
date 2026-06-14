# Task Dispatcher

> A web console that turns "handing a coding task to Claude Code" into dealing out a card. Each task runs a **real, interactive Claude** inside its own git worktree + tmux session, and you drop straight into that terminal from the browser to watch it work and take over anytime. Many tasks run in parallel without stepping on each other, and the whole thing schedules across multiple machines.

## Keywords: small · fast · multi-host · Claude native

In one line, it's built around exactly these — see **Features** below for the mechanics:

- **Small** — 4 runtime dependencies, zero build step, ~4.5k lines for the whole server + frontend. The server runs straight under `tsx`, the frontend is native ES Modules; clone, `npm i`, and you're up.
- **Fast** — task terminals stay **resident**, so switching is instant — no reconnect, no redraw. Pulling code is pure git (blobless partial clone + lazy file fetch) and burns zero Claude tokens.
- **Multi-host** — your local machine plus any ssh-reachable remote, managed as one. The worktree / tmux / claude all run **locally on the target machine**; the web layer only relays and probes liveness.
- **Claude native** — the web terminal attaches to the real claude inside a real tmux. Permission prompts, follow-up questions, and slash commands all work as-is — no wrapper, no rewritten interaction.
- **State passthrough** — running / ready / cloning / errored each get a status dot. When a session is parked on a permission confirmation waiting for you, a Claude Code **native hook** flips the card to a **yellow light** that says "your turn" — same mechanism local and remote.

## What it solves

- You want to let AI work several features at once without them clobbering each other's working directory or interrupting one another.
- You want to watch and control all those sessions in **one place**, instead of juggling a pile of terminal tabs and memorizing a pile of tmux names.
- You want to dispatch tasks to different machines (local + a remote server / GPU box) but drive them all from one web page.

## Features

- **Tasks as cards** — dispatching = pick a repo / branch + one opening instruction; it auto-creates the worktree, starts tmux, and runs claude.
- **Real TUI, not a wrapper** — permission prompts, follow-up questions, and slash commands all work. The web terminal just attaches to the same tmux, so you can `tmux attach` from your own terminal too and share the session both ways.
- **Parallel isolation** — every task gets its own worktree; multiple task terminals stay **resident**, so switching is instant with no reconnect and no redraw.
- **Multi-host orchestration** — your local machine plus any ssh-reachable remote, managed as one. The worktree / tmux / claude all run on the target machine; the web layer only relays. A background prober shows online status in real time.
- **Status at a glance** — running / ready / cloning / errored are shown with status dots. When a session is parked on a permission confirmation waiting for you, the card lights up **yellow** to flag "your turn".
- **Skill injection** — at dispatch time you can check off Claude skills (official plugins; install them first via "Skills" in the top-right) and pull them straight into the task's worktree.
- **Token-thrifty** — pulling code is all pure git (blobless partial clone, files fetched lazily) and costs no Claude tokens.
- **Dark / light + bilingual (EN/中文)** — toggle in the top-right; your choice is remembered.
- **Zero frontend build** — native HTML / CSS / ES Modules + self-hosted xterm, no bundling step.

## Quick start

**Prerequisites** (do this once on every machine that will run tasks):

1. **Install Node 22+** (the rest is validated by the next step).
2. **Run the preflight script**, which validates and auto-writes any missing PATH entries into `~/.zshenv`:

   ```sh
   ./scripts/setup.sh          # validates claude / tmux / git, writes "installed but not on PATH" dirs into ~/.zshenv (idempotent, auto-backs up to .bak)
   ./scripts/setup.sh --check  # show what it would change, write nothing
   ```

   It checks things the way the dispatcher actually invokes them — a non-interactive shell (tmux / ssh → `zsh -c`, which only reads `~/.zshenv`). If a command genuinely isn't installed, it tells you how to install it rather than installing it for you. nvm-installed `claude` paths carry a version number and break on upgrade, so the script reminds you to pin a stable symlink.

Once prerequisites pass, start the server:

```bash
npm install
npm run dev      # http://localhost:4500 (PORT is configurable)
```

> **Why step 2 matters**: the dispatcher launches each task with `zsh -c 'claude …'`, a non-interactive, non-login shell — if `claude` isn't on PATH you get `command not found` and the pane dies outright (exit status 127). `~/.zshenv` applies to every zsh invocation, so fixing PATH there is the most reliable. Remote machines are configured by hand for now (add claude / tmux / git to the `~/.zshenv` on **that** machine); scripting it is a later job.

**Using it**:

1. **Add a repo**: enter a name + git url (GitHub / GitLab; for an https private repo you can supply a token, leave it blank for SSH) → it registers and clones, status goes `ready`.
2. **Dispatch a task**: pick a repo → pick a base branch → fill in a title + the opening instruction for claude → (optional) check extra skills → it creates the worktree and starts the session.
3. **Enter the terminal**: the right pane auto-connects to that session and you interact with claude directly; "Enter terminal" on the card reconnects anytime.
4. **Wrap up**: archive (kill the session, keep the worktree) / clean up (kill the session + delete the worktree) / delete (remove the record).

> Don't want to register a repo? Use a **local quick task**: it opens a bare tmux shell in some directory on your local machine, you `cd` yourself and run claude or any command — the same list / connect / archive flow applies.

## Notes

- **Security**: the service **binds loopback `127.0.0.1` only by default**, so other machines on the LAN can't reach it. To expose it on the LAN you must set `HOST=0.0.0.0` explicitly (at which point the web terminal = handing a shell to anyone who can reach that port, so **add your own auth / reverse proxy — never expose it raw on the public internet**). For remote access, an ssh tunnel is preferable: `ssh -L 4500:localhost:4500 host`. Tokens are currently stored **in plaintext** in sqlite, intended for local personal use only.
- **Terminal feel**: give claude full-screen rendering — `/tui fullscreen` inside the session, or set `{"tui":"fullscreen"}` in `~/.claude/settings.json` (per-machine, configured on each) — to pin the input box, keep scrolling smooth, and stop the horizontal jumping.

## Structure

```
server/   REST API + /pty WebSocket; git / tmux / pty / multi-host Runner (local + ssh) orchestration
web/      board + xterm terminal (native ES Modules, no build)
scripts/  setup.sh — preflight on each machine before running tasks: validates claude/tmux/git and fixes the PATH in ~/.zshenv
~/.task-dispatcher/   per machine: mirrors/ worktrees/ (+ dispatcher.db on the control host)
```

> The server and frontend each carry their own zh/en string dictionary (`server/i18n.ts`, `web/i18n.js`), the single source of truth for that layer. For the finer data model, multi-host ledger semantics, and i18n conventions, see the source comments.
