---
name: ahpd-teardown
description: Teardown for the ahpd bundle. Stops and removes the ahpd login service, deletes ~/.a3/ahpd (keeping work files), and removes the localhost AHP server from Anton. Load when the ahpd bundle is uninstalled or when the user asks to remove ahpd.
---

# Remove ahpd from this machine

This undoes what the `ahpd-setup` skill did. Tell the user in one sentence what will be removed, then do these steps in order.

1. **Stop and remove ahpd.** Run this script exactly as written with bash. It is safe to run when parts are already gone.
   - Stops and removes the login service (systemd user unit on Linux, LaunchAgent on macOS).
   - Deletes `~/.a3/ahpd`. If `~/.a3/ahpd/work` has files, it keeps that folder and prints `KEPT=...`.
   - Removes `~/.config/ahpd` only if setup created it.
   - Prints `ADDRESS=...` (the address ahpd used) when it could still read the config.

```bash
set -uo pipefail
A="$HOME/.a3/ahpd"
LABEL="io.trustgrid.anton.ahpd"
if [ -f "$A/config.json" ]; then
  echo "ADDRESS=ws://127.0.0.1:$(node -p "require('$A/config.json').port" 2>/dev/null)"
fi
case "$(uname -s)" in
  Linux)
    UNIT="$HOME/.config/systemd/user/anton-ahpd.service"
    systemctl --user disable --now anton-ahpd.service 2>/dev/null || true
    rm -f "$UNIT"
    systemctl --user daemon-reload 2>/dev/null || true
    systemctl --user reset-failed anton-ahpd.service 2>/dev/null || true
    ;;
  Darwin)
    launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
    rm -f "$HOME/Library/LaunchAgents/$LABEL.plist"
    ;;
esac
if [ -e "$A/.created-config-dir" ]; then rm -rf "$HOME/.config/ahpd"; fi
if [ -d "$A/work" ] && [ -n "$(ls -A "$A/work")" ]; then
  find "$A" -mindepth 1 -maxdepth 1 ! -name work -exec rm -rf {} +
  echo "KEPT=$A/work"
else
  rm -rf "$A"
fi
echo "REMOVED=ahpd service"
```

2. **Remove it from Anton.**
   - Call `anton.builtin.settingsRead` with section `ahp`.
   - If the `localhost` server's address equals the printed `ADDRESS`, or no `ADDRESS` was printed and the address is a `ws://127.0.0.1:` URL that no longer answers, call `anton.builtin.settingsWrite` with `{"section":"ahp","field":"server","key":"localhost","delete":true}`. Leave any other AHP server alone.
   - If no AHP servers remain, call `anton.builtin.settingsWrite` with `{"section":"ahp","field":"enabled","value":false}`. Do not change the Advanced settings toggle.

3. **Report.** Say that the ahpd service and files are gone. If a folder was kept, name it and say the user can delete it once they no longer need those files. Existing Anton chats that used ahpd stay in the sidebar but can no longer reconnect.
