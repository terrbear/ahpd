import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it, vi } from 'vitest';
import type { Bag, Session } from '@ahpd/sdk';
import { acpAgent } from '../src/agent.js';

const fixture = fileURLToPath(new URL('./fixtures/acp-server.mjs', import.meta.url));
const asyncFixture = fileURLToPath(new URL('./fixtures/acp-async-question.mjs', import.meta.url));
const sessions: Session[] = [];
const paths: string[] = [];
const wait = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

afterEach(async () => {
  for (const session of sessions.splice(0)) await session.close();
  for (const path of paths.splice(0)) rmSync(path, { recursive: true, force: true });
});

function setup(options: { idleTimeoutMs?: number; asyncQuestions?: boolean; nonResumable?: boolean } = {}) {
  const path = mkdtempSync(join(tmpdir(), 'ahpd-acp-idle-'));
  paths.push(path);
  const log = join(path, 'requests.jsonl');
  const sessionOptions = {
    command: process.execPath,
    args: [options.asyncQuestions ? asyncFixture : fixture],
    provider: options.asyncQuestions ? 'codex' : 'idle-test',
    stateDirectory: join(path, 'state'),
    hostTools: false,
    idleTimeoutMs: options.idleTimeoutMs ?? 40,
    env: { ACP_LOG: log, ...(options.nonResumable ? { ACP_NO_LOAD_SESSION: '1' } : {}) },
  };
  const events: Bag[] = [];
  const session = acpAgent(sessionOptions).create({
    uri: 'idle-test:/host', chatUri: 'ahp-chat:/idle-test', workingDirectory: path,
    settings: {}, schema: () => ({}), emit: (_channel, action) => { events.push(action); },
  }) as Session;
  sessions.push(session);
  return { events, log, session };
}

const completedTurns = (events: Bag[]): Bag[] => events.filter((event) => event.type === 'chat/turnComplete');
const requests = (log: string): Bag[] => readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as Bag);

it('retires an idle ACP process and resumes the same saved ACP session on the next turn', async () => {
  const { events, log, session } = setup({ idleTimeoutMs: 40 });
  session.begin('first', 'first');
  await vi.waitFor(() => expect(completedTurns(events)).toHaveLength(1));
  await wait(100);

  session.begin('second', 'second');
  await vi.waitFor(() => expect(completedTurns(events)).toHaveLength(2));

  const prompts = requests(log).filter((request) => request.method === 'session/prompt');
  const loads = requests(log).filter((request) => request.method === 'session/load');
  expect(prompts).toHaveLength(2);
  expect(prompts[1]!.pid).not.toBe(prompts[0]!.pid);
  expect(loads).toHaveLength(1);
  expect((loads[0]!.params as Bag).sessionId).toBe(`acp-session-${String(prompts[0]!.pid)}-1`);
  expect((session.chatState() as Bag).turns).toHaveLength(2);
});

it('keeps a runtime whose ACP server cannot reload sessions', async () => {
  const { events, log, session } = setup({ idleTimeoutMs: 30, nonResumable: true });
  session.begin('first', 'first');
  await vi.waitFor(() => expect(completedTurns(events)).toHaveLength(1));
  await wait(100);
  session.begin('second', 'second');
  await vi.waitFor(() => expect(completedTurns(events)).toHaveLength(2));

  const prompts = requests(log).filter((request) => request.method === 'session/prompt');
  expect(prompts).toHaveLength(2);
  expect(prompts[1]!.pid).toBe(prompts[0]!.pid);
  expect(requests(log).some((request) => request.method === 'session/load')).toBe(false);
});

it('does not retire during an active provider turn or an outstanding approval', async () => {
  const { events, session } = setup({ idleTimeoutMs: 30 });
  session.begin('approval', 'ask');
  await vi.waitFor(() => expect((session.sessionState() as Bag).inputNeeded).toMatchObject([{ kind: 'toolConfirmation' }]));
  await wait(100);
  expect((session.chatState() as Bag).activeTurn).toBeDefined();
  expect(completedTurns(events)).toHaveLength(0);

  session.confirm('call-perm', true, 'yes-once');
  await vi.waitFor(() => expect(completedTurns(events)).toHaveLength(1));
});

it('does not retire while a host-owned shell job is still running', async () => {
  const { events, session } = setup({ idleTimeoutMs: 30 });
  session.begin('first', 'first');
  await vi.waitFor(() => expect(completedTurns(events)).toHaveLength(1));

  let finish!: (result: { success: boolean; output: string; said: string; code: number }) => void;
  session.ran!('shell-job', 'long-running fixture', () => new Promise((resolve) => { finish = resolve; }));
  await wait(100);
  expect((session.chatState() as Bag).activeTurn).toBeDefined();
  expect(completedTurns(events)).toHaveLength(1);
  finish({ success: true, output: '', said: 'finished', code: 0 });
  await vi.waitFor(() => expect(completedTurns(events)).toHaveLength(2));
});

it('keeps an unanswered Codex question and its live runtime until the answer is recorded', async () => {
  const { events, log, session } = setup({ idleTimeoutMs: 30, asyncQuestions: true });
  session.begin('question', 'ask');
  await vi.waitFor(() => expect(completedTurns(events)).toHaveLength(1));
  expect((session.sessionState() as Bag).inputNeeded).toMatchObject([{ kind: 'chatInput' }]);
  await wait(100);
  expect(requests(log).some((request) => request.method === 'session/load')).toBe(false);

  const answer = session.answer('codex-async-question-1', true, {
    '0': { state: 'submitted', value: { kind: 'selected', value: 'Keep paused', freeformValues: [] } },
  }) as { text: string };
  session.queue('follow-up', answer.text);
  await vi.waitFor(() => expect(completedTurns(events)).toHaveLength(2));
  expect(requests(log).some((request) => request.method === 'session/load')).toBe(false);
  expect((session.sessionState() as Bag).inputNeeded).toEqual([]);
});

it('lets a new turn cancel the pending idle timer and supports disabling retirement', async () => {
  const active = setup({ idleTimeoutMs: 150 });
  active.session.begin('first', 'first');
  await vi.waitFor(() => expect(completedTurns(active.events)).toHaveLength(1));
  await wait(30);
  active.session.begin('second', 'second');
  await vi.waitFor(() => expect(completedTurns(active.events)).toHaveLength(2));
  expect(requests(active.log).some((request) => request.method === 'session/load')).toBe(false);

  const disabled = setup({ idleTimeoutMs: 0 });
  disabled.session.begin('first', 'first');
  await vi.waitFor(() => expect(completedTurns(disabled.events)).toHaveLength(1));
  await wait(100);
  disabled.session.begin('second', 'second');
  await vi.waitFor(() => expect(completedTurns(disabled.events)).toHaveLength(2));
  expect(requests(disabled.log).some((request) => request.method === 'session/load')).toBe(false);
});

it('refuses to start an idle timer for invalid timeout values', () => {
  const path = mkdtempSync(join(tmpdir(), 'ahpd-acp-idle-invalid-'));
  paths.push(path);
  const make = (idleTimeoutMs: number) => acpAgent({ command: process.execPath, idleTimeoutMs }).create({
    uri: 'idle-test:/invalid', chatUri: 'ahp-chat:/invalid', workingDirectory: path,
    settings: {}, schema: () => ({}), emit: () => {},
  });
  for (const idleTimeoutMs of [-1, 0.5, Number.NaN, 2_147_483_648]) {
    expect(() => make(idleTimeoutMs)).toThrow('idleTimeoutMs');
  }
});
