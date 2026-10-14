import { afterEach, expect, it, vi } from 'vitest';
import type { Socket } from 'node:net';
import { WebSocket } from 'ws';
import { chatReducer } from '@microsoft/agent-host-protocol';
import { echo } from '../../../examples/echo/agent.js';
import { createHost } from '../src/host.js';
import { listen } from '../src/listen.js';
import { OUTBOUND_LIMIT } from '../src/rpc.js';
import { DEFERRED_BYTE_LIMIT, DEFERRED_FRAME_LIMIT } from '../src/outbound-node.js';
import type { Peer } from '../src/types/rpc.js';
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

/** Smaller, genuine host recovery replies that can share a deferred budget. */
async function smaller(setup: ReturnType<Host['accept']>) {
  const smallChannel = 'ahp-chat:/small';
  const smallText = 's'.repeat(16 * 1024);
  await setup.handle({ method: 'createSession', params: { channel: 'ahp-session:/small', provider: 'echo' } });
  await setup.handle({
    method: 'dispatchAction',
    params: { channel: smallChannel, action: { type: 'chat/turnStarted', turnId: 'small-turn', message: { text: smallText, origin: { kind: 'user' } } } },
  });
  const snapshot = await setup.handle({ method: 'subscribe', params: { channel: smallChannel } });
  const replay = await setup.handle({ method: 'reconnect', params: { clientId: 'setup', subscriptions: [smallChannel], lastSeenServerSeq: 0 } });
  return { smallText, snapshot, replay };
}

function toolOutput(index: number, text: string) {
  return {
    jsonrpc: '2.0', method: 'action',
    params: {
      channel: 'ahp-chat:/small', serverSeq: 1000 + index,
      action: {
        type: 'chat/toolCallComplete', turnId: 'small-turn', toolCallId: `synthetic-tool-${index}`,
        result: { success: true, content: [{ type: 'text', text }] },
      },
    },
  };
}

async function readingBurst(largeText: string, smallText: string, toolText: string) {
  let peer!: Peer;
  let serverSocket: WebSocket | undefined;
  const amount = Object.getOwnPropertyDescriptor(WebSocket.prototype, 'bufferedAmount')!.get!;
  const observed = vi.spyOn(WebSocket.prototype, 'bufferedAmount', 'get').mockImplementation(function (this: WebSocket) {
    serverSocket = this;
    return amount.call(this) as number;
  });
  try {
    const disconnected = vi.fn();
    const overload = vi.fn();
    listener = await listen({ port: 0, onOutboundClose: overload }, (arrival) => {
      peer = arrival;
      return { handle: async () => ({}), close: disconnected };
    });
    socket = new WebSocket(`ws://127.0.0.1:${listener.port}`);
    const received: Array<{ tag: string; bytes: number; valid: boolean }> = [];
    const errors: Error[] = [];
    socket.on('error', (error) => { errors.push(error); });
    socket.on('message', (raw) => {
      const rawText = String(raw);
      const frame = JSON.parse(rawText) as Bag;
      let tag = frame.method as string;
      let valid = frame.method === 'ready';
      if (frame.method === 'action') {
        tag = `tool-${frame.params.action.toolCallId.slice('synthetic-tool-'.length)}`;
        valid = frame.params.action.result.content[0].text === toolText;
      } else if (frame.id === 1) {
        tag = 'large';
        valid = frame.result?.snapshot?.state?.turns?.[0]?.message?.text === largeText
          || (frame.result?.type === 'replay' && frame.result.actions.length > 0);
      } else if (typeof frame.id === 'number') {
        tag = `reply-${frame.id}`;
        valid = frame.result?.snapshot?.state?.turns?.[0]?.message?.text === smallText
          || (frame.result?.type === 'replay' && frame.result.actions.some((one: Bag) => one.action?.message?.text === smallText));
      }
      // Large payloads are validated but only these small summaries survive.
      received.push({ tag, bytes: Buffer.byteLength(rawText), valid });
    });
    await new Promise<void>((resolve, reject) => {
      socket!.once('open', resolve);
      socket!.once('error', reject);
    });
    peer.notify('ready', {});
    await vi.waitFor(() => expect(received.map((one) => one.tag)).toEqual(['ready']), { timeout: 5000 });
    return {
      peer, received, errors, disconnected, overload,
      transport: (serverSocket! as unknown as { _socket: Socket })._socket,
      restore: () => observed.mockRestore(),
    };
  } catch (error) { observed.mockRestore(); throw error; }
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

it.each(['snapshot', 'replay'])('orders tool-output bursts and multiple smaller recovery replies behind an oversized %s', async (kind) => {
  const { setup, text } = await seeded();
  let reading: Awaited<ReturnType<typeof readingBurst>> | undefined;
  try {
    const result = kind === 'snapshot'
      ? await setup.handle({ method: 'subscribe', params: { channel } })
      : await setup.handle({ method: 'reconnect', params: { clientId: 'setup', subscriptions: [channel], lastSeenServerSeq: 0 } });
    const { smallText, snapshot, replay } = await smaller(setup);
    const toolText = '界'.repeat(10 * 1024); // 30 KiB of UTF-8 tool output each.
    const followups = [
      toolOutput(0, toolText), { jsonrpc: '2.0', id: 2, result: snapshot },
      toolOutput(1, toolText), { jsonrpc: '2.0', id: 3, result: replay },
      toolOutput(2, toolText), { jsonrpc: '2.0', id: 4, result: snapshot },
    ];
    const bytes = followups.reduce((total, frame) => total + Buffer.byteLength(JSON.stringify(frame)), 0);
    expect(bytes).toBeGreaterThan(128 * 1024);
    expect(bytes).toBeLessThanOrEqual(DEFERRED_BYTE_LIMIT);
    expect(followups.length).toBeLessThanOrEqual(DEFERRED_FRAME_LIMIT);
    reading = await readingBurst(text, smallText, toolText);
    reading.transport.cork();
    try {
      reading.peer.send({ jsonrpc: '2.0', id: 1, result });
      for (const frame of followups) reading.peer.send(frame);
    } finally { reading.transport.uncork(); }
    await vi.waitFor(() => {
      expect(reading!.errors).toEqual([]);
      expect(reading!.disconnected).not.toHaveBeenCalled();
      expect(reading!.overload).not.toHaveBeenCalled();
      expect(socket!.readyState).toBe(WebSocket.OPEN);
      expect(reading!.received.map((one) => one.tag)).toEqual([
        'ready', 'large', 'tool-0', 'reply-2', 'tool-1', 'reply-3', 'tool-2', 'reply-4',
      ]);
    }, { timeout: 5000 });
    expect(reading.received.every((one) => one.valid)).toBe(true);
    expect(reading.received[1]!.bytes).toBeGreaterThan(OUTBOUND_LIMIT);
    expect(reading.received.slice(2).reduce((total, one) => total + one.bytes, 0)).toBe(bytes);
  } finally { reading?.restore(); setup.close(); }
}, 15_000);

it.each(['aggregate', 'second-oversized'])('intentionally closes a reading client for %s overflow behind an oversized recovery reply', async (ending) => {
  const { setup, text } = await seeded();
  let reading: Awaited<ReturnType<typeof readingBurst>> | undefined;
  try {
    const result = await setup.handle({ method: 'subscribe', params: { channel } });
    const toolText = '界'.repeat(10 * 1024);
    reading = await readingBurst(text, '', toolText);
    const dropped = new Promise<void>((resolve) => { socket!.once('close', resolve); });
    reading.transport.cork();
    try {
      reading.peer.send({ jsonrpc: '2.0', id: 1, result });
      if (ending === 'second-oversized') reading.peer.send({ jsonrpc: '2.0', id: 2, result });
      else {
        // Each notification fits; nine together exceed the aggregate budget.
        for (let index = 0; index < 9; index++) {
          reading.peer.send(toolOutput(index, toolText));
        }
      }
    } finally { reading.transport.uncork(); }
    await dropped;
    await vi.waitFor(() => expect(reading!.disconnected).toHaveBeenCalledTimes(1));
    expect(reading.overload).toHaveBeenCalledTimes(1);
    expect(reading.overload.mock.calls[0]![0]).toMatchObject({
      reason: 'deferred_byte_limit', deferredFrames: ending === 'aggregate' ? 8 : 0,
    });
    expect(reading.received.map((one) => one.tag)).toEqual(['ready']);
  } finally { reading?.restore(); setup.close(); }
}, 15_000);

it.each(['snapshot', 'replay'])('delivers an oversized %s reply followed by a same-turn notification', async (kind) => {
  const { setup, text } = await seeded();
  let peer!: Peer;
  let serverSocket: WebSocket | undefined;
  const amount = Object.getOwnPropertyDescriptor(WebSocket.prototype, 'bufferedAmount')!.get!;
  const observed = vi.spyOn(WebSocket.prototype, 'bufferedAmount', 'get').mockImplementation(function (this: WebSocket) {
    serverSocket = this;
    return amount.call(this) as number;
  });
  try {
    const result = kind === 'snapshot'
      ? await setup.handle({ method: 'subscribe', params: { channel } })
      : await setup.handle({ method: 'reconnect', params: { clientId: 'setup', subscriptions: [channel], lastSeenServerSeq: 0 } });
    const disconnected = vi.fn();
    listener = await listen({ port: 0 }, (arrival) => {
      peer = arrival;
      return { handle: async () => ({}), close: disconnected };
    });
    socket = new WebSocket(`ws://127.0.0.1:${listener.port}`);
    const received: Array<{ method?: string; id?: number; bytes?: number; valid?: boolean }> = [];
    const errors: Error[] = [];
    socket.on('error', (error) => { errors.push(error); });
    socket.on('message', (raw) => {
      const rawText = String(raw);
      const frame = JSON.parse(rawText) as Bag;
      received.push(frame.id === 1 ? {
        id: 1, bytes: Buffer.byteLength(rawText),
        valid: kind === 'snapshot'
          ? frame.result.snapshot.state.turns[0].message.text === text
          : frame.result.type === 'replay' && frame.result.actions.length > 0,
      } : { method: frame.method });
    });
    await new Promise<void>((resolve, reject) => {
      socket!.once('open', resolve);
      socket!.once('error', reject);
    });
    peer.notify('ready', {});
    await vi.waitFor(() => expect(received).toEqual([{ method: 'ready' }]), { timeout: 5000 });
    const transport = (serverSocket! as unknown as { _socket: Socket })._socket;
    transport.cork();
    try {
      peer.send({ jsonrpc: '2.0', id: 1, result });
      peer.notify('after-recovery', {});
    } finally { transport.uncork(); }
    await vi.waitFor(() => {
      expect(errors).toEqual([]);
      expect(disconnected).not.toHaveBeenCalled();
      expect(socket!.readyState).toBe(WebSocket.OPEN);
      expect(received).toHaveLength(3);
    }, { timeout: 5000 });
    expect(received[1]).toMatchObject({ id: 1, valid: true });
    expect(received[1]!.bytes).toBeGreaterThan(OUTBOUND_LIMIT);
    expect(received[2]).toEqual({ method: 'after-recovery' });
  } finally { observed.mockRestore(); setup.close(); }
}, 15_000);

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
