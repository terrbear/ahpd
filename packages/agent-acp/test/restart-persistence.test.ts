import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it, vi } from 'vitest';
import { acpAgent } from '../src/agent.js';
import { persistentCatalog } from '../src/persistence.js';
import type { Bag, Session, Start } from '@ahpd/sdk';

const fixture = fileURLToPath(new URL('./fixtures/acp-server.mjs', import.meta.url));
const paths: string[] = [];
const live: Session[] = [];
afterEach(async () => {
  for (const session of live.splice(0)) await session.close();
  for (const path of paths.splice(0)) rmSync(path, { recursive: true, force: true });
});

it('streams bounded tool previews, stores full output, and restores exactly the displayed result', async () => {
  const path = mkdtempSync(join(tmpdir(), 'ahpd-acp-output-'));
  paths.push(path);
  const options = { command: process.execPath, args: [fixture], provider: 'output', stateDirectory: path };
  const actions: Bag[] = [];
  const agent = acpAgent(options);
  const session = agent.create({
    uri: 'output:/host', chatUri: 'ahp-chat:/host', workingDirectory: path,
    settings: {}, schema: () => ({}), emit: (_, action) => { actions.push(action); },
  }) as Session;
  live.push(session);
  session.begin('large-turn', 'large-output');
  await vi.waitFor(() => expect(actions.some((one) => one.type === 'chat/turnComplete')).toBe(true));
  expect(actions.every((one) => Buffer.byteLength(JSON.stringify(one)) < 32768)).toBe(true);
  const turns = session.allTurns();
  const parts = turns[0]!.responseParts as Bag[];
  const content = (parts[0]!.toolCall as Bag).content as Bag[];
  expect(content[1]!.type).toBe('resource');
  expect(readFileSync(fileURLToPath(String(content[1]!.uri)), 'utf8')).toBe('log line\n'.repeat(8192 * 8));
  const saved = persistentCatalog(path, 'output').get('host')!;
  expect(saved.turns[0]!.updates).toEqual([]);
  expect(Buffer.byteLength(JSON.stringify(saved))).toBeLessThan(32768);
  await session.close();
  const restored = await acpAgent(options).transcript?.('host');
  expect(restored?.[0]?.responseParts).toEqual(parts);
});

it('fails the turn visibly if a tool output cannot be stored', async () => {
  const path = mkdtempSync(join(tmpdir(), 'ahpd-acp-output-failure-'));
  paths.push(path);
  writeFileSync(join(path, 'outputs'), 'not a directory');
  const actions: Bag[] = [];
  const session = acpAgent({ command: process.execPath, args: [fixture], provider: 'output-failure', stateDirectory: path }).create({
    uri: 'output-failure:/host', chatUri: 'ahp-chat:/host', workingDirectory: path,
    settings: {}, schema: () => ({}), emit: (_, action) => { actions.push(action); },
  }) as Session;
  live.push(session);
  session.begin('failed-turn', 'large-output');
  await vi.waitFor(() => expect(actions.some((one) => one.type === 'chat/error')).toBe(true));
  expect(JSON.stringify(actions)).toContain('Unable to retain tool output');
  expect(JSON.stringify(actions)).not.toContain('Output truncated:');
  expect((session.chatState() as Bag).activeTurn).toBeUndefined();
});

it('bounds shell result text and the duplicate terminal preview', async () => {
  const path = mkdtempSync(join(tmpdir(), 'ahpd-acp-shell-output-'));
  paths.push(path);
  const actions: Bag[] = [];
  const session = acpAgent({ command: process.execPath, args: [fixture], stateDirectory: path }).create({
    uri: 'acp:/shell', chatUri: 'ahp-chat:/shell', workingDirectory: path,
    settings: {}, schema: () => ({}), emit: (_, action) => { actions.push(action); },
  }) as Session;
  live.push(session);
  const output = 'shell log\n'.repeat(100000);
  session.ran!('shell-turn', 'synthetic log', async () => ({ success: true, output, said: 'done', terminal: 'ahp-terminal:/shell', code: 0 }));
  await vi.waitFor(() => expect(actions.some((one) => one.type === 'chat/turnComplete')).toBe(true));
  const result = actions.find((one) => one.type === 'chat/toolCallComplete')!.result as Bag;
  expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(64 * 1024);
  const resource = (result.content as Bag[]).find((block) => block.type === 'resource')!;
  expect(readFileSync(fileURLToPath(String(resource.uri)), 'utf8')).toBe(output);
});

it('restores host identity, all turns and the provider resume ID in a fresh bridge', async () => {
  const path = mkdtempSync(join(tmpdir(), 'ahpd-acp-persist-'));
  paths.push(path);
  const log = join(path, 'requests.jsonl');
  const stateDirectory = join(path, 'state');
  const options = { command: process.execPath, args: [fixture], env: { ACP_LOG: log, ACP_LOAD_REPLAY: '1' }, provider: 'restart', stateDirectory };
  const events: string[] = [];
  const start: Start = {
    uri: 'restart:/stable-host-id', chatUri: 'ahp-chat:/stable-host-id',
    workingDirectory: path, settings: {}, schema: () => ({}),
    emit: (_, action) => { events.push(String(action.type)); },
  };
  const original = acpAgent(options).create(start);
  live.push(original);
  for (const id of ['first', 'second']) {
    const before = events.filter((type) => type === 'chat/turnComplete').length;
    original.begin(id, id);
    await vi.waitFor(() => expect(events.filter((type) => type === 'chat/turnComplete')).toHaveLength(before + 1));
  }
  const providerID = original.agentId();
  await original.close();
  live.splice(live.indexOf(original), 1);
  vi.resetModules();
  const { acpAgent: freshAgent } = await import('../src/agent.js');
  const restored = freshAgent(options);
  expect((await restored.list?.())?.some((row) => row.id === 'stable-host-id')).toBe(true);
  expect((await restored.transcript?.('stable-host-id'))?.map((turn) => turn.id)).toEqual(['first', 'second']);
  const resumed = restored.create({ ...start, resume: 'stable-host-id' });
  live.push(resumed);
  resumed.begin('third', 'third');
  await vi.waitFor(() => expect(events.filter((type) => type === 'chat/turnComplete')).toHaveLength(3));
  expect(resumed.agentId()).toBe(providerID);
  const state = resumed.chatState() as { turns: { responseParts: unknown[] }[] };
  expect(JSON.stringify(state.turns.at(-1)?.responseParts)).not.toContain('historic reply');
  const requests = readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { method: string; params?: { sessionId?: string } });
  expect(requests.filter((request) => request.method === 'session/new')).toHaveLength(1);
  expect(requests.filter((request) => request.method === 'session/load').map((request) => request.params?.sessionId)).toEqual([providerID]);
  const directories = readdirSync(stateDirectory);
  expect(directories.length).toBeGreaterThan(0);
  for (const directory of directories) {
    for (const file of readdirSync(join(stateDirectory, directory))) {
      expect(statSync(join(stateDirectory, directory, file)).mode & 0o777).toBe(0o600);
    }
  }
});

it('refuses a missing saved transcript instead of treating its identity as absent', () => {
  const path = mkdtempSync(join(tmpdir(), 'ahpd-acp-missing-record-'));
  paths.push(path);
  const catalog = persistentCatalog(path, 'missing-record');
  catalog.save({ provider: 'missing-record', id: 'native', cwd: path, additional: [], title: 'saved', createdAt: '2026-10-12T00:00:00Z', modifiedAt: '2026-10-12T00:00:00Z', turns: [] }, 'host');
  const folder = join(path, readdirSync(path)[0]!);
  for (const file of readdirSync(folder)) if (file !== 'index.json') rmSync(join(folder, file));
  expect(() => persistentCatalog(path, 'missing-record').get('host')).toThrow('missing or invalid');
});

it('ends the turn with an error if its private registry cannot be saved', async () => {
  const path = mkdtempSync(join(tmpdir(), 'ahpd-acp-save-failure-'));
  paths.push(path);
  const stateDirectory = join(path, 'state');
  const events: string[] = [];
  const session = acpAgent({ command: process.execPath, args: [fixture], provider: 'save-failure', stateDirectory }).create({
    uri: 'save-failure:/host', chatUri: 'ahp-chat:/host', workingDirectory: path,
    settings: {}, schema: () => ({}), emit: (_, action) => { events.push(String(action.type)); },
  });
  live.push(session);
  session.begin('first', 'first');
  await vi.waitFor(() => expect(events).toContain('chat/turnComplete'));
  rmSync(stateDirectory, { recursive: true });
  writeFileSync(stateDirectory, 'not a directory');
  session.begin('second', 'second');
  await vi.waitFor(() => expect(events).toContain('chat/error'));
  expect((session.chatState() as { activeTurn?: unknown }).activeTurn).toBeUndefined();
});
