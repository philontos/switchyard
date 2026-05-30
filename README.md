# Task Dispatcher

Web 任务派发器：注册 GitLab 仓库 → 选分支 → 派发任务 → 每个任务在独立 git worktree 里跑一个**交互式 Claude Code（tmux 会话）** → 网页内 xterm 直接进终端交互 → 提 MR → 一键清理。并发多个 feature 互不干扰。

## 原理
- 注册仓库时 `git clone --mirror` 一份；后续 worktree 共享对象库，建/删都快。
- 派发任务 = `git worktree add` + `tmux new-session 跑 claude`（带初始 prompt）。跑的是真 TUI，所以权限弹窗、追加对话全部正常。
- 网页终端 = `xterm.js` ⟷ WebSocket ⟷ `node-pty` 跑 `tmux attach`。也可随时在自己终端 `tmux attach -t task-<id>`，两边共享同一会话。
- 拉代码全是纯 git 操作，**不消耗任何 Claude token**。

## 前置
- node 22+、tmux、`claude`（已登录）、`glab`（提 MR 用，需先 `glab auth login`）。

## 运行
```bash
npm install
npm run dev      # http://localhost:4500  (PORT 可改)
```

## 用法
1. 左侧「新建仓库」：填名称 + git url（https 私有库可填 token；提 MR 需填 `group/repo` project path）。点「注册并克隆」，状态变 `ready`。
2. 「派发任务」：选仓库 → 选基分支 → 填标题 + 给 claude 的初始指令 → 「建 worktree + 起会话」。
3. 右侧终端自动连上该会话，直接跟 claude 交互；任务卡片「进终端」可随时重连。
4. 完成后「提 MR」（push 工作分支 + glab 开 MR），再「清理」杀会话删 worktree。

## 结构
```
server/
  paths.ts   路径常量
  db.ts      better-sqlite3: repos / tasks
  git.ts     mirror clone / fetch / 列分支 / worktree 生命周期
  tmux.ts    会话 起/查/杀
  mr.ts      glab 开 MR
  index.ts   REST API + /pty WebSocket(node-pty <-> tmux attach)
web/
  index.html 看板 + xterm 终端（CDN 引 xterm，无需前端构建）
data/        mirrors/ worktrees/ dispatcher.db（gitignored）
```

## 注意
- token 目前明文存 sqlite，仅供本机自用；要多人用需加密 + 鉴权。
- 服务监听 localhost；网页终端等于把 shell 暴露给能访问该端口的人，别裸暴露到公网。
