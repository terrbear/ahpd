# Shared session storage and ownership

The SDK exports two opt-in Linux building blocks. The daemon still uses
`fileSessions` by default. An optional host lifecycle port provides asynchronous
admission and native-identity claims. These APIs do not enable horizontal cloud scaling.

```ts
import { directorySessions, fileSessionLocks } from '@ahpd/sdk';

const sessions = directorySessions({
  directory: '/shared/owner/ahpd/session-records',
  legacyFile: '/shared/owner/ahpd/sessions.json',
});
const locks = fileSessionLocks({ directory: '/shared/owner/ahpd/session-locks' });
const release = locks.acquire('canonical-provider-session-id');
try {
  // Start, use, and fully stop every backend writer for this session.
} finally {
  release();
}
```

## Metadata

Each session has a SHA-256 named JSON record. Reads open the current record;
there is no process snapshot. Setters take a short, per-session metadata lock,
read the current values, change only the requested field, and write a new file.
They fsync the file, rename it, and fsync its directory before returning.
Corrupt records and failed writes throw. A caller must not acknowledge a failed
write as durable. A crash after rename but before acknowledgment can leave the
new value committed; retry setters with the same value.

Different sessions do not share a lock. Same-session changes to different
fields and sender/title entries preserve each other. Replacing a complete
field, such as config or artifacts, still replaces that field. Callers that
read a list and then append must serialize that higher-level operation under
session ownership; the metadata store does not make two API calls a transaction.

Stop **all** old `fileSessions` writers before switching stores. `legacyFile`
is a read-only fallback for records not yet written in the new directory.
The first mutation copies that session's legacy fields. Forget writes an empty
record, so a legacy entry cannot return. Keep the legacy file until all required
records have migrated. Do not roll back to an old writer without an explicit
migration. Never run old and new stores as concurrent writers.

## Process ownership

`fileSessionLocks.acquire(id)` takes a nonblocking exclusive kernel flock and
returns an idempotent release function. A competing acquire throws
`SessionBusyError` with the requested ID. Different sessions can be held at
once, including by separate processes. Use a namespace isolated by owner.
Resolve frontend aliases to the same canonical transcript ID before acquiring.

The process opens the inode; util-linux `flock` locks its inherited descriptor
3. The open-file description stays in the parent after the utility exits.
Closing it or process death releases the lock. No timeout, PID reuse check, or
stale-lock deletion permits takeover. Lock files must never be unlinked: doing
so would allow two processes to lock different inodes under the same name.

Requires util-linux `flock`, Linux open-file-description flock semantics, and a
filesystem/mount that supports remote advisory locking. Windows and mounts
that disable remote locking are unsupported. These APIs do not test mount
configuration or prove EFS behavior. The descriptor is not intentionally
inherited by provider children. If those children outlive the daemon, daemon
lock release does not prove that every writer stopped.

## Required cloud integration

Keep the existing whole-home lock until all these pieces are integrated:

- A durable owner registry binds each canonical session to a task ARN,
  task incarnation, and routable endpoint. Initial assignment is conditional.
- Reconnect reaches the live owner. The same AHP connection can address more
  than one session; a gateway must account for that protocol behavior.
- A timeout or expired heartbeat is not permission to steal ownership.
  Reassignment requires proof the old ECS task has stopped, including its
  provider processes, or another effective write fence. EFS/NFS lease expiry
  alone cannot fence a stale client from future writes.
- Acquire before any backend writer starts. Retain ownership across reconnect,
  idle periods, and restart. Release only after every session writer has
  completed close. A rejected or timed-out close must retain ownership until
  the task is fenced. Host dispose/restart paths now await provider close.
- Provider credential refresh is another shared writer. Coordinate refresh and
  atomic credential publication, or use an auth lifetime lock. Copying a refresh
  token into multiple tasks does not make concurrent refresh safe.
- Other process-wide stores, provider indexes, and automation schedulers need
  their own concurrency review. Per-session metadata does not protect them.

No TTL-based cloud lease, host routing, credential refresh coordinator, or
server flag is introduced by these primitives.

## Validation

`pnpm exec vitest run packages/sdk/test/shared-sessions.test.ts` exercises
current source in independent Node processes: competing same-session metadata
updates, distinct session ownership and writes, same-session refusal, SIGKILL,
failure exit, durable reopen, legacy tombstones, and fail-closed recovery.
Run on Linux with util-linux installed. Local tests do not establish EFS host
loss fencing or cloud reconnect routing; those require deployment-level tests.

For the full source-based suite, use a Node runtime with native TypeScript
stripping (Node 22.18+). Run from the physical worktree path (`cd -P .`) and
use an isolated `XDG_CONFIG_HOME`; the nested stdio daemon test otherwise reads
the operator's existing state. The tests generate `test/fixtures/wire.jsonl`;
do not include unrelated fixture regeneration in a storage-only change.

## Host lifecycle port

Plugins can call `host.registerSessionLifecycle(lifecycle)`, or embedders can
supply `HostOptions.sessionLifecycle`. The SDK exports these types:

```ts
interface SessionLifecycle {
  acquire(context: {
    provider: string;
    sessionUri: string;
    chatUri: string;
    clientId?: string;
  }): Promise<SessionLease>;
}
interface SessionLease {
  claim(canonicalId: string): Promise<void>;
  release(proof: WriterExitProof | { kind: 'never-started' }): Promise<void>;
  disposed?(): Promise<void>;
}
interface WriterExitProof {
  kind: 'isolated-process-scope-empty';
  scope: string;
}
// Optional Session capability; absent from current ACP and Claude providers:
// writerExitProof?: () => WriterExitProof | undefined;
```

Admission completes before `Agent.create`. Creation and lazy resume carry the
connection's client ID; tool-created sessions inherit their parent's client.
Automation admission has no client ID, and a cloud coordinator may reject it.
Client IDs are routing identities, not authentication credentials. Admission
must remain inside the already authenticated owner's boundary.

The host retains one lease per logical chat across supported provider restarts.
Native claims are idempotent for that lease and must be namespaced by provider.
Claude claims its reserved native ID before spawning its query. ACP claims an
existing ID before spawning the adapter for resume; for a new session, ACP
allocates the ID, then the hook claims it before any prompt. An ACP allocator
must guarantee that a new ID does not alias an existing transcript. Claude
forks are refused when the lifecycle hook is active because their new native
ID cannot be reserved through this SDK path.

Disposal awaits provider close. It calls `Session.writerExitProof()` only after
close completes. Only a proof with kind `isolated-process-scope-empty` and a
nonempty scope can authorize `lease.release(proof)`. The capability is a trusted
provider contract: its implementation must establish that every writer was
contained in that scope and that the scope is now empty. A process-group kill,
a direct-child exit, or a successful cleanup callback is not this proof.
The cloud coordinator must validate proof shape again before any cleanup and
retain all locks and protection on missing, invalid, or failed proof.

Without proof the host calls optional `lease.disposed()` and retains the lease.
This notification means only that the logical chat was closed; it must not
release filesystem locks, registry claims, or ECS protection. The closed chat
is removed from the host, but same-task reacquisition is refused until the task
is fenced. Notification failure can be retried. Rejected closes or releases
retain the lease. Host shutdown follows the same proof rule.

A provider factory that throws after entry leaves its lease held: generic host
code cannot prove that factory's partial work exited. Only admission cancelled
before entering the factory can release with `{kind: 'never-started'}`. The
host remembers prior factory entry across retries, so that exception cannot
release a previous partial writer. A rejected admission can be retried.

**Current ACP and Claude providers do not furnish containment proof.** Their
close methods establish direct-child exit only. With the lifecycle hook active,
they disable idle retirement, and the host refuses explicit restart, directory
restart, and rewind until containment support exists. Plain non-shared sessions
retain their previous idle and restart behavior. Do not claim five-minute
memory retirement savings for lifecycle-enabled cloud sessions.

The conservative cloud recovery path retains ownership for the task lifetime.
After logical sessions are disposed, an external drain controller can stop
admission and terminate the task while protection remains; reassignment waits
for authoritative confirmation that that exact ECS task is STOPPED. This SDK
does not stop tasks, clear protection, or reconcile ECS desired count. A
per-session delegated cgroup could eventually provide real containment, but
ordinary ECS cgroup visibility is not evidence that delegation is available.
Process groups alone cannot contain descendants that create their own session.

Keep shared cloud operation disabled until drain/recovery, routing, and
credential coordination are integrated and tested. These hooks do not establish
ECS task death or safe credential sharing.

## Work admission (partial instrumentation)

A lease may implement `beginWork(work: SessionWork): Promise<() => Promise<void>>`,
where `SessionWork` contains string `kind` and globally unique `operationId`.
The lease already identifies the logical chat, so a cloud implementation calls
`drain.beginWork({logicalId: context.chatUri, ...work})`. The returned asynchronous
function records definitive completion. Failed completion must leave the work
outstanding. Admission rejection must prevent dispatch.

The host passes this hook to providers as `Start.beginWork` and refuses new
work after logical disposal. Contributed host tools await admission before
calling the tool and finish after a successful return. Tool rejection retains
the permit because arbitrary tool code may have started detached work.
ACP prompts await admission before opening their runtime and finish after an
actual ACP prompt response, including an authoritative cancelled response.
Transport errors and shutdown during a prompt retain the permit. Cancellation
before opening the runtime may finish because no work was dispatched.

ACP and Claude client-owned tool dispatch also await admission after matching
the native tool call. Only a result from the expected client completes that
permit. Disconnect, turn cancellation, failed publication, and disposal retain
any already-dispatched permit even when they settle the local request with a
synthetic failure. Cancellation during admission completes only if dispatch
never occurred. Waiting for the native call report is not yet counted.

This is not a complete activity census. Claude prompts, report waiters,
shell commands, native background activity, pending questions,
approvals, and other host operations still need instrumentation. An ACP prompt
response alone does not establish that its questions or background work ended.
Do not acknowledge a drain participant as fully instrumented or enable sealing
based on these hooks alone. Disconnect and synthetic cancellation results are
not definitive completion evidence.
