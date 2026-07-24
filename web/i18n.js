// Frontend i18n — the SINGLE SOURCE OF TRUTH for every user-facing string in
// the web UI. (Server-returned messages are localized separately in
// server/i18n.ts.) No build step: this file is loaded as a plain <script>
// before the app script in index.html, exposing a global `I18N` and `t()`.
//
// HOW TO ADD / USE A STRING
//   1. Add the key to BOTH `zh` and `en` in DICT below. Keep both sets
//      identical — the dev check at the bottom warns in the console if they
//      drift, and t() falls back to en then to the raw key.
//   2. Use `{name}` placeholders for interpolated values, e.g.
//        "task.dispatched": "Task dispatched: {session}"
//      then call `t("task.dispatched", { session })`.
//   3. STATIC markup (lives in index.html): tag the element instead of writing
//      a literal —
//        <button data-i18n="repo.new"></button>          // sets textContent
//        <input  data-i18n-ph="repo.namePh">             // sets placeholder
//        <button data-i18n-title="term.attachCopy">      // sets title (tooltip)
//      I18N.applyStatic() fills every tagged element and re-runs on language
//      switch, so static text needs no JS.
//   4. DYNAMIC text built in JS (toasts, dialogs, cards, empty states): call
//      `t("some.key")`. Anything that renders content must re-render on switch
//      — wire it through I18N.onChange (see index.html).
//
// Keys are grouped by area with dotted names (repo.*, task.*, toast.*, …) so
// related strings stay together and new features get an obvious home.

(function () {
  const DICT = {
    zh: {
      // top-level nav / layout
      "task.dispatch": "＋ 派发任务",

      // terminal dock
      "term.notConnected": "未连接",
      "term.disconnected": "[已断开]",
      "term.creating": "正在创建任务…",
      "task.creating": "创建中…",
      "term.creationFailed": "创建失败",
      "term.dismiss": "关闭",
      "term.attach": "Attach",
      "term.attachCopy": "点击复制 tmux attach 命令",
      "term.empty": "点左侧任务进入终端",
      "term.claudeCopy": "点击复制完整 session id",

      // read-only repository tree + task diff explorer
      "code.open": "查看代码",
      "code.refresh": "刷新代码快照",
      "code.close": "关闭代码预览",
      "code.files": "文件",
      "code.changes": "改动",
      "code.back": "返回",
      "code.repoTitle": "代码 · {name}",
      "code.taskTitle": "任务代码 · {name}",
      "code.changesCount": "改动 ({count})",
      "code.approximate": "推定基线",
      "code.loading": "正在读取代码…",
      "code.selectFile": "从左侧选择一个文件",
      "code.selectChange": "从左侧选择一个改动",
      "code.nodeUpdate": "该节点版本不支持代码预览，请先更新节点",
      "code.emptyRepo": "这个版本没有可显示的文件",
      "code.treeTruncated": "仓库文件较多，目录已截断显示",
      "code.noChanges": "相对派发基线暂无改动",
      "code.binary": "二进制文件不提供内容预览",
      "code.tooLarge": "文件较大（{size}），MVP 暂不加载",
      "code.symlink": "软链接只展示在目录中，不跟随读取",
      "code.submodule": "Git submodule 暂不展开",
      "code.unavailable": "这个文件无法预览",
      "code.binaryDiff": "二进制文件已变化，不提供文本 diff",
      "code.diffTooLarge": "diff 较大，MVP 暂不加载",
      "code.diffTruncated": "diff 较大，已截断显示",
      "code.viewMode": "文件展示方式",
      "code.structure": "结构",
      "code.source": "源码",
      "code.structureTruncated": "结构较大，已截断显示",

      // terminal-centric layout: col2 list (groups + machine header)
      "repo.repoWord": "仓库",
      "repo.noTasks": "暂无任务",
      "host.manage": "机器管理",
      "list.localGroup": "Shells",
      "list.archived": "已归档",
      "local.none": "暂无 shell",

      // shared dialog buttons
      "dialog.cancel": "取消",
      "dialog.ok": "确定",
      "common.delete": "删除",
      "common.stop": "终止任务",
      "task.stopConfirm": "确定要终止任务“{task}”吗？当前会话会立即结束并归档，worktree 将保留。",

      // repo modal
      "repo.modalTitle": "新建仓库",
      "repo.urlLabel": "Git 地址 *",
      "repo.urlPh": "git@github.com:owner/repo.git",
      "repo.nameLabel": "显示名称 *",
      "repo.namePh": "例：aurelia",
      "repo.tokenLabel": "访问令牌（可选）",
      "repo.tokenPh": "token — https 私有库才填，SSH 留空",
      "repo.defaultLabel": "默认分支（可选）",
      "repo.defaultPh": "默认分支 (默认 main)",
      "repo.submit": "添加并校验",
      "repo.urlRequired": "请输入 Git 地址。",
      "repo.nameRequired": "请填写显示名称。",
      "repo.submitting": "正在注册…",
      "repo.submittingHint": "正在保存仓库并校验 Git 连接；私有 SSH 仓库会使用这台机器的 ~/.ssh key。",
      "repo.submitFailed": "注册失败：{error}",
      "repo.statusChecking": "校验连接中",
      "repo.statusError": "连接失败",
      "repo.hint": "SSH 私有库示例：git@github.com:owner/repo.git，token 留空，并确认运行 tdsp 的这台机器有 GitHub SSH 权限。HTTPS 私有库才填写 token。",

      // task modal
      "task.modalTitle": "派发任务",
      "task.baseLabel": "基于分支",
      "task.branchPh": "选择分支",
      "task.loadingBranches": "加载分支…",
      "task.titlePh": "任务标题",
      "task.promptPh": "给智能体的初始指令（可选）",
      "task.submit": "建 worktree + 起会话",

      // agent axis (which coding-agent CLI runs the task)
      "task.agentLabel": "智能体",
      "agent.modelLabel": "模型",
      "agent.codexModelPh": "Codex 模型（可选），留空用默认，如 gpt-5-codex",
      "agent.codexAutoNote": "🔓 完全放开：Codex 可 push/联网/跑 gh；极少数情况会停下问授权(此时任务静默等待)，使用本机已登录的 Codex 账号",
      "agent.kimiModelPh": "Kimi 模型（可选），留空用默认，如 kimi-code/kimi-for-coding",
      "agent.kimiAutoNote": "Kimi 以 auto 模式启动；普通工具审批由 Kimi Code 自动处理，使用本机已登录的 Kimi 账号",

      // shells (bare tmux, per machine — local or remote)
      "local.new": "新建 shell",
      "local.tag": "shell",
      "local.starting": "正在启动 shell…",

      // custom <select>
      "cs.placeholder": "请选择",
      "cs.empty": "无可选项",
      "cs.loading": "加载中…",

      // model backends (alternate providers for claude, e.g. GLM)
      "provider.label": "模型后端",
      "provider.default": "Anthropic 默认",
      "provider.manage": "管理模型后端",
      "provider.namePh": "名称，如 GLM-4.6",
      "provider.urlPh": "Base URL（Anthropic 兼容端点）",
      "provider.tokenPh": "API Key / Token",
      "provider.modelPh": "模型名，如 glm-4.6",
      "provider.fastPh": "小/快模型（可选），如 glm-4.5-air",
      "provider.test": "测试连接",
      "provider.add": "保存",
      "provider.testing": "测试中…",
      "provider.reachable": "✓ 可达",
      "provider.added": "已添加模型后端",
      "provider.none": "暂无模型后端",
      "provider.hint": "先测试连接，绿灯通过后才能保存。探测方式与 claude 运行时一致。",

      // repo card / empty state
      "repo.delTitle": "删除仓库",
      "repo.delConfirm": "删除该仓库镜像？",
      "repo.forceDelConfirm": "该仓库下还有 {count} 个进行中的任务。强制删除会杀掉它们的会话、删除 worktree 和任务记录。确定？",

      // task card
      "task.waiting": "等待你授权",
      "task.renameHint": "双击重命名",
      "task.stopTitle": "终止任务并归档",
      "task.worktreeKept": "worktree 未删",
      "task.resume": "恢复",
      "task.resumeTitle": "会话已结束，重启并接回上次对话",
      "task.removeWorktree": "删除 worktree",
      "task.deleteRecord": "删除记录",
      "task.removeWtConfirm": "删除该任务的 worktree？释放磁盘，工作目录将移除（不可恢复）。",

      // archived task list
      "empty.archTitle": "暂无已归档任务",

      // loading overlay
      "loading.default": "处理中…",
      "loading.creatingWorktree": "正在拉取分支并创建 worktree…",
      "system.updateTitle": "更新并重启",
      "system.updating": "正在更新代码…",
      "system.restarting": "已更新，正在按原启动参数重启…",

      // toasts
      "toast.opFailed": "操作失败",
      "toast.repoNotReady": "仓库尚未就绪",
      "toast.repoRegistered": "仓库 #{id} 已注册，正在校验连接…",
      "toast.repoExists": "仓库 #{id} 已经注册，已定位现有记录",
      "toast.taskFieldsRequired": "仓库 / 分支 / 标题必填",
      "toast.taskDispatched": "任务已派发：{session}",
      "toast.dispatchFailed": "派发失败：{error}",
      "toast.killed": "任务已终止并归档",
      "toast.worktreeRemoved": "worktree 已删除",
      "toast.resumed": "已恢复会话",
      "toast.resumeFailed": "恢复失败：{error}",
      "toast.pasteOk": "图片已贴入终端",
      "toast.pasteFailed": "贴图失败：{error}",
      "toast.claudeCopied": "已复制 Claude session id",
      "toast.attachCopied": "已复制 attach 命令",
      "toast.termReconnecting": "终端连接已断开，正在重连；输入未发送",

      // machines (remote hosts)
      "host.blocked": "· 有任务在等你",
      "host.local": "本机",
      "host.noRepos": "还没有仓库",
      "host.onMachine": "注册到",
      "host.modalTitle": "新建机器",
      "host.namePh": "名称 (例: gpu-box)",
      "host.targetPh": "ssh 目标 (例: user@192.168.1.10)",
      "host.profilePh": "隔离 profile（可选，如 tailscale-test）",
      "host.kindLabel": "连接方式",
      "host.submit": "添加",
      "host.hint": "复用本机 ~/.ssh 登录态。连上后 shell / tmux / 代码 / 文件全在远程机器上，本机只做中继。",
      "host.del": "删除机器",
      "host.bootstrap": "安装 tdsp",
      "host.installing": "安装中…（约 1 分钟，请稍候）",
      "host.update": "更新代码",
      "host.updating": "正在更新 {name}…",
      "host.updated": "{name} 已更新到最新",
      "host.upToDate": "{name} 已是最新",
      "host.bootstrapping": "正在 {name} 上安装 tdsp…",
      "host.bootstrapped": "{name} 已安装 tdsp",
      "host.liveTasks": "{n} 个实时任务",
      "host.outdated": "节点代码较旧，请点击“更新代码”",
      "host.unreachable": "不可达",
      "host.version": "版本不匹配，请升级该节点",
      "host.error": "读取失败",
      "host.sshPending": "已连接，SSH 尚未就绪",
      "node.group": "节点任务",
      "node.newTask": "在该仓库新建任务",
      "host.required": "名称 / ssh 目标必填",
      "host.added": "机器已添加",
      "host.delConfirm": "删除该机器入口？（不影响远程机本身）",
      "discovery.title": "发现设备",
      "discovery.hint": "搜索同一 Tailscale 账号下正在运行 Switchyard 的在线设备。",
      "discovery.refresh": "重新搜索",
      "discovery.searching": "正在搜索 Tailnet 中的设备…",
      "discovery.empty": "没有发现在线设备",
      "discovery.manual": "手动添加",
      "discovery.ready": "Switchyard 已就绪",
      "discovery.notSwitchyard": "未发现 Switchyard",
      "discovery.unavailable": "不可连接",
      "discovery.connect": "连接",
      "discovery.connecting": "连接中…",
      "discovery.connected": "已连接",
      "discovery.connectedToast": "设备已双向连接，SSH 已就绪",
      "discovery.connectedSshPending": "设备已双向连接；SSH 尚未就绪",
      // first-run and remote-access onboarding
      "onboarding.nav": "连接设备",
      "onboarding.navReady": "远程访问已就绪",
      "onboarding.navPending": "继续远程访问设置",
      "onboarding.kicker": "REMOTE SETUP",
      "onboarding.title": "让这台电脑随时可用",
      "onboarding.subtitle": "逐项检查本机在线状态、手机接入和多电脑连接；本地功能始终可以直接使用。",
      "onboarding.recheck": "重新检查",
      "onboarding.continue": "进入 Switchyard",
      "onboarding.done": "已完成",
      "onboarding.actionNeeded": "需要操作",
      "onboarding.pending": "待完成",
      "onboarding.optional": "可选",
      "onboarding.working": "处理中…",
      "onboarding.copy": "复制",
      "onboarding.copied": "手机访问地址已复制",
      "onboarding.network.title": "建立安全远程网络",
      "onboarding.network.install": "安装 Tailscale",
      "onboarding.network.login": "登录 Tailscale",
      "onboarding.network.start": "启动并连接",
      "onboarding.network.authorize": "授权私有 HTTPS",
      "onboarding.network.configure": "配置远程访问",
      "onboarding.network.configured": "Tailscale 远程访问已配置",
      "onboarding.network.ready": "已通过 Tailscale 账号 {account} 私密发布。",
      "onboarding.network.dnsWarning": "本机当前无法解析 Tailscale MagicDNS（可能被 VPN 或 DNS 设置接管）；在这台电脑上可继续使用 {localUrl}。手机和其他设备仍应使用下面的 Tailscale HTTPS 地址。",
      "onboarding.network.state.tailscale-missing": "尚未安装 Tailscale。安装官方客户端后返回这里继续。",
      "onboarding.network.state.tailscale-login": "Tailscale 正在等待登录，请使用你自己的账号完成认证。",
      "onboarding.network.state.tailscale-stopped": "Tailscale 已安装但尚未连接。",
      "onboarding.network.state.serve-consent": "Tailnet 尚未授权 Tailscale Serve 的私有 HTTPS。",
      "onboarding.network.state.serve-setup": "Tailscale 已连接，可以为本机控制台配置私有 HTTPS。",
      "onboarding.network.state.serve-conflict": "目标 HTTPS 端口已被其他 Serve/Funnel 路由使用；Switchyard 不会覆盖它。",
      "onboarding.network.state.network-error": "无法确认 Tailscale 或 Serve 状态，请查看下面的错误后重试。",
      "onboarding.power.title": "保持开发机始终在线",
      "onboarding.power.manual": "当前系统需要手动确认不会因空闲进入睡眠。",
      "onboarding.power.needsPower": "当前正在使用电池。24/7 模式需要接通电源；Switchyard 的安全保活只在接电时生效。",
      "onboarding.power.runtimeReady": "Switchyard 运行期间会阻止系统空闲睡眠，但允许屏幕正常熄灭。",
      "onboarding.power.systemReady": "系统已配置为不因空闲进入睡眠。",
      "onboarding.power.needsAction": "系统目前可能在空闲 {minutes} 分钟后睡眠，远程任务会因此中断。",
      "onboarding.power.enable": "运行期间保持唤醒",
      "onboarding.power.disable": "关闭 Switchyard 保活",
      "onboarding.power.displaySleep": "显示器仍可在 {minutes} 分钟后熄灭，不影响后台任务。",
      "onboarding.power.displayNever": "显示器当前不会自动熄灭；可在系统设置中单独设置显示器睡眠时间。",
      "onboarding.power.lid": "MacBook 合盖通常仍会睡眠。只有接电并满足 macOS 支持的闭盖模式条件时才可靠；Switchyard 不会绕过这项系统保护。",
      "onboarding.power.lidReady": "macOS 当前报告已满足闭盖运行条件；请持续接电并保持外接设备条件不变。",
      "onboarding.power.enabledToast": "已启用运行时保活；退出 Switchyard 后自动解除",
      "onboarding.power.disabledToast": "已关闭 Switchyard 运行时保活",
      "onboarding.phone.title": "连接手机",
      "onboarding.phone.blocked": "完成 Tailscale 私有 HTTPS 后即可生成手机二维码。",
      "onboarding.phone.verified": "{device} 已成功打开这台开发机。",
      "onboarding.phone.device": "手机",
      "onboarding.phone.waiting": "等待手机扫码并在 Safari 中打开…",
      "onboarding.phone.qrAlt": "手机访问 Switchyard 的二维码",
      "onboarding.phone.stepTailscale": "在手机安装 Tailscale，并登录同一账号 {account}。",
      "onboarding.phone.stepScan": "用系统相机扫描二维码，在 Safari 中打开。",
      "onboarding.phone.stepHome": "在 Safari 分享菜单中选择“添加到主屏幕”。",
      "onboarding.fleet.title": "连接另一台开发机",
      "onboarding.fleet.none": "当前还没有连接其他 Switchyard 开发机。",
      "onboarding.fleet.otherSetup": "先在另一台电脑完成本机安装和 Tailscale 步骤，它随后会自动出现在设备发现中。",
      "onboarding.fleet.discover": "发现设备",
      "onboarding.fleet.ready": "已连接 {count} 台开发机，双向 SSH 均已就绪。",
      "onboarding.fleet.manage": "管理设备",
      "onboarding.fleet.pending": "SSH 已就绪 {ready} 台，仍待处理 {pending} 台。",
      "onboarding.fleet.macos-remote-login": "在本机打开“系统设置 → 通用 → 共享 → 远程登录”，然后重新检查。",
      "onboarding.fleet.linux-openssh": "在本机启用 OpenSSH server，再重新检查。",
      "onboarding.fleet.windows-openssh": "在 Windows 可选功能中安装并启动 OpenSSH Server，再重新检查。",
      "onboarding.fleet.remotePending": "本机 SSH 已开启；请在仍未就绪的另一台电脑打开它自己的 Onboarding 查看具体提示。",
      "onboarding.mobileWelcome.title": "手机连接成功",
      "onboarding.mobileWelcome.body": "Safari 已安全连接到 {machine}。现在可以查看任务、回复确认并进入实时终端。",
      "onboarding.mobileWelcome.home": "建议：点击 Safari 的分享按钮，再选择“添加到主屏幕”，以后就像 App 一样打开。",
      // theme toggle (header)
      "theme.toLight": "切换到浅色",
      "theme.toDark": "切换到深色",

      // mobile (touch layout: master-detail views + quick-input bar)
      "m.back": "返回列表",
      "m.send": "发送",
      "m.inputPh": "输入发给终端…",
      "m.fnKeys": "特殊按键",
      "read.tabRead": "阅读",
      "read.tabLive": "实时",
      "read.needsYou": "需要确认",
      "read.goLive": "去实时 →",
      "read.latest": "最新",
      "read.loading": "加载中…",
      "read.empty": "还没有对话记录",
      "read.you": "你",
      "read.thinking": "思考",
      "read.running": "运行中…",
      "read.noOutput": "（无输出）",
    },
    en: {
      "task.dispatch": "＋ Dispatch task",

      "term.notConnected": "Not connected",
      "term.disconnected": "[disconnected]",
      "term.creating": "Creating task…",
      "task.creating": "Creating…",
      "term.creationFailed": "Creation failed",
      "term.dismiss": "Dismiss",
      "term.attach": "Attach",
      "term.attachCopy": "Click to copy the tmux attach command",
      "term.empty": "Pick a task on the left to open its terminal",
      "term.claudeCopy": "Click to copy the full session id",

      // read-only repository tree + task diff explorer
      "code.open": "Browse code",
      "code.refresh": "Refresh code snapshot",
      "code.close": "Close code preview",
      "code.files": "Files",
      "code.changes": "Changes",
      "code.back": "Back",
      "code.repoTitle": "Code · {name}",
      "code.taskTitle": "Task code · {name}",
      "code.changesCount": "Changes ({count})",
      "code.approximate": "estimated baseline",
      "code.loading": "Reading code…",
      "code.selectFile": "Select a file on the left",
      "code.selectChange": "Select a change on the left",
      "code.nodeUpdate": "This node does not support code preview yet; update it first",
      "code.emptyRepo": "No files to show in this revision",
      "code.treeTruncated": "This repository is large; the file tree has been truncated",
      "code.noChanges": "No changes from the dispatch baseline",
      "code.binary": "Binary file contents are not previewed",
      "code.tooLarge": "This file is too large ({size}) for the MVP preview",
      "code.symlink": "Symlinks appear in the tree but are not followed",
      "code.submodule": "Git submodules are not expanded yet",
      "code.unavailable": "This file cannot be previewed",
      "code.binaryDiff": "This binary file changed; no text diff is available",
      "code.diffTooLarge": "This diff is too large for the MVP preview",
      "code.diffTruncated": "This diff is large and has been truncated",
      "code.viewMode": "File view mode",
      "code.structure": "Structure",
      "code.source": "Source",
      "code.structureTruncated": "This structure is large and has been truncated",

      // terminal-centric layout: col2 list (groups + machine header)
      "repo.repoWord": "repo",
      "repo.noTasks": "No tasks yet",
      "host.manage": "Machine settings",
      "list.localGroup": "Shells",
      "list.archived": "Archived",
      "local.none": "No shells yet",

      "dialog.cancel": "Cancel",
      "dialog.ok": "OK",
      "common.delete": "Delete",
      "common.stop": "Stop task",
      "task.stopConfirm": "Stop “{task}”? Its session will end immediately and the task will be archived; the worktree will be kept.",

      "repo.modalTitle": "New repository",
      "repo.urlLabel": "Git URL *",
      "repo.urlPh": "git@github.com:owner/repo.git",
      "repo.nameLabel": "Display name *",
      "repo.namePh": "e.g. aurelia",
      "repo.tokenLabel": "Access token (optional)",
      "repo.tokenPh": "token — only for private https repos, leave blank for SSH",
      "repo.defaultLabel": "Default branch (optional)",
      "repo.defaultPh": "Default branch (defaults to main)",
      "repo.submit": "Add & verify",
      "repo.urlRequired": "Enter a Git URL.",
      "repo.nameRequired": "Enter a display name.",
      "repo.submitting": "Registering…",
      "repo.submittingHint": "Saving the repository and checking Git access; private SSH repos use this machine's ~/.ssh key.",
      "repo.submitFailed": "Registration failed: {error}",
      "repo.statusChecking": "checking access",
      "repo.statusError": "access failed",
      "repo.hint": "For private SSH repos, use git@github.com:owner/repo.git, leave token blank, and make sure the machine running tdsp has GitHub SSH access. Only HTTPS private repos need a token.",

      "task.modalTitle": "Dispatch task",
      "task.baseLabel": "Based on branch",
      "task.branchPh": "Select branch",
      "task.loadingBranches": "Loading branches…",
      "task.titlePh": "Task title",
      "task.promptPh": "Initial prompt for the agent (optional)",
      "task.submit": "Create worktree + start session",

      // agent axis (which coding-agent CLI runs the task)
      "task.agentLabel": "Agent",
      "agent.modelLabel": "Model",
      "agent.codexModelPh": "Codex model (optional), blank = default, e.g. gpt-5-codex",
      "agent.codexAutoNote": "🔓 Full access: Codex can push / network / run gh; may rarely pause for approval (task then waits silently); uses this machine's Codex login",
      "agent.kimiModelPh": "Kimi model (optional), blank = default, e.g. kimi-code/kimi-for-coding",
      "agent.kimiAutoNote": "Kimi starts in auto mode; normal tool approvals are handled by Kimi Code and it uses this machine's Kimi login",

      // shells (bare tmux, per machine — local or remote)
      "local.new": "New shell",
      "local.tag": "shell",
      "local.starting": "Starting shell…",

      "cs.placeholder": "Select…",
      "cs.empty": "No options",
      "cs.loading": "Loading…",

      // model backends (alternate providers for claude, e.g. GLM)
      "provider.label": "Model backend",
      "provider.default": "Anthropic (default)",
      "provider.manage": "Manage model backends",
      "provider.namePh": "Name, e.g. GLM-4.6",
      "provider.urlPh": "Base URL (Anthropic-compatible endpoint)",
      "provider.tokenPh": "API Key / Token",
      "provider.modelPh": "Model, e.g. glm-4.6",
      "provider.fastPh": "Small/fast model (optional), e.g. glm-4.5-air",
      "provider.test": "Test",
      "provider.add": "Save",
      "provider.testing": "Testing…",
      "provider.reachable": "✓ Reachable",
      "provider.added": "Model backend added",
      "provider.none": "No model backends yet",
      "provider.hint": "Test first — Save unlocks only on a green check. The probe matches how claude calls the backend at runtime.",

      "repo.delTitle": "Delete repository",
      "repo.delConfirm": "Delete this repository mirror?",
      "repo.forceDelConfirm": "This repository still has {count} task(s) in progress. Force delete will kill their sessions, remove their worktrees and delete the task records. Proceed?",

      "task.waiting": "Waiting for your approval",
      "task.renameHint": "Double-click to rename",
      "task.stopTitle": "Stop task & archive",
      "task.worktreeKept": "worktree kept",
      "task.resume": "Resume",
      "task.resumeTitle": "Session ended — relaunch and reattach the prior conversation",
      "task.removeWorktree": "Remove worktree",
      "task.deleteRecord": "Delete record",
      "task.removeWtConfirm": "Remove this task's worktree? Frees disk; the working directory is deleted (not recoverable).",

      "empty.archTitle": "No archived tasks yet",

      "loading.default": "Working…",
      "loading.creatingWorktree": "Fetching branch and creating worktree…",
      "system.updateTitle": "Update and restart",
      "system.updating": "Updating code…",
      "system.restarting": "Updated; restarting with the original serve arguments…",

      "toast.opFailed": "Operation failed",
      "toast.repoNotReady": "Repository is not ready yet",
      "toast.repoRegistered": "Repository #{id} registered, verifying connection…",
      "toast.repoExists": "Repository #{id} is already registered; showing the existing entry",
      "toast.taskFieldsRequired": "Repo / branch / title are required",
      "toast.taskDispatched": "Task dispatched: {session}",
      "toast.dispatchFailed": "Dispatch failed: {error}",
      "toast.killed": "Task stopped and archived",
      "toast.worktreeRemoved": "worktree removed",
      "toast.resumed": "Session resumed",
      "toast.resumeFailed": "Resume failed: {error}",
      "toast.pasteOk": "Image pasted into the terminal",
      "toast.pasteFailed": "Paste failed: {error}",
      "toast.claudeCopied": "Copied the Claude session id",
      "toast.attachCopied": "Copied the attach command",
      "toast.termReconnecting": "Terminal is reconnecting; your input was not sent",

      "host.blocked": "· task needs you",
      "host.local": "Local",
      "host.noRepos": "No repos yet",
      "host.onMachine": "Register to",
      "host.modalTitle": "New machine",
      "host.namePh": "Name (e.g. gpu-box)",
      "host.targetPh": "ssh target (e.g. user@192.168.1.10)",
      "host.profilePh": "Isolated profile (optional, e.g. tailscale-test)",
      "host.kindLabel": "Connection",
      "host.submit": "Add",
      "host.hint": "Reuses your local ~/.ssh. Once connected, the shell / tmux / code / files all live on the remote machine — this box is just a relay.",
      "host.del": "Delete machine",
      "host.bootstrap": "Install tdsp",
      "host.installing": "Installing… (~1 min, please wait)",
      "host.update": "Update code",
      "host.updating": "Updating {name}…",
      "host.updated": "{name} updated to latest",
      "host.upToDate": "{name} already up to date",
      "host.bootstrapping": "Installing tdsp on {name}…",
      "host.bootstrapped": "tdsp installed on {name}",
      "host.liveTasks": "{n} live tasks",
      "host.outdated": "node code is outdated; click Update code",
      "host.unreachable": "unreachable",
      "host.version": "version mismatch — upgrade this node",
      "host.error": "read failed",
      "host.sshPending": "Connected; SSH is not ready yet",
      "node.group": "Node tasks",
      "node.newTask": "New task on this repo",
      "host.required": "Name and ssh target are required",
      "host.added": "Machine added",
      "host.delConfirm": "Delete this machine entry? (the remote machine itself is unaffected)",
      "discovery.title": "Discover devices",
      "discovery.hint": "Find online Switchyard nodes signed in to the same Tailscale account.",
      "discovery.refresh": "Search again",
      "discovery.searching": "Searching devices in your tailnet…",
      "discovery.empty": "No online devices found",
      "discovery.manual": "Add manually",
      "discovery.ready": "Switchyard ready",
      "discovery.notSwitchyard": "Switchyard not found",
      "discovery.unavailable": "Unavailable",
      "discovery.connect": "Connect",
      "discovery.connecting": "Connecting…",
      "discovery.connected": "Connected",
      "discovery.connectedToast": "Devices connected both ways; SSH is ready",
      "discovery.connectedSshPending": "Devices connected both ways; SSH is not ready yet",
      // first-run and remote-access onboarding
      "onboarding.nav": "Connect devices",
      "onboarding.navReady": "Remote access is ready",
      "onboarding.navPending": "Continue remote-access setup",
      "onboarding.kicker": "REMOTE SETUP",
      "onboarding.title": "Keep this computer available",
      "onboarding.subtitle": "Check always-on readiness, phone access, and multi-computer connections step by step. Local use always remains available.",
      "onboarding.recheck": "Check again",
      "onboarding.continue": "Enter Switchyard",
      "onboarding.done": "Done",
      "onboarding.actionNeeded": "Action needed",
      "onboarding.pending": "Pending",
      "onboarding.optional": "Optional",
      "onboarding.working": "Working…",
      "onboarding.copy": "Copy",
      "onboarding.copied": "Phone access URL copied",
      "onboarding.network.title": "Create a secure remote network",
      "onboarding.network.install": "Install Tailscale",
      "onboarding.network.login": "Sign in to Tailscale",
      "onboarding.network.start": "Start and connect",
      "onboarding.network.authorize": "Authorize private HTTPS",
      "onboarding.network.configure": "Configure remote access",
      "onboarding.network.configured": "Tailscale remote access configured",
      "onboarding.network.ready": "Privately published under Tailscale account {account}.",
      "onboarding.network.dnsWarning": "This computer cannot currently resolve Tailscale MagicDNS (a VPN or DNS setting may be taking over); keep using {localUrl} here. Phones and other devices should still use the Tailscale HTTPS URL below.",
      "onboarding.network.state.tailscale-missing": "Tailscale is not installed. Install the official client, then return here.",
      "onboarding.network.state.tailscale-login": "Tailscale is waiting for sign-in. Authenticate with your own account.",
      "onboarding.network.state.tailscale-stopped": "Tailscale is installed but not connected.",
      "onboarding.network.state.serve-consent": "This tailnet has not authorized private HTTPS for Tailscale Serve.",
      "onboarding.network.state.serve-setup": "Tailscale is connected and can privately publish this local console.",
      "onboarding.network.state.serve-conflict": "The HTTPS port is already owned by another Serve/Funnel route. Switchyard will not overwrite it.",
      "onboarding.network.state.network-error": "Switchyard could not confirm Tailscale or Serve state. Review the error below and retry.",
      "onboarding.power.title": "Keep the development machine online",
      "onboarding.power.manual": "Confirm manually that this system will not enter idle sleep.",
      "onboarding.power.needsPower": "This computer is on battery. A 24/7 machine should be plugged in; Switchyard's safe assertion applies only on AC power.",
      "onboarding.power.runtimeReady": "While Switchyard runs, idle system sleep is prevented while the display may still turn off normally.",
      "onboarding.power.systemReady": "The system is already configured not to idle-sleep.",
      "onboarding.power.needsAction": "The system may currently sleep after {minutes} idle minutes, interrupting remote work.",
      "onboarding.power.enable": "Keep awake while running",
      "onboarding.power.disable": "Disable Switchyard keep-awake",
      "onboarding.power.displaySleep": "The display may still turn off after {minutes} minutes without affecting background work.",
      "onboarding.power.displayNever": "The display is not set to turn off automatically; display sleep can be configured separately in System Settings.",
      "onboarding.power.lid": "Closing a MacBook normally still sleeps it. It is reliable only while plugged in under macOS-supported closed-display conditions; Switchyard does not bypass this protection.",
      "onboarding.power.lidReady": "macOS currently reports that closed-display operation is available. Keep AC power and the required external-device conditions unchanged.",
      "onboarding.power.enabledToast": "Runtime keep-awake enabled; it is released automatically when Switchyard exits",
      "onboarding.power.disabledToast": "Switchyard runtime keep-awake disabled",
      "onboarding.phone.title": "Connect a phone",
      "onboarding.phone.blocked": "Finish private Tailscale HTTPS to generate the phone QR code.",
      "onboarding.phone.verified": "{device} successfully opened this development machine.",
      "onboarding.phone.device": "Phone",
      "onboarding.phone.waiting": "Waiting for a phone to scan and open in Safari…",
      "onboarding.phone.qrAlt": "QR code for phone access to Switchyard",
      "onboarding.phone.stepTailscale": "Install Tailscale on the phone and sign in to the same account, {account}.",
      "onboarding.phone.stepScan": "Scan this code with the system camera and open it in Safari.",
      "onboarding.phone.stepHome": "In Safari's Share menu, choose Add to Home Screen.",
      "onboarding.fleet.title": "Connect another development machine",
      "onboarding.fleet.none": "No other Switchyard development machine is connected yet.",
      "onboarding.fleet.otherSetup": "Finish local installation and Tailscale setup on the other computer first; it will then appear automatically in discovery.",
      "onboarding.fleet.discover": "Discover devices",
      "onboarding.fleet.ready": "{count} development machine(s) connected with bidirectional SSH ready.",
      "onboarding.fleet.manage": "Manage devices",
      "onboarding.fleet.pending": "SSH ready on {ready}; still pending on {pending}.",
      "onboarding.fleet.macos-remote-login": "On this Mac, open System Settings → General → Sharing → Remote Login, then check again.",
      "onboarding.fleet.linux-openssh": "Enable the OpenSSH server on this computer, then check again.",
      "onboarding.fleet.windows-openssh": "Install and start OpenSSH Server from Windows Optional Features, then check again.",
      "onboarding.fleet.remotePending": "Local SSH is enabled. Open Onboarding on the remaining computer for its specific guidance.",
      "onboarding.mobileWelcome.title": "Phone connected",
      "onboarding.mobileWelcome.body": "Safari is securely connected to {machine}. You can now inspect tasks, answer confirmations, and enter live terminals.",
      "onboarding.mobileWelcome.home": "Recommended: tap Safari's Share button and choose Add to Home Screen for an app-like launch.",
      // theme toggle (header)
      "theme.toLight": "Switch to light",
      "theme.toDark": "Switch to dark",

      // mobile (touch layout: master-detail views + quick-input bar)
      "m.back": "Back to list",
      "m.send": "Send",
      "m.inputPh": "Type to the terminal…",
      "m.fnKeys": "Special keys",
      "read.tabRead": "Read",
      "read.tabLive": "Live",
      "read.needsYou": "Needs you",
      "read.goLive": "Live →",
      "read.latest": "Latest",
      "read.loading": "Loading…",
      "read.empty": "No conversation yet",
      "read.you": "You",
      "read.thinking": "Thinking",
      "read.running": "Running…",
      "read.noOutput": "(no output)",
    },
  };

  const DEFAULT_LANG = "en";
  let lang = DEFAULT_LANG;

  function interpolate(s, params) {
    return params
      ? s.replace(/\{(\w+)\}/g, (_, k) => (params[k] != null ? String(params[k]) : `{${k}}`))
      : s;
  }

  function t(key, params) {
    const table = DICT[lang] || {};
    if (key in table) return interpolate(table[key], params);
    if (key in DICT[DEFAULT_LANG]) {
      console.warn("[i18n] missing key for", lang, "→", key);
      return interpolate(DICT[DEFAULT_LANG][key], params);
    }
    console.warn("[i18n] unknown key", key);
    return interpolate(key, params);
  }

  function applyStatic(root) {
    const scope = root || document;
    scope.querySelectorAll("[data-i18n]").forEach((el) => {
      el.textContent = t(el.getAttribute("data-i18n"));
    });
    scope.querySelectorAll("[data-i18n-ph]").forEach((el) => {
      el.setAttribute("placeholder", t(el.getAttribute("data-i18n-ph")));
    });
    scope.querySelectorAll("[data-i18n-title]").forEach((el) => {
      el.setAttribute("title", t(el.getAttribute("data-i18n-title")));
    });
  }

  function detect() {
    let saved = null;
    try { saved = localStorage.getItem("lang"); } catch (_) {}
    if (saved && DICT[saved]) return saved;
    const nav = ((navigator.languages && navigator.languages[0]) || navigator.language || "").toLowerCase();
    return nav.startsWith("zh") ? "zh" : DEFAULT_LANG;
  }

  function setLang(next) {
    if (!DICT[next] || next === lang) return;
    lang = next;
    try { localStorage.setItem("lang", next); } catch (_) {}
    document.documentElement.lang = next;
    applyStatic();
    if (typeof I18N.onChange === "function") I18N.onChange(lang);
  }

  // Resolve the initial locale from storage / browser before first paint.
  function init() {
    lang = detect();
    document.documentElement.lang = lang;
  }

  const I18N = {
    t,
    applyStatic,
    setLang,
    init,
    onChange: null, // app sets this to re-render dynamic content on switch
    get lang() { return lang; },
    get languages() { return Object.keys(DICT); },
  };
  window.I18N = I18N;
  window.t = t; // convenience alias used throughout the app script

  // Dev-time guard: keep both locales in lockstep so nothing ships half-translated.
  const zhKeys = Object.keys(DICT.zh);
  const enKeys = Object.keys(DICT.en);
  const onlyZh = zhKeys.filter((k) => !(k in DICT.en));
  const onlyEn = enKeys.filter((k) => !(k in DICT.zh));
  if (onlyZh.length || onlyEn.length) {
    console.warn("[i18n] key mismatch between zh/en", { onlyZh, onlyEn });
  }
})();
