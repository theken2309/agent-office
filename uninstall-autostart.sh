#!/bin/bash
# Gỡ tự bật của Agent Office (server dừng luôn).
UIDN="$(id -u)"
LA="$HOME/Library/LaunchAgents"
for L in local.agent-office.server local.agent-office.window; do
  launchctl bootout "gui/$UIDN/$L" 2>/dev/null || true
  rm -f "$LA/$L.plist"
done
echo "Đã gỡ tự bật."
