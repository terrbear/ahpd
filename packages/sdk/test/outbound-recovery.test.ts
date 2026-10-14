import { afterEach, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { chatReducer } from '@microsoft/agent-host-protocol';
import { echo } from '../../../examples/echo/agent.js';
import { createHost } from '../src/host.js';
import { listen } from '../src/listen.js';
import { OUTBOUND_LIMIT } from '../src/rpc.js';
import type { Host } from '../src/types/host.js';
import type { Listener } from '../src/types/listen.js';
import { BASE, REJECTED, historicalSourcesAvailable, versions } from './outbound-versions.js';

type Bag = Record<string, any>;
const channel = 'ahp-chat:/large';
let host: Host | undefined;
let listener: Listener | undefined;
let socket: WebSocket | undefined;

afterEach(async () => {
  socket?.terminate();
  await listener?.close();
  await host?.close();
  socket = undefined;
  listener = undefined;
  host = undefined;
});

/** A completed synthetic turn, made through the normal host and echo backend. */
async function seeded() {
  host = createHost({ path: '/tmp/ahpd-large-output', agents: [echo({ path: '/tmp/ahpd-large-output', pace: 0 })] });
  const setup = host.accept({ send: () => {}, notify: () => {}, request: async () => ({}), answered: () => {}, close: () => {} });
  await setup.handle({ method: 'initialize', params: { clientId: 'setup', protocolVersions: ['0.9.0'] } });
  await setup.handle({ method: 'createSession', params: { channel: 'ahp-session:/large', provider: 'echo' } });
  // Each action fits below the mark, but both the completed snapshot and the
  // combined replay reply exceed it. No fixture contains private traffic.
  const text = 'x'.repeat(OUTBOUND_LIMIT / 2 + 1024);
  await setup.handle({
    method: 'dispatchAction',
    params: { channel, action: { type: 'chat/turnStarted', turnId: 'large-turn', message: { text, origin: { kind: 'user' } } } },
  });
  const truth = await setup.handle({ method: 'subscribe', params: { channel } }) as Bag;
  expect(truth.snapshot.state.turns).toHaveLength(1);
  return { setup, text };
}

async function ready() {
  const { setup, text } = await seeded();
  setup.close();

  const sizes = new Map<number, number>();
  const disconnected = vi.fn();
  listener = await listen({ port: 0, tap: (from, raw) => {
    if (from !== 'host') return;
    const frame = JSON.parse(raw) as Bag;
    if (typeof frame.id === 'number') sizes.set(frame.id, Buffer.byteLength(raw));
  } }, (peer) => {
    const connected = host!.accept(peer);
    return { handle: connected.handle, close: () => { disconnected(); connected.close(); } };
  });
  socket = new WebSocket(`ws://127.0.0.1:${listener.port}`);
  const pending = new Map<number, { resolve(value: Bag): void; reject(error: Error): void }>();
  const notes: Bag[] = [];
  socket.on('message', (raw) => {
    const frame = JSON.parse(String(raw)) as Bag;
    const held = pending.get(frame.id);
    if (held === undefined) { notes.push(frame); return; }
    pending.delete(frame.id);
    if (frame.error) held.reject(new Error(frame.error.message));
    else held.resolve(frame.result);
  });
  socket.on('close', () => {
    for (const [id, held] of pending) held.reject(new Error(`Connection closed before reply ${id}`));
    pending.clear();
  });
  await new Promise<void>((resolve, reject) => {
    socket!.once('open', resolve);
    socket!.once('error', reject);
  });
  let id = 0;
  const ask = (method: string, params: Bag): Promise<Bag> => new Promise((resolve, reject) => {
    const next = ++id;
    pending.set(next, { resolve, reject });
    socket!.send(JSON.stringify({ jsonrpc: '2.0', id: next, method, params }));
  });
  await ask('initialize', { clientId: 'healthy', protocolVersions: ['0.9.0'] });
  return { ask, notes, sizes, disconnected, text };
}

it('delivers healthy snapshots over 8 MiB repeatedly and continues delivering actions', async () => {
  const { ask, sizes, notes, disconnected, text } = await ready();
  for (let i = 0; i < 2; i++) {
    const answer = await ask('subscribe', { channel });
    const turn = answer.snapshot.state.turns[0];
    expect(turn.message.text === text).toBe(true);
    expect(turn.responseParts[0].content === text).toBe(true);
    expect([...sizes.values()].at(-1)).toBeGreaterThan(OUTBOUND_LIMIT);
    if (i === 0) await ask('unsubscribe', { channel });
  }
  await ask('dispatchAction', { channel, action: { type: 'chat/draftChanged', draft: { text: 'progress', origin: { kind: 'user' } } } });
  await vi.waitFor(() => expect(notes.some((note) => note.params?.action?.draft?.text === 'progress')).toBe(true));
  expect(socket!.readyState).toBe(WebSocket.OPEN);
  expect(disconnected).not.toHaveBeenCalled();
}, 15_000);

it.skipIf(!historicalSourcesAvailable()).each(['snapshot', 'replay'])('preserves the rejected cap regression: a healthy >8 MiB %s closes at zero backlog', async (kind) => {
  const { setup } = await seeded();
  try {
    const result = kind === 'snapshot'
      ? await setup.handle({ method: 'subscribe', params: { channel } })
      : await setup.handle({ method: 'reconnect', params: { clientId: 'setup', subscriptions: [channel], lastSeenServerSeq: 0 } });
    const message = { jsonrpc: '2.0', id: 1, result };
    const bytes = Buffer.byteLength(JSON.stringify(message));
    expect(bytes).toBeGreaterThan(OUTBOUND_LIMIT);
    const results: Record<string, unknown> = {};
    for (const [revision, create] of Object.entries(await versions())) {
      let deliveries = 0;
      let disconnects = 0;
      // Two fresh, empty connections model a healthy client retrying recovery.
      for (let attempt = 0; attempt < 2; attempt++) {
        const peer = create({ bufferedBytes: () => 0, send: () => { deliveries += 1; }, close: () => { disconnects += 1; }, isOpen: () => true });
        peer.send(message);
      }
      results[revision] = { deliveries, disconnects };
    }
    expect(results[BASE]).toEqual({ deliveries: 2, disconnects: 0 });
    expect(results[REJECTED]).toEqual({ deliveries: 0, disconnects: 2 });
    expect(results.final).toEqual({ deliveries: 2, disconnects: 0 });
    console.info(`Healthy ${kind} at zero backlog (${bytes} bytes):`, JSON.stringify(results));
  } finally { setup.close(); }
}, 15_000);

it('delivers healthy replay replies over 8 MiB repeatedly and advances recovery', async () => {
  const { ask, sizes, notes, disconnected, text } = await ready();
  let upTo = 0;
  for (let i = 0; i < 2; i++) {
    const answer = await ask('reconnect', { clientId: 'healthy', subscriptions: [channel], lastSeenServerSeq: 0 });
    expect(answer.type).toBe('replay');
    expect(answer.missing).toEqual([]);
    expect([...sizes.values()].at(-1)).toBeGreaterThan(OUTBOUND_LIMIT);
    const sequences = answer.actions.map((one: Bag) => one.serverSeq) as number[];
    expect(sequences).toEqual([...sequences].sort((a, b) => a - b));
    expect(new Set(sequences).size).toBe(sequences.length);
    let recovered: Bag = { turns: [] };
    for (const envelope of answer.actions) recovered = chatReducer(recovered as never, envelope.action as never) as unknown as Bag;
    expect(recovered.turns).toHaveLength(1);
    expect(recovered.turns[0].message.text === text).toBe(true);
    expect(recovered.turns[0].responseParts[0].content === text).toBe(true);
    upTo = sequences.at(-1)!;
  }
  await ask('dispatchAction', { channel, action: { type: 'chat/draftChanged', draft: { text: 'progress', origin: { kind: 'user' } } } });
  await vi.waitFor(() => expect(notes.some((note) => note.params?.action?.draft?.text === 'progress')).toBe(true));
  const advanced = await ask('reconnect', { clientId: 'healthy', subscriptions: [channel], lastSeenServerSeq: upTo });
  expect(advanced.type).toBe('replay');
  expect(advanced.actions).toHaveLength(1);
  expect(advanced.actions[0].serverSeq).toBeGreaterThan(upTo);
  expect(advanced.actions[0].action.draft.text).toBe('progress');
  const caughtUp = await ask('reconnect', { clientId: 'healthy', subscriptions: [channel], lastSeenServerSeq: advanced.actions[0].serverSeq });
  expect(caughtUp.actions).toEqual([]);
  expect(socket!.readyState).toBe(WebSocket.OPEN);
  expect(disconnected).not.toHaveBeenCalled();
}, 15_000);
