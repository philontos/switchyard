# Task Dispatcher

Web 任务派发器：注册 GitLab 仓库 → 选分支 → 派发任务 → 每个任务在独立 git worktree 里跑一个**交互式 Claude Code（tmux 会话）** → 网页内 xterm 直接进终端交互 → 提 MR → 一键清理。并发多个 feature 互不干扰。

## 原理
- 注册仓库时 `git clone --mirror` 一份；后续 worktree 共享对象库，建/删都快。
- 派发任务 = `git worktree add` + `tmux new-session 跑 claude`（带初始 prompt）。跑的是真 TUI，所以权限弹窗、追加对话全部正常。
- 网页终端 = `xterm.js` ⟷ WebSocket ⟷ `node-pty` 跑 `tmux attach`。也可随时在自己终端 `tmux attach -t task-<id>`，两边共享同一会话。
- 拉代码全是纯 git 操作，**不消耗任何 Claude token**。

## 前置
- node 22+、tmux、`claude`（已登录）、`glab`（提 MR 用，需先 `glab auth login`）。

## 远程机器
除本机外，可把仓库注册到、任务派发到一台**远程机器**（ssh）上 —— worktree、tmux、claude 都跑在那台机器上。dispatcher 只负责**转发命令**：远程命令走非交互 ssh（`ssh host '<cmd>'`），而非交互、非登录 shell **只读 `~/.zshenv`**（不读 `.zshrc`/`.zprofile`）。

所以 **dispatcher 在远程机用到的所有命令 —— `git`、`tmux`、`claude` —— 都必须在 `~/.zshenv` 配好的 PATH 里**。这不只是 Homebrew 的事：每个工具各自所在的目录都要加（Homebrew 的 bin 给 git/tmux、claude 的安装目录、nvm 的 bin……）：

```sh
# 远程机的 ~/.zshenv
eval "$(/opt/homebrew/bin/brew shellenv)"   # git / tmux 等 Homebrew 工具
export PATH="$HOME/.local/bin:$PATH"          # claude（按 `which claude` 的实际目录改）
```

> 为什么必须是 `.zshenv`：它是 zsh 里唯一对**所有** shell 都生效的启动文件；`ssh host '命令'` 跑的非交互 shell 只读它。`.zshrc` 只交互、`.zprofile` 只登录 —— 所以你手动 ssh 进去能用、dispatcher 转发的命令却找不到。远程的 mirror / worktree 落在那台机器的 `~/.task-dispatcher/`。

### 数据模型：谁是账本

每台机器的 `~/.task-dispatcher/` 布局相同，但**唯一的真相来源是「控制端」的 `dispatcher.db`** —— 即正在跑 dispatcher 服务的那台机器：

```
~/.task-dispatcher/
├── mirrors/      {repoId}-{name}.git      物理 git 数据（裸库）
├── worktrees/    {repoId}-{taskId}
├── repos.json    只写、从不回读的自述快照（信息性，不参与状态恢复）
└── dispatcher.db 仅控制端有；repos / tasks / hosts 的账本
```

磁盘上的目录名都用**控制端 db 的自增 id** 做前缀（mirror=`{repoId}-…`、worktree=`{repoId}-{taskId}`、tmux 会话=`tdsp-{taskId}-…`）。由此推出两条容易误解的性质：

- **仓库不跨控制端共用。** 控制端只读自己的 db，**从不读**远程机的 `dispatcher.db` / `repos.json` / 主机列表。所以把 B 机注册成 A 的远程靶机后，A **看不到** B 自己本地注册过的仓库 —— 你要在 A 的界面重新注册（主机选 B）。又因为 mirror 目录带控制端 repoId 前缀，同一个仓库会在 B 磁盘上被克隆成两份不同目录（`1-x.git` vs `3-x.git`），**不去重、不共享**。
- **不会自我引用 / 成环。** 主机图不是传递的，没有发现或爬取：A 连 B 只通过 ssh 跑 git/tmux/fs 命令操作 B 的数据目录，不会把 B 的「本机」或 B 注册过的远程导进来。「本机（host #0）」永远只指当前跑 dispatcher 的这台。

> **建议：单控制端。** 让靶机只当远程，别再开它自己的本地 dispatcher。否则两个控制端的 id 序列都从 1 起，拼出的磁盘路径 / 会话名（`mirrors/1-x.git`、`tdsp-1-…`）可能指向不同对象却**撞同一个路径**。单控制端 = 一份账本、一套 id、零冲突。

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

## 预设 / skill 注入（preset skills）
派发任务时可让会话**自带一套实践**：把若干 Claude Code skill 注入到该任务的 worktree，并用一段开场模板驱动 claude。框架对 skill 内容零认知 —— 实践全在 skill 与模板里。

- **skill 来源（只读，不入库，动态扫描）**：`~/.claude/skills/`、插件 cache `~/.claude/plugins/cache/**`、dispatcher 本地 `~/.task-dispatcher/skills/`、以及 dispatcher 安装目录 `~/.task-dispatcher/claude-config/plugins/cache/**`。每个 skill 以 `源:name` 标识（如 `plugin:brainstorming`）。要加自写 skill，把标准 skill 目录放进上述任一位置即可。
- **从官方市场安装（header「Skills」）**：浏览 `claude` 官方插件市场，选落点安装 —— **全局**（`claude plugin install` → `~/.claude`）或 **dispatcher 本地**（`CLAUDE_CONFIG_DIR=~/.task-dispatcher/claude-config claude plugin install`，**不碰用户全局 `~/.claude`**）。装好的插件，其捆绑 skill 自动进上面的来源列表。（skill 以插件为载体分发，故安装单位是插件。）
- **预设**：header「预设」里新建/命名 —— 一段开场 `dispatch_prompt` 模板（变量 `{title}/{slug}/{branch}/{prompt}`）+ 引用的 skill 列表。
- **派发**：填标题后选一个预设、再勾选额外 skill。派发时框架把 (预设引用 ∪ 勾选) 的 skill **整目录**拷进 `<worktree>/.claude/skills/`（写 `.git/info/exclude` 防污染 git），开场消息末尾追加「本任务已带入 skills: …」。本机/远程一致（远程经 `Runner.putDir` 走 tar+ssh）。
- **校验**：派发前先校验引用的 skill 都存在，缺任何一个立即报错、任务创建失败、不留半成品。

## 结构
```
server/
  paths.ts   路径常量
  db.ts      better-sqlite3: repos / tasks
  git.ts     mirror clone / fetch / 列分支 / worktree 生命周期
  tmux.ts    会话 起/查/杀
  mr.ts      glab 开 MR
  skills.ts  读穿式 skill 源扫描 / 解析（源:name）
  presets.ts 开场 prompt 模板渲染 + skills 清单行
  plugins.ts 官方渠道安装（全局 / dispatcher 隔离 CLAUDE_CONFIG_DIR）
  runner.ts  本机/远程执行抽象（exec/mkdirp/putDir…）
  i18n.ts    服务端文案唯一真源（API 错误消息 zh/en）
  index.ts   REST API（含 /api/skills、/api/presets、派发注入）+ /pty WebSocket
web/                 看板 + xterm 终端（无前端构建：原生 ES Module + 静态托管）
  index.html 仅骨架：HTML 标记 + <link> + <script>
  i18n.js    前端文案唯一真源（UI 字符串 zh/en）+ t() / applyStatic
  css/app.css  全部样式
  js/        按关注点拆分的 ES Module：
    dom.js      $ / api 工具
    feedback.js toast / loading 遮罩
    dialog.js   promise 化的 confirm / prompt
    select.js   自定义 <select> 组件
    terminal.js xterm 终端 + 底部 dock + openPty
    state.js    跨模块共享的可变状态
    repos.js    仓库列表 / 卡片 / 注册弹窗
    hosts.js    机器（host）切换 / 注册 / 远程终端
    tasks.js    任务列表 / 派发弹窗（预设下拉 + 附加 skill）/ 生命周期 / 连接会话
    presets.js  预设管理弹窗（列/建/删 + 选 skill + 模板）
    skills.js   Skills 弹窗（浏览官方插件 + 选落点安装）
    main.js     入口：把内联 onclick 处理函数桥接到 window + 初始化
  vendor/    自托管的 xterm（无外部 CDN）
~/.task-dispatcher/  每台机器：mirrors/ worktrees/ repos.json（+ 控制器的 dispatcher.db）
```

## i18n（中 / en）
两份字典，各自是所属层的**唯一真源**，互不依赖：
- **前端** `web/i18n.js`：所有界面文案。静态标签用 `data-i18n="key"`（textContent）/
  `data-i18n-ph="key"`（placeholder）；JS 动态文案调 `t("key", { name })`。
- **服务端** `server/i18n.ts`：API 返回的固定错误消息。路由里用
  `tr(langFromReq(req), "key", { ... })`。
- **语言选择**：前端按 `localStorage.lang` > 浏览器语言自动判定，header 右上角文字按钮手动切换并持久化；
  前端每个请求带 `X-Lang` 头，WebSocket 带 `?lang=`，服务端据此返回对应语言。
- **新增文案**：在对应字典的 `zh` 和 `en` **同时**加同名 key（两份文件底部都有 key 一致性
  自检，缺翻译会在控制台告警，运行时回退 en→key）。`{name}` 为插值占位符。
- **不翻译**：git / glab / node-pty 等外部工具透传的原始报错（动态、非我方文案），保持原样。

## 注意
- token 目前明文存 sqlite，仅供本机自用；要多人用需加密 + 鉴权。
- 服务监听 localhost；网页终端等于把 shell 暴露给能访问该端口的人，别裸暴露到公网。
