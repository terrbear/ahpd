# @ahpd/agent-acp

[![npm](https://img.shields.io/npm/v/%40ahpd%2Fagent-acp)](https://www.npmjs.com/package/@ahpd/agent-acp)
[![CI](https://github.com/softov/ahpd/actions/workflows/ci.yml/badge.svg)](https://github.com/softov/ahpd/actions/workflows/ci.yml)
![license MIT](https://img.shields.io/badge/license-MIT-blue)
![node >=22](https://img.shields.io/badge/node-%3E%3D22-5fa04e)
![Agent Host Protocol 0.9.0](https://img.shields.io/badge/AHP-0.9.0-0b7285)

An [Agent Client Protocol](https://agentclientprotocol.com) backend for [`@ahpd/sdk`](https://www.npmjs.com/package/@ahpd/sdk), and a plugin for the [`@ahpd/server`](https://www.npmjs.com/package/@ahpd/server) daemon.

Any program that speaks ACP over its stdio is one configured command, not a package of its own, so `copilot --acp`, `codex-acp`, `gemini --experimental-acp` and `@deepseek-ai/dsh-acp` all run through this one package.

Part of [ahpd](https://github.com/softov/ahpd). The source is in [`packages/agent-acp`](https://github.com/softov/ahpd/tree/main/packages/agent-acp).

## In the daemon

```bash
ahpd plugin install @ahpd/agent-acp
```

Then add one entry per ACP server to `plugins` in the daemon's `config.json`:

```json
{
  "plugins": [
    {
      "name": "@ahpd/agent-acp",
      "options": { "provider": "copilot", "displayName": "Copilot", "command": "copilot", "args": ["--acp"] }
    },
    {
      "name": "@ahpd/agent-acp",
      "options": { "provider": "codex", "displayName": "Codex", "command": "codex-acp" }
    }
  ]
}
```

The command must be an absolute executable path or available on the daemon's `PATH`. The `codex` CLI has no ACP mode of its own. This fork uses [terrbear/codex-acp](https://github.com/terrbear/codex-acp), including its native asynchronous question support.

From the terrbear/ahpd repository, install the pinned adapter into a new directory:

```bash
node scripts/install-codex-acp.mjs "$HOME/.local/share/ahpd/codex-acp"
```

Set the Codex provider's `command` to the absolute `dist/index.js` path printed by the installer. The installer fetches the exact fork commit in `scripts/codex-acp.json`, installs its locked dependencies and builds it. It requires Git, npm and Node 22 or newer; Node must also be on the daemon's `PATH`. Existing install directories are never overwritten. For updates, install into a new directory, change the provider command and restart ahpd.

Do not substitute the upstream `@agentclientprotocol/codex-acp` npm package: it may lack the fixes required by this daemon. Adapter changes and pull requests belong in `terrbear/codex-acp`; daemon changes belong in `terrbear/ahpd`. A missing command fails that provider's turns with a message and leaves the daemon running.

## In your own host

```bash
pnpm add @ahpd/agent-acp @ahpd/sdk
```

```ts
import { createHost, listen } from '@ahpd/sdk';
import { acpAgent } from '@ahpd/agent-acp';

const path = process.cwd();
const host = createHost({
  path,
  agents: [
    acpAgent({ provider: 'copilot', displayName: 'Copilot', command: 'copilot', args: ['--acp'] }),
  ],
});
await listen({ port: 9187 }, (peer) => host.accept(peer));
```

`createHost` takes a list of agents, so several ACP servers run beside each other and beside any other backend.

## Options

| option | | |
| --- | --- | --- |
| `command` | required | the program to spawn as the ACP server |
| `stateDirectory` | | private restart registry directory; defaults to `acp-sessions` beside daemon configuration when used as a plugin |
| `args` | | the arguments to give it |
| `env` | | environment variables merged over `process.env` for the child |
| `cwd` | | the directory the server runs in; the session's working directory when absent |
| `provider` | | the AHP provider id, default `acp` |
| `displayName` | | what a client reads instead of the id, default `ACP` |
| `description` | | one line about what this backend is |
| `model` | | the model a session that names none runs on |
| `hostTools` | | give each session the host's tools and its clients' tools as an HTTP MCP server; default on, skipped for a server that takes no http MCP servers |

## What it does

It spawns the command, completes the ACP handshake over its stdio, opens one session, and turns each `session/update` into the `chat/*` action a client already knows. A turn ends as `chat/turnComplete` or `chat/turnCancelled` from the server's own stop reason, and `cancel` reaches the server as its notification.

A `session/request_permission` is a confirmation offering the server's own options, approvals first, and the one the person picks is the `optionId` the server receives. An answer that picked none selects the server's once option of that kind, never an `always`.

## Documentation

| | |
| --- | --- |
| [PLUGINS.md](https://github.com/softov/ahpd/blob/main/docs/PLUGINS.md) | The ACP options in the daemon, and what the server may ask the host for |
| [AGENT.md](https://github.com/softov/ahpd/blob/main/docs/AGENT.md) | The `Agent` and `Session` contracts this implements |
| [AHP.md](https://github.com/softov/ahpd/blob/main/docs/AHP.md) | Which actions are served, which are refused, and why |

## License

MIT © Softov

## Restart persistence

When loaded as a daemon plugin, the bridge stores its host IDs, provider resume
IDs and completed transcript turns in `acp-sessions` beside the daemon
configuration. The index and per-session files are private (mode 0600), and
writes replace files atomically. `stateDirectory` overrides that directory.
Embedders calling `acpAgent` directly can opt in with the same option.

Reopening a saved host ID uses ACP `session/load` with its original provider
ID. A backend that cannot load sessions reports an error instead of silently
starting another conversation. Interrupted turns are restored as cancelled.
Sessions created before this registry existed require recovery because their
host-to-provider mapping was not persisted.

## Codex asynchronous questions

Codex ACP updates carrying `_meta["codex/asyncUserInput"]` become persistent AHP
input requests. This requires a Codex ACP bridge that forwards
`agentMessage.questions`; older bridges discard those native questions.
Completing a turn does not withdraw the form. Reconnecting or restarting restores
unanswered forms, and accepted or declined answers are saved before completion is
broadcast. An explicit stop withdraws pending forms.

A form answer queues a new user turn through the host's normal message queue.
The prompt includes each original question and the user's answer, including
free text. The SDK's `Session.answer` may return `{text}` for this asynchronous
follow-up; existing backends that return nothing keep their current behavior.

File attachments use AHP `embeddedResource` messages. Images become native ACP
image blocks; UTF-8 text files become embedded resource blocks. PDFs are rejected
with a recovery message because ACP providers may expose binary resources as
base64 text instead of native documents. The
provider must advertise `promptCapabilities.image` or `embeddedContext` for the
corresponding content. Unsupported content fails visibly instead of being
silently discarded. Attachments are preserved in queued turns and recorded
transcripts. Images have a 5 MB limit and all files together have a 25 MB limit
per message.

### Codex system instructions

The `codex` provider accepts the host's `ahpd.clientSystemInstructions` extension and forwards the saved instructions through the pinned Codex ACP adapter's `ahpd.clientSystemInstructions` metadata on `session/new`. The adapter passes them to Codex `thread/start` as `developerInstructions`. The bridge checks the adapter's advertised version 1 `ahpd.clientSystemInstructions` capability before opening or resuming an instructed session. Unsupported adapters fail the turn before sending its user prompt. Other ACP providers do not advertise instruction support. The extension does not enable AIR rendering or alter command/file/MCP output.

Instructions are separate from user messages and do not replace the provider's base instructions. The existing Codex thread retains its developer instructions on `session/load`; a new chat receives its own copy through `session/new`. Changing a client's prompt requires a fresh session. Acceptance by the AHP host records its transport contract, not proof that the model followed the instructions.
