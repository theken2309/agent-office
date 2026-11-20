#!/bin/bash
# Bật server (nếu chưa chạy) và mở Agent Office thành cửa sổ riêng.
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
PORT="${PORT:-47321}"
URL="http://127.0.0.1:$PORT"
STATE="$HOME/.agent-office"
mkdir -p "$STATE"

SERVER_PLIST="$HOME/Library/LaunchAgents/local.agent-office.server.plist"
health() { curl -fs --retry "$1" --retry-connrefused --retry-delay 1 --retry-max-time "$1" "$URL/health" >/dev/null 2>&1; }

if ! curl -fs "$URL/health" >/dev/null 2>&1; then
  if [ -f "$SERVER_PLIST" ]; then
    # Đã cài tự bật: nhờ launchd chạy server (lúc đăng nhập có thể nó đang khởi động).
    launchctl bootstrap "gui/$(id -u)" "$SERVER_PLIST" 2>/dev/null || launchctl kickstart "gui/$(id -u)/local.agent-office.server" 2>/dev/null || true
  else
    nohup node "$DIR/server.mjs" >"$STATE/server.log" 2>&1 &
    echo $! >"$STATE/server.pid"
  fi
  health 10 || {
    echo "Server không lên được, xem $STATE/server.log" >&2
    exit 1
  }
fi

CHROME="/Applications/Google Chrome.app"
if [ -d "$CHROME" ]; then
  # Cửa sổ cũ (profile riêng của Agent Office) còn chạy ngầm thì tắt đi để cửa sổ mới hiện ra phía trước.
  if pgrep -f -- "--user-data-dir=$STATE/chrome" >/dev/null; then
    pkill -f -- "--user-data-dir=$STATE/chrome" || true
    for _ in 1 2 3 4 5 6 7 8 9 10; do
      pgrep -f -- "--user-data-dir=$STATE/chrome" >/dev/null || break
      perl -e 'select(undef,undef,undef,0.3)'
    done
  fi
  # Hồ sơ Chrome riêng → cửa sổ app độc lập, không lẫn vào tab Chrome đang dùng.
  open -na "$CHROME" --args \
    --app="$URL" \
    --user-data-dir="$STATE/chrome" \
    --no-first-run --no-default-browser-check \
    --window-size=440,820
else
  open "$URL"
fi
echo "Agent Office: $URL"
