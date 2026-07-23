const repoTask = ({
  id,
  repoId,
  title,
  agent,
  branch,
  waiting = false,
  alive = true,
  status = "running",
  model = null,
}) => ({
  id,
  repo_id: repoId,
  host_id: 1,
  kind: "repo",
  title,
  base_branch: "main",
  work_branch: branch,
  status,
  session: `switchyard-demo-${id}`,
  cwd: `/Users/demo/.switchyard/worktrees/${id}`,
  worktree_path: `/Users/demo/.switchyard/worktrees/${id}`,
  agent,
  agent_model: model,
  alive,
  waiting,
  hasWorktree: true,
  claude_session: agent === "claude" ? "0f6c0aa0-demo-48-onboarding-flow" : null,
  created_at: "2026-07-23 09:00:00",
});

export const repos = [
  {
    id: 1,
    name: "switchyard-web",
    git_url: "git@github.com:demo/switchyard-web.git",
    default_branch: "main",
    status: "ready",
    error: null,
    host_id: 1,
  },
  {
    id: 2,
    name: "relay-service",
    git_url: "git@github.com:demo/relay-service.git",
    default_branch: "main",
    status: "ready",
    error: null,
    host_id: 1,
  },
];

export const tasks = [
  repoTask({
    id: 48,
    repoId: 1,
    title: "Ship guided device onboarding",
    agent: "claude",
    branch: "feat/48-guided-onboarding",
    waiting: true,
  }),
  repoTask({
    id: 47,
    repoId: 1,
    title: "Add task usage dashboard",
    agent: "codex",
    model: "gpt-5-codex",
    branch: "feat/47-usage-dashboard",
  }),
  repoTask({
    id: 46,
    repoId: 2,
    title: "Polish mobile review mode",
    agent: "kimi",
    model: "k3",
    branch: "feat/46-mobile-review",
  }),
  repoTask({
    id: 44,
    repoId: 2,
    title: "Upgrade dependency graph",
    agent: "codex",
    model: "gpt-5-codex",
    branch: "chore/44-dependencies",
    alive: false,
    status: "cleaned",
  }),
];

export const hosts = [
  {
    id: 1,
    name: "Home Studio",
    target: "local",
    kind: "local",
    status: "online",
    connection_source: "local",
    ssh_ready: 1,
  },
  {
    id: 2,
    name: "Office MacBook",
    target: "demo@office-macbook.demo-tailnet.ts.net",
    kind: "ssh",
    status: "online",
    connection_source: "tailscale",
    ssh_ready: 1,
    node_id: "demo-office-node",
    tailscale_dns: "office-macbook.demo-tailnet.ts.net",
  },
  {
    id: 3,
    name: "GPU Workstation",
    target: "demo@gpu-workstation.demo-tailnet.ts.net",
    kind: "ssh",
    status: "online",
    connection_source: "tailscale",
    ssh_ready: 1,
    node_id: "demo-gpu-node",
    tailscale_dns: "gpu-workstation.demo-tailnet.ts.net",
  },
];

const remoteRepoTask = ({
  id,
  repoId,
  title,
  agent,
  branch,
  waiting = false,
  model = null,
}) => ({
  id,
  repo_id: repoId,
  kind: "repo",
  title,
  base_branch: "main",
  work_branch: branch,
  status: "running",
  session: `switchyard-remote-${id}`,
  cwd: `/Users/demo/.switchyard/worktrees/${id}`,
  agent,
  agent_model: model,
  alive: true,
  waiting,
  hasWorktree: true,
});

export const fleet = {
  schema_version: 1,
  nodes: [
    {
      node: { id: 1, name: "Home Studio" },
      kind: "local",
      ok: true,
      schema_version: 2,
      capabilities: ["node-control-v1", "code-view-v1"],
      tasks,
      repos,
    },
    {
      node: { id: 2, name: "Office MacBook" },
      kind: "ssh",
      ok: true,
      schema_version: 2,
      capabilities: ["node-control-v1", "code-view-v1"],
      tasks: [
        remoteRepoTask({
          id: 19,
          repoId: 11,
          title: "Review billing migration",
          agent: "claude",
          branch: "feat/19-billing-migration",
        }),
        remoteRepoTask({
          id: 18,
          repoId: 12,
          title: "Benchmark search index",
          agent: "codex",
          model: "gpt-5-codex",
          branch: "perf/18-search-index",
        }),
      ],
      repos: [
        { id: 11, name: "billing-console", default_branch: "main", status: "ready" },
        { id: 12, name: "search-platform", default_branch: "main", status: "ready" },
      ],
    },
    {
      node: { id: 3, name: "GPU Workstation" },
      kind: "ssh",
      ok: true,
      schema_version: 2,
      capabilities: ["node-control-v1", "code-view-v1"],
      tasks: [
        remoteRepoTask({
          id: 7,
          repoId: 21,
          title: "Tune local model evals",
          agent: "kimi",
          model: "k3",
          branch: "exp/7-model-evals",
        }),
      ],
      repos: [
        { id: 21, name: "model-evals", default_branch: "main", status: "ready" },
      ],
    },
  ],
};

export const providers = [
  { id: 2, name: "GLM Coding", model: "glm-4.6" },
  { id: 1, name: "Team Gateway", model: "claude-sonnet-4-5" },
];

export const skills = [
  {
    key: "official:frontend-design",
    name: "frontend-design",
    description: "Build polished production interfaces.",
    source: "official",
  },
  {
    key: "official:security-review",
    name: "security-review",
    description: "Review a change for security issues.",
    source: "official",
  },
  {
    key: "personal:release-check",
    name: "release-check",
    description: "Run the project release checklist.",
    source: "personal",
  },
];

export const onboarding = {
  schema_version: 1,
  instance_id: "demo-home-studio",
  machine: {
    name: "Home Studio",
    platform: "darwin",
    local_url: "http://127.0.0.1:4500",
  },
  network: {
    state: "ready",
    installed: true,
    running: true,
    account: "demo@switchyard.local",
    dns_name: "home-studio.demo-tailnet.ts.net",
    ips: ["100.64.20.10"],
    install_url: "https://tailscale.com/download",
    auth_url: null,
    magic_dns: { enabled: true, resolves_locally: true },
    serve: {
      ready: true,
      state: "ready",
      local_port: 4500,
      https_port: 443,
      url: "https://home-studio.demo-tailnet.ts.net",
      consent_url: null,
      error: null,
    },
  },
  phone: {
    state: "verified",
    url: "https://home-studio.demo-tailnet.ts.net/?onboarding=mobile",
    qr_path: "/api/onboarding/mobile-qr.svg",
    verified_at: "2026-07-23 09:12:00",
    device: "iPhone",
  },
  availability: {
    supported: true,
    source: "ac",
    model: "MacBook Pro (Demo)",
    laptop: true,
    idle_sleep_minutes: 1,
    display_sleep_minutes: 10,
    display_can_sleep: true,
    keep_awake_enabled: true,
    keep_awake_active: true,
    state: "ready",
    lid: "clamshell-ready",
    lid_closed: false,
  },
  fleet: {
    state: "ready",
    connected: 2,
    ssh_ready: 2,
    ssh_pending: 0,
    local_ssh: {
      listening: true,
      guidance: "macos-remote-login",
    },
  },
  ready: {
    local: true,
    always_on: true,
    phone: true,
    fleet: true,
  },
  recommended: "complete",
};

export const discovery = {
  ok: true,
  self: {
    id: "demo-home-node",
    name: "Home Studio",
    login_name: "demo@switchyard.local",
  },
  peers: [
    {
      id: "demo-office-node",
      name: "Office MacBook",
      dns_name: "office-macbook.demo-tailnet.ts.net",
      ip: "100.64.20.11",
      os: "macOS",
      connection: "direct",
      switchyard: true,
      compatible: true,
      connected: true,
      serve_port: 443,
      error: null,
    },
    {
      id: "demo-travel-node",
      name: "Travel MacBook",
      dns_name: "travel-macbook.demo-tailnet.ts.net",
      ip: "100.64.20.12",
      os: "macOS",
      connection: "peer-relay",
      switchyard: true,
      compatible: true,
      connected: false,
      serve_port: 443,
      error: null,
    },
    {
      id: "demo-phone-node",
      name: "Demo iPhone",
      dns_name: "demo-iphone.demo-tailnet.ts.net",
      ip: "100.64.20.20",
      os: "iOS",
      connection: "idle",
      switchyard: false,
      compatible: false,
      connected: false,
      serve_port: null,
      error: "Switchyard was not found",
    },
  ],
};

export const transcript = {
  agent: "claude",
  source: "demo-session-48",
  cursor: 2048,
  entries: [
    {
      t: "user",
      text: "Turn remote setup into one guided flow. Keep local use available at every step.",
    },
    {
      t: "assistant",
      text: "I’ll map the live network, power, phone, and fleet checks into one evidence-backed onboarding state.",
    },
    {
      t: "tool_call",
      id: "tool-read",
      name: "Read",
      arg: "web/js/features/onboarding.js",
      detail: "{\"file_path\":\"web/js/features/onboarding.js\"}",
    },
    {
      t: "tool_result",
      id: "tool-read",
      ok: true,
      output: "Loaded onboarding renderer and current device-discovery flow.",
    },
    {
      t: "assistant",
      text: "The UI is complete. The last check runs the full test suite before I hand it back.",
    },
    {
      t: "tool_call",
      id: "tool-test",
      name: "Bash",
      arg: "npm test",
      detail: "{\"command\":\"npm test\"}",
    },
  ],
};

export function terminalFrame(session) {
  const dim = "\u001b[38;2;125;115;103m";
  const text = "\u001b[38;2;236;230;221m";
  const accent = "\u001b[38;2;224;144;111m";
  const green = "\u001b[38;2;138;170;102m";
  const amber = "\u001b[38;2;224;179;65m";
  const reset = "\u001b[0m";
  return [
    "\u001b[2J\u001b[H",
    `${accent}Claude Code${reset}  ${dim}• ${session || "switchyard-demo-48"} • feat/48-guided-onboarding${reset}`,
    "",
    `${text}Task${reset}  Turn remote setup into one guided flow.`,
    "",
    `${green}✓${reset} Read       server/onboarding/status.ts`,
    `${green}✓${reset} Updated    web/js/features/onboarding.js`,
    `${green}✓${reset} Added      phone QR + Tailscale identity verification`,
    `${green}✓${reset} Verified   display sleep and always-on behavior`,
    "",
    `${text}The implementation is ready. One final check remains.${reset}`,
    "",
    `${amber}Permission required${reset}`,
    `${text}Run ${accent}npm test${text} in this worktree?${reset}`,
    "",
    `  ${amber}1.${reset} Yes`,
    `  ${dim}2.${reset} Yes, and don't ask again for npm test`,
    `  ${dim}3.${reset} No`,
    "",
    `${dim}Esc to cancel${reset}`,
  ].join("\r\n");
}
