import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { acpAgent } from '../src/agent.js';
import { persistentCatalog, TURN_STATUS_RECORD_MAX_BYTES } from '../src/persistence.js';

const provider = 'codex';
const id = 'session-1';
const turnId = 'turn-1';
const paths: string[] = [];

afterEach(() => {
  for (const path of paths.splice(0)) rmSync(path, { recursive: true, force: true });
});

const hash = (value: string): string => createHash('sha256').update(value).digest('hex');

const catalogFor = (record: unknown, formatVersion: number | undefined = 2, raw?: string, hostIds: string[] = []) => {
  const root = mkdtempSync(join(tmpdir(), 'ahpd-turn-status-'));
  paths.push(root);
  const folder = join(root, hash(provider));
  mkdirSync(folder, { recursive: true });
  const entry = {
    provider, id, cwd: '/work', additional: [], title: 'Test',
    createdAt: '2026-10-18T00:00:00.000Z', modifiedAt: '2026-10-18T00:00:00.000Z', hostIds,
    ...(formatVersion === undefined ? {} : { formatVersion }),
  };
  writeFileSync(join(folder, 'index.json'), JSON.stringify({ version: 1, entries: [entry] }));
  writeFileSync(join(folder, `${hash(id)}.json`), raw ?? JSON.stringify(record));
  return { root, catalog: persistentCatalog(root, provider), folder };
};

const recordWith = (turns: unknown[], formatVersion = 2, recordId = id) => ({
  formatVersion, provider, id: recordId, cwd: '/work', additional: [], title: 'Test',
  createdAt: '2026-10-18T00:00:00.000Z', modifiedAt: '2026-10-18T00:00:00.000Z', turns,
});

const turn = (extra: Record<string, unknown> = {}) => ({
  turnId, startedAt: '2026-10-18T00:01:02.000Z', state: 'complete', duration: 42,
  message: { text: 'private historical prompt' }, updates: [], responseParts: [], ...extra,
});

it('reads one exact status from a v2 record without exposing content or modifying files', () => {
  const hostId = 'host-session-1';
  const { root, catalog, folder } = catalogFor(recordWith([turn()]), 2, undefined, [hostId]);
  const before = new Map(readdirSync(folder).map((name) => [name, readFileSync(join(folder, name))]));
  const result = catalog.historicalTurnStatus(id, turnId);
  const agent = acpAgent({ command: process.execPath, provider, stateDirectory: root });
  expect(catalog.historicalTurnStatus(hostId, turnId)).toEqual(result);
  expect(agent.historicalTurnStatus?.(id, turnId)).toEqual(result);
  expect(agent.historicalTurnStatus?.(hostId, turnId)).toEqual(result);
  expect(result).toEqual({ status: 'known', state: 'complete', startedAt: '2026-10-18T00:01:02.000Z' });
  expect(JSON.stringify(result)).not.toContain('private historical prompt');
  expect(catalog.historicalTurnStatus(id, 'missing')).toEqual({ status: 'unknown', reason: 'not-found' });
  expect(catalog.historicalTurnStatus('missing', turnId)).toEqual({ status: 'unknown', reason: 'not-found' });
  expect(readdirSync(folder)).toEqual([...before.keys()]);
  for (const [name, bytes] of before) expect(readFileSync(join(folder, name))).toEqual(bytes);
});

it('returns unknown for legacy, malformed, oversized, ambiguous, and incomplete records', () => {
  const legacy = catalogFor(recordWith([turn()], 1), undefined);
  expect(legacy.catalog.historicalTurnStatus(id, turnId)).toEqual({ status: 'unknown', reason: 'legacy' });

  const malformed = catalogFor(recordWith([turn()]), 2, '{not json');
  expect(malformed.catalog.historicalTurnStatus(id, turnId)).toEqual({ status: 'unknown', reason: 'malformed' });

  const oversized = catalogFor(undefined, 2, 'x'.repeat(TURN_STATUS_RECORD_MAX_BYTES + 1));
  const tooLarge = oversized.catalog.historicalTurnStatus(id, turnId);
  expect(tooLarge).toEqual({ status: 'unknown', reason: 'oversized' });
  expect(tooLarge).not.toHaveProperty('size');

  const ambiguous = catalogFor(recordWith([turn(), turn()]));
  expect(ambiguous.catalog.historicalTurnStatus(id, turnId)).toEqual({ status: 'unknown', reason: 'ambiguous' });

  const incomplete = catalogFor(recordWith([turn({ duration: undefined })]));
  expect(incomplete.catalog.historicalTurnStatus(id, turnId)).toEqual({ status: 'unknown', reason: 'incomplete' });

  const interrupted = catalogFor(recordWith([turn({ state: 'cancelled', duration: 0 })]));
  expect(interrupted.catalog.historicalTurnStatus(id, turnId)).toEqual({ status: 'unknown', reason: 'incomplete' });
});

it('returns unknown for ambiguous aliases and mismatched canonical records', () => {
  const alias = 'host-shared';
  const secondId = 'session-2';
  const ambiguous = catalogFor(recordWith([turn()]), 2, undefined, [alias]);
  const indexPath = join(ambiguous.folder, 'index.json');
  const index = JSON.parse(readFileSync(indexPath, 'utf8')) as { entries: Array<Record<string, unknown>> };
  const first = { ...index.entries[0]!, hostIds: [alias, secondId] };
  const second = { ...first, id: secondId, hostIds: [alias] };
  writeFileSync(indexPath, JSON.stringify({ version: 1, entries: [first, second] }));
  writeFileSync(join(ambiguous.folder, `${hash(secondId)}.json`), JSON.stringify(recordWith([turn()], 2, secondId)));
  const ambiguousCatalog = persistentCatalog(ambiguous.root, provider);
  expect(ambiguousCatalog.historicalTurnStatus(alias, turnId)).toEqual({ status: 'unknown', reason: 'ambiguous' });
  expect(ambiguousCatalog.historicalTurnStatus(secondId, turnId)).toEqual({ status: 'unknown', reason: 'ambiguous' });

  const mismatch = catalogFor(recordWith([turn()], 2, 'different-record-id'), 2, undefined, ['host-mismatch']);
  expect(mismatch.catalog.historicalTurnStatus('host-mismatch', turnId)).toEqual({ status: 'unknown', reason: 'malformed' });
});

it('returns unknown for duplicate session index identities', () => {
  const root = mkdtempSync(join(tmpdir(), 'ahpd-turn-status-'));
  paths.push(root);
  const folder = join(root, hash(provider));
  mkdirSync(folder, { recursive: true });
  const entry = {
    provider, id, cwd: '/work', additional: [], title: 'Test',
    createdAt: '2026-10-18T00:00:00.000Z', modifiedAt: '2026-10-18T00:00:00.000Z', formatVersion: 2, hostIds: [],
  };
  writeFileSync(join(folder, 'index.json'), JSON.stringify({ version: 1, entries: [entry, entry] }));
  writeFileSync(join(folder, `${hash(id)}.json`), JSON.stringify(recordWith([turn()])));
  expect(persistentCatalog(root, provider).historicalTurnStatus(id, turnId)).toEqual({ status: 'unknown', reason: 'ambiguous' });
});
