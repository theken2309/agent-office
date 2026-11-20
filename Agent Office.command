#!/bin/bash
# Bấm đúp file này trong Finder để mở Agent Office.
"$(cd "$(dirname "$0")" && pwd)/open.sh"
# Đóng cửa sổ Terminal mà Finder vừa mở.
osascript -e 'tell application "Terminal" to close (every window whose name contains "Agent Office")' >/dev/null 2>&1 &
exit 0
