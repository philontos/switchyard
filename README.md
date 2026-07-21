<p align="center">
  <img src="web/assets/switchyard-wordmark.png" alt="Switchyard" width="360">
</p>

<p align="center">English | <a href="README.zh-CN.md">简体中文</a></p>

> A web console that turns "handing a coding task to an AI" into dealing out a card. Every task is a **real, interactive Claude Code, Codex, or Kimi Code** running in its own git worktree + tmux session; you drop into that terminal from the browser, watch it work, and take over anytime. Tasks run in parallel without stepping on each other, every machine on your network is a first-class node — dispatch, watch, and wrap up from one page. And your phone gets the full experience: add it to your home screen and it's an app.

<p align="center">
  <img src="docs/screenshots/desktop-board.png" alt="Desktop overview: task board grouped by repo on the left, a real Claude Code terminal on the right" width="100%">
</p>

## One repo, N parallel worktree tasks

The core loop is repo-centric: register a repo (`+repo` — GitHub / GitLab, cloned on registration), then deal tasks against it. **Every task** automatically gets an **independent git worktree + work branch + tmux session**, cut from the base branch you pick — each agent works in its own directory, overwriting nothing, interrupting nobody. Want three features moving at once? Dispatch three cards against the same repo and review them one by one (archive / clean up / delete).

Tasks are hosted by tmux on the machine — **the web page is just a viewfinder**: close the browser and the task keeps running; open it from another device and the session is right where it was. You can also `tmux attach` from your own terminal and share the very same session, and TUI interactions — permission prompts, slash commands — work as-is in the web terminal.

A killed tmux session, host reboot, or archived task does not mean its working state is lost: as long as its worktree remains, one click resumes it with the same CLI, model, and endpoint. The live terminal also accepts screenshots pasted from the clipboard; the image is stored on the task's local or remote machine and handed to the selected agent.

> Aside: you can open a terminal without any repo — hit ＋ on the Shells group of the local machine or any remote node to get a bare tmux shell in a directory of your choice (quick debugging, one-off scripts), riding the same list / connect / archive flow as repo tasks.

## Three agent CLIs × multiple models

Pick the **agent CLI per task** — currently **Claude Code, Codex, and Kimi Code** — and they run side by side on the same board, cards colored by CLI. Local and remote are fully symmetric: whichever machine you dispatch to runs the CLI you picked; the task also remembers its model or endpoint when resumed.

<p align="center">
  <img src="docs/screenshots/dispatch-modal.png" alt="Dispatch modal: agent CLI + base branch + opening prompt + model backend" width="100%">
</p>

- **Claude Code** — full capability: skill injection (check off official plugin skills at dispatch; they're delivered straight into the task's worktree) and the permission **yellow light** (driven by a native hook, see below).
- **Codex** — launched with on-request + danger-full-access, so it can push, reach the network, and run `gh`; optionally pin any model ID available to the machine's Codex installation, or leave it blank for the machine default.
- **Kimi Code / Kimi K3** — launched as an interactive TUI with `--auto`, so Kimi Code handles routine tool approvals; it uses the Kimi account already signed in on that machine. Set a per-task model ID such as `k3` for [Kimi K3](https://www.kimi.com/code/docs/en/kimi-code/models.html) (subject to account access), or leave it blank for the Kimi Code default.
- **Multiple model endpoints** — point Claude Code at any **Anthropic-compatible endpoint** (e.g. GLM): the same Claude Code TUI drives another vendor's model. When you add an endpoint, the server probes it exactly the way claude will call it at runtime — **it only saves on a green check**. Picked per task and remembered across dispatches; keys stay on the target node and are never propagated between nodes.

> Current capability boundary: Switchyard's extra skill injection and permission-waiting yellow light are Claude Code-only. Codex and Kimi Code do not receive those skills or report permission-waiting state yet. All three CLIs support the live terminal, session resume, and image paste.

## Fleet: many machines, one page

Every machine on your network is a first-class node:

- **Fleet view** — each node's repos and live tasks are read **live over ssh** and grouped by repo; a node that's offline or not yet set up says so — you never look at stale data.
- **Dispatch anywhere** — pick a remote node's repo and dispatch; the task is created and owned on that node, and you connect / watch / stop it from your console, all relayed over ssh. Remote dispatches get the same instant optimistic loading card as local ones.
- **One-click bootstrap** — click "Install tdsp" on a machine and it's set up over ssh: code plus launcher, ready to use.
- **State passthrough** — running / ready / cloning / errored each get a status dot; when a Claude session parks on a permission prompt waiting for you, a Claude Code **native hook** flips the card to a **yellow light** that says "your turn" — the same mechanism local and remote.

## Mobile

On narrow screens the UI switches to a full touch experience. **Recommended: open it in Safari → Share → "Add to Home Screen" → check "Open as Web App"** — it runs standalone (no browser chrome, dark launch background, no white flashes), and from then on the console is one tap from your home screen, as close to a native app as it gets.

<p align="center">
  <img src="docs/screenshots/mobile-board.png" alt="Mobile task list" width="32%">
  <img src="docs/screenshots/mobile-reading.png" alt="Mobile reading mode: chat-style transcript with a Needs-you banner" width="32%">
  <img src="docs/screenshots/mobile-dispatch-codex.png" alt="Dispatching a Codex task from the phone" width="32%">
</p>

- **Master–detail views** — a task list page and a full-screen terminal page; tap a card to enter, swipe from the edge to go back (wired into browser history, so the iOS back gesture is native-smooth — even inside the live terminal).
- **Read | Live modes** — **Read** renders transcripts for local Claude / Codex tasks as a chat stream: native scrolling, auto-tailing, tool calls folded — perfect for checking progress from the couch. When Claude needs your confirmation, a "Needs you" banner appears with a one-tap jump to **Live** — the real terminal, where you act. Remote-node and Kimi Code transcripts are not wired in yet, so those tasks currently open in the live terminal.
- **Keyboard-glued input bar** — the input bar sits right above the iOS soft keyboard, supports multiple lines, and keeps a separate unsent draft per task, so switching tasks never leaks text.
- **Touch polish** — no double-tap/pinch zoom, no accidental text selection, one-finger terminal scrolling with momentum, hover styles only on true hover devices.

## Install & start (once per machine)

**Prerequisites:** Node 22+, `git` / `tmux`, and whichever signed-in agent CLIs you plan to use (`claude` / `codex` / `kimi`). The current `setup.sh` preflights both `claude` and `kimi`; to run Codex tasks, also make sure `codex` is reachable from a non-interactive shell. The setup helper currently targets zsh. Clone, then one command:

```sh
git clone <repo-url> switchyard && cd switchyard
./scripts/setup.sh   # one-shot setup: environment preflight + npm install + global tdsp (idempotent)
tdsp serve           # → http://localhost:4500
```

> `setup.sh` does three things in order: ① **preflight** — verifies `claude` / `kimi` / `tmux` / `git` are reachable from a non-interactive zsh (tasks are launched by exactly that kind of shell, which reads only `~/.zshenv`; a missing command kills the pane), idempotently writing any missing PATH dirs into `~/.zshenv`; ② `npm install` (4 runtime deps, zero build); ③ installs the global `tdsp` command (`~/.task-dispatcher/src` points at this clone, launcher linked at `~/.local/bin/tdsp` — if `tdsp` isn't found, put `~/.local/bin` on your PATH). `--check` inspects only — writes and installs nothing.

From here on, everything is `tdsp`:

```sh
tdsp serve                            # start the console (loopback only, :4500)
PORT=8080 tdsp serve                  # different port
tdsp serve --host-cidr 10.10.0.0/24   # also bind this machine's IP inside that range
tdsp update                           # update: pull latest code + refresh deps; rerun tdsp serve to apply
```

`--host-cidr` is for private overlays like WireGuard / Tailscale: with your phone and computer on the same range, the phone opens the printed address and gets the full console (pair it with "Add to Home Screen"):

```
task-dispatcher on http://127.0.0.1:4500
task-dispatcher on http://10.10.0.3:4500
```

## Using it

1. **Add a repo** — name + git url (GitHub / GitLab; supply a token for an https private repo, blank for SSH). It registers and clones; status goes `ready`.
2. **Dispatch a task** — pick a repo → base branch → title + opening prompt → choose the agent (Claude Code / Codex / Kimi Code) → optionally pick Claude skills and an endpoint, or a Codex / Kimi model ID. Worktree created, session started.
3. **Enter the terminal** — the right pane auto-connects; "Enter terminal" on a card reconnects anytime. You're talking to the real agent.
4. **Wrap up** — archive (kill session, keep worktree) / clean up (kill session + delete worktree) / delete (remove the record).

### Adding a remote machine

1. **Register it** — name + ssh target (e.g. `user@host`) in the console. A background prober shows its online status.
2. **Install tdsp on it** — open the machine's ⚙ menu and click **Install tdsp**. One click over ssh: it clones the code there (or reuses a clone it already has) and installs the launcher.
   - A machine that already runs its own console has a clone — run `npm run tdsp -- install` there once instead (reuses that clone, no second copy), then click Install in the console to register it as ready.
3. **Use it** — the machine's repos and live tasks show up, grouped by repo. Dispatch onto **its** repos (＋ on the repo group) or open a shell on it (＋ on its Shells group).

## tdsp commands

Every machine runs the same `tdsp`; the controller invokes the one-shot verbs on a remote via `ssh <node> tdsp …`.

| command | what it does |
|---|---|
| `tdsp serve` | start the web console (the persistent server); `--host-cidr <range>` also binds the private-overlay address |
| `tdsp list` | print this machine's tasks + repos as JSON |
| `tdsp create-local` | open a bare shell task on this machine |
| `tdsp create` | create a repo task on this machine (driven by the controller) |
| `tdsp stop <id>` | stop one of this machine's tasks |
| `tdsp branches` | list live branches of one of this machine's mirrors (for the controller's dispatch picker) |
| `tdsp install` | set up the global `tdsp` for this machine from its clone |
| `tdsp update` | update this machine's install: `git pull --ff-only` + `npm install` on the clone behind `~/.task-dispatcher/src`; restart serve to apply |

## Notes

- **Security** — the service **binds loopback `127.0.0.1` only by default**, so the LAN can't reach it. Exposing it requires an explicit `HOST=0.0.0.0` (at which point the web terminal hands a shell to anyone who can reach the port — **add your own auth / reverse proxy, never expose it raw on the public internet**). Prefer either an ssh tunnel (`ssh -L 4500:localhost:4500 host`) or `tdsp serve --host-cidr <range>` to bind only your private overlay (WireGuard / Tailscale) address. Reaching other nodes uses your ssh keys (login = authorization); no new ports or protocols. Tokens are stored **in plaintext** in sqlite — local personal use only.
- **Terminal feel** — give claude full-screen rendering (`/tui fullscreen` in the session, or `{"tui":"fullscreen"}` in `~/.claude/settings.json`, per machine) to pin the input box, keep scrolling smooth, and stop horizontal jumping.

## Structure

```
server/                REST API + /pty WebSocket; the tdsp CLI; git / tmux / pty / ssh Runner orchestration
  index.ts             HTTP entry: build app + http server, attach WS, run boot, listen
  tdsp.ts              the tdsp entrypoint (serve + one-shot verbs)
  http/                the web layer — thin HTTP glue over the domain folders below
    app.ts             assemble express: json → preview proxy → static → routes
    routes.ts          every /api/* handler
    ws.ts              upgrade routing + the pty/tmux terminal relay
    preview.ts         dev-server reverse-proxy upstream resolution
    context.ts         shared prepared statements + cross-cutting helpers
  core/                paths, sqlite db + schema, migration, server i18n
  repo/                git mirrors, worktrees, per-task repo env
  task/                task lifecycle (create/manifest/rename) + the tdsp node-local API (cli.ts)
  fleet/               remote hosts: runners, bootstrap, liveness, cross-node fleet view
  session/             tmux sessions, pty spawn, attach command, agent launch args (claude / codex / kimi)
  skills/              skill scan/resolve, plugin install, hook settings
  preview/             the preview reverse-proxy engine
web/                   board + xterm terminal (native ES Modules, no build)
  js/main.js           entry — wires the modules, bridges inline onclick handlers
  js/core/             shared infra: dom, state, feedback, dialog, select
  js/features/         hosts, tasks, terminal, repos, providers, skills, reorder, mobile, reading
scripts/setup.sh       one-shot machine setup: preflight (fix ~/.zshenv PATH for agent CLIs + git/tmux) + npm install + global tdsp
~/.task-dispatcher/    per machine:
  src                  pointer to this machine's clone (real clone or symlink)
  bin/tdsp             the global launcher → src
  <namespace>/         this machine's own data: mirrors/ worktrees/ tasks/ dispatcher.db
```

> The server and frontend each carry their own zh/en string dictionary (`server/core/i18n.ts`, `web/i18n.js`), the single source of truth for that layer. For the finer data model and node semantics, see the source comments.
