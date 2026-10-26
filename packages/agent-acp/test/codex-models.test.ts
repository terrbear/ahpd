import { copyFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it, vi } from 'vitest';
import { acpAgent } from '../src/index.js';
import { createHost } from '../../sdk/src/host.js';

const paths: string[] = [];
const hosts: ReturnType<typeof createHost>[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const host of hosts.splice(0)) await host.close();
  for (const path of paths.splice(0)) rmSync(path, { recursive: true, force: true });
});

function fixture(mode = '') {
  const path = mkdtempSync(join(tmpdir(), 'codex-models-'));
  paths.push(path);
  const command = join(path, 'codex-acp');
  copyFileSync(fileURLToPath(new URL('./fixtures/codex-models.mjs', import.meta.url)), command);
  chmodSync(command, 0o755);
  const log = join(path, 'requests');
  const env = { MODEL_TEST_LOG: log, MODEL_TEST_MODE: mode };
  const agent = acpAgent({ command, env, provider: 'codex' });
  return { agent, env, path, log, command };
}

const expected = [{ id: 'fast', name: 'Fast' }, { id: 'thorough', name: 'Thorough' }];

it('discovers the bundled Codex catalog before session/new without creating a thread', async () => {
  const { agent, log } = fixture();
  expect((await agent.probe?.())?.models).toEqual(expected);
  expect(readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line).method))
    .toEqual(['initialize', 'initialized', 'account/read', 'model/list', 'model/list']);
});

it.each(['signed-out', 'error', 'malformed', 'loop', 'exit', 'hang'])('bounds %s and retries without caching failure', async (mode) => {
  const { agent, env } = fixture(mode);
  await expect(agent.probe?.()).rejects.toThrow();
  env.MODEL_TEST_MODE = '';
  expect((await agent.probe?.())?.models).toEqual(expected);
});

it('does not query models when authentication is required', async () => {
  const { agent, log } = fixture('signed-out');
  await expect(agent.probe?.()).rejects.toThrow();
  expect(readFileSync(log, 'utf8')).not.toContain('model/list');
});

it('includes discovered models in the first host initialize snapshot', async () => {
  const { agent, path } = fixture();
  const host = createHost({ path, agents: [{ ...agent, list: async () => [] }] });
  hosts.push(host);
  const client = host.accept({ send: () => {}, notify: () => {}, request: async () => ({}), answered: () => {}, close: async () => {} });
  const result = await client.handle({ method: 'initialize', params: { clientId: 'cold', protocolVersions: ['0.9.0'], initialSubscriptions: ['ahp-root://'] } });
  expect(result).toMatchObject({ snapshots: [{ state: { agents: [{ provider: 'codex', models: expected }] } }] });
});

it('supports a node-wrapped adapter without switching to a PATH Codex', async () => {
  const { command, env } = fixture();
  const agent = acpAgent({ command: process.execPath, args: [command], env, provider: 'codex' });
  expect((await agent.probe?.())?.models).toEqual(expected);
});

it.each(['CODEX_CONFIG', 'MODEL_PROVIDER', 'DEFAULT_AUTH_REQUEST'])('does not bypass adapter-specific %s configuration', async (key) => {
  const { command, log, env } = fixture();
  const agent = acpAgent({ command, env: { ...env, [key]: 'synthetic' }, provider: 'codex' });
  expect((await agent.probe?.())?.models).toEqual([]);
  expect(existsSync(log)).toBe(false);
});

it.each(['error', 'empty', 'signed-out'])('retries %s host discovery on a later handshake and coalesces concurrent handshakes', async (mode) => {
  const { agent, env, path, log } = fixture(mode);
  const probe = vi.fn(agent.probe);
  const host = createHost({ path, agents: [{ ...agent, probe, list: async () => [] }] });
  hosts.push(host);
  const initialize = () => host.accept({ send: () => {}, notify: () => {}, request: async () => ({}), answered: () => {}, close: async () => {} })
    .handle({ method: 'initialize', params: { clientId: 'retry', protocolVersions: ['0.9.0'], initialSubscriptions: ['ahp-root://'] } });
  expect(await initialize()).toMatchObject({ snapshots: [{ state: { agents: [{ models: [] }] } }] });
  env.MODEL_TEST_MODE = '';
  const now = Date.now();
  vi.spyOn(Date, 'now').mockReturnValue(now + 6000);
  const results = await Promise.all([initialize(), initialize()]);
  for (const result of results) expect(result).toMatchObject({ snapshots: [{ state: { agents: [{ models: expected }] } }] });
  expect(probe).toHaveBeenCalledTimes(2);
  expect(readFileSync(log, 'utf8')).not.toContain('session/new');
});

it('terminates a hung probe and its subprocess without leaking the parent', async () => {
  const { agent, log } = fixture('tree');
  await expect(agent.probe?.()).rejects.toThrow('Codex model discovery failed');
  const pids = readFileSync(log + '.pid', 'utf8').trim().split('\n').map(Number);
  expect(pids).toHaveLength(2);
  await expect.poll(() => pids.every((pid) => {
    try { process.kill(pid, 0); return false; } catch { return true; }
  })).toBe(true);
});

it('recognizes the pinned installer dist/index.js entrypoint', async () => {
  const { command, path, env } = fixture();
  mkdirSync(join(path, 'dist'));
  const entry = join(path, 'dist', 'index.js');
  copyFileSync(command, entry);
  chmodSync(entry, 0o755);
  writeFileSync(join(path, 'package.json'), JSON.stringify({ name: '@agentclientprotocol/codex-acp', type: 'module', bin: { 'codex-acp': 'dist/index.js' } }));
  const agent = acpAgent({ command: entry, env, provider: 'codex' });
  expect((await agent.probe?.())?.models).toEqual(expected);
});

it('does not launch an unknown provider command or a custom adapter argument', async () => {
  const { command, env, log } = fixture();
  for (const options of [
    { command, args: ['--custom'] },
    { command: '/missing/unknown-adapter' },
  ]) {
    expect((await acpAgent({ ...options, env, provider: 'codex' }).probe?.())?.models).toEqual([]);
  }
  expect(existsSync(log)).toBe(false);
});

it('replaces the cold catalog with models learned from a session', async () => {
  const { agent: discovery, path } = fixture('cold-model');
  const sessionAgent = acpAgent({
    command: process.execPath,
    args: [fileURLToPath(new URL('./fixtures/acp-server.mjs', import.meta.url))],
    provider: 'codex',
    hostTools: false,
  });
  const host = createHost({ path, agents: [{ ...sessionAgent, probe: () => discovery.probe!(), list: async () => [] }] });
  hosts.push(host);
  const changes: unknown[] = [];
  const client = host.accept({ send: () => {}, notify: (_method, params) => { changes.push(params); }, request: async () => ({}), answered: () => {}, close: async () => {} });
  const initial = await client.handle({ method: 'initialize', params: { clientId: 'updates', protocolVersions: ['0.9.0'], initialSubscriptions: ['ahp-root://'] } });
  expect(initial).toMatchObject({ snapshots: [{ state: { agents: [{ models: [{ id: 'cold', name: 'Cold' }] }] } }] });
  const channel = 'ahp-session:/catalog-update';
  await client.handle({ method: 'createSession', params: { channel, provider: 'codex', workingDirectories: [`file://${path}`] } });
  await client.handle({ method: 'dispatchAction', params: { channel: 'ahp-chat:/catalog-update', action: { type: 'chat/turnStarted', turnId: 't1', message: { text: 'hello' } } } });
  await expect.poll(() => changes.some((change) => {
    const action = (change as { action?: { type: string; agents?: { models: { id: string }[] }[] } }).action;
    return action?.type === 'root/agentsChanged' && action.agents?.[0]?.models.some((model) => model.id === 'thorough');
  })).toBe(true);
});
