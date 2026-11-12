#!/usr/bin/env bash
# ============================================================
#  YangTex - Linux one-click launcher
#  Double-click in the file manager (or run from a terminal).
#  The service is detached with nohup, so no terminal stays open,
#  and the default browser opens automatically once the port is up.
# ============================================================
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG="$HOME/.yangtex-launch.log"
RUNTIME="$ROOT/.runtime.json"
SCRIPT="$ROOT/YangTex.py"

log() { printf '[%s] linux-launcher: %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >> "$LOG" 2>/dev/null || true; }
fail() { log "ERROR: $1"; printf 'YangTex: %s\n' "$1" >&2; exit 1; }

[ -f "$SCRIPT" ] || fail "YangTex.py was not found next to this launcher."

# --- locate Python >= 3.10 -----------------------------------------------
PY=""
for c in "${YANGTEX_PYTHON:-}" "$(command -v python3 2>/dev/null)" \
         /usr/bin/python3 /usr/local/bin/python3 "$HOME/.pyenv/shims/python3" \
         "$HOME/miniconda3/bin/python3" "$HOME/anaconda3/bin/python3"; do
  if [ -n "$c" ] && [ -x "$c" ] && \
     "$c" -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)' >/dev/null 2>&1; then
    PY="$c"
    break
  fi
done
[ -n "$PY" ] || fail "Python 3.10+ not found. Set YANGTEX_PYTHON to override."

cd "$ROOT" || fail "cannot enter $ROOT"
log "root=$ROOT python=$PY"

# env execs python in place, so $! is exactly the pid main() writes into
# .runtime.json. The launcher opens the browser; the backend steps aside.
nohup env YANGTEX_LAUNCHER_OPENS_BROWSER=1 "$PY" "$SCRIPT" --restart \
      >> "$LOG" 2>&1 < /dev/null &
SVC_PID=$!
disown 2>/dev/null || true
log "service detached (pid $SVC_PID)"

# --- wait until THIS instance publishes a reachable port ------------------
# Do not delete .runtime.json: --restart needs it to find and stop the old
# instance. Matching the pid tells a fresh runtime file from the old one.
port=""
fallback=""
i=0
while [ "$i" -lt 80 ]; do
  if [ -f "$RUNTIME" ]; then
    info="$("$PY" -c 'import json,sys
try:
    d=json.load(open(sys.argv[1],encoding="utf-8"))
    print(d["port"], d["pid"])
except Exception:
    pass' "$RUNTIME" 2>/dev/null)"
    p=""; rpid=""
    if [ -n "$info" ]; then p="${info%% *}"; rpid="${info##* }"; fi
    if [ -n "$p" ] && "$PY" -c 'import json,sys,urllib.request
try:
    r=urllib.request.urlopen("http://127.0.0.1:"+sys.argv[1]+"/api/health",timeout=1)
    raise SystemExit(0 if json.loads(r.read().decode()).get("app")=="YangTex" else 1)
except Exception:
    raise SystemExit(1)' "$p" >/dev/null 2>&1; then
      fallback="$p"
      if [ "$rpid" = "$SVC_PID" ]; then port="$p"; break; fi
    fi
  fi
  sleep 0.25
  i=$((i + 1))
done

if [ -z "$port" ] && [ -n "$fallback" ]; then
  log "WARNING: pid mismatch, using reachable port $fallback"
  port="$fallback"
fi
if [ -z "$port" ]; then
  log "WARNING: service did not report a ready port"
  printf 'YangTex: 服务可能仍在启动，请稍后打开 %s\n' "http://127.0.0.1:17865/"
  exit 0
fi

URL="http://127.0.0.1:$port/"
log "service ready on $URL"

# --- open the browser (BROWSER override / headless fallback) -------------
if [ -n "${BROWSER:-}" ] && command -v "${BROWSER%% *}" >/dev/null 2>&1; then
  # shellcheck disable=SC2086
  $BROWSER "$URL" >/dev/null 2>&1 &
elif [ -z "${DISPLAY:-}" ] && [ -z "${WAYLAND_DISPLAY:-}" ]; then
  log "no graphical session; browser not opened"
  printf 'YangTex 已启动（无图形会话），请在浏览器中打开：%s\n' "$URL"
else
  opened=0
  if command -v xdg-open >/dev/null 2>&1; then
    xdg-open "$URL" >/dev/null 2>&1 & opened=1
  elif command -v gio >/dev/null 2>&1; then
    gio open "$URL" >/dev/null 2>&1 & opened=1
  elif command -v sensible-browser >/dev/null 2>&1; then
    sensible-browser "$URL" >/dev/null 2>&1 & opened=1
  fi
  [ "$opened" -eq 1 ] || printf 'YangTex 已启动，请在浏览器中打开：%s\n' "$URL"
fi
printf 'YangTex: %s\n' "$URL"
exit 0
