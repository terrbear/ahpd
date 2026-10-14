import { afterEach, expect, it, vi } from 'vitest';
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

it('bounds a stalled Node socket and stops serializing after disconnect', async () => {
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
  expect(peak).toBe(8_364_340);
  expect(peak).toBeLessThanOrEqual(OUTBOUND_LIMIT);
  expect(sent).toBe(170);
  expect(serialized).toBe(171);
  await vi.waitFor(() => expect(closed).toHaveBeenCalledTimes(1));
  const stopped = serialized;
  peer.notify('synthetic', payload);
  expect(serialized).toBe(stopped);
  await expect(peer.request('synthetic', payload)).rejects.toMatchObject({ name: 'RpcClosed' });
  // Keep the synthetic model's storage small even on a failing baseline.
  queued = 0;
});

it('disconnects a real paused Node consumer within a finite traffic budget', async () => {
  let peer!: Peer;
  let serialized = 0;
  let peak = 0;
  const amount = Object.getOwnPropertyDescriptor(WebSocket.prototype, 'bufferedAmount')!.get!;
  vi.spyOn(WebSocket.prototype, 'bufferedAmount', 'get').mockImplementation(function (this: WebSocket) {
    const bytes = amount.call(this) as number;
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
  }
  await vi.waitFor(() => expect(closed).toHaveBeenCalledTimes(1));
  expect(serialized).toBeLessThan(1024);
  // ws includes frame headers in its backlog. An unmasked server frame's
  // header is at most ten bytes, beyond the admitted payload budget.
  expect(peak).toBeLessThanOrEqual(OUTBOUND_LIMIT + 10);
  client.resume();
});

it('counts UTF-8 bytes and admits a frame exactly at the remaining budget', () => {
  const message = { text: '界' };
  const text = JSON.stringify(message);
  let queued = OUTBOUND_LIMIT - Buffer.byteLength(text);
  const send = vi.fn();
  const close = vi.fn();
  const peer = createPeer({ bufferedBytes: () => queued, send, close, isOpen: () => true });
  peer.send(message);
  expect(send).toHaveBeenCalledWith(text);
  queued += 1;
  peer.send(message);
  expect(send).toHaveBeenCalledTimes(1);
  expect(close).toHaveBeenCalledTimes(1);
});

it('checks a full queue before serialization and rejects pending questions once', async () => {
  let queued = 0;
  const close = vi.fn();
  const peer = createPeer({ bufferedBytes: () => queued, send: () => {}, close, isOpen: () => true });
  const pending = peer.request('synthetic', {}).catch((error: unknown) => error);
  const toJSON = vi.fn(() => 'synthetic');
  queued = OUTBOUND_LIMIT;
  peer.notify('synthetic', { toJSON });
  peer.close();
  peer.send({ toJSON });
  expect(toJSON).not.toHaveBeenCalled();
  expect(await pending).toBeInstanceOf(RpcClosed);
  await expect(peer.request('synthetic', {})).rejects.toBeInstanceOf(RpcClosed);
  expect(close).toHaveBeenCalledTimes(1);
});

it('rejects one oversized frame without writing or tapping it', () => {
  const send = vi.fn();
  const close = vi.fn();
  const peer = createPeer({ bufferedBytes: () => 0, send, close, isOpen: () => true });
  peer.send({ text: '界'.repeat(Math.floor(OUTBOUND_LIMIT / 3)) });
  expect(send).not.toHaveBeenCalled();
  expect(close).toHaveBeenCalledTimes(1);
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
