---
name: ahpd-setup
description: One-time setup for the ahpd bundle. Installs the ahpd agent host with the Claude Code and Codex backends under ~/.a3/ahpd, runs it as a login service with a connection token, and registers it in Anton as the localhost AHP server. Load when the ahpd bundle is installed or when the user asks to set up or repair ahpd.
---

# Set up ahpd for Anton

This installs the [terrbear/ahpd](https://github.com/terrbear/ahpd) fork of the Agent Host Protocol server, so Anton can run Claude Code and Codex sessions on this machine. The fork contains the session and model-listing fixes used by the existing Anton setup.

Tell the user in one or two sentences what is about to happen, then do these steps in order. Stop and report the error if a step fails; do not improvise workarounds.

1. **Check prerequisites.** macOS or Linux with systemd, Git, pnpm through Corepack, Node.js 22 or newer on PATH, and Claude Code installed and signed in (`claude` works in a terminal). Codex is installed by the script but uses its own sign-in: `~/.a3/ahpd/node_modules/.bin/codex login`, or an existing login in `~/.codex`. The script checks Git, pnpm, Node.js and the OS itself.

2. **Install and start ahpd.** Run this script exactly as written with bash. It is safe to run again: it keeps the existing port and token, updates the packages, and restarts the service.
   - Clones or fast-forwards `terrbear/ahpd` in `~/.a3/ahpd-src`, installs its locked pnpm dependencies and builds `packages/server`, `packages/agent-claude`, and `packages/agent-acp`. Installs only `@agentclientprotocol/codex-acp` from npm into `~/.a3/ahpd` (nothing global, no sudo). A dirty or unexpected source checkout stops setup without replacing the running service.
   - Writes `~/.a3/ahpd/config.json`, using port 9187 or the next free port, bound to 127.0.0.1.
   - Uses `~/.a3/ahpd/work` as the default working folder.
   - ahpd creates the connection token at `~/.a3/ahpd/token` (owner-only) on first start.
   - Installs a login service from the fork server at `~/.a3/ahpd-src/packages/server/dist/main.js`: `~/.config/systemd/user/anton-ahpd.service` on Linux, `~/Library/LaunchAgents/io.trustgrid.anton.ahpd.plist` on macOS. Logs go to `~/.a3/ahpd/ahpd.log`.
   - On success it prints `ADDRESS=...` and `AHPD_HOME=...`. The token file is `<AHPD_HOME>/token`; the script prints the folder rather than the file so Anton's secret redaction does not hide the path.

```bash
set -euo pipefail
A="$HOME/.a3/ahpd"
LABEL="io.trustgrid.anton.ahpd"
NODE="$(command -v node || true)"
if [ -z "$NODE" ]; then echo "ERROR: node is not on PATH; install Node.js 22 or newer"; exit 1; fi
MAJOR="$("$NODE" -p 'process.versions.node.split(".")[0]')"
if [ "$MAJOR" -lt 22 ]; then echo "ERROR: node $MAJOR found; ahpd needs Node.js 22 or newer"; exit 1; fi
command -v claude >/dev/null || echo "WARNING: the claude CLI is not on PATH; Claude Code must be installed and signed in"
case "$(uname -s)" in
  Linux) OS=linux; command -v systemctl >/dev/null || { echo "ERROR: systemctl not found; only systemd is supported on Linux"; exit 1; } ;;
  Darwin) OS=mac ;;
  *) echo "ERROR: unsupported OS $(uname -s)"; exit 1 ;;
esac
command -v git >/dev/null || { echo "ERROR: git is not on PATH"; exit 1; }
command -v pnpm >/dev/null || { echo "ERROR: pnpm is not on PATH; enable it with Corepack"; exit 1; }
SRC="$HOME/.a3/ahpd-src"
mkdir -p "$HOME/.a3"
if [ -e "$SRC" ]; then
  [ -d "$SRC/.git" ] || { echo "ERROR: $SRC exists but is not a Git checkout"; exit 1; }
  case "$(git -C "$SRC" remote get-url origin)" in
    git@github.com:terrbear/ahpd|https://github.com/terrbear/ahpd|https://github.com/terrbear/ahpd.git) ;;
    *) echo "ERROR: $SRC has an unexpected origin"; exit 1 ;;
  esac
  [ -z "$(git -C "$SRC" status --porcelain)" ] || { echo "ERROR: $SRC has local changes"; exit 1; }
  [ "$(git -C "$SRC" branch --show-current)" = main ] || { echo "ERROR: $SRC is not on main"; exit 1; }
  git -C "$SRC" fetch origin main
  git -C "$SRC" merge --ff-only origin/main
else
  git clone https://github.com/terrbear/ahpd.git "$SRC"
fi
(
  cd "$SRC"
  pnpm install --frozen-lockfile
  pnpm build
)
mkdir -p "$A/work"
chmod 700 "$A"
if [ ! -e "$HOME/.config/ahpd" ] && [ ! -e "$A/.created-config-dir" ]; then touch "$A/.created-config-dir"; fi
echo "Installing the Codex ACP backend into $A"
npm uninstall --prefix "$A" --no-fund --no-audit --loglevel=error @ahpd/server @ahpd/agent-claude @ahpd/agent-acp
npm install --prefix "$A" --no-fund --no-audit --loglevel=error @agentclientprotocol/codex-acp@latest
if [ -f "$A/config.json" ]; then
  PORT="$("$NODE" -p "require('$A/config.json').port")"
else
  PORT="$("$NODE" -e '
const net = require("net");
const busy = (p) => new Promise((r) => { const c = net.connect(p, "127.0.0.1"); c.once("connect", () => { c.destroy(); r(true); }); c.once("error", () => r(false)); });
const free = (p) => new Promise((r) => { const s = net.createServer(); s.once("error", () => r(false)); s.once("listening", () => s.close(() => r(true))); s.listen(p, "127.0.0.1"); });
(async () => { for (let p = 9187; p < 9287; p++) { if (!(await busy(p)) && (await free(p))) { console.log(p); return; } } process.exit(1); })();
')"
fi
cat > "$A/config.json" <<EOF
{
  "port": $PORT,
  "paths": ["$A/work"],
  "connectionTokenFile": "$A/token",
  "plugins": [
    "$SRC/packages/agent-claude",
    { "name": "$SRC/packages/agent-acp", "options": { "provider": "codex", "displayName": "Codex", "command": "$A/node_modules/.bin/codex-acp" } }
  ],
  "updateCheck": false
}
EOF
chmod 600 "$A/config.json"
AHPD="$SRC/packages/server/dist/main.js"
if [ "$OS" = linux ]; then
  UNIT="$HOME/.config/systemd/user/anton-ahpd.service"
  mkdir -p "$(dirname "$UNIT")"
  cat > "$UNIT" <<EOF
[Unit]
Description=ahpd agent host for Anton

[Service]
WorkingDirectory=$A/work
Environment="PATH=$PATH"
ExecStart=$NODE $AHPD --config-file $A/config.json
Restart=on-failure
RestartSec=5
StandardOutput=append:$A/ahpd.log
StandardError=append:$A/ahpd.log

[Install]
WantedBy=default.target
EOF
  systemctl --user daemon-reload
  systemctl --user enable anton-ahpd.service >/dev/null
  systemctl --user restart anton-ahpd.service
else
  PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
  mkdir -p "$(dirname "$PLIST")"
  cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE</string>
    <string>$AHPD</string>
    <string>--config-file</string>
    <string>$A/config.json</string>
  </array>
  <key>WorkingDirectory</key><string>$A/work</string>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>$PATH</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>StandardOutPath</key><string>$A/ahpd.log</string>
  <key>StandardErrorPath</key><string>$A/ahpd.log</string>
</dict>
</plist>
EOF
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$PLIST"
fi
for _ in $(seq 1 60); do
  if [ -s "$A/token" ] && "$NODE" -e 'const c=require("net").connect(+process.argv[1],"127.0.0.1");c.once("connect",()=>process.exit(0));c.once("error",()=>process.exit(1))' "$PORT"; then
    echo "ADDRESS=ws://127.0.0.1:$PORT"
    echo "AHPD_HOME=$A"
    exit 0
  fi
  sleep 1
done
echo "ERROR: ahpd did not start; last log lines:"
tail -n 20 "$A/ahpd.log" 2>/dev/null || true
exit 1
```

3. **Register it in Anton.** Never read, print, or copy the token itself; pass the token file path and Anton reads it.
   - Call `anton.builtin.settingsRead` with section `ahp`. If a `server` entry for `localhost` already exists with an address other than the `ADDRESS` printed above, ask the user before replacing it: replacing it detaches Anton sessions that used the old server.
   - If `advanced-toggle.advanced` is not already true, call `anton.builtin.settingsWrite` with `{"section":"advanced-toggle","field":"advanced","value":true}`. AHP sessions only appear with Advanced settings on.
   - Call `anton.builtin.settingsWrite` with `{"section":"ahp","field":"server","key":"localhost","value":{"address":"<ADDRESS>","tokenFile":"<AHPD_HOME>/token"}}`.
   - Call `anton.builtin.settingsWrite` with `{"section":"ahp","field":"enabled","value":true}`.

4. **Tell the user how to use it.** In New Chat, pick the localhost host, a working folder (or `~/.a3/ahpd/work`), and **Claude Code** or **Codex** in the model picker (Codex needs its own sign-in first). ahpd starts automatically at login. If sessions fail, check `~/.a3/ahpd/ahpd.log` and that `claude` (or Codex) is signed in. To remove everything, uninstall the bundle; its teardown skill stops the service and cleans up.
