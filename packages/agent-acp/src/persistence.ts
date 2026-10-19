import { createHash, randomUUID } from 'node:crypto';
import { constants, closeSync, copyFileSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { TextDecoder } from 'node:util';
import type { HistoricalTurnStatus, Listed } from '@ahpd/sdk';
import type { WatchedSession } from './types.js';
import { turnsOf } from './transcript.js';

type Entry = Omit<WatchedSession, 'turns'> & { hostIds: string[] };
export interface AcpCatalog {
  get(id: string): WatchedSession | undefined;
  list(): Listed[];
  save(record: WatchedSession, hostId: string): void;
  historicalTurnStatus(id: string, turnId: string): HistoricalTurnStatus;
}

export const TURN_STATUS_RECORD_MAX_BYTES = 128 * 1024;

const hash = (value: string): string => createHash('sha256').update(value).digest('hex');
const read = (path: string): unknown => {
  try { return JSON.parse(readFileSync(path, 'utf8')) as unknown; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
};

const unknown = (reason: Extract<HistoricalTurnStatus, { status: 'unknown' }>['reason']): HistoricalTurnStatus => ({ status: 'unknown', reason });
const validTimestamp = (value: unknown): value is string =>
  typeof value === 'string' && Buffer.byteLength(value) <= 64 && Number.isFinite(Date.parse(value));

const boundedJson = (path: string): { value: unknown } | { reason: 'not-found' | 'oversized' | 'malformed' } => {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const stats = fstatSync(descriptor);
    if (!stats.isFile()) return { reason: 'malformed' };
    if (stats.size > TURN_STATUS_RECORD_MAX_BYTES) return { reason: 'oversized' };
    const bytes = Buffer.alloc(TURN_STATUS_RECORD_MAX_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(descriptor, bytes, length, bytes.length - length, length);
      if (count === 0) break;
      length += count;
    }
    if (length > TURN_STATUS_RECORD_MAX_BYTES) return { reason: 'oversized' };
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length));
    return { value: JSON.parse(text) as unknown };
  }
  catch (error) {
    return { reason: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'not-found' : 'malformed' };
  }
  finally {
    if (descriptor !== undefined) {
      try { closeSync(descriptor); }
      catch {}
    }
  }
};

const historicalStatus = (value: unknown, provider: string, id: string, turnId: string): HistoricalTurnStatus => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return unknown('malformed');
  const record = value as Record<string, unknown>;
  if (record.formatVersion !== 2) return unknown('legacy');
  if (record.id !== id || record.provider !== provider || typeof record.cwd !== 'string'
    || !Array.isArray(record.additional) || !record.additional.every((one) => typeof one === 'string')
    || typeof record.title !== 'string' || !validTimestamp(record.createdAt) || !validTimestamp(record.modifiedAt)) return unknown('malformed');
  if (!Array.isArray(record.turns)) return unknown('malformed');
  const seen = new Set<string>();
  let matched: { state: 'complete' | 'cancelled' | 'error'; startedAt: string; duration: number } | undefined;
  for (const value_ of record.turns) {
    if (typeof value_ !== 'object' || value_ === null || Array.isArray(value_)) return unknown('incomplete');
    const turn = value_ as Record<string, unknown>;
    if (typeof turn.turnId !== 'string' || turn.turnId === '' || Buffer.byteLength(turn.turnId) > 1024) return unknown('incomplete');
    if (seen.has(turn.turnId)) return unknown('ambiguous');
    seen.add(turn.turnId);
    if ((turn.state !== 'complete' && turn.state !== 'cancelled' && turn.state !== 'error')
      || !validTimestamp(turn.startedAt)
      || typeof turn.duration !== 'number' || !Number.isFinite(turn.duration) || turn.duration < 0) return unknown('incomplete');
    if (turn.turnId === turnId) matched = { state: turn.state, startedAt: turn.startedAt, duration: turn.duration };
  }
  if (matched === undefined) return unknown('not-found');
  if (matched.state === 'cancelled' && matched.duration === 0) return unknown('incomplete');
  return { status: 'known', state: matched.state, startedAt: matched.startedAt };
};

const write = (path: string, value: unknown): void => {
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
  renameSync(temporary, path);
};

export function persistentCatalog(directory: string, provider: string): AcpCatalog {
  const folder = join(directory, hash(provider));
  const indexPath = join(folder, 'index.json');
  const index = read(indexPath) as { version?: unknown; entries?: Entry[] } | undefined;
  if (index !== undefined && (index.version !== 1 || !Array.isArray(index.entries))) {
    throw new Error('Invalid ACP session registry');
  }
  const entries = new Map<string, Entry>();
  const identities = new Map<string, Entry[]>();
  for (const entry of index?.entries ?? []) {
    if (entry.provider !== provider || typeof entry.id !== 'string' || typeof entry.cwd !== 'string'
      || !Array.isArray(entry.hostIds) || !entry.hostIds.every((id) => typeof id === 'string')) {
      throw new Error('Invalid ACP session identity');
    }
    entries.set(entry.id, entry);
    for (const identity of new Set([entry.id, ...entry.hostIds])) {
      const matches = identities.get(identity) ?? [];
      matches.push(entry);
      identities.set(identity, matches);
    }
  }
  const loaded = new Map<string, WatchedSession>();
  const legacy = new Set([...entries.values()].filter((entry) => entry.formatVersion !== 2).map((entry) => entry.id));
  return {
    get: (id) => {
      const entry = entries.get(id) ?? [...entries.values()].find((one) => one.hostIds.includes(id));
      if (entry === undefined) return undefined;
      const cached = loaded.get(entry.id);
      if (cached !== undefined) return cached;
      const record = read(join(folder, `${hash(entry.id)}.json`)) as WatchedSession | undefined;
      if (record === undefined || record.id !== entry.id || record.provider !== provider || !Array.isArray(record.turns)) {
        throw new Error('ACP session record is missing or invalid');
      }
      turnsOf(record, directory);
      loaded.set(entry.id, record);
      return record;
    },
    list: () => [...entries.values()].flatMap((entry) => [...new Set([entry.id, ...entry.hostIds])].map((id) => ({
      id, title: entry.title, createdAt: entry.createdAt, modifiedAt: entry.modifiedAt,
      workingDirectories: [entry.cwd, ...entry.additional].map((directory) => `file://${directory}`),
    }))),
    historicalTurnStatus: (id, turnId) => {
      const matches = identities.get(id) ?? [];
      if (matches.length === 0) return unknown('not-found');
      if (matches.length !== 1) return unknown('ambiguous');
      const entry = matches[0]!;
      if (entry.provider !== provider || typeof entry.id !== 'string' || entry.id === '') return unknown('malformed');
      if (entry.formatVersion !== 2) return unknown('legacy');
      const loadedRecord = boundedJson(join(folder, `${hash(entry.id)}.json`));
      if ('reason' in loadedRecord) return unknown(loadedRecord.reason);
      return historicalStatus(loadedRecord.value, provider, entry.id, turnId);
    },
    save: (record, hostId) => {
      mkdirSync(folder, { recursive: true, mode: 0o700 });
      const recordPath = join(folder, `${hash(record.id)}.json`);
      if (record.formatVersion === 2 && legacy.has(record.id)) {
        // Keep the previous durable representation when first replacing a
        // legacy record, so an operator can restore it on a software rollback.
        try { copyFileSync(recordPath, `${recordPath}.v1.bak`, constants.COPYFILE_EXCL); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      }
      const previous = entries.get(record.id);
      const { turns, ...fields } = record;
      const entry = { ...fields, hostIds: [...new Set([...(previous?.hostIds ?? []), hostId])] };
      write(recordPath, {
        ...record,
        turns: turns.map((turn) => turn.duration === undefined ? { ...turn, state: 'cancelled', duration: 0 } : turn),
      });
      if (record.formatVersion === 2) legacy.delete(record.id);
      else legacy.add(record.id);
      entries.set(record.id, entry);
      write(indexPath, { version: 1, entries: [...entries.values()] });
      loaded.set(record.id, record);
    },
  };
}
