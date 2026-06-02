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
      "term.selectHint": "⇧ 拖拽选中",
      "term.selectHintTitle": "终端开了鼠标模式,普通拖拽会发给会话;按住 Shift(或 mac 的 Option)拖拽即可选中,松手自动复制",

      // shared dialog buttons
      "dialog.cancel": "取消",
      "dialog.ok": "确定",
      "common.delete": "删除",

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

      // local quick task (repo-less)
      "local.new": "＋ 本地任务",
      "local.tag": "本地",
      "local.starting": "正在启动本地会话…",

      // custom <select>
      "cs.placeholder": "请选择",
      "cs.empty": "无可选项",
      "cs.loading": "加载中…",

      // repo card / empty state
      "repo.delTitle": "删除仓库",
      "repo.delConfirm": "删除该仓库镜像？",
      "repo.forceDelConfirm": "该仓库下还有 {count} 个进行中的任务。强制删除会杀掉它们的会话、删除 worktree 和任务记录。确定？",
      "repo.emptyTitle": "还没有仓库",
      "repo.emptyHintPre": "注册一个 Git 仓库",
      "repo.emptyHintPost": "开始派发任务",

      // task card
      "task.waiting": "等待你授权",
      "task.stopTitle": "停止会话并归档",
      "task.worktreeKept": "worktree 未删",
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

      // machines (remote hosts)
      "host.new": "＋ 新建机器",
      "host.heading": "机器",
      "host.local": "本机",
      "host.terminal": "终端",
      "host.noRepos": "还没有仓库",
      "host.onMachine": "注册到",
      "host.modalTitle": "新建机器",
      "host.namePh": "名称 (例: gpu-box)",
      "host.targetPh": "ssh 目标 (例: user@192.168.1.10)",
      "host.kindLabel": "连接方式",
      "host.sessionPh": "远程 tmux 会话名 (默认 main)",
      "host.submit": "添加",
      "host.hint": "复用本机 ~/.ssh 登录态。连上后 shell / tmux / 代码 / 文件全在远程机器上，本机只做中继。",
      "host.del": "删除机器",
      "host.emptyTitle": "还没有机器",
      "host.emptyHintPre": "添加一台可 SSH 的远程机",
      "host.emptyHintPost": "在网页里操作它",
      "host.required": "名称 / ssh 目标必填",
      "host.added": "机器已添加",
      "host.delConfirm": "删除该机器入口？（不影响远程机本身）",
      // presets + skill injection
      "preset.heading": "预设",
      "preset.manage": "预设",
      "preset.new": "＋ 新建预设",
      "preset.modalTitle": "新建预设",
      "preset.namePh": "预设名称",
      "preset.descPh": "描述（可选）",
      "preset.promptPh": "开场 prompt 模板，变量 {title} {slug} {branch} {prompt}",
      "preset.skillsLabel": "引用的 skills",
      "preset.submit": "保存预设",
      "preset.required": "预设名称必填",
      "preset.added": "预设已保存",
      "preset.delTitle": "删除预设",
      "preset.delConfirm": "删除该预设？",
      "preset.empty": "还没有预设",
      "task.presetLabel": "预设",
      "task.presetNone": "无（自由 prompt）",
      "task.extraSkills": "附加 skill",
      "skill.none": "（无可用 skill）",
      "skill.manage": "Skills",
      "skill.modalTitle": "安装 skill（官方插件）",
      "skill.target": "落点",
      "skill.targetGlobal": "全局 (~/.claude)",
      "skill.targetDispatcher": "dispatcher 本地",
      "skill.filterPh": "筛选插件…",
      "skill.install": "安装",
      "skill.installing": "安装中…（克隆插件，可能十几秒）",
      "skill.installedToast": "已安装：{name}",
      "skill.loadFailed": "加载可用插件失败",
      "skill.availableEmpty": "没有可用插件",
      "skill.loading": "加载中…",
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
      "term.selectHint": "⇧ Drag-select",
      "term.selectHintTitle": "The terminal runs in mouse mode, so a plain drag is sent to the session; hold Shift (or Option on mac) and drag to select, release to copy automatically.",

      "dialog.cancel": "Cancel",
      "dialog.ok": "OK",
      "common.delete": "Delete",

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

      // local quick task (repo-less)
      "local.new": "＋ Local task",
      "local.tag": "local",
      "local.starting": "Starting local session…",

      "cs.placeholder": "Select…",
      "cs.empty": "No options",
      "cs.loading": "Loading…",

      "repo.delTitle": "Delete repository",
      "repo.delConfirm": "Delete this repository mirror?",
      "repo.forceDelConfirm": "This repository still has {count} task(s) in progress. Force delete will kill their sessions, remove their worktrees and delete the task records. Proceed?",
      "repo.emptyTitle": "No repositories yet",
      "repo.emptyHintPre": "Register a Git repository",
      "repo.emptyHintPost": "to start dispatching tasks",

      "task.waiting": "Waiting for your approval",
      "task.stopTitle": "Stop session & archive",
      "task.worktreeKept": "worktree kept",
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

      "host.new": "＋ New machine",
      "host.heading": "Machines",
      "host.local": "Local",
      "host.terminal": "Terminal",
      "host.noRepos": "No repos yet",
      "host.onMachine": "Register to",
      "host.modalTitle": "New machine",
      "host.namePh": "Name (e.g. gpu-box)",
      "host.targetPh": "ssh target (e.g. user@192.168.1.10)",
      "host.kindLabel": "Connection",
      "host.sessionPh": "Remote tmux session (default main)",
      "host.submit": "Add",
      "host.hint": "Reuses your local ~/.ssh. Once connected, the shell / tmux / code / files all live on the remote machine — this box is just a relay.",
      "host.del": "Delete machine",
      "host.emptyTitle": "No machines yet",
      "host.emptyHintPre": "Add a remote machine you can SSH into",
      "host.emptyHintPost": "to operate it from the browser",
      "host.required": "Name and ssh target are required",
      "host.added": "Machine added",
      "host.delConfirm": "Delete this machine entry? (the remote machine itself is unaffected)",
      // presets + skill injection
      "preset.heading": "Presets",
      "preset.manage": "Presets",
      "preset.new": "＋ New preset",
      "preset.modalTitle": "New preset",
      "preset.namePh": "Preset name",
      "preset.descPh": "Description (optional)",
      "preset.promptPh": "Opening prompt template; vars {title} {slug} {branch} {prompt}",
      "preset.skillsLabel": "Referenced skills",
      "preset.submit": "Save preset",
      "preset.required": "Preset name required",
      "preset.added": "Preset saved",
      "preset.delTitle": "Delete preset",
      "preset.delConfirm": "Delete this preset?",
      "preset.empty": "No presets yet",
      "task.presetLabel": "Preset",
      "task.presetNone": "None (freeform prompt)",
      "task.extraSkills": "Extra skills",
      "skill.none": "(no skills available)",
      "skill.manage": "Skills",
      "skill.modalTitle": "Install skills (official plugins)",
      "skill.target": "Install to",
      "skill.targetGlobal": "Global (~/.claude)",
      "skill.targetDispatcher": "Dispatcher-local",
      "skill.filterPh": "Filter plugins…",
      "skill.install": "Install",
      "skill.installing": "Installing… (cloning plugin, ~10s+)",
      "skill.installedToast": "Installed: {name}",
      "skill.loadFailed": "Failed to load available plugins",
      "skill.availableEmpty": "No plugins available",
      "skill.loading": "Loading…",
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
