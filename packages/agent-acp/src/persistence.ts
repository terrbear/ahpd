import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Listed } from '@ahpd/sdk';
import type { WatchedSession } from './types.js';

type Entry = Omit<WatchedSession, 'turns'> & { hostIds: string[] };
export interface AcpCatalog {
  get(id: string): WatchedSession | undefined;
  list(): Listed[];
  save(record: WatchedSession, hostId: string): void;
}

const hash = (value: string): string => createHash('sha256').update(value).digest('hex');
const read = (path: string): unknown => {
  try { return JSON.parse(readFileSync(path, 'utf8')) as unknown; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
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
  for (const entry of index?.entries ?? []) {
    if (entry.provider !== provider || typeof entry.id !== 'string' || typeof entry.cwd !== 'string'
      || !Array.isArray(entry.hostIds) || !entry.hostIds.every((id) => typeof id === 'string')) {
      throw new Error('Invalid ACP session identity');
    }
    entries.set(entry.id, entry);
  }
  const loaded = new Map<string, WatchedSession>();
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
      loaded.set(entry.id, record);
      return record;
    },
    list: () => [...entries.values()].flatMap((entry) => [...new Set([entry.id, ...entry.hostIds])].map((id) => ({
      id, title: entry.title, createdAt: entry.createdAt, modifiedAt: entry.modifiedAt,
      workingDirectories: [entry.cwd, ...entry.additional].map((directory) => `file://${directory}`),
    }))),
    save: (record, hostId) => {
      mkdirSync(folder, { recursive: true, mode: 0o700 });
      const previous = entries.get(record.id);
      const { turns, ...fields } = record;
      const entry = { ...fields, hostIds: [...new Set([...(previous?.hostIds ?? []), hostId])] };
      write(join(folder, `${hash(record.id)}.json`), {
        ...record,
        turns: turns.map((turn) => turn.duration === undefined ? { ...turn, state: 'cancelled', duration: 0 } : turn),
      });
      entries.set(record.id, entry);
      write(indexPath, { version: 1, entries: [...entries.values()] });
      loaded.set(record.id, record);
    },
  };
}
