#!/usr/bin/env bash
#
# task-dispatcher 预检 / 修复脚本（跑在 npm install 之前）
#
# dispatcher 用 `zsh -c 'claude …'`（远程走 `ssh host '<cmd>'`）起每个任务，
# 那是只读 ~/.zshenv 的「非交互、非登录」shell —— PATH 里没有 claude/tmux/git
# 就 `command not found`、pane 直接死（状态 127）。本脚本按 dispatcher 实际看到
# 的那种环境去检查这三个命令，把「已装但不在 PATH」的目录幂等写进 ~/.zshenv。
#
# 用法:
#   ./scripts/setup.sh           检查并自动修 ~/.zshenv（自动备份 ~/.zshenv.bak）
#   ./scripts/setup.sh --check   只检查、只读，不写任何文件（可当 CI / predev 门禁）
#
# 不做的事: 不装 node（README 里要求装好）、不装缺失的二进制、不跑 npm。

set -euo pipefail

CHECK_ONLY=0
case "${1:-}" in
  --check) CHECK_ONLY=1 ;;
  "")      ;;
  *)       echo "未知参数: $1（可用: --check）" >&2; exit 2 ;;
esac

ZSHENV="$HOME/.zshenv"
MARKER_BEGIN="# >>> task-dispatcher >>>"
MARKER_END="# <<< task-dispatcher <<<"
# dispatcher 的非交互 shell 拿到的基线 PATH（约等于 sshd 给 `ssh host cmd` 的那份）。
BASE_PATH="/usr/bin:/bin:/usr/sbin:/sbin"
CMDS="claude tmux git"

if [ -t 1 ]; then
  R=$'\e[31m'; G=$'\e[32m'; Y=$'\e[33m'; B=$'\e[1m'; N=$'\e[0m'
else
  R=; G=; Y=; B=; N=
fi
ok()   { printf "  ${G}✓${N} %s\n" "$1"; }
warn() { printf "  ${Y}!${N} %s\n" "$1"; }
bad()  { printf "  ${R}✗${N} %s\n" "$1"; }

ZSH_BIN="$(command -v zsh || true)"

# 登录 shell 必须是 zsh —— 整套 ~/.zshenv 机制是 zsh 专属。
if [ "$(basename "${SHELL:-}")" != "zsh" ] || [ -z "$ZSH_BIN" ]; then
  echo "${Y}你的登录 shell 不是 zsh（SHELL=${SHELL:-未设置}）。${N}"
  echo "本脚本只配置 ~/.zshenv（zsh 专属）。其它 shell 请手动把 claude/tmux/git 所在"
  echo "目录加进 dispatcher 用的非交互 shell 启动文件（bash 看 \$BASH_ENV）。"
  exit 1
fi

# dispatcher 的非交互 zsh 能否找到该命令？（干净环境 + 只让它 source ~/.zshenv，
# 避免继承本脚本被调用时那份「污染」的 PATH 而假性通过。）
reachable() {
  env -i HOME="$HOME" PATH="$BASE_PATH" "$ZSH_BIN" -c "command -v -- $1 >/dev/null 2>&1"
}

# 你交互 shell 里这个命令的真实所在目录（拿不到或不是绝对路径就返回空）。
real_dir() {
  local p
  p="$(command -v -- "$1" 2>/dev/null || true)"
  case "$p" in
    /*) dirname "$p" ;;
    *)  return 1 ;;
  esac
}

echo "${B}检查 dispatcher 的非交互 shell 能否找到 claude / tmux / git …${N}"

ADD_DIRS=""      # 需要写进 ~/.zshenv 的目录（空格分隔，后面去重）
MISSING=""       # 压根没装的命令
NEED_BREW=0

for c in $CMDS; do
  if reachable "$c"; then
    ok "$c —— 非交互 shell 已能找到"
  else
    d="$(real_dir "$c" || true)"
    if [ -n "$d" ]; then
      warn "$c —— 已装在 ${d}，但 dispatcher 的 shell 看不到（要写进 ~/.zshenv）"
      ADD_DIRS="$ADD_DIRS $d"
      case "$d" in
        /opt/homebrew/*|/usr/local/*) NEED_BREW=1 ;;
        *"/.nvm/versions/node/"*)
          warn "    （$c 在 nvm 下，路径含 node 版本号，升级即失效；建议 ln -s \"\$(command -v $c)\" ~/.local/bin/$c 后改用 ~/.local/bin）" ;;
      esac
    else
      bad "$c —— 没找到（未安装）"
      MISSING="$MISSING $c"
    fi
  fi
done

# 去重 ADD_DIRS（保序）
UNIQ_DIRS=""
for d in $ADD_DIRS; do
  found=0
  for u in $UNIQ_DIRS; do [ "$u" = "$d" ] && found=1 && break; done
  [ "$found" = 0 ] && UNIQ_DIRS="$UNIQ_DIRS $d"
done

# 安装提示（不替你装）
if [ -n "$MISSING" ]; then
  echo
  echo "${R}以下命令未安装，装好再重跑本脚本：${N}"
  for m in $MISSING; do
    case "$m" in
      tmux)   echo "  tmux:   brew install tmux" ;;
      git)    echo "  git:    xcode-select --install   或   brew install git" ;;
      claude) echo "  claude: curl -fsSL https://claude.ai/install.sh | bash   （或 npm i -g @anthropic-ai/claude-code）" ;;
    esac
  done
fi

# 拼接要写入 ~/.zshenv 的 marker 块
BREW_BIN="$(command -v brew || true)"
build_block() {
  printf '%s\n' "$MARKER_BEGIN"
  printf '%s\n' "# 由 scripts/setup.sh 写入：让 dispatcher 的非交互 shell（tmux/ssh → zsh -c）找到这些命令。"
  if [ "$NEED_BREW" = 1 ] && [ -n "$BREW_BIN" ]; then
    printf 'eval "$(%s shellenv)"\n' "$BREW_BIN"
  fi
  for d in $UNIQ_DIRS; do
    printf 'export PATH="%s:$PATH"\n' "$d"
  done
  printf '%s\n' "$MARKER_END"
}

write_block() {
  local block; block="$(build_block)"
  [ -f "$ZSHENV" ] && cp "$ZSHENV" "$ZSHENV.bak"
  if [ -f "$ZSHENV" ] && grep -qF "$MARKER_BEGIN" "$ZSHENV"; then
    # 删掉旧块、保留其余内容，再追加新块
    awk -v b="$MARKER_BEGIN" -v e="$MARKER_END" '
      $0==b {skip=1}
      skip==0 {print}
      $0==e {skip=0}
    ' "$ZSHENV" > "$ZSHENV.tmp"
    printf '%s\n' "$block" >> "$ZSHENV.tmp"
    mv "$ZSHENV.tmp" "$ZSHENV"
  else
    [ -s "$ZSHENV" ] && printf '\n' >> "$ZSHENV"
    printf '%s\n' "$block" >> "$ZSHENV"
  fi
}

# 没什么要修的
if [ -z "$UNIQ_DIRS" ]; then
  echo
  if [ -n "$MISSING" ]; then
    echo "${R}还有命令没装（见上），装好后重跑。${N}"
    exit 1
  fi
  echo "${G}全部就绪，~/.zshenv 无需改动。${N}"
  exit 0
fi

# 有要修的
echo
if [ "$CHECK_ONLY" = 1 ]; then
  echo "${Y}[--check] 以下内容应写入 ${ZSHENV}（当前未写）：${N}"
  build_block | sed 's/^/    /'
  echo "去掉 --check 重跑即可自动写入。"
  exit 1
fi

echo "${B}写入 ${ZSHENV}（备份到 ${ZSHENV}.bak）：${N}"
build_block | sed 's/^/    /'
write_block

# 用同一条干净环境检测复验
echo
echo "${B}复验：${N}"
allok=1
for c in $CMDS; do
  if reachable "$c"; then ok "$c"; else bad "$c —— 仍找不到"; allok=0; fi
done

echo
if [ "$allok" = 1 ] && [ -z "$MISSING" ]; then
  echo "${G}搞定。当前 shell 立即生效请 \`source ~/.zshenv\`；新开的任务会自动带上。${N}"
  echo "接着：${B}npm install && npm run dev${N}"
  exit 0
fi
echo "${Y}还有未解决项（见上）。${N}"
exit 1
