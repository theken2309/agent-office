#!/bin/bash
# Đóng gói "Agent Office.app" (icon pixel) vào ~/Applications và ghim lên Dock.
#   ./make-app.sh            → tạo app + ghim Dock
#   ./make-app.sh --no-dock  → chỉ tạo app
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
APP="$HOME/Applications/Agent Office.app"
NODE_DIR="$(dirname "$(command -v node)")"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# 1. icon: SVG → PNG 1024 (Chrome headless, nền trong suốt) → .icns
node "$DIR/tools/make-icon.mjs" >/dev/null
printf '<html><body style="margin:0;background:transparent">%s</body></html>' "$(cat "$DIR/assets/icon.svg")" >"$WORK/icon.html"
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --disable-gpu --hide-scrollbars \
  --default-background-color=00000000 --user-data-dir="$WORK/prof" --window-size=1024,1024 \
  --screenshot="$WORK/icon.png" "file://$WORK/icon.html" >/dev/null 2>&1
mkdir -p "$WORK/AppIcon.iconset"
for size in 16 32 128 256 512; do
  sips -z $size $size "$WORK/icon.png" --out "$WORK/AppIcon.iconset/icon_${size}x${size}.png" >/dev/null
  sips -z $((size * 2)) $((size * 2)) "$WORK/icon.png" --out "$WORK/AppIcon.iconset/icon_${size}x${size}@2x.png" >/dev/null
done
iconutil -c icns "$WORK/AppIcon.iconset" -o "$WORK/AppIcon.icns"
cp "$WORK/icon.png" "$DIR/assets/icon.png"

# 2. bundle .app: chạy open.sh rồi thoát (cửa sổ là Chrome dạng app)
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$WORK/AppIcon.icns" "$APP/Contents/Resources/AppIcon.icns"
cat >"$APP/Contents/MacOS/agent-office" <<EOF
#!/bin/bash
export PATH="$NODE_DIR:/usr/local/bin:/opt/homebrew/bin:\$PATH"
exec "$DIR/open.sh" >>"\$HOME/.agent-office/app.log" 2>&1
EOF
chmod +x "$APP/Contents/MacOS/agent-office"
cat >"$APP/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Agent Office</string>
  <key>CFBundleDisplayName</key><string>Agent Office</string>
  <key>CFBundleIdentifier</key><string>local.agent-office.app</string>
  <key>CFBundleExecutable</key><string>agent-office</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSMinimumSystemVersion</key><string>11.0</string>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
EOF
mkdir -p "$HOME/.agent-office"
touch "$APP" # Finder/Dock nạp lại icon
echo "Đã tạo: $APP"

# 3. ghim Dock (nếu chưa có)
if [ "$1" != "--no-dock" ]; then
  URL="file://$(python3 -c 'import sys,urllib.parse;print(urllib.parse.quote(sys.argv[1]))' "$APP")/"
  if defaults read com.apple.dock persistent-apps 2>/dev/null | grep -q "Agent%20Office.app"; then
    echo "Đã có trên Dock."
  else
    defaults write com.apple.dock persistent-apps -array-add \
      "<dict><key>tile-data</key><dict><key>file-data</key><dict><key>_CFURLString</key><string>$URL</string><key>_CFURLStringType</key><integer>15</integer></dict></dict></dict>"
    killall Dock
    echo "Đã ghim lên Dock."
  fi
fi
