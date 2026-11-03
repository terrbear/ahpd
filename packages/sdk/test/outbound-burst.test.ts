import { expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { listen } from '../src/listen.js';
import type { Peer } from '../src/types/rpc.js';

it('delivers a thousand synchronous streaming updates through a real Node WebSocket', async () => {
  let peer!: Peer;
  const closed: unknown[] = [];
  const listener = await listen({ port: 0, onOutboundClose: (event) => { closed.push(event); } }, (arrival) => {
    peer = arrival;
    return { handle: async () => ({}), close: () => {} };
  });
  const socket = new WebSocket(`ws://127.0.0.1:${listener.port}`);
  try {
    await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
    const received: number[] = [];
    const done = new Promise<void>((resolve, reject) => {
      socket.on('message', (data) => {
        received.push(JSON.parse(data.toString()).params.index as number);
        if (received.length === 1000) resolve();
      });
      socket.once('close', () => { reject(new Error('Streaming connection closed before the burst finished')); });
      socket.once('error', reject);
    });
    for (let index = 0; index < 1000; index++) peer.notify('stream', { index });
    await done;
    expect(received).toEqual(Array.from({ length: 1000 }, (_, index) => index));
    expect(closed).toEqual([]);
  } finally {
    socket.terminate();
    await listener.close();
  }
});
