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
The initial focused run hit a test-helper failure in three historical comparisons; after the helper was corrected, the exact three-case rerun passed.
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
Both zero-backlog historical recovery assertions passed in the targeted rerun after the helper correction.

## Finite workload comparison

The deterministic transport model retains only a queued-byte counter, never a growing queue of strings.
It attempts 256 messages whose payload is 16,384 copies of `界`, making each notification 49,202 UTF-8 bytes.
The following table gives source-derived expectations, with the final counts independently verified by the passing Node listener model test.
The exact three-version comparison passed in the targeted rerun; its measured counters are reported below.

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

The task authorized one focused Node/Vitest regression run and a specifically allocated three-case historical rerun, with no aggregate/full-suite tests or parallel builds.
The initial run used a 256 MiB V8 heap cap per process, one worker, no file parallelism and a 180-second outer timeout.
Exact command:

```sh
NODE_OPTIONS=--max-old-space-size=256 node --max-old-space-size=256 node_modules/vitest/vitest.mjs run packages/sdk/test/outbound.test.ts packages/sdk/test/outbound-recovery.test.ts packages/sdk/test/outbound-comparison.test.ts packages/sdk/test/outbound-runtime.test.ts packages/sdk/test/rpc.test.ts packages/sdk/test/listen.test.ts packages/sdk/test/stdio.test.ts packages/sdk/test/subscribe.test.ts packages/sdk/test/host-close.test.ts --maxWorkers=1 --no-file-parallelism
```

Initial run start: `2026-10-14T01:59:39.923762Z`.
Initial run end: `2026-10-14T01:59:44.295608Z`.
Initial terminal result: exit 1, 69 passed and 3 failed across nine files, duration 4.08 seconds, no OOM.
Passed: outbound 10, real healthy recovery 2, runtime adapter compatibility 3, RPC 15, listener 15, stdio 8, subscription/replay 4 and host close 12.
Failed: three historical-comparison tests, each with `TypeError: A dynamic import callback was not specified` in the helper before comparison assertions.
The helper now evaluates exact historical RPC source as synchronous CommonJS instead of using a generated dynamic import.
Historical comparisons skip when a shallow checkout lacks either exact git object; the final healthy socket and backlog tests always run.
The exact targeted rerun was:

```sh
timeout 180s env NODE_OPTIONS=--max-old-space-size=256 node --max-old-space-size=256 node_modules/vitest/vitest.mjs run packages/sdk/test/outbound-comparison.test.ts packages/sdk/test/outbound-recovery.test.ts --testNamePattern="compares the same finite stalled workload|preserves the rejected cap regression" --maxWorkers=1 --no-file-parallelism
```

Targeted rerun start: `2026-10-14T02:09:14.748188610Z`.
Targeted rerun end: `2026-10-14T02:09:16.761635626Z`.
Terminal result: exit 0, 3 passed and 2 filtered/skipped across two files, duration 1.64 seconds, no OOM. This passed the finite three-version comparison and both healthy zero-backlog recovery comparisons. The local test slot was then released to Sentry.
The production correction did not change after the focused run.
`pnpm typecheck` passed before and after the synchronous helper correction.
`pnpm boundary` passed for all eight packages, and `git diff --check` passed.
No aggregate/full-suite test, build, native Bun/Deno test or live workload was run in the authorized slot.
Bun and Deno compatibility tests exercise their existing listener branches using API doubles under Node; stdout is tested with an actual finite stalled `Writable`.
No incident logs or customer payloads are included; test inputs are generated synthetic data, and the exact command, timing and exit results are recorded above.

Dependencies were installed from the unchanged lockfile with scripts disabled; no package or lockfile changes were made. The initial sandboxed fetch failed, and an approved retry succeeded.
The work is local to `fix/ahpd-v8-oom-highwater`, starting exactly at `abdd4504bce4aed563205920641a4f3fa3c2ec29`.
No old worktree or thread storage was inspected, and no push, PR, merge, service action or deployment was performed.

## 2026-10-14 follow-up: replay retention

The user reported another periodic crash and asked for investigation and a pushed fix.
The service journal records an abort at `2026-10-14T20:34:32Z` and an automatic restart five seconds later.
The daemon log records `Ineffective mark-compacts near heap limit` with approximately 4,088 MiB still retained after collection.
The active release was `a794e1daa8e68f391c02558333372596ff9bc3b9`, which already contains the outbound drain fixes.
Backlog and deferred-byte closures immediately preceded the abort, so those protections were running but did not prevent process heap exhaustion.

[`mapping.ts`](../../packages/agent-acp/src/mapping.ts) accumulates terminal deltas into the tool's full content and emits that full content in each `chat/toolCallContentChanged` action.
The host previously cloned and retained 1,000 such actions without a byte budget.
Repeated cumulative output therefore retained many independent copies of the same growing text, regardless of whether any client subscribed or drained its socket.
Local ACP records confirm terminal-delta traffic in the affected sessions; no private payloads are copied into this repository or its tests.
This demonstrates an independent memory amplification path, but without a heap snapshot it does not establish that replay was the sole retainer in the reported crash.

[`replay.ts`](../../packages/sdk/src/replay.ts) now keeps a contiguous suffix bounded by 1,000 actions and 32 MiB of estimated cloned storage.
Accounting charges two bytes per string code unit plus allowances for properties, arrays and objects, without serializing or cloning the candidate first.
Old entries are released before cloning an admitted action.
An oversized, unsupported or excessively deep value clears the replay suffix and advances the eviction watermark, while live broadcast remains unchanged.
An empty buffer after such an action must not mean that an older client missed nothing.
Reconnect uses the watermark to select the existing snapshot recovery path, and subscribe retakes a snapshot if its catch-up actions were evicted while it awaited state.
A second gap rejects subscribe so it cannot silently establish an incomplete baseline.
The budget applies to replay retention, not individual frames, snapshots, live session state, transcript caches or total process memory.

### Verification

All seven new replay tests pass under a 256 MiB heap cap.
They cover cumulative ACP terminal output, live delivery, eviction boundaries, contiguous replay, large-action snapshot recovery with an empty buffer, snapshot races, clone avoidance, immutable values, and small-action count limits.
The three new host/ACP integration tests were also run against the exact `a794e1d` host source; all three failed as expected, while the fixed source passes.
The old host returns retained replay for the two oversized workloads, and the subscription race retains its old snapshot rather than retaking it.

A separate finite synthetic comparison ran 96 cumulative tool-content actions, adding 16,384 copies of `界` per action, under Node 22 with `--expose-gc --max-old-space-size=256`.
The count-only implementation retained 96 actions and grew the collected heap by 148.54 MiB.
The bounded implementation retained the latest 11 actions, accounted for 31.29 MiB and grew the collected heap by 30.52 MiB.
These are reproduction measurements, not measurements of the production process.

The focused 11-file run covered 439 tests: 435 passed initially, and four required generating `tools/ahp.strict.schema.json` first.
After `node tools/schema.mjs`, the targeted seven-test rerun passed, including all four previously failing cases.
The passing coverage includes host, protocol conformance, reconnect, presence, permissions, close cleanup, subscription races, outbound grace and all ten healthy large-frame recovery tests.
Socket-based tests needed the unsandboxed runner because loopback binds were denied in the initial sandbox run.
`pnpm typecheck`, `pnpm boundary`, `pnpm build` and `git diff --check` pass.
Dependencies came from the unchanged lockfile using the existing offline package store, with install scripts disabled.
No service restart or production deployment was performed for this investigation.

## October 14 large tool-output follow-up

The running daemon survived the later disconnect with the same PID and no restart.
Its transport logged a 14,554,464-byte frame and the 256-frame queue limit, followed by a client reconnect.
The exact frame was not captured; inspection of the affected session found a similarly sized snapshot dominated by tool output and repeated multiline command labels.

ACP tool text now spills above 32 KiB of UTF-8 into private files under the ACP registry's `outputs` directory.
The session retains only a 12 KiB head and tail, an explicit notice and a standard resource reference with the full byte count.
Small output and complete tool arguments remain intact; display labels are bounded first lines.
Live turns and new persisted records share the materialized response parts rather than retaining a second raw update stream.
Legacy records pass through the same mapper, and their first materialized save retains a `.v1.bak` copy.
The files remain until explicitly cleaned up; their absolute URIs must remain valid while their history is retained.
This limits AHP session retention, not the adapter's own model context or other providers' output.

The host now pages live completed turns as well as restored history, with a 50-turn maximum and a 1 MiB serialized-turn target.
A single oversized turn is admitted intact to preserve cursor progress; active turns and the RPC envelope are additional.
Large arguments and non-tool response text can therefore still exceed that target.

An offline conversion of a copy of the affected persisted session, using the old deployed mapper and the new mapper, measured 38 turns.
Its mapped history shrank from 14,690,346 to 4,697,163 bytes, and its newest page was 970,785 bytes across nine turns.
The persisted record shrank from 20,892,693 to 4,698,103 bytes, with 18 separate output files totaling 7,140,268 bytes.
These are measurements of the copied record, not a measurement of a deployed reconnect frame.
The running daemon and its registry were not modified by the comparison.

Focused validation covers streamed Unicode output, complete artifact bytes and private modes, per-session isolation, replacement output, label bounds with intact arguments, legacy backup and restart recovery, storage failure, shell previews, live byte paging and cursor traversal.
The ACP suite plus host, paging and healthy large-frame recovery tests passed after updating the replay fixture to expose its synthetic history through `allTurns` as well as `chatState`.
The session suite now expects the live snapshot's 50-turn page rather than all 60 retained turns.
Host metadata is added after selecting the page so omitted-cursor fetches and snapshots use the same backend byte boundary.
Typecheck, package boundaries, build and diff checks pass.
