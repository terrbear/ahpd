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

const catalogFor = (record: unknown, formatVersion: number | undefined = 2, raw?: string) => {
  const root = mkdtempSync(join(tmpdir(), 'ahpd-turn-status-'));
  paths.push(root);
  const folder = join(root, hash(provider));
  mkdirSync(folder, { recursive: true });
  const entry = {
    provider, id, cwd: '/work', additional: [], title: 'Test',
    createdAt: '2026-10-18T00:00:00.000Z', modifiedAt: '2026-10-18T00:00:00.000Z', hostIds: [],
    ...(formatVersion === undefined ? {} : { formatVersion }),
  };
  writeFileSync(join(folder, 'index.json'), JSON.stringify({ version: 1, entries: [entry] }));
  writeFileSync(join(folder, `${hash(id)}.json`), raw ?? JSON.stringify(record));
  return { root, catalog: persistentCatalog(root, provider), folder };
};

const recordWith = (turns: unknown[], formatVersion = 2) => ({
  formatVersion, provider, id, cwd: '/work', additional: [], title: 'Test',
  createdAt: '2026-10-18T00:00:00.000Z', modifiedAt: '2026-10-18T00:00:00.000Z', turns,
});

const turn = (extra: Record<string, unknown> = {}) => ({
  turnId, startedAt: '2026-10-18T00:01:02.000Z', state: 'complete', duration: 42,
  message: { text: 'private historical prompt' }, updates: [], responseParts: [], ...extra,
});

it('reads one exact status from a v2 record without exposing content or modifying files', () => {
  const { root, catalog, folder } = catalogFor(recordWith([turn()]));
  const before = new Map(readdirSync(folder).map((name) => [name, readFileSync(join(folder, name))]));
  const result = catalog.historicalTurnStatus(id, turnId);
  const agent = acpAgent({ command: process.execPath, provider, stateDirectory: root });
  expect(agent.historicalTurnStatus?.(id, turnId)).toEqual(result);
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
