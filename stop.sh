#!/bin/bash
# Tắt server Agent Office (cửa sổ thì đóng như app bình thường).
STATE="$HOME/.agent-office"
SERVER=local.agent-office.server
if launchctl print "gui/$(id -u)/$SERVER" >/dev/null 2>&1; then
  # Đang chạy qua tự bật: dừng tới lần đăng nhập sau (hoặc chạy lại open.sh / install-autostart.sh).
  launchctl bootout "gui/$(id -u)/$SERVER" && echo "Đã tắt server (tự bật lại ở lần đăng nhập sau)."
elif [ -f "$STATE/server.pid" ] && kill "$(cat "$STATE/server.pid")" 2>/dev/null; then
  echo "Đã tắt server."
else
  echo "Server không chạy."
fi
rm -f "$STATE/server.pid"
