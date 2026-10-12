# Busy-chat collaboration delivery

The SDK's existing `send_message` and `get_session_context` tools now expose host-owned delivery state. `interrupt_session` is a separate destructive tool requiring the exact active turn ID. Existing host permission and session ownership checks still apply. These tools do not approve agent tools, answer questions, or resume a cancelled turn.

`send_message` returns JSON containing a stable `deliveryId`, target `resource` and `chat`, instance-scoped `generation`, calling session/chat `source`, `acceptedAt`, `ageMs`, `state`, and an `openLink`. Queued receipts also contain `queueId` and current position. The `message` field retains a human-readable acknowledgement; callers previously comparing the entire plain-text response must parse the new JSON response.

States describe host evidence:

| State | Evidence |
| --- | --- |
| accepted | Internal registration before synchronous backend callbacks; not itself proof of handoff. |
| queued | A matching pending instruction is present in the exact target chat. |
| consumed | The exact delivery has a correlated backend turn-start or authoritative turn snapshot. This means handoff, not model comprehension or successful work. |
| superseded | The same caller replaced its confirmed pending revision; `supersededBy` names the new receipt. |
| removed | The backend reported removal without a correlated handoff. This does not authorize a retry. |
| uncertain | Confirmation is missing, conflicting, or the queue revision changed externally. Inspect before any deliberate new delivery. |

`send_message({session, message, supersedes})` replaces only the calling session/chat's exact confirmed pending revision. It keeps the backend queue ID and order, generates a new delivery ID, and preserves agent/delegation attribution. Unknown, old-generation, consumed, removed, foreign-caller, foreign-target, and externally edited receipts fail before another backend write. The revision fingerprint is private and is never returned or logged. No retry is automatic.

`get_session_context` includes delivery information separately from transcript truncation: exact active turn ID, pending count, queue position, age where known, and delivery journal. Pending previews are at most 1024 UTF-8 bytes. The first 50 pending instructions are returned; pass `pendingOffset` from `nextPendingOffset` to page further. External or changed instructions have unknown acceptance time and are not attributed to an old receipt. An unavailable host snapshot explicitly reports unknown delivery state.

The journal retains at most 128 settled and 256 active deliveries per chat. At capacity, a new delivery fails before backend mutation; replacing an existing confirmed pending instruction remains possible. Older settled receipts are evicted with `deliveryHistoryTruncated: true`. Unlisted or previous-generation identities remain unknown, never implicitly retryable. There is no active-delivery TTL. Host/chat disposal clears retained state; the journal is in-memory and does not claim restart durability.

`interrupt_session({session, turnId})` registers its observer before cancelling and waits at most five seconds for the exact target instance/chat/turn terminal event or authoritative terminal snapshot. It returns `confirmed` or `unconfirmed` and whether the pre-existing queue IDs remain present. It never sends a new instruction, drains a queue, grants permission, or cancels a worker's parent as fallback. A pending stop for the same turn rejects another cancellation; at most 256 stop observers are retained across the host. Terminal callbacks from a replaced same-URI session cannot confirm the current stop. Confirmation is host turn termination, not a process-exit receipt or rollback of earlier side effects.

Delegated mid-turn steering is explicitly unsupported. Some adapters have a steer method, but they do not provide a uniformly correlated delegated-instruction consumption receipt. The context capability reports this limitation instead of assigning delegated text a user origin or claiming invisible success. A coordinator can inspect, explicitly interrupt, and deliberately supersede its own still-pending instruction. Permission and elicitation holds remain in force.

## Verification and limits

Dedicated helper tests cover synchronous callbacks, missing and conflicting receipts, same-ID external edits, queue ordering, provenance, capacity/eviction, exact-turn stopping, disposal, stale owners, and observer bounds. Actual `createHost` tests use the unchanged ACP bridge and subprocess fixture to keep a Codex permission pending, supersede queued validation, and prove only the correction reaches the next prompt once. They invoke the bound host-tool handler; they do not claim live model adherence or a browser-to-MCP approval integration test.

The deterministic fuzz suite uses xorshift32, 64 default seeds, and 100 operations per seed, including queue/supersede/remove/external edit, turn completion, held permission/elicitation, late/duplicate/reordered/missing callbacks, reconnect observation, same-URI recreation, capacity, eviction, interruption, and host close. Consumed receipts must match the model's actual handed-off instruction; foreign replacement cannot mutate the backend. Explicit larger campaigns accept bounded `AHP_DELIVERY_FUZZ_START`, `AHP_DELIVERY_FUZZ_COUNT` (up to 10000), and `AHP_DELIVERY_FUZZ_STEPS` (up to 1000). This is reproducible fixture coverage, not a proof of all backend or live-network behavior.

The minimized seed `0x32240001` reproduces a late old-instance terminal callback falsely confirming a replacement session's same-ID turn stop. The permanent regression requires the stop to remain unconfirmed, with no retained timeout after settlement. Other focused regressions cover stale pending attribution, chat-specific cleanup, duplicate pending stop bounds, and a missing-body old-revision handoff that must stay uncertain until a matching authoritative turn snapshot or callback arrives. The initial large campaign executed its assertions but failed with a Vitest reporting RPC timeout; yielding to the real event loop between seeds corrected the harness without increasing timeouts or retries. That failed command is retained as failed evidence. Execution receipts and any failed campaign attempts are reported separately with the reviewed source head.

This SDK slice addresses the collaboration tool contract in Anton issue #3224. Anton UI/local-queue presentation and other unimplemented issue requirements remain outside this change. No running daemon or live session was changed.
