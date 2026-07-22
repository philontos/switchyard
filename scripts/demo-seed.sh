#!/bin/bash
# demo-seed.sh — 为 README 截图生成一套演示数据,与真实实例完全隔离。
#
#   ./scripts/demo-seed.sh                        # 起隔离实例(:4501)并播种仓库+任务(仅本机可访问)
#   ./scripts/demo-seed.sh --cidr 10.10.0.0/24    # 同 tdsp serve --host-cidr:绑回环+该网段内的本机 IP,手机走 WireGuard/Tailscale 可访问
#   ./scripts/demo-seed.sh --lan                  # 绑 0.0.0.0(同一 Wi-Fi 的手机可访问;无鉴权,拍完速 clean)
#   ./scripts/demo-seed.sh --with-remote          # 额外伪造一台"远程机器"(需 ssh localhost 可用)
#   ./scripts/demo-seed.sh clean                  # 全部拆除:杀会话、停服务、删演示数据
#
# 原理:TASK_DISPATCHER_DATA_DIR 指向独立数据根 → 独立的 db/mirrors/worktrees,
# 连 tmux 会话名都带独立命名空间。仓库是脚本现造的虚构项目(本地 git 仓库当
# git 源),任务是真派发 —— 终端里是真 Claude/Codex,状态灯和阅读模式全是真的。
set -euo pipefail

ROOT_A="$HOME/.task-dispatcher-demo"            # 演示"本机"的数据根
ROOT_B="$HOME/.task-dispatcher-demo-node2"      # 伪造"远程机器"的数据根(--with-remote)
FIXTURES="$ROOT_A/fixtures"                     # 虚构项目仓库存放处
PORT_A=4501
PORT_B=4502                                     # 播种机器B时临时用,种完即关
TDSP="${TDSP:-$HOME/.task-dispatcher/bin/tdsp}" # 复用你已安装的 tdsp 启动器
REMOTE_NAME="m2-mini"                           # 伪造远程机器在页面上显示的名字

say()  { printf '\033[1;36m» %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m! %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

api() { # api <port> <method> <path> [json]
  local port=$1 method=$2 path=$3 body=${4:-}
  if [ -n "$body" ]; then
    curl -sS -X "$method" "http://localhost:$port$path" -H 'Content-Type: application/json' -d "$body"
  else
    curl -sS -X "$method" "http://localhost:$port$path"
  fi
  echo
}

must_create() { # must_create <说明> <port> <path> <json> —— 创建类调用,响应里没有 id 就报错退出
  local what=$1 port=$2 path=$3 body=$4 resp
  resp="$(api "$port" POST "$path" "$body")"
  echo "$resp" | grep -q '"id"' || die "$what 失败: $resp"
}

wait_http() { # 等服务起来;失败时把日志尾巴打出来
  local port=$1 log=$2 i=0
  until curl -sf "http://localhost:$port/api/hosts" >/dev/null 2>&1; do
    i=$((i+1))
    if [ $i -gt 60 ]; then
      echo "---- $log 末尾 ----" >&2; tail -10 "$log" >&2 || true
      die "服务 :$port 没起来"
    fi
    sleep 0.5
  done
}

wait_repos_ready() { # 等所有仓库离开 cloning
  local port=$1 i=0
  while api "$port" GET /api/repos | grep -q '"status":"cloning"'; do
    i=$((i+1)); [ $i -gt 60 ] && die "仓库一直在 cloning,看 :$port 的 /api/repos"
    sleep 0.5
  done
  if api "$port" GET /api/repos | grep -q '"status":"error"'; then
    die "有仓库注册失败,看 :$port 的 /api/repos"
  fi
}

ns_of() { cat "$1/controller-id" 2>/dev/null || true; }
db_of() { echo "$1/$(ns_of "$1")/dispatcher.db"; }

kill_ns_sessions() { # 杀掉某个命名空间的所有 tmux 会话
  local ns=$1
  [ -n "$ns" ] || return 0
  tmux ls -F '#{session_name}' 2>/dev/null | grep "^tdsp-$ns-" | while read -r s; do
    tmux kill-session -t "=$s" 2>/dev/null || true
  done
}

# ---------- clean ----------
if [ "${1:-}" = "clean" ]; then
  say "杀演示 tmux 会话…"
  kill_ns_sessions "$(ns_of "$ROOT_A")"
  kill_ns_sessions "$(ns_of "$ROOT_B")"
  say "停演示服务…"
  lsof -ti ":$PORT_A" 2>/dev/null | xargs kill 2>/dev/null || true
  lsof -ti ":$PORT_B" 2>/dev/null | xargs kill 2>/dev/null || true
  sleep 1
  say "删演示数据根…"
  rm -rf "$ROOT_A" "$ROOT_B"
  say "完事。你的真实实例(~/.task-dispatcher)全程未动。"
  exit 0
fi

# ---------- 参数 ----------
LAN=0; WITH_REMOTE=0; CIDR=""
while [ $# -gt 0 ]; do
  case "$1" in
    --lan) LAN=1 ;;
    --with-remote) WITH_REMOTE=1 ;;
    --cidr) shift; CIDR="${1:-}"; [ -n "$CIDR" ] || die "--cidr 需要一个网段,例如 10.10.0.0/24" ;;
    *) die "未知参数: $1(可用: --cidr <网段> --lan --with-remote clean)" ;;
  esac
  shift
done

[ -x "$TDSP" ] || die "找不到 tdsp 启动器 $TDSP(或用 TDSP=/path/to/tdsp 指定)"
[ -e "$ROOT_A" ] && die "$ROOT_A 已存在 —— 先 ./scripts/demo-seed.sh clean"
command -v tmux >/dev/null || die "需要 tmux"
HAVE_CODEX=1; zsh -c 'command -v codex' >/dev/null 2>&1 || HAVE_CODEX=0
[ $HAVE_CODEX = 1 ] || warn "没找到 codex CLI —— 跳过 Codex 演示任务(卡片会少一种颜色)"

# ---------- 1. 虚构项目仓库 ----------
say "造虚构项目仓库(README 截图里出现的就是它们)…"
mkdir -p "$FIXTURES"

mk_aurora() { # aurora-web: 一个小 React 前端
  local d="$FIXTURES/aurora-web"
  mkdir -p "$d/src/settings"
  cat > "$d/package.json" <<'EOF'
{
  "name": "aurora-web",
  "version": "0.4.2",
  "private": true,
  "type": "module",
  "scripts": { "dev": "vite", "build": "vite build", "test": "vitest run" },
  "dependencies": { "react": "^18.3.1", "react-dom": "^18.3.1" },
  "devDependencies": { "vite": "^5.4.0", "vitest": "^2.0.0", "@vitejs/plugin-react": "^4.3.0" }
}
EOF
  cat > "$d/index.html" <<'EOF'
<!doctype html>
<html lang="en">
  <head><meta charset="UTF-8" /><title>Aurora</title></head>
  <body><div id="root"></div><script type="module" src="/src/main.jsx"></script></body>
</html>
EOF
  cat > "$d/src/main.jsx" <<'EOF'
import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";

createRoot(document.getElementById("root")).render(<App />);
EOF
  cat > "$d/src/App.jsx" <<'EOF'
import React from "react";
import Settings from "./settings/Settings.jsx";

export default function App() {
  return (
    <main>
      <h1>Aurora</h1>
      <Settings />
    </main>
  );
}
EOF
  cat > "$d/src/settings/Settings.jsx" <<'EOF'
import React from "react";

// Settings page: language + notifications only for now; theming is not built yet.
export default function Settings() {
  return (
    <section className="settings">
      <h2>Settings</h2>
      <label>Language <select><option>English</option><option>中文</option></select></label>
      <label><input type="checkbox" defaultChecked /> Email notifications</label>
    </section>
  );
}
EOF
  echo "# Aurora — team workspace frontend" > "$d/README.md"
  git -C "$d" init -q -b main
  git -C "$d" add -A && git -C "$d" commit -qm "chore: scaffold vite + react app"
  echo ".vite/" > "$d/.gitignore"
  git -C "$d" add -A && git -C "$d" commit -qm "feat: settings page with language + notification prefs"
  git -C "$d" commit -qm "fix: settings select overflow on narrow screens" --allow-empty
  git -C "$d" branch feat/checkout-flow
  git -C "$d" branch fix/i18n-fallback
}

mk_courier() { # courier-api: 一个小 Express API
  local d="$FIXTURES/courier-api"
  mkdir -p "$d/src/routes" "$d/test"
  cat > "$d/package.json" <<'EOF'
{
  "name": "courier-api",
  "version": "1.7.0",
  "private": true,
  "type": "module",
  "scripts": { "start": "node src/server.js", "test": "node --test test/" },
  "dependencies": { "express": "^4.21.2" }
}
EOF
  cat > "$d/src/server.js" <<'EOF'
import express from "express";
import { orders } from "./routes/orders.js";

const app = express();
app.use(express.json());
app.use("/v1/orders", orders);
app.listen(process.env.PORT || 3000);
EOF
  cat > "$d/src/routes/orders.js" <<'EOF'
import { Router } from "express";

export const orders = Router();

// TODO: returns the full order list in one shot — needs pagination before GA.
const DB = Array.from({ length: 137 }, (_, i) => ({ id: i + 1, status: i % 3 ? "delivered" : "in_transit" }));

orders.get("/", (_req, res) => {
  res.json({ orders: DB });
});
EOF
  cat > "$d/test/orders.test.js" <<'EOF'
import { test } from "node:test";
import assert from "node:assert";

test("orders payload shape", () => {
  assert.ok(true); // placeholder — route tests TBD
});
EOF
  echo "# Courier — delivery orders API" > "$d/README.md"
  git -C "$d" init -q -b main
  git -C "$d" add -A && git -C "$d" commit -qm "chore: express service skeleton"
  git -C "$d" commit -qm "feat: /v1/orders list endpoint" --allow-empty
  git -C "$d" commit -qm "fix: json body limit for webhook payloads" --allow-empty
  git -C "$d" branch fix/rate-limit
}

mk_atlas() { # atlas-docs: 一个文档站
  local d="$FIXTURES/atlas-docs"
  mkdir -p "$d/docs"
  cat > "$d/package.json" <<'EOF'
{
  "name": "atlas-docs",
  "version": "0.2.0",
  "private": true,
  "scripts": { "dev": "vitepress dev docs", "build": "vitepress build docs" },
  "devDependencies": { "vitepress": "^1.3.0" }
}
EOF
  cat > "$d/docs/index.md" <<'EOF'
# Atlas

Developer platform docs. Start with [Installation](./install.md).
EOF
  cat > "$d/docs/install.md" <<'EOF'
# Installation

```sh
npm install -g atlas-cli
atlas init
```
EOF
  echo "# Atlas — developer platform docs" > "$d/README.md"
  git -C "$d" init -q -b main
  git -C "$d" add -A && git -C "$d" commit -qm "chore: vitepress scaffold"
  git -C "$d" commit -qm "docs: installation page" --allow-empty
  git -C "$d" branch docs/api-reference
}

mk_aurora
mk_courier
mk_atlas

# ---------- 2. 起演示实例(机器A) ----------
say "起演示控制台 :$PORT_A(数据根 $ROOT_A)…"
mkdir -p "$ROOT_A"
if [ -n "$CIDR" ]; then
  env TASK_DISPATCHER_DATA_DIR="$ROOT_A" PORT="$PORT_A" nohup "$TDSP" serve --host-cidr "$CIDR" > "$ROOT_A/serve.log" 2>&1 &
elif [ $LAN = 1 ]; then
  env TASK_DISPATCHER_DATA_DIR="$ROOT_A" PORT="$PORT_A" HOST=0.0.0.0 nohup "$TDSP" serve > "$ROOT_A/serve.log" 2>&1 &
else
  env TASK_DISPATCHER_DATA_DIR="$ROOT_A" PORT="$PORT_A" nohup "$TDSP" serve > "$ROOT_A/serve.log" 2>&1 &
fi
wait_http "$PORT_A" "$ROOT_A/serve.log"

# ---------- 3. 注册仓库 ----------
say "注册仓库(本地路径当 git 源,秒级 ready)…"
must_create "注册 aurora-web"  "$PORT_A" /api/repos "{\"name\":\"aurora-web\",\"git_url\":\"$FIXTURES/aurora-web\",\"default_branch\":\"main\"}"
must_create "注册 courier-api" "$PORT_A" /api/repos "{\"name\":\"courier-api\",\"git_url\":\"$FIXTURES/courier-api\",\"default_branch\":\"main\"}"
must_create "注册 atlas-docs"  "$PORT_A" /api/repos "{\"name\":\"atlas-docs\",\"git_url\":\"$FIXTURES/atlas-docs\",\"default_branch\":\"main\"}"
wait_repos_ready "$PORT_A"

# ---------- 4. 派真任务(终端/状态灯/阅读模式都是真的) ----------
say "派发演示任务(真 agent,会小额消耗 token)…"
# aurora-web(repo 1)
must_create "task: dark mode" "$PORT_A" /api/tasks '{"repo_id":1,"base_branch":"main","title":"Add dark mode toggle to settings","prompt":"Read through this small project, then add a dark mode toggle to the settings page, persisting the choice in localStorage. Before touching code, explain your plan in two or three sentences."}'
must_create "task: select overflow" "$PORT_A" /api/tasks '{"repo_id":1,"base_branch":"main","title":"Fix settings select overflow on mobile","prompt":"The settings page select overflows on narrow screens. Reproduce by reading the code, then fix it with plain CSS."}'
if [ $HAVE_CODEX = 1 ]; then
  must_create "task: css modules (codex)" "$PORT_A" /api/tasks '{"repo_id":1,"base_branch":"main","title":"Migrate settings styles to CSS modules","prompt":"Move the settings page styling to CSS modules, keeping the rendered output identical.","agent":"codex"}'
fi
# courier-api(repo 2)
if [ $HAVE_CODEX = 1 ]; then
  must_create "task: pagination (codex)" "$PORT_A" /api/tasks '{"repo_id":2,"base_branch":"main","title":"Add cursor-based pagination to /v1/orders","prompt":"Add cursor-based pagination (limit + cursor) to /v1/orders, with unit tests.","agent":"codex"}'
fi
must_create "task: bump deps" "$PORT_A" /api/tasks '{"repo_id":2,"base_branch":"main","title":"Bump dependencies and fix the test suite","prompt":"Upgrade dependencies to their latest minor versions, then run the tests and make sure nothing broke."}'
must_create "task: webhook backoff" "$PORT_A" /api/tasks '{"repo_id":2,"base_branch":"main","title":"Add exponential backoff to webhook retries","prompt":"Add exponential backoff with jitter to failed webhook deliveries. Skim the code structure first and outline a short plan before implementing."}'
# atlas-docs(repo 3)
must_create "task: quickstart" "$PORT_A" /api/tasks '{"repo_id":3,"base_branch":"main","title":"Write a quickstart guide","prompt":"Write a concise quickstart guide (docs/quickstart.md) that gets a new user from install to first deploy, and link it from the docs index."}'
# 一个 shell 快速任务(无仓库任务的形态也入镜)
must_create "shell task" "$PORT_A" /api/tasks/local '{"title":"Profile build memory usage"}'

# 保底黄灯:直接放置 waiting 标记(真实机制就是 worktree 下的这个文件)。
# 若该任务的 agent 后续真的动了,hook 可能清掉它 —— 截图前重跑本段即可。
DB_A="$(db_of "$ROOT_A")"
WT="$(sqlite3 "$DB_A" "SELECT worktree_path FROM tasks WHERE title='Bump dependencies and fix the test suite' ORDER BY id DESC LIMIT 1")"
if [ -n "$WT" ] && [ -d "$WT" ]; then
  mkdir -p "$WT/.claude" && touch "$WT/.claude/waiting"
  say "黄灯已就位:「Bump dependencies and fix the test suite」卡片(标记文件 $WT/.claude/waiting)"
fi

# ---------- 5. 伪造第二台机器(可选) ----------
if [ $WITH_REMOTE = 1 ]; then
  if ! ssh -o BatchMode=yes -o ConnectTimeout=3 localhost true 2>/dev/null; then
    warn "ssh localhost 不可用(系统设置→通用→共享→远程登录,并把自己的公钥加进 authorized_keys),跳过远程机器"
  else
    say "播种伪造远程机器「$REMOTE_NAME」(数据根 $ROOT_B)…"
    mkdir -p "$ROOT_B"
    env TASK_DISPATCHER_DATA_DIR="$ROOT_B" PORT="$PORT_B" nohup "$TDSP" serve > "$ROOT_B/serve.log" 2>&1 &
    wait_http "$PORT_B" "$ROOT_B/serve.log"
    must_create "机器B:注册 courier-api" "$PORT_B" /api/repos "{\"name\":\"courier-api\",\"git_url\":\"$FIXTURES/courier-api\",\"default_branch\":\"main\"}"
    wait_repos_ready "$PORT_B"
    must_create "机器B:rate-limit 任务" "$PORT_B" /api/tasks '{"repo_id":1,"base_branch":"main","title":"Rate-limit the public API","prompt":"Add a simple token-bucket rate limiter middleware to the API. Outline a short plan first."}'
    must_create "机器B:shell 任务" "$PORT_B" /api/tasks/local '{"title":"Tail production logs"}'
    lsof -ti ":$PORT_B" | xargs kill 2>/dev/null || true   # 种完即关,数据留在 ROOT_B

    # 机器B 的 tdsp 包装器:先切数据根,再借用你真实安装的启动器
    mkdir -p "$ROOT_B/bin"
    cat > "$ROOT_B/bin/tdsp" <<EOF
#!/bin/sh
export TASK_DISPATCHER_DATA_DIR="$ROOT_B"
exec "$TDSP" "\$@"
EOF
    chmod +x "$ROOT_B/bin/tdsp"

    # 在机器A 上登记它:target=localhost,tdsp_bin 指向包装器 → 舰队视图走真 ssh 拉真数据
    must_create "登记远程机器" "$PORT_A" /api/hosts "{\"name\":\"$REMOTE_NAME\",\"target\":\"localhost\"}"
    sqlite3 "$DB_A" "UPDATE hosts SET tdsp_bin='$ROOT_B/bin/tdsp', status='online' WHERE target='localhost'"
    say "远程机器「$REMOTE_NAME」已上线(ssh localhost + 独立数据根,一切走真实链路)"
  fi
fi

# ---------- 6. 收尾提示 ----------
echo
say "演示环境就绪,可访问地址:"
grep -o 'http://[^ ]*' "$ROOT_A/serve.log" | sed 's/^/    /' || say "    http://localhost:$PORT_A"
if [ -n "$CIDR" ]; then
  say "手机(同一 WireGuard/Tailscale 网段)直接开上面的 10.x 地址,Safari 分享→添加到主屏幕即可拍 PWA"
elif [ $LAN = 1 ]; then
  IP=$(ipconfig getifaddr en0 2>/dev/null || echo "<本机IP>")
  say "手机(同一局域网)→ http://$IP:$PORT_A"
else
  say "要拍手机截图:clean 后加 --cidr 10.10.0.0/24(或 --lan)重来"
fi
cat <<'TIPS'

  建议镜头:
   · 桌面总览      —— 三个仓库分组 + 绿/黄状态灯 + codex/claude 双色卡片,右侧真终端
   · 移动端主-详    —— 手机开任务列表,点进「Add dark mode toggle to settings」看全屏终端
   · 移动端阅读模式 —— 同一任务切「阅读」,该任务的提示词就是为聊天流设计的
   · 舰队视图      —— --with-remote 时,「m2-mini」节点带自己的仓库和任务

  黄灯被 agent 清掉了?重新 touch 对应 worktree 下的 .claude/waiting 即可。
  拍完:./scripts/demo-seed.sh clean(杀会话/停服务/删数据,真实实例全程不动)
TIPS
