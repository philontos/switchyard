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
//        <span   data-i18n-title="term.selectHintTitle"> // sets title (tooltip)
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
      "repo.new": "＋ 新建仓库",
      "repo.heading": "仓库",
      "tab.live": "任务列表",
      "tab.archived": "归档",
      "task.dispatch": "＋ 派发任务",

      // terminal dock
      "term.label": "终端",
      "term.notConnected": "未连接",
      "term.disconnected": "[已断开]",
      "term.creating": "正在创建任务…",
      "task.creating": "创建中…",
      "term.creationFailed": "创建失败",
      "term.dismiss": "关闭",
      "term.selectHint": "⇧ 拖拽选中",
      "term.selectHintTitle": "终端开了鼠标模式,普通拖拽会发给会话;按住 Shift(或 mac 的 Option)拖拽即可选中,松手自动复制",
      "term.empty": "点左侧任务进入终端",
      "term.claudeCopy": "点击复制完整 session id",

      // web preview (click a localhost link in the terminal → new browser tab)
      "preview.portPh": "端口",
      "preview.go": "在新标签打开预览",
      "preview.portTitle": "填 dev server 端口,在新标签打开当前任务的页面(用于链接没被自动识别时)",

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
      "common.stop": "停止",
      "task.stopConfirm": "停止该节点上的这个任务？",

      // repo modal
      "repo.modalTitle": "新建仓库",
      "repo.namePh": "名称 (例: ug)",
      "repo.urlPh": "git url (https / ssh)",
      "repo.tokenPh": "token — https 私有库才填，SSH 留空",
      "repo.defaultPh": "默认分支 (默认 main)",
      "repo.submit": "注册并克隆",
      "repo.hint": "克隆为 mirror，worktree 共享对象库。SSH 复用本地 ~/.ssh 与 glab 登录态，token 多半留空即可。",

      // task modal
      "task.modalTitle": "派发任务",
      "task.baseLabel": "基于分支",
      "task.branchPh": "选择分支",
      "task.loadingBranches": "加载分支…",
      "task.titlePh": "任务标题",
      "task.promptPh": "给 claude 的初始指令（可选）",
      "task.submit": "建 worktree + 起会话",

      // agent axis (which coding-agent CLI runs the task)
      "task.agentLabel": "智能体",
      "agent.modelLabel": "模型",
      "agent.codexModelPh": "Codex 模型（可选），留空用默认，如 gpt-5-codex",
      "agent.codexSkillsNote": "Codex 暂不支持附加 skill",
      "agent.codexAutoNote": "🔒 全自动：Codex 不会中途停下来问授权，使用本机已登录的 Codex 账号",

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
      "repo.menu": "仓库操作",
      "repo.delConfirm": "删除该仓库镜像？",
      "repo.forceDelConfirm": "该仓库下还有 {count} 个进行中的任务。强制删除会杀掉它们的会话、删除 worktree 和任务记录。确定？",
      "repo.emptyTitle": "还没有仓库",
      "repo.emptyHintPre": "注册一个 Git 仓库",
      "repo.emptyHintPost": "开始派发任务",

      // task card
      "task.waiting": "等待你授权",
      "task.renameHint": "双击重命名",
      "task.stopTitle": "停止会话并归档",
      "task.worktreeKept": "worktree 未删",
      "task.resume": "恢复",
      "task.resumeTitle": "会话已结束，重启并接回上次对话",
      "task.removeWorktree": "删除 worktree",
      "task.deleteRecord": "删除记录",
      "task.killConfirm": "kill 该任务的 tmux 会话？会话结束后自动归档（保留 worktree）。",
      "task.killTitle": "kill 会话",
      "task.removeWtConfirm": "删除该任务的 worktree？释放磁盘，工作目录将移除（不可恢复）。",

      // empty states (task lists)
      "empty.liveTitle": "还没有进行中的任务",
      "empty.liveHint": "在左侧仓库卡片点击「派发任务」开始",
      "empty.archTitle": "暂无已归档任务",
      "empty.archHint": "归档进行中的任务后会出现在这里",

      // loading overlay
      "loading.default": "处理中…",
      "loading.creatingWorktree": "正在拉取分支并创建 worktree…",

      // toasts
      "toast.opFailed": "操作失败",
      "toast.repoNotReady": "仓库尚未就绪",
      "toast.repoFieldsRequired": "名称和 git url 必填",
      "toast.repoRegistered": "仓库已注册，正在校验连接…",
      "toast.taskFieldsRequired": "仓库 / 分支 / 标题必填",
      "toast.taskDispatched": "任务已派发：{session}",
      "toast.dispatchFailed": "派发失败：{error}",
      "toast.killed": "已 kill 并归档",
      "toast.worktreeRemoved": "worktree 已删除",
      "toast.resumed": "已恢复会话",
      "toast.resumeFailed": "恢复失败：{error}",
      "toast.pasteOk": "图片已贴入终端（claude 显示为 [Image #N]）",
      "toast.pasteFailed": "贴图失败：{error}",
      "toast.claudeCopied": "已复制 Claude session id",

      // machines (remote hosts)
      "host.new": "＋ 新建机器",
      "host.heading": "机器",
      "host.blocked": "· 有任务在等你",
      "host.local": "本机",
      "host.terminal": "终端",
      "host.noRepos": "还没有仓库",
      "host.onMachine": "注册到",
      "host.modalTitle": "新建机器",
      "host.namePh": "名称 (例: gpu-box)",
      "host.targetPh": "ssh 目标 (例: user@192.168.1.10)",
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
      "host.unreachable": "不可达",
      "host.version": "版本不匹配，请升级该节点",
      "host.error": "读取失败",
      "node.group": "节点任务",
      "node.none": "该节点暂无任务",
      "node.newTask": "在该仓库新建任务",
      "toast.dispatchingToNode": "正在派发到 {name}…",
      "host.emptyTitle": "还没有机器",
      "host.emptyHintPre": "添加一台可 SSH 的远程机",
      "host.emptyHintPost": "在网页里操作它",
      "host.required": "名称 / ssh 目标必填",
      "host.added": "机器已添加",
      "host.delConfirm": "删除该机器入口？（不影响远程机本身）",
      // skill injection
      "task.extraSkills": "附加 skill",
      "skill.none": "（无可用 skill）",
      "skill.manage": "Skills",
      "skill.modalTitle": "安装 skill（官方插件）",
      "skill.filterPh": "筛选插件…",
      "skill.install": "安装",
      "skill.installing": "安装中…（克隆插件，可能十几秒）",
      "skill.installedToast": "已安装：{name}",
      "skill.loadFailed": "加载可用插件失败",
      "skill.availableEmpty": "没有可用插件",
      "skill.loading": "加载中…",

      // theme toggle (header)
      "theme.toLight": "切换到浅色",
      "theme.toDark": "切换到深色",
    },
    en: {
      "repo.new": "＋ New repo",
      "repo.heading": "Repositories",
      "tab.live": "Tasks",
      "tab.archived": "Archived",
      "task.dispatch": "＋ Dispatch task",

      "term.label": "Terminal",
      "term.notConnected": "Not connected",
      "term.disconnected": "[disconnected]",
      "term.creating": "Creating task…",
      "task.creating": "Creating…",
      "term.creationFailed": "Creation failed",
      "term.dismiss": "Dismiss",
      "term.selectHint": "⇧ Drag-select",
      "term.selectHintTitle": "The terminal runs in mouse mode, so a plain drag is sent to the session; hold Shift (or Option on mac) and drag to select, release to copy automatically.",
      "term.empty": "Pick a task on the left to open its terminal",
      "term.claudeCopy": "Click to copy the full session id",

      // web preview (click a localhost link in the terminal → side panel)
      "preview.portPh": "port",
      "preview.go": "Open preview in a new tab",
      "preview.portTitle": "Enter a dev-server port to open the current task's page in a new tab (for when the printed link isn't auto-detected)",

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
      "common.stop": "Stop",
      "task.stopConfirm": "Stop this task on the node?",

      "repo.modalTitle": "New repository",
      "repo.namePh": "Name (e.g. ug)",
      "repo.urlPh": "git url (https / ssh)",
      "repo.tokenPh": "token — only for private https repos, leave blank for SSH",
      "repo.defaultPh": "Default branch (defaults to main)",
      "repo.submit": "Register & clone",
      "repo.hint": "Cloned as a mirror; worktrees share the object store. SSH reuses your local ~/.ssh and glab login, so token can usually stay blank.",

      "task.modalTitle": "Dispatch task",
      "task.baseLabel": "Based on branch",
      "task.branchPh": "Select branch",
      "task.loadingBranches": "Loading branches…",
      "task.titlePh": "Task title",
      "task.promptPh": "Initial prompt for claude (optional)",
      "task.submit": "Create worktree + start session",

      // agent axis (which coding-agent CLI runs the task)
      "task.agentLabel": "Agent",
      "agent.modelLabel": "Model",
      "agent.codexModelPh": "Codex model (optional), blank = default, e.g. gpt-5-codex",
      "agent.codexSkillsNote": "Codex doesn't support extra skills yet",
      "agent.codexAutoNote": "🔒 Full-auto: Codex won't pause for approvals; uses this machine's Codex login",

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
      "repo.menu": "Repo actions",
      "repo.delConfirm": "Delete this repository mirror?",
      "repo.forceDelConfirm": "This repository still has {count} task(s) in progress. Force delete will kill their sessions, remove their worktrees and delete the task records. Proceed?",
      "repo.emptyTitle": "No repositories yet",
      "repo.emptyHintPre": "Register a Git repository",
      "repo.emptyHintPost": "to start dispatching tasks",

      "task.waiting": "Waiting for your approval",
      "task.renameHint": "Double-click to rename",
      "task.stopTitle": "Stop session & archive",
      "task.worktreeKept": "worktree kept",
      "task.resume": "Resume",
      "task.resumeTitle": "Session ended — relaunch and reattach the prior conversation",
      "task.removeWorktree": "Remove worktree",
      "task.deleteRecord": "Delete record",
      "task.killConfirm": "Kill this task's tmux session? It is archived automatically once the session ends (the worktree is kept).",
      "task.killTitle": "Kill session",
      "task.removeWtConfirm": "Remove this task's worktree? Frees disk; the working directory is deleted (not recoverable).",

      "empty.liveTitle": "No tasks in progress yet",
      "empty.liveHint": "Click “Dispatch task” on a repo card on the left to start",
      "empty.archTitle": "No archived tasks yet",
      "empty.archHint": "Archived tasks show up here after you archive an active one",

      "loading.default": "Working…",
      "loading.creatingWorktree": "Fetching branch and creating worktree…",

      "toast.opFailed": "Operation failed",
      "toast.repoNotReady": "Repository is not ready yet",
      "toast.repoFieldsRequired": "Name and git url are required",
      "toast.repoRegistered": "Repository registered, verifying connection…",
      "toast.taskFieldsRequired": "Repo / branch / title are required",
      "toast.taskDispatched": "Task dispatched: {session}",
      "toast.dispatchFailed": "Dispatch failed: {error}",
      "toast.killed": "Killed and archived",
      "toast.worktreeRemoved": "worktree removed",
      "toast.resumed": "Session resumed",
      "toast.resumeFailed": "Resume failed: {error}",
      "toast.pasteOk": "Image pasted into the terminal (shows as [Image #N] in claude)",
      "toast.pasteFailed": "Paste failed: {error}",
      "toast.claudeCopied": "Copied the Claude session id",

      "host.new": "＋ New machine",
      "host.heading": "Machines",
      "host.blocked": "· task needs you",
      "host.local": "Local",
      "host.terminal": "Terminal",
      "host.noRepos": "No repos yet",
      "host.onMachine": "Register to",
      "host.modalTitle": "New machine",
      "host.namePh": "Name (e.g. gpu-box)",
      "host.targetPh": "ssh target (e.g. user@192.168.1.10)",
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
      "host.unreachable": "unreachable",
      "host.version": "version mismatch — upgrade this node",
      "host.error": "read failed",
      "node.group": "Node tasks",
      "node.none": "no tasks on this node",
      "node.newTask": "New task on this repo",
      "toast.dispatchingToNode": "Dispatching to {name}…",
      "host.emptyTitle": "No machines yet",
      "host.emptyHintPre": "Add a remote machine you can SSH into",
      "host.emptyHintPost": "to operate it from the browser",
      "host.required": "Name and ssh target are required",
      "host.added": "Machine added",
      "host.delConfirm": "Delete this machine entry? (the remote machine itself is unaffected)",
      // skill injection
      "task.extraSkills": "Extra skills",
      "skill.none": "(no skills available)",
      "skill.manage": "Skills",
      "skill.modalTitle": "Install skills (official plugins)",
      "skill.filterPh": "Filter plugins…",
      "skill.install": "Install",
      "skill.installing": "Installing… (cloning plugin, ~10s+)",
      "skill.installedToast": "Installed: {name}",
      "skill.loadFailed": "Failed to load available plugins",
      "skill.availableEmpty": "No plugins available",
      "skill.loading": "Loading…",

      // theme toggle (header)
      "theme.toLight": "Switch to light",
      "theme.toDark": "Switch to dark",
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
