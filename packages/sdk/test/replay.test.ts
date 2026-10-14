import { expect, it, vi } from 'vitest';
import { Replay, REPLAY_ACTIONS, REPLAY_BYTES } from '../src/replay.js';

it('bounds repeated cumulative tool output before the action count limit', () => {
  const replay = new Replay<{ serverSeq: number; content: string }>();
  let oldRetainedBytes = 0;
  for (let serverSeq = 1; serverSeq <= 128; serverSeq++) {
    const content = '界'.repeat(serverSeq * 16 * 1024);
    oldRetainedBytes += content.length * 2;
    replay.push({ serverSeq, content });
    expect(replay.retainedBytes).toBeLessThanOrEqual(REPLAY_BYTES);
  }
  expect(oldRetainedBytes).toBeGreaterThan(8 * REPLAY_BYTES);
  expect(replay.entries.length).toBeLessThan(128);
  const oldest = replay.entries[0]!.serverSeq;
  expect(replay.covers(oldest - 2)).toBe(false);
  expect(replay.covers(oldest - 1)).toBe(true);
  expect(replay.entries.map((one) => one.serverSeq)).toEqual(
    Array.from({ length: 129 - oldest }, (_, index) => oldest + index),
  );
});

it('skips cloning oversized actions and remembers the gap even when empty', () => {
  const replay = new Replay<{ serverSeq: number; content: string }>();
  replay.push({ serverSeq: 1, content: 'before' });
  const clone = vi.spyOn(globalThis, 'structuredClone');
  try {
    replay.push({ serverSeq: 2, content: 'x'.repeat(REPLAY_BYTES) });
    expect(clone).not.toHaveBeenCalled();
    expect(replay.entries).toEqual([]);
    expect(replay.retainedBytes).toBe(0);
    expect(replay.covers(1)).toBe(false);
    expect(replay.covers(2)).toBe(true);
    replay.push({ serverSeq: 3, content: 'after' });
    expect(replay.covers(1)).toBe(false);
    expect(replay.covers(2)).toBe(true);
    expect(replay.entries).toEqual([{ serverSeq: 3, content: 'after' }]);
  } finally { clone.mockRestore(); }
});

it('still limits small actions by count and freezes mutable action values', () => {
  const replay = new Replay<{ serverSeq: number; action: { content: string } }>();
  const action = { content: 'before' };
  replay.push({ serverSeq: 1, action });
  action.content = 'after';
  expect(replay.entries[0]!.action.content).toBe('before');
  for (let serverSeq = 2; serverSeq <= REPLAY_ACTIONS + 1; serverSeq++) replay.push({ serverSeq, action });
  expect(replay.entries).toHaveLength(REPLAY_ACTIONS);
  expect(replay.covers(0)).toBe(false);
  expect(replay.covers(1)).toBe(true);
});

it('accounts for arrays and object overhead, and avoids getters and unsupported values', () => {
  const replay = new Replay<{ serverSeq: number; action: unknown }>();
  // A sparse array with a huge logical length, without a huge allocation.
  replay.push({ serverSeq: 1, action: new Array(2 ** 32 - 1) });
  expect(replay.entries).toHaveLength(0);
  const getter = vi.fn(() => 'value');
  replay.push({ serverSeq: 2, action: { get text() { return getter(); } } });
  expect(getter).not.toHaveBeenCalled();
  replay.push({ serverSeq: 3, action: new Map([['key', 'value']]) });
  expect(replay.entries).toHaveLength(0);
  expect(replay.covers(2)).toBe(false);
  replay.push({ serverSeq: 4, action: { rows: [{ text: 'hello' }] } });
  expect(replay.retainedBytes).toBeGreaterThan(2 * 'hello'.length);
});
