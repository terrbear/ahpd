# Shared session storage and ownership

The SDK exports two opt-in Linux building blocks. The daemon still uses
`fileSessions` by default. These APIs do not enable horizontal cloud scaling.

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
  the task is fenced. Current host dispose/restart paths do not all await close.
- Provider credential refresh is another shared writer. Coordinate refresh and
  atomic credential publication, or use an auth lifetime lock. Copying a refresh
  token into multiple tasks does not make concurrent refresh safe.
- Other process-wide stores, provider indexes, and automation schedulers need
  their own concurrency review. Per-session metadata does not protect them.

No TTL-based cloud lease, host routing, credential refresh coordinator, server
flag, or automatic ownership enforcement is introduced by these primitives.

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
