# Managed host updates

The Anton setup installs the managed supervisor on Linux (systemd) and macOS
(launchd). Run setup once after adopting this release to enable it. Existing
custom services keep their current behavior until explicitly migrated.

The supervisor checks for a new revision every six hours. Which tag it fetches
depends on the branch checked out in the source directory; see Channels below.
Updates use this fork, never the upstream npm packages. A private release checkout is built
with the exact pnpm version and frozen lockfile, checked for package boundaries,
and smoke-tested before the live host is touched. Git, npm, a supported Node,
and network access are required; a failed or offline check keeps serving the
current release.

An update waits for all running turns and permission waits to finish. The host
checks idleness itself and immediately closes admission before shutting down.
The supervisor then starts the new release and requires its ready message within
60 seconds. Failure rolls back to the previous release and records the failed
revision so it is not repeatedly retried. A supervisor or machine restart before
readiness also starts the previously confirmed release.

The original configuration and source checkout are preserved. Only plugin paths
inside the managed source checkout are redirected in memory. The daemon keeps
using the original configuration file, so settings edits survive updates. Enabled
Codex providers using a recognized managed adapter path adopt the candidate
release's exact adapter pin and locked Codex runtime. The adapter is installed
and validated before draining the current host, then its command is redirected
only in the child's in-memory configuration. Older supervisors validate it at
activation and roll back before starting a candidate whose adapter fails.
Custom plugins, custom provider commands, credentials, disabled providers and
Node remain operator-managed. Markerless adapter directories are preserved;
a verified `<commit>-managed` sibling is used when necessary. Rollback uses
the prior release's adapter without rewriting saved configuration.

To disable automatic updates, put `{"enabled":false}` in
`~/.a3/ahpd/self-update.json`. The file is checked each minute. An optional
`intervalMinutes` controls checks (default 360, minimum 5). Status and failures
are logged to `ahpd.log`; `managed-update-state.json` records current, previous,
and rejected revisions. Builds are under `managed-releases`; older managed releases are pruned after
readiness, keeping current and previous. The original source checkout is always
retained. Do not remove the current or previous release.

## Channels

The channel is the branch checked out in `~/.a3/ahpd-src`, the checkout setup
cloned. Managed release directories are detached, so the updater reads that
source checkout and not the release that is currently serving.

- `develop` fetches the `anton-ahpd-develop` tag. CI moves that tag only after
  a successful push to `develop`, the same way `anton-ahpd` follows `main`.
- `main`, a detached checkout, and any other branch fetch `anton-ahpd`. CI
  moves that tag only after a successful push to `main`. An install that has
  never checked out `develop` keeps doing this with no migration, and it does
  not see a develop commit until that commit has been promoted.

A fresh setup clones `main`. To install the develop channel from the start,
run the setup script with `AHPD_CHANNEL=develop`.

Re-running setup fast-forwards the branch already checked out (`main` or
`develop`). It does not change branches. `AHPD_CHANNEL` applies to a new clone.
If it is set and names the other branch, setup stops and says so.

Each validated host release carries the exact Codex ACP commit pinned in its
`scripts/codex-acp.json`. Managed adapter installations follow that release pin
on either channel, including the adapter's locked native Codex runtime. A
custom adapter command remains unchanged; update custom installations yourself.

To switch an install that is already running a release with channel tracking,
check out the other branch in the source directory and restart the service.
The restart drops the six-hour wait; the next check, about a minute after the
service is up, fetches the tag for the branch now checked out.

```bash
git -C ~/.a3/ahpd-src fetch origin
git -C ~/.a3/ahpd-src switch develop
git -C ~/.a3/ahpd-src merge --ff-only origin/develop
systemctl --user restart anton-ahpd.service
```

Use `main` and `origin/main` to switch back. On macOS, restart the LaunchAgent
instead of the systemd unit:

```bash
launchctl bootout "gui/$(id -u)/io.trustgrid.anton.ahpd"
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/io.trustgrid.anton.ahpd.plist"
```

The checkout has to stay on the branch. A detached source is read as `main`.
Until the running release contains this channel tracking, the supervisor still
fetches `anton-ahpd` only. A fresh develop install runs the checkout it cloned,
so it tracks `anton-ahpd-develop` immediately. GitHub reads the publisher from
the default branch, so that tag starts moving once this workflow is on `main`.
A missing tag fails the check and leaves the current release in place.

## Promoting develop to main

New changes land on `develop`. Installs checked out on `develop` pick up a
commit after CI on that push moves `anton-ahpd-develop`. When a change is
ready for everyone else, merge `develop` into `main`. CI on that push moves
`anton-ahpd`, and installs on `main` update from that tag. They do not fetch
`develop` or `anton-ahpd-develop`.
