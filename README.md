# Task Dispatcher

> 一个网页控制台，把「派发编程任务给 Claude Code」变成开卡片的事。每个任务在独立的 git worktree + tmux 会话里跑一个**真·交互式 Claude**，你在浏览器里直接进终端盯着它干、随时接管。多任务并行互不干扰，还能跨多台机器统一调度。

## 关键词：小 · 快 · 多主机 · Claude native

一句话讲，它就奔着这几点设计 —— 详细机制见下面的「特点」：

- **小** —— 4 个运行时依赖、零构建步骤，整个服务端 + 前端约 4.5k 行；服务端 `tsx` 直跑、前端原生 ES Module，clone 完 `npm i` 就能上。
- **快** —— 多任务终端**常驻**，切换即时、不重连不重绘；拉代码全走纯 git（blobless 部分克隆 + 文件懒取），不烧一个 Claude token。
- **多主机** —— 本机 + 任意可 ssh 的远程机统一纳管，worktree / tmux / claude 都在**目标机本地**跑，网页只做中继与探活。
- **Claude native** —— 网页终端直接 attach 到真 tmux 里的真 claude，权限弹窗 / 追问 / 斜杠命令原样可用，不套壳、不重写交互。
- **状态透传** —— 跑中 / 就绪 / 克隆中 / 出错都有状态点；会话卡在权限确认等你时，靠 Claude Code **原生 hook** 把卡片点成**黄灯**喊「等你」—— 本机和远程同一套机制。

## 它解决什么

- 想同时让 AI 跑好几个 feature，又不想它们互相踩工作目录、互相打断。
- 想在**一个地方**统一看 / 控这些会话，而不是开一堆终端 tab、记一堆 tmux 名字。
- 想把任务派到不同机器（本机 + 远程服务器 / GPU 机）上跑，但只在一个网页里操作。

## 特点

- **任务即卡片** —— 派发 = 选仓库 / 分支 + 一句开场指令；自动建 worktree、起 tmux、跑 claude。
- **真 TUI，不是套壳** —— 权限弹窗、追问、斜杠命令全部正常。网页终端只是 attach 到同一个 tmux，你也能在自己终端 `tmux attach` 双向共享同一会话。
- **并行隔离** —— 每个任务独立 worktree；多个任务的终端**常驻**，切换即时、不重连、不重绘。
- **多机编排** —— 本机 + 任意可 ssh 的远程机统一纳管；worktree / tmux / claude 都跑在目标机上，网页只做中继；后台探活实时显示在线状态。
- **一眼看状态** —— 跑中 / 就绪 / 克隆中 / 出错用状态点表示；会话卡在权限确认等你时，卡片亮**黄灯**提醒「等你」。
- **skill 注入** —— 派发时可勾选若干 Claude skill（官方插件，先在右上角「Skills」里装好），一键带进任务的 worktree。
- **省 token** —— 拉代码全是纯 git（blobless 部分克隆，文件按需懒取），不花任何 Claude token。
- **深 / 浅色 + 中英双语** —— 右上角一键切换并记住选择。
- **零前端构建** —— 原生 HTML / CSS / ES Module + 自托管 xterm，没有打包步骤。

## 快速开始

前置：Node 22+、`tmux`、已登录的 `claude` —— 且这三个命令在**非交互、非登录 shell** 里都能被找到（原因见下方 PATH）。

```bash
npm install
npm run dev      # http://localhost:4500（PORT 可改）
```

**PATH（最容易踩的坑）**：dispatcher 用 `tmux new-session … claude` 拉起每个会话（远程走 `ssh host '<cmd>'`），跑的是**非交互、非登录 shell** —— zsh 下**只读 `~/.zshenv`**，不读 `.zshrc` / `.zprofile`。所以 `claude` / `tmux` / `git` 必须出现在 `~/.zshenv` 的 PATH 里，否则任务一起就 `command not found: claude`、pane 直接死（状态 127）。**每台**要跑任务的机器（本机 + 各远程机）都要配：

```sh
# ~/.zshenv（没有就新建）
eval "$(/opt/homebrew/bin/brew shellenv)"   # git / tmux 等（按需）
export PATH="$HOME/.local/bin:$PATH"          # claude（按 `command -v claude` 改）
```

验证 `zsh -c 'command -v claude tmux git'`，三个都打印路径即就绪。nvm 装的 `claude` 路径带 node 版本号、node 一升级就失效，建议软链到固定位置再写进 PATH：`ln -s "$(command -v claude)" ~/.local/bin/claude`。

1. **新建仓库**：填名称 + git url（GitHub / GitLab，https 私有库可填 token，SSH 留空）→ 注册并克隆，状态变 `ready`。
2. **派发任务**：选仓库 → 选基分支 → 填标题 + 给 claude 的开场指令 →（可选）勾附加 skill → 建 worktree + 起会话。
3. **进终端**：右侧自动连上该会话，直接跟 claude 交互；卡片「进终端」可随时重连。
4. **收尾**：归档（杀会话、留 worktree）/ 清理（杀会话 + 删 worktree）/ 删除（删记录）。

> 不想建仓库时用「本地快速任务」：在本机某目录直接开个裸 tmux shell，自己 `cd`、跑 claude 或任何命令，同一套列表 / 连接 / 归档照用。

## 注意

- **远程机**：PATH 规则同「快速开始」那条 —— 在**远程机自己**的 `~/.zshenv` 里也配好 `git / tmux / claude`（dispatcher 走 `ssh host '<cmd>'`，同样只读 `.zshenv`，不读 `.zshrc` / `.zprofile`）。
- **安全**：服务**默认只绑环回 `127.0.0.1`**，局域网内别的机器连不上。要暴露到局域网需显式 `HOST=0.0.0.0`（此时网页终端 = 把 shell 开放给能访问该端口的人，**务必自加鉴权 / 反代，别裸暴露公网**）；想远程访问更建议走 ssh 隧道 `ssh -L 4500:localhost:4500 host`。token 目前**明文**存 sqlite，仅供本机自用。
- **终端手感**：给 claude 开全屏渲染——会话内 `/tui fullscreen`，或 `~/.claude/settings.json` 设 `{"tui":"fullscreen"}`（per-machine，各机各配）——输入框钉死、滚动顺滑、不再横跳。

## 结构

```
server/   REST API + /pty WebSocket；git / tmux / pty / 多机 Runner（本地 + ssh）编排
web/      看板 + xterm 终端（原生 ES Module，无构建）
~/.task-dispatcher/   每台机器：mirrors/ worktrees/（+ 控制端的 dispatcher.db）
```

> 服务端 / 前端文案各有一份 zh/en 字典（`server/i18n.ts`、`web/i18n.js`），是各自层的唯一真源。更细的数据模型、多机账本语义、i18n 约定见源码注释。
