#!/bin/bash
# Cho Agent Office tự bật khi đăng nhập macOS:
#   - local.agent-office.server : server luôn chạy nền, tự chạy lại nếu chết
#   - local.agent-office.window : mở cửa sổ một lần mỗi lần đăng nhập
# Gỡ: ./uninstall-autostart.sh
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
NODE="$(command -v node)"
STATE="$HOME/.agent-office"
LA="$HOME/Library/LaunchAgents"
UIDN="$(id -u)"
SERVER=local.agent-office.server
WINDOW=local.agent-office.window
mkdir -p "$STATE" "$LA"

[ -n "$NODE" ] || { echo "Không tìm thấy node" >&2; exit 1; }

cat >"$LA/$SERVER.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$SERVER</string>
  <key>ProgramArguments</key>
  <array><string>$NODE</string><string>$DIR/server.mjs</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$STATE/server.log</string>
  <key>StandardErrorPath</key><string>$STATE/server.log</string>
</dict>
</plist>
EOF

cat >"$LA/$WINDOW.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$WINDOW</string>
  <key>ProgramArguments</key>
  <array><string>/bin/bash</string><string>$DIR/open.sh</string></array>
  <key>RunAtLoad</key><true/>
  <key>AbandonProcessGroup</key><true/>
  <key>StandardOutPath</key><string>$STATE/window.log</string>
  <key>StandardErrorPath</key><string>$STATE/window.log</string>
</dict>
</plist>
EOF

# Tắt server đang chạy tay (nếu có) rồi giao cho launchd.
if [ -f "$STATE/server.pid" ]; then
  kill "$(cat "$STATE/server.pid")" 2>/dev/null || true
  rm -f "$STATE/server.pid"
fi
launchctl bootout "gui/$UIDN/$SERVER" 2>/dev/null || true
launchctl bootstrap "gui/$UIDN" "$LA/$SERVER.plist"
# Cửa sổ: không nạp ngay (đỡ mở trùng), launchd tự chạy ở lần đăng nhập sau.

echo "Đã cài tự bật. Server: launchd ($SERVER). Cửa sổ sẽ tự mở ở lần đăng nhập sau."
