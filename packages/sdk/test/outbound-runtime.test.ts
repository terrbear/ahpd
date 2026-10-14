import { PassThrough, Writable } from 'node:stream';
import { afterEach, expect, it, vi } from 'vitest';
import { listen, overStdio } from '../src/listen.js';
import { OUTBOUND_LIMIT } from '../src/rpc.js';
import type { Peer } from '../src/types/rpc.js';

afterEach(() => { vi.unstubAllGlobals(); });

// These run the actual adapter branches with their runtime API shapes. They
// check compatibility, not native Bun/Deno execution or their queue behavior.
it('keeps Bun frames unrestricted through the existing listener adapter', async () => {
  let callbacks!: { open(socket: unknown): void; close(socket: unknown): void };
  const stop = vi.fn();
  vi.stubGlobal('Bun', { serve: (options: { websocket: typeof callbacks }) => {
    callbacks = options.websocket;
    return { port: 1, stop };
  } });
  let peer!: Peer;
  const disconnected = vi.fn();
  const listener = await listen({ port: 0 }, (arrival) => {
    peer = arrival;
    return { handle: async () => ({}), close: disconnected };
  });
  const bytes: number[] = [];
  const bufferedAmount = vi.fn(() => OUTBOUND_LIMIT * 2);
  const close = vi.fn();
  const socket = { readyState: 1, send: (raw: string) => { bytes.push(Buffer.byteLength(raw)); }, close, get bufferedAmount() { return bufferedAmount(); } };
  try {
    callbacks.open(socket);
    peer.notify('large', { text: 'x'.repeat(OUTBOUND_LIMIT + 1) });
    peer.notify('after', {});
    expect(listener.runtime).toBe('bun');
    expect(bytes[0]).toBeGreaterThan(OUTBOUND_LIMIT);
    expect(bytes).toHaveLength(2);
    expect(bufferedAmount).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
    callbacks.close(socket);
    expect(disconnected).toHaveBeenCalledTimes(1);
  } finally { await listener.close(); }
});

it('keeps Deno frames unrestricted through the existing listener adapter', async () => {
  let handler!: (request: Request) => Promise<Response>;
  const bytes: number[] = [];
  const bufferedAmount = vi.fn(() => OUTBOUND_LIMIT * 2);
  const close = vi.fn();
  const socket = {
    readyState: 1, send: (raw: string) => { bytes.push(Buffer.byteLength(raw)); }, close,
    get bufferedAmount() { return bufferedAmount(); },
    onopen: undefined as (() => void) | undefined,
    onclose: undefined as (() => void) | undefined,
  };
  const shutdown = vi.fn(async () => {});
  vi.stubGlobal('Deno', {
    serve: (_options: unknown, next: typeof handler) => { handler = next; return { addr: { port: 1 }, shutdown }; },
    upgradeWebSocket: () => ({ socket, response: new Response('upgraded') }),
  });
  let peer!: Peer;
  const disconnected = vi.fn();
  const listener = await listen({ port: 0 }, (arrival) => {
    peer = arrival;
    return { handle: async () => ({}), close: disconnected };
  });
  try {
    await handler(new Request('http://127.0.0.1/', { headers: { upgrade: 'websocket' } }));
    socket.onopen!();
    peer.notify('large', { text: 'x'.repeat(OUTBOUND_LIMIT + 1) });
    peer.notify('after', {});
    expect(listener.runtime).toBe('deno');
    expect(bytes[0]).toBeGreaterThan(OUTBOUND_LIMIT);
    expect(bytes).toHaveLength(2);
    expect(bufferedAmount).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
    socket.onclose!();
    expect(disconnected).toHaveBeenCalledTimes(1);
  } finally { await listener.close(); }
});

it('preserves stdout/stdio serialization even with more than 8 MiB already queued', async () => {
  const input = new PassThrough();
  // Hold the write callback to model a pipe that does not drain. This is a
  // finite two-message compatibility check, not a stdout memory mitigation.
  const output = new Writable({ highWaterMark: 1, write: () => {} });
  let peer!: Peer;
  const disconnected = vi.fn();
  const listener = await overStdio({ input, output }, (arrival) => {
    peer = arrival;
    return { handle: async () => ({}), close: disconnected };
  });
  try {
    peer.notify('large', { text: 'x'.repeat(OUTBOUND_LIMIT + 1) });
    expect(output.writableLength).toBeGreaterThan(OUTBOUND_LIMIT);
    const toJSON = vi.fn(() => 'still serialized');
    peer.notify('after', { toJSON });
    expect(toJSON).toHaveBeenCalledTimes(1);
    expect(disconnected).not.toHaveBeenCalled();
    await listener.close();
    await listener.close();
    expect(disconnected).toHaveBeenCalledTimes(1);
  } finally { await listener.close(); input.destroy(); output.destroy(); }
});
