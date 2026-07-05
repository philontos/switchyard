<p align="center">
  <img src="web/assets/switchyard-wordmark.png" alt="Switchyard" width="360">
</p>

<p align="center"><a href="README.md">English</a> | 简体中文</p>

> 一个 web 控制台，把「交给 AI 一个编码任务」变成甩一张牌。每个任务都是一个**真实、可交互的 Claude Code 或 Codex**，跑在自己专属的 git worktree + tmux 会话里；你从浏览器直接进入那个终端，看它干活，随时接管。多个任务并行互不干扰，局域网里的每台机器都是一等节点——在一个页面上派发、围观、收工。手机上同样是完整体验：加到主屏幕就是一个 App。

<p align="center">
  <img src="docs/screenshots/desktop-board.png" alt="桌面总览:左侧按仓库分组的任务看板,右侧真实的 Claude Code 终端" width="100%">
</p>

## 一个 repo，N 个并行的 worktree 任务

核心玩法以仓库为中心：`+repo` 接入仓库（GitHub / GitLab，注册即克隆），之后对着它随手派任务。**每个任务**自动从你选的基础分支拉出**独立的 git worktree + 独立工作分支 + 独立 tmux 会话**——agent 在自己的目录里干自己的活，互不覆盖工作区、互不打断。想同时推进三个 feature？对同一个仓库派三张卡就是了，回头逐个验收（归档 / 清理 / 删除）。

任务的宿主是机器上的 tmux，**网页只是取景器**：关掉浏览器任务照跑，换台设备打开会话原样都在；也可以随时从自己的终端 `tmux attach` 接管同一个会话，权限确认、斜杠命令这些 TUI 交互在网页里原样可用。

> 顺带一提：不挂仓库也能直接开终端——在本机或任何远程节点的 Shells 组点 ＋，在指定目录起一个真 tmux shell（临时排查、跑脚本都行），和仓库任务同一套列表 / 连接 / 归档流程。

## 多 CLI × 多模型端点

派发任务时**按任务选 agent CLI**——当前支持 **Claude Code** 与 **Codex**，同一块看板上并肩跑，卡片按 CLI 上色，一眼分清。本机、远程完全对等：派到哪台机器，哪台机器就跑你选的那个 CLI。

<p align="center">
  <img src="docs/screenshots/dispatch-modal.png" alt="派发弹窗:Claude Code / Codex 双选 + 分支 + 开场指令 + 模型后端" width="100%">
</p>

- **Claude Code** —— 完整能力：技能注入（派发时勾选官方插件技能，直接送进任务的 worktree）、权限确认黄灯（原生 hook 驱动，见下）。
- **Codex** —— 以 on-request + danger-full-access 启动，能 push、联网、跑 `gh`；派发时可指定模型（如 `gpt-5.2`），留空用机器默认。
- **多模型接入端点** —— 给 Claude Code 配任意 **Anthropic 兼容端点**（如 GLM），同一个 Claude Code TUI 驱动别家模型。添加端点时服务端按 claude 运行时的真实调用方式探测连通性，**绿灯才能保存**；之后每次派发按任务选用，选择会被记住。密钥是节点本地配置，永远不跨机传播。

## 多机协同

局域网里每台机器都是一等节点，一页管理：

- **舰队视图** —— 每个节点的仓库和任务经 ssh **现场读取**、按仓库分组；掉线或未安装的节点如实标注，绝不给你看过期数据。
- **派发到任何地方** —— 选中远程节点的仓库直接派；任务在那个节点上创建并归它所有，你在控制台连接/围观/停止，全部经 ssh 转达。远程派发同样有即时的乐观加载卡片，和本机手感一致。
- **一键装机** —— 控制台里点「安装 tdsp」，经 ssh 把代码和启动器装到远程机器上，装完即用。
- **状态直通** —— running / ready / cloning / errored 各有状态灯；Claude 停在权限确认上等你时，Claude Code 的**原生 hook** 把卡片点成**黄灯**「该你了」——本机远程同一套机制。

## 移动端

窄屏下自动切换成一套完整的触屏体验。**推荐的打开方式：Safari 访问 → 分享 → 「添加到主屏幕」→ 勾选「作为网页 App 打开」**——以独立 App 模式运行（无浏览器边框、深色启动底、无白闪），从此手机上点图标就进控制台，体验最接近原生 App。

<p align="center">
  <img src="docs/screenshots/mobile-board.png" alt="移动端任务列表" width="32%">
  <img src="docs/screenshots/mobile-reading.png" alt="移动端阅读模式:聊天式会话记录 + Needs you 黄条" width="32%">
  <img src="docs/screenshots/mobile-dispatch-codex.png" alt="移动端派发 Codex 任务" width="32%">
</p>

- **主-详双视图** —— 任务列表和全屏终端两页切换，点卡片进任务，iOS 边缘右划原生返回（接入浏览器 history，实时终端里也能划）。
- **阅读 | 实时 双模式** —— **阅读**把 Claude / Codex 的会话记录渲染成聊天流：原生滚动、自动追新、工具调用折叠展示，适合躺着翻进度；任务等你确认时顶部亮「Needs you」黄条，一键跳**实时**——那个真终端，要出手就在这。
- **贴键盘输入条** —— 输入条钉在 iOS 软键盘正上方，支持多行；每个任务有独立的未发送草稿，切换任务互不串词。
- **触控打磨** —— 禁双击/捏合缩放、禁误选 UI 文字、终端单指拖动 + 惯性滚动、hover 只在真悬停设备生效。

## 安装与启动（每台机器一次）

**前置：** Node 22+，装好 `git` / `tmux` / `claude`。拉代码，一条命令装完：

```sh
git clone <repo-url> switchyard && cd switchyard
./scripts/setup.sh   # 一键装机:环境预检 + npm install + 安装全局 tdsp(幂等,重跑无害)
tdsp serve           # 启动 → http://localhost:4500
```

> `setup.sh` 依次做三件事：① **环境预检**——用非交互 shell 验证 `claude` / `tmux` / `git` 可达（任务就是用这种只读 `~/.zshenv` 的 shell 启动的，找不到命令任务面板会直接死），缺的把所在目录幂等写进 `~/.zshenv`；② `npm install`（4 个运行时依赖，零构建）；③ 安装全局 `tdsp` 命令（`~/.task-dispatcher/src` 指向这份 clone，启动器链到 `~/.local/bin/tdsp`——敲不到就把 `~/.local/bin` 加进 PATH）。`--check` 只检查、不写不装。

装完之后，一切都是 `tdsp`：

```sh
tdsp serve                            # 启动控制台(只绑本机回环 :4500)
PORT=8080 tdsp serve                  # 换端口
tdsp serve --host-cidr 10.10.0.0/24   # 额外绑上落在该网段内的本机 IP
tdsp update                           # 更新:拉最新代码 + 刷依赖,重跑 tdsp serve 生效
```

`--host-cidr` 是给 WireGuard / Tailscale 这类私有组网用的：手机和电脑在同一个网段里，手机直接打开对应地址就是完整控制台（配合「添加到主屏幕」当 App 用）：

```
task-dispatcher on http://127.0.0.1:4500
task-dispatcher on http://10.10.0.3:4500
```

## 使用

1. **添加仓库** —— 名字 + git 地址（GitHub / GitLab；https 私有仓库填 token，SSH 留空）。注册并克隆，状态变 `ready`。
2. **派发任务** —— 选仓库 → 基础分支 → 标题 + 开场指令 → 选 agent（Claude Code / Codex）→（可选）技能、模型后端。自动建 worktree、开工。
3. **进终端** —— 右侧面板自动连上；卡片上的「进入终端」随时重连。你面对的就是真 agent。
4. **收尾** —— 归档（杀会话、留 worktree）/ 清理（杀会话 + 删 worktree）/ 删除（移除记录）。

### 添加远程机器

1. **注册** —— 在控制台填名字 + ssh 目标（如 `user@host`）。后台探针会显示它的在线状态。
2. **在它上面装 tdsp** —— 打开机器的 ⚙ 菜单，点**安装 tdsp**。一键经 ssh 完成：在那边 clone 代码（已有 clone 则复用）并装好启动器。
   - 已经自己跑控制台的机器本来就有 clone——在那台机器上跑一次 `npm run tdsp -- install`（复用现有 clone，不产生第二份），再回控制台点安装登记为就绪即可。
3. **用起来** —— 这台机器的仓库和实时任务出现在页面上，按仓库分组。选**它的**仓库派发（仓库组上的 ＋），或在它上面开 shell（Shells 组的 ＋）。

## tdsp 命令

每台机器跑的都是同一个 `tdsp`；控制端对远程执行一次性子命令即 `ssh <node> tdsp …`。

| 命令 | 作用 |
|---|---|
| `tdsp serve` | 启动 web 控制台（常驻服务）；`--host-cidr <网段>` 加绑私有组网地址 |
| `tdsp list` | 以 JSON 打印本机任务 + 仓库 |
| `tdsp create-local` | 在本机开一个裸 shell 任务 |
| `tdsp create` | 在本机创建仓库任务（由控制端驱动） |
| `tdsp stop <id>` | 停止本机的一个任务 |
| `tdsp branches` | 列出本机某个镜像的实时分支（供控制端派发时选择） |
| `tdsp install` | 用本机这份 clone 装好全局 `tdsp` |
| `tdsp update` | 更新本机安装：对 `~/.task-dispatcher/src` 指向的 clone 执行 `git pull --ff-only` + `npm install`；重启 serve 生效 |

## 说明

- **安全** —— 服务**默认只绑回环 `127.0.0.1`**，局域网碰不到。要暴露必须显式设 `HOST=0.0.0.0`（此时 web 终端等于把 shell 递给任何能摸到端口的人，**务必自加认证/反向代理——绝不裸奔公网**）。更推荐两种方式：ssh 隧道 `ssh -L 4500:localhost:4500 host`，或 `tdsp serve --host-cidr <网段>` 只绑私有组网（WireGuard / Tailscale）里的本机地址。访问其它节点用你的 ssh 密钥（登录即授权），不开新端口不加新协议。token 以**明文**存在 sqlite 里——仅限本地个人使用。
- **终端手感** —— 给 claude 开全屏渲染（会话里 `/tui fullscreen`，或每台机器的 `~/.claude/settings.json` 加 `{"tui":"fullscreen"}`），输入框固定、滚动顺滑、不再横向跳动。

## 结构

```
server/                REST API + /pty WebSocket;tdsp CLI;git / tmux / pty / ssh 的 Runner 编排
  index.ts             HTTP 入口:组装 app + http server,挂 WS,跑 boot,监听
  tdsp.ts              tdsp 入口(serve + 一次性子命令)
  http/                web 层 —— 盖在下面领域目录上的薄 HTTP 胶水
    app.ts             组装 express: json → 预览代理 → 静态 → 路由
    routes.ts          全部 /api/* 处理器
    ws.ts              upgrade 路由 + pty/tmux 终端中继
    preview.ts         dev-server 反向代理的上游解析
    context.ts         共享预编译语句 + 横切工具
  core/                路径、sqlite 库与 schema、迁移、服务端 i18n
  repo/                git 镜像、worktree、每任务的 repo 环境
  task/                任务生命周期(创建/清单/改名) + tdsp 节点本地 API(cli.ts)
  fleet/               远程主机:runner、bootstrap、存活探测、跨节点舰队视图
  session/             tmux 会话、pty 派生、attach 命令、agent 启动参数(claude / codex)
  skills/              技能扫描/解析、插件安装、hook 设置
  preview/             预览反向代理引擎
web/                   看板 + xterm 终端(原生 ES Modules,零构建)
  js/main.js           入口 —— 接线各模块,桥接内联 onclick
  js/core/             共享底座:dom、state、feedback、dialog、select
  js/features/         hosts、tasks、terminal、repos、providers、skills、reorder、mobile、reading
scripts/setup.sh       预检:校验 claude/tmux/git,修 ~/.zshenv 的 PATH
~/.task-dispatcher/    每台机器:
  src                  指向本机 clone 的指针(真 clone 或软链)
  bin/tdsp             全局启动器 → src
  <namespace>/         本机自己的数据: mirrors/ worktrees/ tasks/ dispatcher.db
```

> 服务端和前端各带一份中/英文案字典（`server/core/i18n.ts`、`web/i18n.js`），是各自层的唯一事实来源。更细的数据模型与节点语义见源码注释。
