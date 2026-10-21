---
name: ahpd-setup
description: One-time setup for the ahpd bundle. Installs the ahpd agent host with the Claude Code and Codex backends under ~/.a3/ahpd, runs it as a login service with a connection token, and registers it in Anton as the localhost AHP server. Load when the ahpd bundle is installed or when the user asks to set up or repair ahpd.
---

# Set up ahpd for Anton

This installs the [terrbear/ahpd](https://github.com/terrbear/ahpd) fork of the Agent Host Protocol server, so Anton can run Claude Code and Codex sessions on this machine. The fork contains the session and model-listing fixes used by the existing Anton setup. Managed installations automatically adopt CI-validated ahpd releases when idle; set `{"enabled":false}` in `~/.a3/ahpd/self-update.json` to opt out. Node, custom plugins, and separately pinned Codex ACP installations remain operator-managed.

Tell the user in one or two sentences what is about to happen, then do these steps in order. Stop and report the error if a step fails; do not improvise workarounds.

1. **Check prerequisites.** macOS or Linux with systemd, Git, pnpm through Corepack, Node.js 22 or newer on PATH, and Claude Code installed and signed in (`claude` works in a terminal). The Codex ACP adapter is built from the full commit pinned in `~/.a3/ahpd-src/scripts/codex-acp.json`; Codex uses its own sign-in via the active install's `node_modules/.bin/codex login` (normally `~/.a3/ahpd/codex-acp/<pinned-commit>/node_modules/.bin/codex`, or `<pinned-commit>-managed` when preserving an older markerless directory), or an existing login in `~/.codex`. The script checks Git, pnpm, Node.js and the OS itself.

2. **Install and start ahpd.** Run this script exactly as written with bash. It is safe to run again: it reuses the existing port and token, reuses only an integrity-checked adapter build for the pinned commit, and rolls back config/service files if the new service does not become healthy.
   - Clones or fast-forwards `terrbear/ahpd` in `~/.a3/ahpd-src`, installs its locked pnpm dependencies and builds `packages/server`, `packages/agent-claude`, and `packages/agent-acp`. Builds the pinned `terrbear/codex-acp` commit into `~/.a3/ahpd/codex-acp/<commit>` using its frozen npm lockfile; an integrity-matched install is reused, a mismatched marked install is staged before replacement, and unmarked directories are never overwritten. If the canonical commit directory is markerless, it is left untouched while setup builds a verified `<commit>-managed` sibling. No floating npm package or global install is used.
   - Preserves existing ahpd config and the configured `paths` allowlist. It migrates the known obsolete npm shim, a marker-backed pinned install, or the legacy markerless layout only when its package identity and executable match; a custom Codex adapter remains untouched. The old npm package tree is left unused rather than removing unrelated packages.
   - Uses port 9187 or the next free port only for a new config, binds to 127.0.0.1, and uses `~/.a3/ahpd/work` as the fresh-install default.
   - ahpd creates the connection token at the configured `connectionTokenFile` (owner-only); for a fresh config this is `~/.a3/ahpd/token`. Existing relative token paths are resolved from `~/.a3/ahpd/config.json`.
   - Installs a login service through the managed supervisor at `~/.a3/ahpd-src/scripts/managed-host.mjs`: `~/.config/systemd/user/anton-ahpd.service` on Linux, `~/Library/LaunchAgents/io.trustgrid.anton.ahpd.plist` on macOS. Its stable PATH contains the detected Node/provider locations and standard system locations; transient shell paths are excluded. Logs go to `~/.a3/ahpd/ahpd.log`.
   - On success it prints `ADDRESS=...`, `AHPD_HOME=...`, and the resolved `TOKEN_FILE=...`. It prints the token-file path, never the token value.

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
CLAUDE="$(command -v claude || true)"
CODEX_REVISION="$("$NODE" -e 'const fs=require("node:fs");console.log(JSON.parse(fs.readFileSync(process.argv[1],"utf8")).revision)' "$SRC/scripts/codex-acp.json")"
[[ "$CODEX_REVISION" =~ ^[a-f0-9]{40}$ ]] || { echo "ERROR: invalid pinned Codex ACP revision in $SRC/scripts/codex-acp.json"; exit 1; }
CODEX_INSTALL="$A/codex-acp/$CODEX_REVISION"
if [ -d "$CODEX_INSTALL" ] && [ ! -e "$CODEX_INSTALL/.codex-acp-install.json" ]; then
  echo "Leaving the existing markerless Codex ACP directory untouched; installing a verified managed sibling instead."
  CODEX_INSTALL="$A/codex-acp/$CODEX_REVISION-managed"
fi
echo "Installing the pinned Codex ACP backend at $CODEX_INSTALL"
"$NODE" "$SRC/scripts/install-codex-acp.mjs" "$CODEX_INSTALL"
if [ -x "$CODEX_INSTALL/node_modules/.bin/codex" ]; then CODEX="$CODEX_INSTALL/node_modules/.bin/codex"; else CODEX="$(command -v codex || true)"; fi
if [ -f "$A/config.json" ]; then
  PORT="$("$NODE" -e 'const fs=require("node:fs");console.log(JSON.parse(fs.readFileSync(process.argv[1],"utf8")).port ?? 9187)' "$A/config.json")"
else
  PORT="$("$NODE" -e '
const net = require("net");
const busy = (p) => new Promise((r) => { const c = net.connect(p, "127.0.0.1"); c.once("connect", () => { c.destroy(); r(true); }); c.once("error", () => r(false)); });
const free = (p) => new Promise((r) => { const s = net.createServer(); s.once("error", () => r(false)); s.once("listening", () => s.close(() => r(true))); s.listen(p, "127.0.0.1"); });
(async () => { for (let p = 9187; p < 9287; p++) { if (!(await busy(p)) && (await free(p))) { console.log(p); return; } } process.exit(1); })();
')"
fi
AHPD="$SRC/packages/server/dist/main.js"
if [ "$OS" = linux ]; then
  SERVICE_FILE="$HOME/.config/systemd/user/anton-ahpd.service"
else
  SERVICE_FILE="$HOME/Library/LaunchAgents/$LABEL.plist"
fi
BACKUP_DIR="$(mktemp -d "$A/.ahpd-setup-backup.XXXXXX")"
chmod 700 "$BACKUP_DIR"
CONFIG_EXISTED=0
SERVICE_EXISTED=0
CONFIG_WRITTEN=0
restore_setup() {
  STATUS=$?
  RESTORE_FAILED=0
  trap - EXIT
  if [ "$STATUS" -ne 0 ] && [ "$CONFIG_WRITTEN" -eq 1 ]; then
    echo "ERROR: setup failed after config/service update; restoring the previous files" >&2
    if [ "$CONFIG_EXISTED" -eq 1 ]; then
      if ! mv -f "$BACKUP_DIR/config.json" "$A/config.json"; then echo "ERROR: could not restore config; backup retained at $BACKUP_DIR/config.json" >&2; RESTORE_FAILED=1; fi
    elif ! rm -f "$A/config.json"; then echo "ERROR: could not remove failed config $A/config.json" >&2; RESTORE_FAILED=1; fi
    if [ "$SERVICE_EXISTED" -eq 1 ]; then
      if ! mv -f "$BACKUP_DIR/service" "$SERVICE_FILE"; then echo "ERROR: could not restore service file; backup retained at $BACKUP_DIR/service" >&2; RESTORE_FAILED=1; fi
    elif ! rm -f "$SERVICE_FILE"; then echo "ERROR: could not remove failed service file $SERVICE_FILE" >&2; RESTORE_FAILED=1; fi
    if [ "$OS" = linux ]; then
      systemctl --user daemon-reload || true
      systemctl --user restart anton-ahpd.service || true
    else
      launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
      if [ "$SERVICE_EXISTED" -eq 1 ]; then launchctl bootstrap "gui/$(id -u)" "$SERVICE_FILE" || true; fi
    fi
  fi
  if [ "$RESTORE_FAILED" -eq 0 ]; then rm -rf "$BACKUP_DIR"; else echo "ERROR: recovery files retained in $BACKUP_DIR" >&2; fi
  return "$STATUS"
}
trap restore_setup EXIT
if [ -e "$A/config.json" ]; then
  [ -f "$A/config.json" ] || { echo "ERROR: $A/config.json is not a regular file"; exit 1; }
  cp -p "$A/config.json" "$BACKUP_DIR/config.json"
  CONFIG_EXISTED=1
fi
if [ -e "$SERVICE_FILE" ]; then
  [ -f "$SERVICE_FILE" ] || { echo "ERROR: $SERVICE_FILE is not a regular file"; exit 1; }
  cp -p "$SERVICE_FILE" "$BACKUP_DIR/service"
  SERVICE_EXISTED=1
fi
"$NODE" "$SRC/scripts/configure-codex-acp.mjs" "$A" "$SRC" "$CODEX_INSTALL/dist/index.js" "$NODE" "$OS" "$SERVICE_FILE" "$PORT" "$CLAUDE" "$CODEX"
CONFIG_WRITTEN=1
if [ "$OS" = linux ]; then
  if command -v systemd-analyze >/dev/null 2>&1; then systemd-analyze verify "$SERVICE_FILE"; fi
  systemctl --user daemon-reload
  systemctl --user enable anton-ahpd.service >/dev/null
  systemctl --user restart anton-ahpd.service
else
  plutil -lint "$SERVICE_FILE" >/dev/null
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$SERVICE_FILE"
fi
CONFIG_PATH="$A/config.json"
PORT="$("$NODE" -p 'JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).port' "$CONFIG_PATH")"
CONNECT_HOST="$("$NODE" -e '
const fs = require("node:fs");
const config = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
let host = config.host ?? "127.0.0.1";
if (host === "" || host === "0.0.0.0") host = "127.0.0.1";
else if (host === "::") host = "::1";
if (/[\0\r\n]/.test(host)) process.exit(1);
process.stdout.write(host);
' "$CONFIG_PATH")"
URL_HOST="$("$NODE" -e 'const host=process.argv[1];process.stdout.write(host.includes(":")?`[${host}]`:host)' "$CONNECT_HOST")"
TOKEN_FILE="$("$NODE" -e '
const fs = require("node:fs");
const path = require("node:path");
const file = process.argv[1];
const config = JSON.parse(fs.readFileSync(file, "utf8"));
const configured = config.connectionTokenFile ?? "token";
const tokenFile = path.isAbsolute(configured) ? configured : path.resolve(path.dirname(file), configured);
if (/[\0\r\n]/.test(tokenFile)) process.exit(1);
process.stdout.write(tokenFile);
' "$CONFIG_PATH")"
ADDRESS="ws://$URL_HOST:$PORT"
for _ in $(seq 1 60); do
  SERVICE_UP=0
  if [ "$OS" = linux ]; then systemctl --user is-active --quiet anton-ahpd.service && SERVICE_UP=1; else launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1 && SERVICE_UP=1; fi
  if [ "$SERVICE_UP" -eq 1 ] && [ -s "$TOKEN_FILE" ] && "$NODE" -e 'const c=require("net").connect({port:+process.argv[1],host:process.argv[2]});c.once("connect",()=>{c.destroy();process.exit(0)});c.once("error",()=>process.exit(1))' "$PORT" "$CONNECT_HOST"; then
    echo "ADDRESS=$ADDRESS"
    echo "AHPD_HOME=$A"
    echo "TOKEN_FILE=$TOKEN_FILE"
    exit 0
  fi
  sleep 1
done
echo "ERROR: ahpd did not start; last log lines:"
tail -n 20 "$A/ahpd.log" 2>/dev/null || true
exit 1
```

3. **Register it in Anton.** Never read, print, or copy the token itself; pass the `TOKEN_FILE` path printed by setup and Anton reads it.
   - Call `anton.builtin.settingsRead` with section `ahp`. If a `server` entry for `localhost` already exists with an address other than the `ADDRESS` printed above, ask the user before replacing it: replacing it detaches Anton sessions that used the old server.
   - If `advanced-toggle.advanced` is not already true, call `anton.builtin.settingsWrite` with `{"section":"advanced-toggle","field":"advanced","value":true}`. AHP sessions only appear with Advanced settings on.
   - Call `anton.builtin.settingsWrite` with `{"section":"ahp","field":"server","key":"localhost","value":{"address":"<ADDRESS>","tokenFile":"<TOKEN_FILE>"}}`, JSON-escaping the exact printed path as needed.
   - Call `anton.builtin.settingsWrite` with `{"section":"ahp","field":"enabled","value":true}`.

4. **Tell the user how to use it.** In New Chat, pick the localhost host, a working folder (or `~/.a3/ahpd/work`), and **Claude Code** or **Codex** in the model picker (Codex needs its own sign-in first). ahpd starts automatically at login. If sessions fail, check `~/.a3/ahpd/ahpd.log` and that `claude` (or Codex) is signed in. To remove everything, uninstall the bundle; its teardown skill stops the service and cleans up.
