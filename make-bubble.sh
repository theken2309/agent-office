#!/bin/bash
# Build "Agent Bubble.app" (bong bóng nổi) vào ~/Applications và cho tự bật khi đăng nhập.
#   ./make-bubble.sh                 → build + tự bật + chạy ngay
#   ./make-bubble.sh --no-autostart  → build + chạy ngay, không tự bật
# Gỡ tự bật: launchctl bootout gui/$(id -u)/local.agent-office.bubble && rm ~/Library/LaunchAgents/local.agent-office.bubble.plist
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
APP="$HOME/Applications/Agent Bubble.app"
BIN="$APP/Contents/MacOS/agent-bubble"
LABEL=local.agent-office.bubble
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
UIDN="$(id -u)"

# dừng bản đang chạy
launchctl bootout "gui/$UIDN/$LABEL" 2>/dev/null || true
pkill -f "Agent Bubble.app/Contents/MacOS/agent-bubble" 2>/dev/null || true

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
xcrun --sdk macosx swiftc -O "$DIR/bubble/main.swift" -o "$BIN" -framework Cocoa -framework WebKit -framework UserNotifications

# icon: dùng chung với Agent Office.app
OFFICE_ICON="$HOME/Applications/Agent Office.app/Contents/Resources/AppIcon.icns"
[ -f "$OFFICE_ICON" ] || "$DIR/make-app.sh" --no-dock >/dev/null
cp "$OFFICE_ICON" "$APP/Contents/Resources/AppIcon.icns"

cat >"$APP/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Agent Bubble</string>
  <key>CFBundleDisplayName</key><string>Agent Bubble</string>
  <key>CFBundleIdentifier</key><string>local.agent-office.bubble</string>
  <key>CFBundleExecutable</key><string>agent-bubble</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSMinimumSystemVersion</key><string>11.0</string>
  <key>LSUIElement</key><true/>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
  <key>AgentOfficeDir</key><string>$DIR</string>
</dict>
</plist>
EOF
codesign --force --sign - "$APP" >/dev/null 2>&1 || true
echo "Đã build: $APP"

if [ "$1" = "--no-autostart" ]; then
  open "$APP"
else
  cat >"$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>$BIN</string></array>
  <key>RunAtLoad</key><true/>
  <!-- chỉ chạy lại khi bị crash; "Tắt bong bóng" trong menu thì thôi -->
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ProcessType</key><string>Interactive</string>
</dict>
</plist>
EOF
  launchctl bootstrap "gui/$UIDN" "$PLIST"
  echo "Đã cài tự bật bong bóng khi đăng nhập và bật ngay."
fi
