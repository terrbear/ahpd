import { describe, expect, it } from 'vitest';
import { humanSteering, type SteeringReceipt } from '../src/steering.js';

function fixture() {
  let answer: (value: { outcome: string }) => void = () => {};
  let saved: SteeringReceipt[] = [];
  const events: Record<string, unknown>[] = [];
  let calls = 0;
  const state = humanSteering({
    persist: (value) => { saved = structuredClone(value); },
    inject: async () => { calls++; return await new Promise((resolve) => { answer = resolve; }); },
    emit: (action) => events.push(action), settled: () => {},
  });
  return { state, events, answer: (outcome: string) => answer({ outcome }), saved: () => saved, calls: () => calls };
}

describe('human steering receipts', () => {
  it('keeps delivery pending until the adapter confirms injection, and never injects an ID twice', async () => {
    const f = fixture();
    expect(f.state.steer('message', 'correction', 'turn')).toBe(true);
    expect(f.saved()[0]?.status).toBe('pending');
    expect(f.state.pending()?.id).toBe('message');
    expect(f.state.steer('message', 'correction', 'turn')).toBe(true);
    expect(f.state.steer('message', 'different', 'turn')).toBe(false);
    expect(f.calls()).toBe(1);
    f.answer('injected');
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(f.saved()[0]?.status).toBe('injected');
    expect(f.state.pending()).toBeUndefined();
    expect(f.events.at(-1)).toMatchObject({ type: 'chat/pendingMessageRemoved', id: 'message' });
  });

  it('records inactive without claiming delivery when the current turn ends first', async () => {
    const f = fixture();
    f.state.steer('message', 'correction', 'turn'); f.answer('inactive');
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(f.saved()[0]?.status).toBe('inactive');
  });

  it('retains unknown outcomes across restoration and refuses an ID reuse', async () => {
    const f = fixture();
    f.state.steer('message', 'correction', 'turn');
    const restored = humanSteering({ initial: f.saved(), persist: () => {}, inject: async () => { throw new Error('must not repeat'); }, emit: () => {}, settled: () => {} });
    expect(restored.metadata().receipts[0]?.status).toBe('unknown');
    expect(restored.steer('message', 'correction', 'turn')).toBe(true);
    expect(restored.steer('message', 'different', 'turn')).toBe(false);
  });
});
