import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it, vi } from 'vitest';
import type { Bag, Session, Start } from '@ahpd/sdk';
import { createHost } from '../../sdk/src/host.js';
import { acpAgent } from '../src/agent.js';
import { customInstructionsMeta } from '../src/instructions.js';

const fixture = fileURLToPath(new URL('./fixtures/acp-server.mjs', import.meta.url));
const paths: string[] = [];
const sessions: Session[] = [];
afterEach(async () => {
  for (const session of sessions.splice(0)) await session.close();
  for (const path of paths.splice(0)) rmSync(path, { recursive: true, force: true });
});

const setup = (supported = true) => {
  const path = mkdtempSync(join(tmpdir(), 'ahpd-instructions-'));
  paths.push(path);
  const log = join(path, 'requests.jsonl');
  const options = {
    provider: 'codex', command: process.execPath, args: [fixture], stateDirectory: path,
    env: { ACP_LOG: log, ACP_CUSTOM_INSTRUCTIONS: supported ? '1' : '0' },
  };
  const actions: Bag[] = [];
  const start: Start = {
    uri: 'codex:/instructions', chatUri: 'ahp-chat:/instructions', workingDirectory: path,
    instructions: ['Consult the Acme handbook.', 'Cite retrieved sources.'],
    settings: {}, schema: () => ({}), emit: (_, action) => { actions.push(action); },
  };
  const requests = () => readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line) as { method: string; params: Bag });
  return { options, start, actions, requests };
};

it('advertises instruction support only for the Codex bridge', async () => {
  const agents = ['codex', 'acp', 'copilot'].map(provider => acpAgent({ command: process.execPath, provider }));
  expect(agents.map(agent => agent.acceptsSystemInstructions)).toEqual([true, undefined, undefined]);
  const host = createHost({ path: tmpdir(), agents });
  const client = host.accept({ send: () => {}, notify: () => {}, request: async () => ({}), answered: () => {}, close: () => {} });
  const result = await client.handle({ method: 'initialize', params: { clientId: 'test', protocolVersions: ['0.9.0'] } }) as Bag;
  expect((result._meta as Bag)['ahpd.clientSystemInstructions']).toEqual(['codex']);
  await host.close();
});

it('sends instructions separately from the unchanged user prompt and resumes the same thread', async () => {
  const { options, start, actions, requests } = setup();
  const session = acpAgent(options).create(start);
  sessions.push(session);
  session.begin('first', 'What project are we in?');
  await vi.waitFor(() => expect(actions.some(action => action.type === 'chat/turnComplete')).toBe(true));
  const sent = requests();
  expect(sent.find(request => request.method === 'initialize')?.params.clientCapabilities).toMatchObject({
    _meta: { 'ahpd.clientSystemInstructions': { version: 1 } },
  });
  expect((sent.find(request => request.method === 'initialize')?.params.clientCapabilities as Bag)._meta).not.toHaveProperty('jetbrains');
  expect(sent.find(request => request.method === 'session/new')?.params._meta).toEqual({
    'ahpd.clientSystemInstructions': start.instructions!.join('\n\n'),
  });
  expect(sent.find(request => request.method === 'session/prompt')?.params.prompt).toEqual([{ type: 'text', text: 'What project are we in?' }]);
  const id = session.agentId();
  await session.close();
  sessions.splice(sessions.indexOf(session), 1);
  const resumed = acpAgent(options).create({ ...start, resume: 'instructions' });
  sessions.push(resumed);
  resumed.begin('second', 'Continue.');
  await vi.waitFor(() => expect(actions.filter(action => action.type === 'chat/turnComplete')).toHaveLength(2));
  expect(requests().filter(request => request.method === 'session/new')).toHaveLength(1);
  expect(requests().find(request => request.method === 'session/load')?.params.sessionId).toBe(id);
  expect(requests().filter(request => request.method === 'session/prompt').at(-1)?.params.prompt).toEqual([{ type: 'text', text: 'Continue.' }]);
});

it('does not send a user prompt when the adapter cannot accept its instructions', async () => {
  const { options, start, actions, requests } = setup(false);
  const session = acpAgent(options).create(start);
  sessions.push(session);
  session.begin('first', 'What project are we in?');
  await vi.waitFor(() => expect(actions.some(action => action.type === 'chat/error')).toBe(true));
  expect(JSON.stringify(actions)).toContain('does not advertise client system instructions');
  expect(requests().some(request => request.method === 'session/new' || request.method === 'session/prompt')).toBe(false);
});

it.each([undefined, {}, { 'ahpd.clientSystemInstructions': true }, { 'ahpd.clientSystemInstructions': { version: 2 } }])('rejects absent or malformed adapter capability %j', meta => {
  expect(() => customInstructionsMeta('Required guidance', { protocolVersion: 1, authMethods: [], ...(meta === undefined ? {} : { _meta: meta }) })).toThrow('does not advertise client system instructions');
});

it('refreshes an idle conversation at developer priority without replaying user text', async () => {
  const { options, start, actions, requests } = setup();
  const session = acpAgent(options).create(start);
  sessions.push(session);
  session.begin('original', 'Remember this conversation.');
  await vi.waitFor(() => expect(actions.some(action => action.type === 'chat/turnComplete')).toBe(true));
  const id = session.agentId();
  await session.setSystemInstructions!(['The user may change the default repository.']);
  const loaded = requests().filter(request => request.method === 'session/load').at(-1);
  expect(loaded?.params.sessionId).toBe(id);
  expect(loaded?.params._meta).toEqual({ 'ahpd.clientSystemInstructions': 'The user may change the default repository.', 'ahpd.refreshClientSystemInstructions': true });
  expect(requests().filter(request => request.method === 'session/new')).toHaveLength(1);
  expect(requests().filter(request => request.method === 'session/prompt')).toHaveLength(1);
  session.begin('updated', 'Continue in the other checkout.');
  await vi.waitFor(() => expect(actions.filter(action => action.type === 'chat/turnComplete')).toHaveLength(2));
  expect(requests().filter(request => request.method === 'session/prompt').at(-1)?.params.prompt).toEqual([{ type: 'text', text: 'Continue in the other checkout.' }]);
});

it('refuses to refresh instructions while a turn is active', async () => {
  const { options, start } = setup();
  const session = acpAgent({ ...options, env: { ...options.env, ACP_PROMPT_DELAY: '1000' } }).create(start);
  sessions.push(session);
  session.begin('busy', 'Wait for completion.');
  await expect(session.setSystemInstructions!(['Changed instructions.'])).rejects.toThrow('active work');
});

it('updates instructions through the authorized host API and keeps the same chat', async () => {
  const { options, start } = setup();
  const refreshed: string[][] = [];
  const bridge = acpAgent(options);
  const host = createHost({ path: start.workingDirectory!, agents: [{ ...bridge, create: input => {
    const session = bridge.create(input);
    const update = session.setSystemInstructions!;
    session.setSystemInstructions = async instructions => { refreshed.push(instructions); await update(instructions); };
    return session;
  } }] });
  const client = host.accept({ send: () => {}, notify: () => {}, request: async () => ({}), answered: () => {}, close: () => {} });
  try {
    const initialized = await client.handle({ method: 'initialize', params: { clientId: 'anton', protocolVersions: ['0.9.0'] } }) as Bag;
    expect((initialized._meta as Bag)['ahpd.updateClientSystemInstructions']).toEqual(['codex']);
    await client.handle({ method: 'createSession', params: { channel: 'codex:/refresh', provider: 'codex', _meta: { 'ahpd.clientSystemInstructions': 'Starting guidance.' } } });
    await expect(client.handle({ method: 'ahpd/updateSessionInstructions', params: { channel: 'codex:/refresh', instructions: 'Follow user repository changes.' } })).resolves.toEqual({ applied: true });
    expect(refreshed).toEqual([['Follow user repository changes.']]);
    await expect(client.handle({ method: 'ahpd/updateSessionInstructions', params: { channel: 'codex:/refresh', instructions: '' } })).rejects.toMatchObject({ code: -32602 });
    await client.handle({ method: 'createChat', params: { channel: 'codex:/refresh', chat: 'ahp-chat:/second' } });
    await expect(client.handle({ method: 'ahpd/updateSessionInstructions', params: { channel: 'codex:/refresh', instructions: 'Do not lose side chats.' } })).rejects.toMatchObject({ code: -32602 });
    expect(refreshed).toHaveLength(1);
  } finally {
    await host.close();
  }
});

it('requires explicit adapter support for developer instructions on resume', () => {
  expect(() => customInstructionsMeta('Updated', { protocolVersion: 1, authMethods: [], _meta: { 'ahpd.clientSystemInstructions': { version: 1 } } }, true)).toThrow('cannot update resumed');
});
