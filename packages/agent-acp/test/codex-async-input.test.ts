import { createHost } from '../../sdk/src/host.js';
import type { Peer } from '@ahpd/sdk';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it, vi } from 'vitest';
import type { Bag, Session } from '@ahpd/sdk';
import { acpAgent } from '../src/agent.js';

const fixture = fileURLToPath(new URL('./fixtures/acp-async-question.mjs', import.meta.url));
const sessions: Session[] = [];
const paths: string[] = [];
afterEach(async () => {
  for (const session of sessions.splice(0)) await session.close();
  for (const path of paths.splice(0)) rmSync(path, { recursive: true, force: true });
});
function setup() {
  const path = mkdtempSync(join(tmpdir(), 'ahpd-codex-async-'));
  paths.push(path);
  const log = join(path, 'requests.jsonl');
  const options = { command: process.execPath, args: [fixture], provider: 'codex', stateDirectory: join(path, 'state'), hostTools: false, env: { ACP_LOG: log } };
  const events: Bag[] = [];
  const start = { uri: 'codex:/async-host', chatUri: 'ahp-chat:/async-host', workingDirectory: path, settings: {}, schema: () => ({}), emit: (_: string, action: Bag) => { events.push(action); } };
  const open = (resume = false) => {
    const session = acpAgent(options).create({ ...start, ...(resume ? { resume: 'async-host' } : {}) });
    sessions.push(session);
    return session;
  };
  return { events, log, open, options };
}
const answers = { '0': { state: 'submitted', value: { kind: 'selected', value: 'Keep paused', freeformValues: [] } } };

it('keeps async questions visible after completion and restart, then saves the answer and returns a follow-up prompt', async () => {
  const { events, open, log, options } = setup();
  const first = open();
  first.begin('ask-turn', 'ask');
  await vi.waitFor(() => expect(events.some((event) => event.type === 'chat/turnComplete')).toBe(true));
  expect(first.sessionState()).toMatchObject({ inputNeeded: [{ kind: 'chatInput', request: { id: 'codex-async-question-1' } }] });
  expect(JSON.stringify(first.chatState())).not.toContain('Proceed with the bounded test?\\nApprove');
  await first.close();
  const resumed = open(true);
  expect(resumed.sessionState()).toMatchObject({ inputNeeded: [{ request: { id: 'codex-async-question-1' } }] });
  const followup = resumed.answer('codex-async-question-1', true, answers) as unknown as { text: string };
  expect(followup.text).toContain('Keep paused');
  expect(followup.text).toContain('Proceed with the bounded test?');
  resumed.queue('answer-turn', followup.text);
  await vi.waitFor(() => expect(events.filter((event) => event.type === 'chat/turnComplete')).toHaveLength(2));
  expect(readFileSync(log, 'utf8')).toContain('Keep paused');
  expect(resumed.sessionState()).toMatchObject({ inputNeeded: [] });
  expect(() => resumed.answer('codex-async-question-1', true, answers)).toThrow();
  await resumed.close();
  const answered = open(true);
  expect(answered.sessionState()).toMatchObject({ inputNeeded: [] });
  expect((answered.chatState() as Bag).turns).toMatchObject([{ responseParts: [{ kind: 'inputRequest', response: 'accept', request: { answers } }] }, {}]);
  expect(JSON.stringify(await acpAgent(options).transcript?.('async-host'))).toContain('"response":"accept"');
});

it('withdraws an unanswered async question when stop arrives while idle', async () => {
  const { events, open } = setup();
  const session = open();
  session.begin('ask-turn', 'ask');
  await vi.waitFor(() => expect(events.some((event) => event.type === 'chat/turnComplete')).toBe(true));
  expect(session.sessionState()).toMatchObject({ inputNeeded: [{ kind: 'chatInput' }] });
  session.cancel('ask-turn');
  expect(session.sessionState()).toMatchObject({ inputNeeded: [] });
  expect(() => session.answer('codex-async-question-1', true, answers)).toThrow();
  await session.close();
  expect(open(true).sessionState()).toMatchObject({ inputNeeded: [] });
});

it('routes an async answer through the host into a new user turn', async () => {
  const { log, options } = setup();
  const notes: Bag[] = [];
  const peer: Peer = { send: () => {}, notify: (method, params) => { if (method === 'action') notes.push(structuredClone(params) as Bag); }, request: async () => ({}), answered: () => {}, close: () => {} };
  const host = createHost({ path: dirname(log), agents: [acpAgent(options)] });
  const client = host.accept(peer);
  try {
    await client.handle({ method: 'initialize', params: { channel: 'ahp-root://', clientId: 'probe', protocolVersions: ['0.9.0'], initialSubscriptions: ['ahp-root://'] } });
    const uri = 'codex:/wire-async';
    await client.handle({ method: 'createSession', params: { channel: uri, provider: 'codex' } });
    const snapshot = await client.handle({ method: 'subscribe', params: { channel: uri } }) as { snapshot: { state: Bag } };
    const chat = (snapshot.snapshot.state.chats as Bag[])[0]!.resource as string;
    await client.handle({ method: 'subscribe', params: { channel: chat } });
    await client.handle({ method: 'dispatchAction', params: { channel: chat, action: { type: 'chat/turnStarted', turnId: 'wire-ask', message: { text: 'ask' } } } });
    await vi.waitFor(() => expect(notes.some((note) => (note.action as Bag).type === 'chat/turnComplete')).toBe(true));
    const requested = notes.find((note) => (note.action as Bag).type === 'chat/inputRequested')!.action as Bag;
    await client.handle({ method: 'dispatchAction', params: { channel: chat, action: { type: 'chat/inputCompleted', turnId: 'wire-ask', requestId: (requested.request as Bag).id, response: 'accept', answers } } });
    await vi.waitFor(() => expect(notes.filter((note) => (note.action as Bag).type === 'chat/turnComplete')).toHaveLength(2));
    expect(readFileSync(log, 'utf8')).toContain('Keep paused');
    const turns = notes.filter((note) => (note.action as Bag).type === 'chat/turnStarted');
    expect((turns.at(-1)!.action as Bag).message).toMatchObject({ origin: { kind: 'user' } });
  } finally { await host.close(); }
});

for (const accepted of [true, false]) {
  it(`preserves a pending question after invalid answers and accepts free text or decline (${accepted})`, async () => {
    const { events, open } = setup();
    const session = open();
    session.begin('ask-turn', 'ask');
    await vi.waitFor(() => expect(events.some((event) => event.type === 'chat/turnComplete')).toBe(true));
    expect(() => session.answer('codex-async-question-1', true, {})).toThrow();
    expect(session.sessionState()).toMatchObject({ inputNeeded: [{ kind: 'chatInput' }] });
    session.begin('intervening-turn', 'Some unrelated follow-up');
    await vi.waitFor(() => expect(events.filter((event) => event.type === 'chat/turnComplete')).toHaveLength(2));
    expect(session.sessionState()).toMatchObject({ inputNeeded: [{ kind: 'chatInput' }] });
    const result = session.answer('codex-async-question-1', accepted, {
      '0': { state: 'submitted', value: { kind: 'selected', value: '', freeformValues: ['Please wait until tomorrow'] } },
    });
    expect(result).toMatchObject({ text: expect.stringContaining(accepted ? 'Please wait until tomorrow' : 'Declined to answer') });
    expect(session.sessionState()).toMatchObject({ inputNeeded: [] });
  });
}
