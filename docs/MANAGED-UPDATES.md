# Managed host updates

The Anton setup installs the managed supervisor on Linux (systemd) and macOS
(launchd). Run setup once after adopting this release to enable it. Existing
custom services keep their current behavior until explicitly migrated.

The supervisor checks `terrbear/ahpd`'s `anton-ahpd` release tag every six hours.
CI promotes only a successful push to the current `main` commit. Updates use
this fork, never the upstream npm packages. A private release checkout is built
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
using the original configuration file, so settings edits survive updates. Custom plugins, credentials, provider commands, and Node stay
operator-managed. In particular this updates ahpd, not separately pinned Codex
ACP installations. Update those through setup when changing their pin.

To disable automatic updates, put `{"enabled":false}` in
`~/.a3/ahpd/self-update.json`. The file is checked each minute. An optional
`intervalMinutes` controls checks (default 360, minimum 5). Status and failures
are logged to `ahpd.log`; `managed-update-state.json` records current, previous,
and rejected revisions. Builds are under `managed-releases`; older managed releases are pruned after
readiness, keeping current and previous. The original source checkout is always
retained. Do not remove the current or previous release.
