import { expect, it } from 'vitest';
import { OUTBOUND_LIMIT } from '../src/rpc.js';
import { BASE, REJECTED, historicalSourcesAvailable, versions } from './outbound-versions.js';

it.skipIf(!historicalSourcesAvailable())('compares the same finite stalled workload with the exact base, rejected cap, and final code without retaining frames', async () => {
  const results: Record<string, unknown> = {};
  for (const [revision, create] of Object.entries(await versions())) {
    let queued = 0;
    let peak = 0;
    let serialized = 0;
    let sent = 0;
    let closed = 0;
    const peer = create({
      bufferedBytes: () => queued,
      send: (raw) => { queued += Buffer.byteLength(raw); peak = Math.max(peak, queued); sent += 1; },
      close: () => { closed += 1; queued = 0; },
      isOpen: () => closed === 0,
    });
    const text = '界'.repeat(16 * 1024);
    const payload = { toJSON: () => { serialized += 1; return text; } };
    for (let i = 0; i < 256; i++) peer.notify('synthetic', payload);
    results[revision] = { serialized, sent, peak, closed, queued };
  }
  expect(results[BASE]).toEqual({ serialized: 256, sent: 256, peak: 12_595_712, closed: 0, queued: 12_595_712 });
  expect(results[REJECTED]).toEqual({ serialized: 171, sent: 170, peak: 8_364_340, closed: 1, queued: 0 });
  expect(results.final).toEqual({ serialized: 171, sent: 171, peak: 8_413_542, closed: 1, queued: 0 });
  expect(8_413_542).toBeLessThan(OUTBOUND_LIMIT + 49_202);
  console.info('Finite outbound comparison (bytes, no retained frames):', JSON.stringify(results));
});
