---
title: Bounded Node WebSocket output and memory diagnosis
date: 2026-10-13
refs:
  - git://31bf80ab062e88439784475d5eff590b88b52f43 - investigated base
  - "[code://packages/sdk/src/rpc.ts#L108-L125](../../packages/sdk/src/rpc.ts#L108-L125) - serialization and outbound admission"
  - "[code://packages/sdk/src/listen.ts#L307-L325](../../packages/sdk/src/listen.ts#L307-L325) - Node queue measurement and connection cleanup"
  - "[code://packages/sdk/test/outbound.test.ts](../../packages/sdk/test/outbound.test.ts) - finite synthetic reproductions and regressions"
  - "[code://packages/sdk/src/host.ts#L2246-L2248](../../packages/sdk/src/host.ts#L2246-L2248) - replay retention and broadcast"
  - "[code://packages/agent-acp/src/persistence.ts#L59-L72](../../packages/agent-acp/src/persistence.ts#L59-L72) - full record serialization and caching"
---

## Finding and confidence

At the investigated base, each outgoing RPC message was fully serialized whenever the wire reported itself open.
The Node listener sent the string through `ws.send` without inspecting `bufferedAmount`.
A consumer that stopped reading therefore allowed continued enqueueing and serialization without an application byte bound.
The installed lockfile-pinned `ws` implementation reports socket writable bytes plus sender buffered bytes through `bufferedAmount`.

Confidence is high in this defect and its correction, established by a failing deterministic reproduction and passing regressions including an actual paused loopback consumer.
Attribution to the reported OOM remains unproven, with low confidence from source and the supplied allocation context alone.
A V8 string allocation during JSON serialization identifies the allocation that failed, not the objects retaining memory or the caller responsible.
No private logs, session payloads or credentials were needed for this investigation.
All test data is generated synthetic text.

## Related paths investigated

| Path | Source finding | Remaining uncertainty |
| --- | --- | --- |
| RPC broadcast | [`rpc.ts`](../../packages/sdk/src/rpc.ts) serializes each message; [`host.ts`](../../packages/sdk/src/host.ts#L1887) calls each subscribed peer separately. | Fan-out multiplies allocations and per-client queues. |
| WebSocket output | [`listen.ts`](../../packages/sdk/src/listen.ts#L307) had no Node backlog admission check. | The incident's consumer behavior is unknown. |
| Replay | [`host.ts`](../../packages/sdk/src/host.ts#L1247) retains 1,000 cloned actions, with eviction at line 2247. | An action count is not a byte bound; reconnect serializes a combined replay response. |
| Historical transcripts | [`host.ts`](../../packages/sdk/src/host.ts#L5922) caches nonempty transcripts; reads share an in-flight promise, then retain results at line 6068. | No cache byte budget or eviction was found on this path. |
| Snapshots | [`host.ts`](../../packages/sdk/src/host.ts#L6093) clones state; [`paging.ts`](../../packages/sdk/src/paging.ts#L24) pages by 50 turns. | Turn counts do not bound payload bytes, and clones cost memory before transmission. |
| ACP history | [`session.ts`](../../packages/agent-acp/src/session.ts#L377) retains raw updates in watched turns as well as mapped response parts. | Payloads and session duration determine retained size. |
| ACP persistence | [`persistence.ts`](../../packages/agent-acp/src/persistence.ts#L24) stringifies a complete record; `save` writes all turns and the index, then caches the record. | Lifecycle and input checkpoints repeat full serialization; ordinary text deltas do not save on every update. |
| Stdio and nested relays | [`listen.ts`](../../packages/sdk/src/listen.ts#L484) writes without checking writable backlog; [`nested.ts`](../../packages/sdk/src/nested.ts#L153) retains unread frames and at line 189 writes without backpressure. | These transports and incomplete input-line buffers remain outside this fix. |
| Other serialization | Session metadata, usage records, HTTP responses, tool inputs and tool responses also stringify values. | The supplied allocation stack cannot select one entrypoint. |

## Correction

`Wire.bufferedBytes` optionally supplies the transport's pending byte count.
Node WebSockets supply `socket.bufferedAmount`.
The peer checks a full queue before serializing, then admits the serialized UTF-8 payload only if it fits within 8,388,608 bytes including the existing backlog.
Closure becomes permanent and idempotent, rejects unanswered requests and prevents further serialization.
Node terminates the socket immediately to release its queue, with the existing close event releasing the host connection and subscriptions.
Disconnecting allows normal protocol recovery instead of silently skipping actions on a connected client's reducer.

The 8 MiB budget is a conservative implementation default, not a measurement of production payload requirements.
It bounds one connection's outgoing queue and rejects individual frames beyond the available budget.
An unmasked WebSocket frame header can add up to ten bytes beyond the admitted payload budget.
Clients producing legitimate large snapshots or combined replay replies may disconnect repeatedly until those payloads can be paged or reduced.

This change does not establish a bound on total daemon memory.
A single large object still allocates its JSON string before the size check, so this path can still exhaust memory while serializing one message.
History, replay payload sizes, concurrent connections, Bun, Deno, stdio and custom wires without byte reporting remain independent growth paths.

## Synthetic reproduction and verification

The deterministic Node transport model retains only a queued-byte counter, never a growing queue of strings.
It attempts 256 messages whose synthetic Unicode payload is 16,384 copies of `界`.
Each serialized notification is 49,202 UTF-8 bytes.
The base sent all 256, producing a modeled backlog of 12,595,712 bytes and an expected regression failure.
The correction sends 170, peaks at 8,364,340 payload bytes, serializes the 171st frame once before rejecting it, and stops further serialization.
The actual paused loopback test attempts at most 1,024 frames, under a 48.1 MiB traffic ceiling, and yields to the event loop every eight frames.
It verifies disconnect, one connection cleanup, and observed backlog no greater than the budget plus a frame header.
The initial 512-frame real-socket budget stayed below the cap and was insufficient to require disconnect; the final finite budget reaches it.
The draining-consumer test sends all 256 Unicode messages in order without disconnecting.
The remaining new cases verify the exact byte boundary, pre-serialization refusal, pending-request rejection and an oversized Unicode frame.

Baseline command, before the production change:

```sh
node --max-old-space-size=256 node_modules/vitest/vitest.mjs run packages/sdk/test/outbound.test.ts --maxWorkers=1 --no-file-parallelism
```

Result: one expected failure, asserting 12,595,712 bytes exceeds 8,388,608 bytes.
The first sandboxed attempt stopped at a loopback bind restriction before reaching assertions.
Socket tests subsequently ran through the standard per-command approval mechanism.
No heap limit was increased and no exhaustion test was run.

Final focused command:

```sh
node --max-old-space-size=256 node_modules/vitest/vitest.mjs run packages/sdk/test/outbound.test.ts packages/sdk/test/rpc.test.ts packages/sdk/test/listen.test.ts packages/sdk/test/stdio.test.ts packages/sdk/test/subscribe.test.ts packages/sdk/test/host-close.test.ts --maxWorkers=1 --no-file-parallelism
```

Result: six files and 60 tests passed: outbound 6, RPC 15, listener 15, stdio 8, subscription/replay 4, host close 12.
`pnpm typecheck` passed.
`pnpm boundary` passed for all eight packages, with no undeclared imports.
`git diff --check` passed.
The full repository test suite and a live workload were not run.

Dependencies were installed from the unchanged lockfile with scripts disabled:

```sh
pnpm install --frozen-lockfile --ignore-scripts --store-dir /tmp/ahpd-oom-pnpm-store --fetch-retries 0
```

The install completed through standard approval after offline attempts lacked a usable cache and a sandboxed network attempt failed resolution.
The work is local to the isolated branch; publishing, service changes and deployment are outside this task.
