---
title: Node WebSocket backlog high-water correction and memory diagnosis
date: 2026-10-13
refs:
  - git://31bf80ab062e88439784475d5eff590b88b52f43 - investigated base
  - git://abdd4504bce4aed563205920641a4f3fa3c2ec29 - rejected hard frame cap and replacement starting point
  - "[code://packages/sdk/src/rpc.ts#L108-L125](../../packages/sdk/src/rpc.ts#L108-L125) - serialization and outbound admission"
  - "[code://packages/sdk/src/listen.ts#L307-L325](../../packages/sdk/src/listen.ts#L307-L325) - Node queue measurement and connection cleanup"
  - "[code://packages/sdk/test/outbound.test.ts](../../packages/sdk/test/outbound.test.ts) - finite synthetic reproductions and regressions"
  - "[code://packages/sdk/test/outbound-recovery.test.ts](../../packages/sdk/test/outbound-recovery.test.ts) - healthy large snapshot/replay delivery and rejected-cap evidence"
  - "[code://packages/sdk/test/outbound-comparison.test.ts](../../packages/sdk/test/outbound-comparison.test.ts) - finite comparison of exact git versions"
  - "[code://packages/sdk/test/outbound-runtime.test.ts](../../packages/sdk/test/outbound-runtime.test.ts) - Bun, Deno and stdout adapter compatibility"
  - "[code://packages/sdk/src/host.ts#L2246-L2248](../../packages/sdk/src/host.ts#L2246-L2248) - replay retention and broadcast"
  - "[code://packages/agent-acp/src/persistence.ts#L59-L72](../../packages/agent-acp/src/persistence.ts#L59-L72) - full record serialization and caching"
---

## Finding and confidence

At the investigated base, each outgoing RPC message was fully serialized whenever the wire reported itself open.
The Node listener sent the string through `ws.send` without inspecting `bufferedAmount`.
A consumer that stopped reading therefore allowed continued enqueueing and serialization without an application byte bound.
The installed lockfile-pinned `ws` implementation reports socket writable bytes plus sender buffered bytes through `bufferedAmount`.

The replacement's backlog and healthy recovery regressions pass, including actual paused and draining loopback consumers.
The three historical-comparison tests encountered a test-helper failure in the sole authorized run, so their corrected helper remains unverified.
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
The peer refuses and closes before serializing a new message only when the already-buffered outbound bytes are at or above 8,388,608 bytes.
When the backlog is below that mark, any single frame size is admitted, including a healthy snapshot or replay reply larger than 8 MiB.
Closure becomes permanent and idempotent, rejects unanswered requests and prevents further serialization.
Node terminates the socket immediately to release its queue, with the existing close event releasing the host connection and subscriptions.
Disconnecting allows normal protocol recovery instead of silently skipping actions on a connected client's reducer.

The 8 MiB high-water mark is an implementation default, not a measurement of production payload requirements.
This permits a one-frame overshoot, including that frame's headers, and is not a hard byte bound on the queue or a hard per-frame limit.
No protocol, snapshot, replay, paging, runtime selection or ACP behavior is redesigned.

This change does not establish a bound on total daemon memory.
A single large object still allocates its JSON string when admitted, so one `JSON.stringify` allocation can still exhaust memory.
Total process memory, stdout/stdio and nested output, history, replay retention, ACP persistence, fan-out, Bun, Deno and custom wires without byte reporting remain independent growth paths.
Incident attribution is outside this correction and remains unproven.

## Rejected cap and preserved regression evidence

The rejected `abdd450` candidate serialized a frame and disconnected if its UTF-8 payload plus the existing backlog would exceed 8 MiB.
Its source therefore rejects a healthy snapshot/replay larger than 8 MiB even with zero backlog, and repeated recovery attempts cannot advance.
The replacement removes only that serialized-frame admission check and the now-unused `node:buffer` import from `rpc.ts`.
The inherited research record reported that the rejected candidate's six focused files and 60 tests passed with a 256 MiB heap cap, plus typecheck, boundary and diff checks, but those tests asserted oversized-frame rejection rather than healthy large recovery.
That previous result is retained as rejected-candidate history, not as validation of the replacement.

New host/protocol tests build a completed echo turn whose message and response together make the snapshot and combined replay exceed 8 MiB.
Real Node WebSocket tests pass repeated large subscriptions and replay replies, continued action delivery, ordered unique replay sequences, reducer reconstruction of the completed turn, recovery to a newer sequence and a subsequent empty replay, without repeated disconnects.
The two preserved rejected-cap tests use those same host-generated values on fresh zero-backlog peers, expecting two disconnects and zero deliveries for `abdd450`, compared with two deliveries and no disconnects for the exact base and final code.
Those two historical assertions were not reached in the authorized run because the helper's dynamic import failed.

## Finite workload comparison

The deterministic transport model retains only a queued-byte counter, never a growing queue of strings.
It attempts 256 messages whose payload is 16,384 copies of `界`, making each notification 49,202 UTF-8 bytes.
The following table gives source-derived expectations, with the final counts independently verified by the passing Node listener model test.
The exact three-version comparison remains unverified after the helper failure.

| Version | Serialized | Sent | Peak modeled bytes | Close count |
| --- | ---: | ---: | ---: | ---: |
| `31bf80ab062e88439784475d5eff590b88b52f43` | 256 | 256 | 12,595,712 | 0 |
| Rejected `abdd4504bce4aed563205920641a4f3fa3c2ec29` | 171 | 170 | 8,364,340 | 1 |
| Replacement | 171 | 171 | 8,413,542 | 1 |

The final code admits the 171st frame below the mark, then refuses the 172nd before serialization.
The actual paused loopback tests attempt at most 1,024 frames, under a 48.1 MiB traffic ceiling, and yield every eight frames.
They verify backlog-triggered and explicit peer closure, queue release to zero and one connection cleanup, with no further serialization after closing.
Boundary tests cover backlog exactly at the mark, above it and one byte below, and large Unicode frames admitted from zero, nonzero and almost-full backlogs.
Pending-request tests verify each rejection once, timer removal, idempotent close and ignored late answers.

## Authorized replacement verification

The latest user instruction permits one focused Node/Vitest command and prohibits aggregate/full-suite tests and parallel builds.
The sole run used a 256 MiB V8 heap cap per process, one worker, no file parallelism and a 180-second outer timeout.
Exact command:

```sh
NODE_OPTIONS=--max-old-space-size=256 node --max-old-space-size=256 node_modules/vitest/vitest.mjs run packages/sdk/test/outbound.test.ts packages/sdk/test/outbound-recovery.test.ts packages/sdk/test/outbound-comparison.test.ts packages/sdk/test/outbound-runtime.test.ts packages/sdk/test/rpc.test.ts packages/sdk/test/listen.test.ts packages/sdk/test/stdio.test.ts packages/sdk/test/subscribe.test.ts packages/sdk/test/host-close.test.ts --maxWorkers=1 --no-file-parallelism
```

Start: `2026-10-14T01:59:39.923762Z`.
End: `2026-10-14T01:59:44.295608Z`.
Terminal result: exit 1, 69 passed and 3 failed across nine files, duration 4.08 seconds, no OOM.
Passed: outbound 10, real healthy recovery 2, runtime adapter compatibility 3, RPC 15, listener 15, stdio 8, subscription/replay 4 and host close 12.
Failed: three historical-comparison tests, each with `TypeError: A dynamic import callback was not specified` in the helper before comparison assertions.
The helper now evaluates exact historical RPC source as synchronous CommonJS instead of using a generated dynamic import.
Historical comparisons skip when a shallow checkout lacks either exact git object; the final healthy socket and backlog tests always run.
That test-only correction has not been rerun because the authorized test slot is exhausted and released.
The production correction did not change after the focused run.
`pnpm typecheck` passed before and after the synchronous helper correction.
`pnpm boundary` passed for all eight packages, and `git diff --check` passed.
No aggregate/full-suite test, build, native Bun/Deno test or live workload was run in the authorized slot.
Bun and Deno compatibility tests exercise their existing listener branches using API doubles under Node; stdout is tested with an actual finite stalled `Writable`.
The test log and exact timing/exit metadata are `/tmp/ahpd-v8-oom-highwater-test.log` and `/tmp/ahpd-v8-oom-highwater-test-evidence.json`.

Dependencies were installed from the unchanged lockfile with scripts disabled:

```sh
pnpm install --frozen-lockfile --ignore-scripts --store-dir /tmp/ahpd-highwater-pnpm-store --fetch-retries 0
```

The sandboxed fetch failed; the identical command completed through standard approval with scripts disabled.
The work is local to `fix/ahpd-v8-oom-highwater`, starting exactly at `abdd4504bce4aed563205920641a4f3fa3c2ec29`.
No old worktree or thread storage was inspected, and no push, PR, merge, service action or deployment was performed.
