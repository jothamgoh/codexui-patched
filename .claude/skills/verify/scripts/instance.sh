#!/usr/bin/env bash
# Start, check, or stop an isolated CodexUI dev instance for verification.
#   instance.sh start [--live-auth]   launch Vite + bridge on $VERIFY_PORT (default 5181)
#   instance.sh doctor                read-only health report
#   instance.sh stop                  stop the process group this script started
# Scratch state lives in $VERIFY_DIR (default ${TMPDIR:-/tmp}/codexui-verify).
set -euo pipefail

REPO="$(cd "$(dirname "$0")/../../../.." && pwd)"
PORT="${VERIFY_PORT:-5181}"
DIR="${VERIFY_DIR:-${TMPDIR:-/tmp/}codexui-verify}"
DIR="${DIR%/}"
PIDFILE="$DIR/pid"
LOG="$DIR/vite.log"
BASE="http://127.0.0.1:$PORT"

alive() { [[ -f "$PIDFILE" ]] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; }
listener() { lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t 2>/dev/null | head -1; }

# Prints "<hours until the access token expires> <days since the last refresh>".
token_age() {
  python3 - "$HOME/.codex/auth.json" <<'PY'
import json, base64, sys, time, datetime
auth = json.load(open(sys.argv[1]))
tok = auth["tokens"]["access_token"].split(".")[1]
tok += "=" * (-len(tok) % 4)
hours = int((json.loads(base64.urlsafe_b64decode(tok))["exp"] - time.time()) / 3600)
refreshed = datetime.datetime.fromisoformat(auth["last_refresh"].replace("Z", "+00:00"))
print(hours, (datetime.datetime.now(datetime.timezone.utc) - refreshed).days)
PY
}

start() {
  local live=0
  [[ "${1:-}" == "--live-auth" ]] && live=1
  if alive; then echo "already running: pid $(cat "$PIDFILE") on $BASE"; exit 0; fi
  if [[ -n "$(listener)" ]]; then
    echo "port $PORT is owned by another process ($(listener)); set VERIFY_PORT to a free port" >&2; exit 1
  fi
  rm -rf "$DIR/codex-home"
  mkdir -p "$DIR/codex-home" "$DIR/claude-config"
  : > "$DIR/empty.env"
  cp "$HOME/.codex/config.toml" "$DIR/codex-home/config.toml"
  if (( live )); then
    local hours days; read -r hours days <<<"$(token_age)"
    if (( hours < 48 || days > 5 )); then
      echo "refusing --live-auth: token expires in ${hours}h, last refreshed ${days}d ago; a refresh inside the scratch copy could sign out the real login. Use UI-only mode or retry after production Codex refreshes." >&2; exit 1
    fi
    mkdir -p "$DIR/workspace"
    cp "$HOME/.codex/auth.json" "$DIR/codex-home/auth.json"
    chmod 600 "$DIR/codex-home/auth.json"
    shasum -a 256 "$DIR/codex-home/auth.json" | cut -d' ' -f1 > "$DIR/auth.sha"
  fi
  cd "$REPO"
  set -m
  CODEX_HOME="$DIR/codex-home" CLAUDE_CONFIG_DIR="$DIR/claude-config" CODEXUI_ENV_FILE="$DIR/empty.env" \
    nohup node node_modules/vite/bin/vite.js --host 127.0.0.1 --port "$PORT" --strictPort >"$LOG" 2>&1 &
  echo $! > "$PIDFILE"
  set +m
  for _ in $(seq 1 60); do
    if curl -fs -o /dev/null "$BASE/codex-api/meta/methods"; then
      echo "ready: $BASE (pid $(cat "$PIDFILE"), auth: $([[ $live == 1 ]] && echo live-copy || echo none), log $LOG)"; return
    fi
    alive || { echo "instance exited during startup; tail of $LOG:" >&2; tail -20 "$LOG" >&2; exit 1; }
    sleep 1
  done
  echo "not ready after 60s; tail of $LOG:" >&2; tail -20 "$LOG" >&2; exit 1
}

doctor() {
  local ok=1
  if alive; then echo "process: pid $(cat "$PIDFILE") alive"; else echo "process: not running"; ok=0; fi
  local l; l="$(listener)"
  if [[ -n "$l" ]] && alive && [[ "$(ps -o pgid= -p "$l" | tr -d ' ')" == "$(cat "$PIDFILE")" ]]; then
    echo "port: $PORT owned by our process group"
  else
    echo "port: $PORT ${l:+owned by foreign pid $l}${l:-not listening}"; ok=0
  fi
  if curl -fs -o /dev/null "$BASE/codex-api/meta/methods"; then echo "bridge: $BASE/codex-api/meta/methods 200"; else echo "bridge: not answering"; ok=0; fi
  if [[ -f "$DIR/codex-home/auth.json" ]]; then echo "auth: live copy (scratch CODEX_HOME)"; else echo "auth: none (UI-only; sending a message will fail)"; fi
  echo "codex home: $DIR/codex-home; claude config: $DIR/claude-config (both scratch)"
  curl -fs "$BASE/codex-api/providers" 2>/dev/null | head -c 400 && echo
  (( ok )) && echo "doctor: OK" || { echo "doctor: NOT OK"; exit 1; }
}

stop() {
  if alive; then
    local pgid; pgid="$(cat "$PIDFILE")"
    kill -TERM -- "-$pgid" 2>/dev/null || true
    for _ in $(seq 1 10); do kill -0 -- "-$pgid" 2>/dev/null || break; sleep 1; done
    kill -KILL -- "-$pgid" 2>/dev/null || true
    echo "stopped process group $pgid"
  else
    echo "no running instance recorded in $PIDFILE"
  fi
  if [[ -f "$DIR/auth.sha" && -f "$DIR/codex-home/auth.json" ]] && \
     [[ "$(shasum -a 256 "$DIR/codex-home/auth.json" | cut -d' ' -f1)" != "$(cat "$DIR/auth.sha")" ]]; then
    echo "WARNING: the scratch Codex login was refreshed during this run. Tell the user: the real ~/.codex login may need 'codex login' if Codex reports it is signed out." >&2
  fi
  rm -rf "$DIR"
}

case "${1:-}" in
  start) shift; start "$@" ;;
  doctor) doctor ;;
  stop) stop ;;
  *) sed -n '2,6p' "$0"; exit 2 ;;
esac
