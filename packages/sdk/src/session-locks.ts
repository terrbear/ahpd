/** Linux advisory locks. Cloud failover also needs an external task fence. */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, mkdirSync, openSync } from 'node:fs';
import { join } from 'node:path';

export const sessionKey = (id: string): string => createHash('sha256').update(id).digest('hex');

export class SessionBusyError extends Error {
  readonly session: string;
  constructor(session: string) {
    super(`Session ${session} is owned by another process`);
    this.name = 'SessionBusyError';
    this.session = session;
  }
}

/**
 * Lock an inode without a timeout or stale-file deletion. Never unlink lock
 * files: a waiter may still hold the old inode. util-linux flock locks the
 * parent's inherited open-file description, so no helper remains alive.
 * Requires Linux flock semantics (including a correctly configured NFS mount).
 */
export function acquireFileLock(file: string, wait = false): () => void {
  const fd = openSync(file, 'a+', 0o600);
  try {
    const child = spawnSync('flock', [...(wait ? [] : ['--nonblock']), '--exclusive', '3'], {
      stdio: ['ignore', 'pipe', 'pipe', fd],
    });
    if (child.error) throw child.error;
    if (child.status !== 0) {
      if (!wait && child.status === 1) throw new SessionBusyError(file);
      throw new Error(`flock failed (${child.status}): ${child.stderr?.toString() ?? child.signal}`);
    }
  } catch (error) {
    closeSync(fd);
    throw error;
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    closeSync(fd);
  };
}

export interface SessionLocks {
  /** Acquire before starting any backend or modifying its transcript. */
  acquire(id: string): () => void;
}

/**
 * Process-held, per-session ownership. Each acquire is exclusive, including
 * against another instance in the same process. Release only after all of the
 * session's writers have stopped. A process exit closes the descriptor.
 *
 * This is NOT a distributed fencing token. NFS lease loss or a provider child
 * surviving its parent needs an external fence. Cloud routing must keep the
 * recorded task owner until that task is confirmed stopped, never steal on TTL.
 */
export function fileSessionLocks(options: { directory: string }): SessionLocks {
  mkdirSync(options.directory, { recursive: true, mode: 0o700 });
  return {
    acquire(id) {
      try { return acquireFileLock(join(options.directory, `${sessionKey(id)}.lock`)); }
      catch (error) {
        if (error instanceof SessionBusyError) throw new SessionBusyError(id);
        throw error;
      }
    },
  };
}
