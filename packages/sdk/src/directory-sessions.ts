/** Per-session metadata for hosts that share a filesystem. Linux only. */
import { randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { acquireFileLock, sessionKey } from './session-locks.js';
import type { SessionStore } from './types/sessions.js';

interface Row { version: 1; id: string; values: Record<string, unknown> }
export interface DirectorySessionOptions {
  directory: string;
  /** Read-only fallback. Stop every old writer before enabling this store. */
  legacyFile?: string;
}

/**
 * Fresh reads and locked read-modify-write prevent two daemon snapshots from
 * overwriting one another. Writes are synchronous and durable before return.
 * Metadata locks are short; backend lifetime ownership is a separate concern.
 * Fail closed on malformed data or I/O errors. An empty row is a tombstone,
 * so forget cannot resurrect a row from the legacy file.
 */
export function directorySessions(options: DirectorySessionOptions): SessionStore {
  mkdirSync(options.directory, { recursive: true, mode: 0o700 });
  let closed = false;
  const path = (id: string): string => join(options.directory, `${sessionKey(id)}.json`);
  const read = (id: string): Record<string, unknown> => {
    let raw: string;
    try { raw = readFileSync(path(id), 'utf8'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      if (options.legacyFile === undefined) return {};
      let legacy: string;
      try { legacy = readFileSync(options.legacyFile, 'utf8'); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
        throw error;
      }
      const old = JSON.parse(legacy) as { version?: number; sessions?: Record<string, unknown>[] };
      if (old.version !== 1 || !Array.isArray(old.sessions)) throw new Error('Invalid legacy session store');
      const row = old.sessions.find((one) => one?.id === id);
      if (row === undefined) return {};
      const { id: _, ...values } = row;
      return values;
    }
    const row = JSON.parse(raw) as Row;
    if (row.version !== 1 || row.id !== id || row.values === null || typeof row.values !== 'object' || Array.isArray(row.values))
      throw new Error(`Invalid session record: ${path(id)}`);
    return row.values;
  };
  const change = (id: string, edit: (values: Record<string, unknown>) => Record<string, unknown>): void => {
    if (closed) throw new Error('Session store is closed');
    const release = acquireFileLock(join(options.directory, `${sessionKey(id)}.metadata.lock`), true);
    let temporary: string | undefined;
    try {
      const row: Row = { version: 1, id, values: edit(read(id)) };
      temporary = `${path(id)}.${process.pid}.${randomUUID()}.tmp`;
      const fd = openSync(temporary, 'wx', 0o600);
      try { writeFileSync(fd, `${JSON.stringify(row)}\n`); fsyncSync(fd); }
      finally { closeSync(fd); }
      renameSync(temporary, path(id));
      temporary = undefined;
      const dir = openSync(options.directory, 'r');
      try { fsyncSync(dir); } finally { closeSync(dir); }
    } finally {
      try { if (temporary !== undefined) unlinkSync(temporary); }
      finally { release(); }
    }
  };
  const set = (id: string, key: string, value: unknown): void => change(id, (row) => {
    if (value === undefined) delete row[key]; else row[key] = value;
    return row;
  });
  const nested = (id: string, key: string, name: string, value: unknown): void => change(id, (row) => {
    const values = { ...(row[key] as Record<string, unknown> | undefined) };
    if (value === undefined) delete values[name];
    else Object.defineProperty(values, name, { value, enumerable: true, configurable: true, writable: true });
    if (Object.keys(values).length === 0) delete row[key]; else row[key] = values;
    return row;
  });
  const member = <T>(values: unknown, key: string): T | undefined =>
    typeof values === 'object' && values !== null && Object.hasOwn(values, key)
      ? (values as Record<string, T>)[key] : undefined;
  return {
    flags: (id) => (read(id).flags as number | undefined) ?? 0,
    setFlags: (id, value) => set(id, 'flags', value),
    config: (id) => read(id).config as ReturnType<SessionStore['config']>,
    setConfig: (id, value) => set(id, 'config', value),
    scope: (id) => read(id).scope as ReturnType<SessionStore['scope']>,
    setScope: (id, value) => set(id, 'scope', value),
    owner: (id) => read(id).owner as ReturnType<SessionStore['owner']>,
    setOwner: (id, value) => set(id, 'owner', value),
    sender: (id, turn) => member<ReturnType<SessionStore['sender']>>(read(id).senders, turn),
    setSender: (id, turn, value) => nested(id, 'senders', turn, value),
    provider: (id) => read(id).provider as ReturnType<SessionStore['provider']>,
    setProvider: (id, value) => set(id, 'provider', value),
    artifacts: (id) => read(id).artifacts as ReturnType<SessionStore['artifacts']>,
    setArtifacts: (id, value) => set(id, 'artifacts', value.length === 0 ? undefined : value),
    pullRequests: (id) => read(id).pullRequests as ReturnType<SessionStore['pullRequests']>,
    setPullRequests: (id, value) => set(id, 'pullRequests', value),
    chatTitle: (id, chat) => member<string>(read(id).chatTitles, chat),
    setChatTitle: (id, chat, value) => nested(id, 'chatTitles', chat, value === '' ? undefined : value),
    forget: (id) => change(id, () => ({})),
    close: () => { closed = true; },
  };
}
