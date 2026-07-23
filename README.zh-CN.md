<p align="center">
  <img src="web/assets/switchyard-wordmark.png" alt="Switchyard" width="360">
</p>

<p align="center"><a href="README.md">English</a> · 简体中文</p>

<h3 align="center">把你自己的电脑变成始终在线的 AI 开发机。</h3>

<p align="center">
  从手机给 Claude Code、Codex 或 Kimi 派活。<br>
  任务在隔离环境里继续执行，等有空再回来验收或接管。
</p>

<p align="center">
  <img src="docs/screenshots/desktop-board.png" alt="Switchyard 桌面端看板：多个并行任务与真实 Claude Code 终端" width="100%">
</p>

## Switchyard 是什么

Switchyard 是运行在用户自己电脑上的、**本地优先的 AI Coding Agent 控制平面**。每个任务都有真实的 git worktree 和 tmux 会话；得到授权的任意浏览器，看到的都是这份持续存在的工作现场。

- **关掉浏览器，任务仍然继续。** 会话由 tmux 持有，网页只是入口。
- **多个任务并行，互不覆盖。** 每个任务有独立的分支、worktree 和终端。
- **在电脑与手机之间切换，现场不丢。** 随时看进度、回答确认，或进入真实 TUI 接管。
- **按任务选择最合适的 Agent。** Claude Code、Codex、Kimi Code 可以共用一块看板，也能为任务指定 Kimi K3 等模型。
- **连接更多电脑，但不引入中心服务器。** 每台机器都是完整、独立的 Switchyard 节点，也是自身任务的唯一真源。

网络层刻意保持很薄：

```text
手机 / 任意浏览器 ── 私有 HTTPS ──► A 机器上的 Switchyard
                                             │
                                             └── SSH 控制 ──► B 机器上的 Switchyard

A 持有：A 的仓库 · 数据库 · worktree · tmux 会话 · Agent
B 持有：B 的仓库 · 数据库 · worktree · tmux 会话 · Agent
```

A 可以通知 B 创建或操作任务，但实际处理和数据保存都发生在 B。远端没有安装 Switchyard 时不会走兼容捷径，也不允许向它派任务。

## 快速开始

每台要作为开发机使用的电脑，只需安装一次。

**环境要求：** Node.js 22+、`git`、`tmux` 与 zsh。当前一键脚本会同时预检 `claude` 和 `kimi`，因此这两个命令都需要已经安装并可达；Codex 为可选项，计划使用时需单独确认。

```sh
git clone https://github.com/philontos/switchyard.git
cd switchyard
./scripts/setup.sh
tdsp serve
```

打开 [http://127.0.0.1:4500](http://127.0.0.1:4500)，本机派发已经可以直接使用。

`setup.sh` 会检查 tmux 与 SSH 实际使用的非交互 shell、安装 npm 依赖、把缺失的 Claude/Kimi PATH 补进 `~/.zshenv`，并安装全局 `tdsp` 启动器。脚本可安全重复执行；`./scripts/setup.sh --check` 只检查、不修改。派发 Codex 任务前，还需确认 `zsh -c` 能找到 `codex`。

### 让这台开发机可远程访问

点击顶部常驻的 **连接设备**。它不是用完即消失的新手弹窗，而是随时可以回看的状态中心，会持续检查：

1. Tailscale 私有 HTTPS；
2. Switchyard 运行期间电脑能否保持唤醒；
3. 手机接入状态与二维码；
4. 可选的其它电脑发现与 SSH 就绪状态。

每张卡片都来自机器的实时状态，只呈现当前有用的下一步。远程配置未完成，不会影响本机继续使用。

<p align="center">
  <img src="docs/screenshots/onboarding.png" alt="Switchyard 连接设备引导：检查私有网络、电源与手机接入" width="100%">
</p>

## 连接手机

1. 在电脑和手机上安装 [Tailscale 官方客户端](https://tailscale.com/download)，登录同一个账号。
2. 打开 **连接设备**。Switchyard 会检查登录与 Tailscale Serve 授权，再通过私有 HTTPS 发布本机回环服务。
3. 用手机扫码，在 Safari 中打开。
4. 推荐：Safari → 分享 → **添加到主屏幕** → **作为网页 App 打开**。

只有私有路由真正可用后才会出现二维码。Switchyard 不会打开 Tailscale Funnel，也不会把控制台暴露到公网。

## 连接另一台电脑

在那台电脑上也走一遍快速开始，并登录同一个 Tailscale 账号。之后在任意一端：

1. 点击机器栏里的 `+`；
2. 选择 **发现设备**；
3. 在发现的 Switchyard 节点旁点击 **连接**；
4. 如果状态提示，再开启系统 SSH / 远程登录。

<p align="center">
  <img src="docs/screenshots/device-discovery.png" alt="在同一 Tailscale 账号下自动发现 Switchyard 开发机" width="100%">
</p>

连接是双向的：双方核验 Tailscale 账号归属，交换稳定节点身份、准确的 `tdsp` 路径以及各 profile 专用的 SSH key，再互相登记。即使系统 SSH 尚未开启，这一步也可以先完成；**真正的仓库、任务、终端和文件操作仍依赖 SSH**，开启远程登录后会自动转为在线。

| 层 | 职责 |
|---|---|
| Tailscale | 私有身份、网络可达、路径选择与节点发现 |
| HTTPS | Web 访问、就绪探测与首次双向连接 |
| SSH | 节点命令、终端传输与文件操作 |
| 目标机器上的 Switchyard | 真正执行仓库 / 任务 / worktree / tmux / Agent 操作，并保存全部状态 |

不适合自动发现时，仍可手动填写 SSH 主机，作为高级回退入口。

## 日常使用流程

1. **登记仓库。** 添加 GitHub 或 GitLab 地址，Switchyard 在目标机器创建本地 mirror。
2. **派发任务。** 选择目标机器、仓库、基础分支、Agent、可选模型和开场指令。
3. **让它自己执行。** 目标机器自动创建工作分支、隔离 worktree 和 tmux 会话。
4. **只在需要时回来。** 围观终端、在手机读进度、粘贴图片、回答权限确认，或直接用 tmux 接管。
5. **明确收尾。** 可以只归档会话并保留 worktree，也可以清理两者或删除记录。

<p align="center">
  <img src="docs/screenshots/dispatch-modal.png" alt="把一个 Kimi K3 任务派发到新的隔离 worktree" width="100%">
</p>

主机重启或 tmux 会话意外结束不会破坏工作目录。只要 worktree 还在，点击 **恢复** 就会用原来的 Agent、模型和端点重建会话。每个节点的 **Shells** 分组还可以创建不绑定仓库的终端，用于临时排查和一次性命令。

## Agent 与模型

| Agent | 任务配置 | 当前 Switchyard 能力 |
|---|---|---|
| **Claude Code** | 本机登录，或经过连通性验证的 Anthropic 兼容端点 | 实时终端、恢复、图片粘贴、可选 Skill 注入、原生权限等待状态、本机移动端会话阅读 |
| **Codex** | 本机登录与可选模型 ID | 实时终端、恢复、图片粘贴、全权限启动、本机移动端会话阅读 |
| **Kimi Code / Kimi K3** | 本机登录与可选模型 ID，例如 `k3` | 交互式 `--auto` 终端、恢复与图片粘贴 |

所选 Agent 与模型属于任务本身，恢复时会被保留。Provider 凭据只留在真正运行任务的机器，不会复制给其它节点。

当前能力边界：附加 Skill 注入和黄色「需要你」权限状态只支持 Claude Code；远程节点与 Kimi 的会话记录暂未接入 **阅读** 模式，这些任务会直接进入实时终端。

## 为手机完整适配

窄屏不是缩小版桌面，而是一套完整的触控流程。

<p align="center">
  <img src="docs/screenshots/mobile-board.png" alt="Switchyard 移动端任务看板" width="32%">
  <img src="docs/screenshots/mobile-reading.png" alt="Switchyard 移动端会话阅读与 Needs you 操作" width="32%">
  <img src="docs/screenshots/mobile-dispatch-codex.png" alt="从手机派发 Codex 任务" width="32%">
</p>

- **看板 → 任务** 接入浏览器 history 与 iOS 边缘返回手势。
- **阅读 | 实时** 可在原生会话流与真正可交互的终端之间切换。
- 顶部 **需要你** 提示可以从进度阅读一键跳到正在等待的确认。
- 输入条贴合软键盘，支持多行，并为每个任务保存独立的未发送草稿。
- 触控滚动、终端惯性、文本选择、缩放和主屏幕 Web App 启动体验都针对手机做了处理。

## 网络与常在线

Switchyard 默认只监听 `127.0.0.1:4500`。推荐用 Tailscale 远程接入，但它是可选的系统级依赖，不是 npm 包：

```sh
tdsp serve --tailscale                  # 回环应用 + tailnet 私有 HTTPS
tdsp network status                    # 查看 Tailscale 身份与节点
tdsp network diagnose <peer>           # 判断直连、Peer Relay 或 DERP
tdsp network off --https-port 443       # 只移除 Switchyard 的 Serve 路由
```

Tailscale 会先尝试 WireGuard 直连，再尝试已授权的 Peer Relay，最后回退到 DERP。已有私有网络也可以继续使用：

```sh
tdsp serve --host-cidr 10.10.0.0/24     # 绑定现有 WireGuard / 局域网网段中的本机地址
```

在 macOS 上，**运行期间保持唤醒**会在接电时创建一个可逆、绑定当前进程的 `caffeinate` 断言。显示器仍可正常熄灭，Switchyard 退出后保活自动释放。合盖运行仍受 macOS 与硬件条件限制；引导只报告当前状态，不绕过系统保护。

<details>
<summary>严格 NAT 或 DERP 路径太远时，使用同城 VPS 中继</summary>

VPS 可以只运行 [Tailscale Peer Relay](https://tailscale.com/docs/features/peer-relay)，不需要安装 Switchyard。它需要 Tailscale 1.86+、一个可达的 UDP 端口，以及严格限定范围的 tailnet grant：

```sh
sudo tailscale set --relay-server-port=40000
# VPS 已安装 tdsp 且有权管理 tailscaled 时，也可以：
tdsp network relay enable --port 40000
tdsp network diagnose <peer>
```

`tdsp network relay disable` 只会移除这一个中继监听。

</details>

<details>
<summary>运行一套不影响正式环境的并行测试 profile</summary>

Profile 会隔离 sqlite、namespace、mirror、worktree、SSH key 与 socket、启动器和端口，只共享当前 checkout：

```sh
npm run -s tdsp -- install --profile canary
~/.task-dispatcher/profiles/canary/bin/tdsp \
  serve --port 14500 --tailscale --tailscale-port 14500
```

适合在完全不触碰正式 `:4500` 的前提下测试网络和节点互联。

</details>

## 命令速查

| 命令 | 作用 |
|---|---|
| `tdsp serve [--port N] [--tailscale]` | 启动本机控制台，并可选发布 tailnet 私有 HTTPS |
| `tdsp serve --host-cidr CIDR` | 额外绑定现有私有网段中的本机地址 |
| `tdsp network status/setup/diagnose/off` | 检查或管理 Switchyard 的 Tailscale 链路 |
| `tdsp list` | 以 JSON 打印本节点的仓库与任务 |
| `tdsp create-local` | 在本节点创建裸 tmux shell |
| `tdsp create` | 在本节点创建仓库任务 |
| `tdsp repo-create/repo-fetch/repo-branches/repo-delete` | 操作本节点自己的仓库目录 |
| `tdsp stop/resume/cleanup/delete-task` | 操作本节点自己的任务生命周期 |
| `tdsp doctor legacy [--json]` | 只读检查旧版本残留的远程归属数据 |
| `tdsp install [--profile name]` | 安装全局启动器或隔离 profile |
| `tdsp update` | 快进更新已安装的 checkout 并刷新依赖 |

## 安全说明

- Web 终端等同于 shell 权限。只应放在回环、私有 tailnet、可信私有网段，或自己带认证的反向代理之后。
- 不要把 `HOST=0.0.0.0` 直接暴露到公网。Switchyard 当前没有应用层的多用户认证。
- 仓库 token 与 Provider key 以明文保存在节点本地 sqlite 中；当前版本面向个人与可信设备。
- Switchyard 会为节点生成带独立标记的专用 SSH 授权记录，不会替换个人 SSH key。
- 页面只渲染所选节点自身持有的数据。节点离线或尚未完成 setup 时会如实提示，不会回退为由控制端代管。

## 开发

```sh
npm install
npm test
npm run screenshots:readme
```

截图命令会让真实 Web 前端连接一次性 mock 服务，用无头 Chrome 实际走完关键交互，再把确定性、已脱敏的图片写入 `docs/screenshots/`。它不会打开真实 Switchyard 数据库或 tmux 会话。Chrome 不在默认位置时可通过 `CHROME_BIN` 指定。

主要代码边界：

```text
server/core/         路径、sqlite、schema、迁移、i18n
server/repo/         mirror 与任务 worktree
server/task/         节点本地任务生命周期与 CLI 命令
server/session/      tmux、PTY 与 Claude/Codex/Kimi 启动参数
server/fleet/        SSH runner、bootstrap、存活探测与节点视图
server/network/      Tailscale Serve、路径诊断与 Peer Relay
server/onboarding/   网络、手机、电源与舰队实时就绪状态
server/http/         REST、WebSocket 与预览路由
web/js/features/     看板、节点、终端、移动端、阅读与引导 UI
```
