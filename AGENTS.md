# Repository ownership

This daemon is maintained in `terrbear/ahpd`. Submit daemon pull requests only to that repository.

The Codex ACP adapter comes from `terrbear/codex-acp`. Submit adapter pull requests only to that repository, never to `agentclientprotocol/codex-acp`. Install the pinned fork with `node scripts/install-codex-acp.mjs <new-install-directory>`; update `scripts/codex-acp.json` when adopting a new adapter commit. Do not replace it with the upstream npm package.
