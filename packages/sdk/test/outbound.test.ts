import { afterEach, expect, it, vi } from 'vitest';
import type { Socket } from 'node:net';
import { WebSocket } from 'ws';
import { listen } from '../src/listen.js';
import { createPeer, OUTBOUND_LIMIT, RpcClosed } from '../src/rpc.js';
import type { Listener } from '../src/types/listen.js';
import type { Peer } from '../src/types/rpc.js';

let listener: Listener | undefined;
let client: WebSocket | undefined;
afterEach(async () => {
  client?.terminate();
  await listener?.close();
  client = undefined;
  listener = undefined;
  vi.restoreAllMocks();
});

it('stops serializing a stalled Node socket after one frame crosses the high-water mark', async () => {
  // Model a consumer that never drains, without allocating a growing queue.
  // Only the byte count is retained, and traffic stops after 256 frames.
  let queued = 0;
  let peak = 0;
  let serialized = 0;
  let sent = 0;
  const closed = vi.fn();
  let peer!: Peer;
  vi.spyOn(WebSocket.prototype, 'bufferedAmount', 'get').mockImplementation(() => queued);
  vi.spyOn(WebSocket.prototype, 'send').mockImplementation((data) => {
    queued += Buffer.byteLength(String(data));
    peak = Math.max(peak, queued);
    sent += 1;
  });
  listener = await listen({ port: 0 }, (arrival) => {
    peer = arrival;
    return { handle: async () => ({}), close: closed };
  });
  client = new WebSocket(`ws://127.0.0.1:${listener.port}`);
  await new Promise<void>((resolve, reject) => {
    client!.once('open', resolve);
    client!.once('error', reject);
  });
  const payload = { toJSON: () => { serialized += 1; return '界'.repeat(16 * 1024); } };
  for (let i = 0; i < 256; i++) peer.notify('synthetic', payload);
  expect(peak).toBe(8_413_542);
  expect(peak).toBeGreaterThan(OUTBOUND_LIMIT);
  expect(peak).toBeLessThan(OUTBOUND_LIMIT + 49_202);
  expect(sent).toBe(171);
  expect(serialized).toBe(171);
  await vi.waitFor(() => expect(closed).toHaveBeenCalledTimes(1));
  const stopped = serialized;
  peer.notify('synthetic', payload);
  expect(serialized).toBe(stopped);
  await expect(peer.request('synthetic', payload)).rejects.toMatchObject({ name: 'RpcClosed' });
  // Keep the synthetic model's storage small even on a failing baseline.
  queued = 0;
});

it('keeps a healthy reading Node client connected after a frame over 8 MiB and a same-turn notification', async () => {
  let peer!: Peer;
  let serverSocket: WebSocket | undefined;
  const backlogs: number[] = [];
  const amount = Object.getOwnPropertyDescriptor(WebSocket.prototype, 'bufferedAmount')!.get!;
  vi.spyOn(WebSocket.prototype, 'bufferedAmount', 'get').mockImplementation(function (this: WebSocket) {
    serverSocket = this;
    const bytes = amount.call(this) as number;
    backlogs.push(bytes);
    return bytes;
  });
  const closed = vi.fn();
  listener = await listen({ port: 0 }, (arrival) => {
    peer = arrival;
    return { handle: async () => ({}), close: closed };
  });
  client = new WebSocket(`ws://127.0.0.1:${listener.port}`);
  const text = 'x'.repeat(OUTBOUND_LIMIT + 1024);
  const received: Array<{ id?: number; method?: string; bytes?: number; matches?: boolean }> = [];
  const errors: Error[] = [];
  client.on('error', (error) => { errors.push(error); });
  client.on('message', (raw) => {
    const rawText = String(raw);
    const frame = JSON.parse(rawText) as { id?: number; method?: string; result?: { text?: string } };
    received.push(frame.id === 1
      ? { id: frame.id, bytes: Buffer.byteLength(rawText), matches: frame.result?.text === text }
      : { method: frame.method });
  });
  await new Promise<void>((resolve, reject) => {
    client!.once('open', resolve);
    client!.once('error', reject);
  });
  peer.notify('ready', {});
  await vi.waitFor(() => expect(received).toEqual([{ method: 'ready' }]), { timeout: 5000 });

  const transport = (serverSocket! as unknown as { _socket: Socket })._socket;
  backlogs.length = 0;
  transport.cork();
  try {
    peer.send({ jsonrpc: '2.0', id: 1, result: { text } });
    peer.notify('after-large', {});
  } finally { transport.uncork(); }
  expect(backlogs[0]).toBe(0);
  expect(backlogs.some((bytes) => bytes > OUTBOUND_LIMIT)).toBe(true);

  await vi.waitFor(() => {
    expect(errors).toEqual([]);
    expect(closed).not.toHaveBeenCalled();
    expect(client!.readyState).toBe(WebSocket.OPEN);
    expect(received).toHaveLength(3);
  }, { timeout: 5000 });
  expect(received[1]).toMatchObject({ id: 1, matches: true });
  expect(received[1].bytes).toBeGreaterThan(OUTBOUND_LIMIT);
  expect(received[2]).toEqual({ method: 'after-large' });
}, 15_000);

it('starts a fresh Node connection after closing with oversized output and a deferred FIFO', async () => {
  let peer!: Peer;
  let serverSocket: WebSocket | undefined;
  const amount = Object.getOwnPropertyDescriptor(WebSocket.prototype, 'bufferedAmount')!.get!;
  vi.spyOn(WebSocket.prototype, 'bufferedAmount', 'get').mockImplementation(function (this: WebSocket) {
    serverSocket = this;
    return amount.call(this) as number;
  });
  const closed = vi.fn();
  listener = await listen({ port: 0 }, (arrival) => {
    peer = arrival;
    return { handle: async () => ({}), close: closed };
  });
  const text = 'x'.repeat(OUTBOUND_LIMIT + 1);
  for (let attempt = 0; attempt < 2; attempt++) {
    client = new WebSocket(`ws://127.0.0.1:${listener.port}`);
    const received: Array<{ method?: string | undefined; matches?: boolean }> = [];
    const errors: Error[] = [];
    client.on('error', (error) => { errors.push(error); });
    client.on('message', (raw) => {
      const frame = JSON.parse(String(raw)) as { method?: string; result?: { text?: string } };
      received.push(frame.result === undefined ? { method: frame.method } : { matches: frame.result.text === text });
    });
    await new Promise<void>((resolve, reject) => {
      client!.once('open', resolve);
      client!.once('error', reject);
    });
    peer.notify('ready', {});
    await vi.waitFor(() => expect(received).toEqual([{ method: 'ready' }]), { timeout: 5000 });
    const transport = (serverSocket! as unknown as { _socket: Socket })._socket;
    const dropped = attempt === 0 ? new Promise<void>((resolve) => { client!.once('close', resolve); }) : undefined;
    transport.cork();
    try {
      peer.send({ jsonrpc: '2.0', id: 1, result: { text } });
      peer.notify(attempt === 0 ? 'discard' : 'fresh', {});
      if (attempt === 0) peer.close();
    } finally { transport.uncork(); }
    if (dropped !== undefined) {
      await dropped;
      await vi.waitFor(() => expect(closed).toHaveBeenCalledTimes(1));
      expect(received).toEqual([{ method: 'ready' }]);
    } else {
      await vi.waitFor(() => {
        expect(errors).toEqual([]);
        expect(client!.readyState).toBe(WebSocket.OPEN);
        expect(received).toEqual([{ method: 'ready' }, { matches: true }, { method: 'fresh' }]);
      }, { timeout: 5000 });
      expect(closed).toHaveBeenCalledTimes(1);
    }
  }
}, 15_000);

it.each(['high-water', 'peer-close'])('releases a real paused Node queue on %s within a finite traffic budget', async (ending) => {
  let peer!: Peer;
  let serverSocket: WebSocket | undefined;
  let serialized = 0;
  let peak = 0;
  const amount = Object.getOwnPropertyDescriptor(WebSocket.prototype, 'bufferedAmount')!.get!;
  vi.spyOn(WebSocket.prototype, 'bufferedAmount', 'get').mockImplementation(function (this: WebSocket) {
    const bytes = amount.call(this) as number;
    serverSocket = this;
    peak = Math.max(peak, bytes);
    return bytes;
  });
  const closed = vi.fn();
  listener = await listen({ port: 0 }, (arrival) => {
    peer = arrival;
    return { handle: async () => ({}), close: closed };
  });
  client = new WebSocket(`ws://127.0.0.1:${listener.port}`);
  await new Promise<void>((resolve, reject) => {
    client!.once('open', resolve);
    client!.once('error', reject);
  });
  client.pause();
  const text = '界'.repeat(16 * 1024);
  const payload = { toJSON: () => { serialized += 1; return text; } };
  // At most 48.1 MiB of synthetic traffic, with event-loop turns so a socket
  // can drain. No heap exhaustion, timers or operating-system buffer tuning.
  for (let i = 0; i < 1024 && closed.mock.calls.length === 0; i++) {
    peer.notify('synthetic', payload);
    if (i % 8 === 7) await new Promise<void>((resolve) => { setImmediate(resolve); });
    if (ending === 'peer-close' && peak > 0) { peer.close(); break; }
  }
  await vi.waitFor(() => expect(closed).toHaveBeenCalledTimes(1));
  expect(serialized).toBeLessThan(1024);
  expect(peak).toBeGreaterThan(0);
  // One admitted notification, including its ws header, may cross the mark.
  expect(peak).toBeLessThan(OUTBOUND_LIMIT + 49_202 + 10);
  expect(serverSocket!.readyState).toBe(WebSocket.CLOSED);
  expect(amount.call(serverSocket)).toBe(0);
  const stopped = serialized;
  peer.close();
  peer.notify('synthetic', payload);
  expect(serialized).toBe(stopped);
  expect(closed).toHaveBeenCalledTimes(1);
  client.resume();
});

it('admits a frame when the existing backlog is one byte below the mark', () => {
  const message = { text: '界' };
  const text = JSON.stringify(message);
  let queued = OUTBOUND_LIMIT - 1;
  const send = vi.fn((raw: string) => { queued += Buffer.byteLength(raw); });
  const close = vi.fn();
  const peer = createPeer({ bufferedBytes: () => queued, send, close, isOpen: () => true });
  peer.send(message);
  expect(send).toHaveBeenCalledWith(text);
  expect(queued).toBeGreaterThan(OUTBOUND_LIMIT);
  peer.send(message);
  expect(send).toHaveBeenCalledTimes(1);
  expect(close).toHaveBeenCalledTimes(1);
});

it.each([OUTBOUND_LIMIT, OUTBOUND_LIMIT + 1])('checks backlog %i before serialization and rejects pending questions once', async (backlog) => {
  vi.useFakeTimers();
  try {
    let queued = 0;
    const close = vi.fn();
    const peer = createPeer({ bufferedBytes: () => queued, send: () => {}, close, isOpen: () => true });
    const rejected = vi.fn((error: unknown) => error);
    const pending = peer.request('synthetic', {}, 100).catch(rejected);
    const toJSON = vi.fn(() => 'synthetic');
    queued = backlog;
    peer.notify('synthetic', { toJSON });
    const refused = peer.request('refused', { toJSON }, 100).catch(rejected);
    peer.close();
    peer.send({ toJSON });
    expect(toJSON).not.toHaveBeenCalled();
    expect(await pending).toBeInstanceOf(RpcClosed);
    expect(await refused).toBeInstanceOf(RpcClosed);
    peer.answered({ id: 1, result: 'too late' });
    await vi.advanceTimersByTimeAsync(1000);
    expect(rejected).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
    expect(close).toHaveBeenCalledTimes(1);
  } finally { vi.useRealTimers(); }
});

it.each([0, 1, OUTBOUND_LIMIT - 1])('admits a frame over 8 MiB with backlog %i, then closes before serializing another', (backlog) => {
  let queued = backlog;
  const send = vi.fn((raw: string) => { queued += Buffer.byteLength(raw); });
  const close = vi.fn(() => { queued = 0; });
  const peer = createPeer({ bufferedBytes: () => queued, send, close, isOpen: () => true });
  const large = { text: '界'.repeat(Math.floor(OUTBOUND_LIMIT / 3) + 1) };
  peer.send(large);
  expect(send).toHaveBeenCalledTimes(1);
  expect(queued).toBeGreaterThan(OUTBOUND_LIMIT);
  expect(close).not.toHaveBeenCalled();
  const toJSON = vi.fn(() => 'must not serialize');
  peer.send({ toJSON });
  expect(toJSON).not.toHaveBeenCalled();
  expect(send).toHaveBeenCalledTimes(1);
  expect(close).toHaveBeenCalledTimes(1);
  expect(queued).toBe(0);
});

it('keeps a draining consumer connected and sends frames in order', () => {
  const frames: number[] = [];
  const close = vi.fn();
  const peer = createPeer({
    bufferedBytes: () => 0,
    send: (text) => { frames.push(JSON.parse(text).params.i); },
    close,
    isOpen: () => true,
  });
  const text = '界'.repeat(16 * 1024);
  for (let i = 0; i < 256; i++) peer.notify('synthetic', { i, text });
  expect(frames).toEqual(Array.from({ length: 256 }, (_, i) => i));
  expect(close).not.toHaveBeenCalled();
});
