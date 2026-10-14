import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { boundedJson, JsonBudgetExceeded } from '../src/bounded-json.js';
import {
  DEFERRED_BYTE_LIMIT, DEFERRED_FRAME_LIMIT, DRAIN_CHECK_MS, DRAIN_GRACE_MS, OUTSTANDING_FRAME_LIMIT,
} from '../src/outbound-node.js';
import { createPeer, OUTBOUND_LIMIT, RpcClosed, RpcTimeout } from '../src/rpc.js';
import type { OutboundClose, Peer } from '../src/types/rpc.js';

const large = { text: 'x'.repeat(OUTBOUND_LIMIT + 1) };
let peers: Peer[] = [];
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['performance', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
});
afterEach(() => {
  try {
    for (const peer of peers) peer.close();
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    peers = [];
    vi.useRealTimers();
  }
});

function connection(retainBytes = true, diagnostic?: (event: OutboundClose) => void) {
  let buffered = 0;
  let open = true;
  // Never retain the large serialized frame in this finite synthetic wire.
  const writes: Array<{ bytes: number; text?: string; done(error?: Error): void }> = [];
  const diagnostics = vi.fn((event: OutboundClose) => { diagnostic?.(event); });
  const close = vi.fn(() => { open = false; buffered = 0; });
  const peer = createPeer({
    send: () => { throw new Error('The completion-capable path must be used'); },
    sendCompleted: (text, done) => {
      const bytes = Buffer.byteLength(text);
      if (retainBytes) buffered += bytes;
      writes.push(bytes > OUTBOUND_LIMIT ? { bytes, done } : { bytes, done, text });
    },
    bufferedBytes: () => buffered,
    isOpen: () => open,
    close,
    onOutboundClose: diagnostics,
  });
  peers.push(peer);
  return {
    peer, writes, close, diagnostics,
    setBacklog(bytes: number) { buffered = bytes; },
    complete(index: number, error?: Error) {
      const write = writes[index]!;
      buffered = Math.max(0, buffered - write.bytes);
      write.done(error);
    },
  };
}

it('defers immutable follow-ups in FIFO order until oversized completion and zero backlog', () => {
  const c = connection();
  c.peer.send(large);
  let value = 'before';
  c.peer.notify('first', { toJSON: () => value });
  c.peer.notify('second', { i: 2 });
  value = 'after';
  expect(c.writes).toHaveLength(1);
  expect(vi.getTimerCount()).toBe(1);
  c.writes[0]!.done(); // Completion alone must not ignore actual backlog.
  vi.advanceTimersByTime(DRAIN_CHECK_MS);
  expect(c.writes).toHaveLength(1);
  c.setBacklog(0);
  vi.advanceTimersByTime(DRAIN_CHECK_MS);
  expect(c.writes.slice(1).map((write) => JSON.parse(write.text!))).toEqual([
    { jsonrpc: '2.0', method: 'first', params: 'before' },
    { jsonrpc: '2.0', method: 'second', params: { i: 2 } },
  ]);
  c.complete(1);
  c.complete(2);
  expect(vi.getTimerCount()).toBe(0);
  c.writes[0]!.done(); // Duplicate completion cannot corrupt counters.
  c.peer.send(large);
  expect(c.writes).toHaveLength(4);
  c.complete(3);
  expect(vi.getTimerCount()).toBe(0);
  expect(c.close).not.toHaveBeenCalled();
});

it('does not treat zero socket backlog as oversized write completion', () => {
  const c = connection();
  c.peer.send(large);
  c.peer.notify('after', {});
  c.setBacklog(0);
  vi.advanceTimersByTime(DRAIN_CHECK_MS);
  expect(c.writes).toHaveLength(1);
  c.complete(0);
  expect(c.writes).toHaveLength(2);
  c.complete(1);
  expect(vi.getTimerCount()).toBe(0);
});

it('handles synchronous write completion without leaking grace timers', () => {
  const close = vi.fn();
  const delivered: number[] = [];
  const peer = createPeer({
    send: () => {}, bufferedBytes: () => 0, isOpen: () => true, close,
    sendCompleted: (text, done) => { delivered.push(Buffer.byteLength(text)); done(); },
  });
  peers.push(peer);
  peer.send(large);
  peer.notify('after', {});
  peer.send(large);
  expect(delivered).toHaveLength(3);
  expect(delivered[0]).toBeGreaterThan(OUTBOUND_LIMIT);
  expect(delivered[2]).toBeGreaterThan(OUTBOUND_LIMIT);
  expect(vi.getTimerCount()).toBe(0);
  expect(close).not.toHaveBeenCalled();
});

it('retains immediate high-water rejection for ordinary completion-capable writes', () => {
  const c = connection();
  c.peer.send({});
  c.setBacklog(OUTBOUND_LIMIT);
  const toJSON = vi.fn(() => 'must not serialize');
  c.peer.send({ toJSON });
  expect(toJSON).not.toHaveBeenCalled();
  expect(c.writes).toHaveLength(1);
  expect(c.diagnostics.mock.calls[0]![0]).toMatchObject({ reason: 'backlog_limit', oversizedFrameBytes: null });
  expect(vi.getTimerCount()).toBe(0);
});

it.each([false, true])('closes at the fixed deadline despite partial progress (new traffic: %s)', (traffic) => {
  const c = connection();
  c.peer.send(large);
  vi.advanceTimersByTime(1000);
  c.setBacklog(1);
  c.writes[0]!.done();
  vi.advanceTimersByTime(DRAIN_GRACE_MS - 1000 - DRAIN_CHECK_MS);
  if (traffic) c.peer.notify('recent', {});
  vi.advanceTimersByTime(DRAIN_CHECK_MS - 1);
  expect(c.close).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1);
  expect(c.close).toHaveBeenCalledTimes(1);
  expect(c.diagnostics).toHaveBeenCalledWith(expect.objectContaining({ reason: 'drain_timeout', drainElapsedMs: 5000 }));
  expect(vi.getTimerCount()).toBe(0);
  c.writes[0]!.done();
  expect(c.writes).toHaveLength(1);
});

it('times out an oversized write without completion or any follow-up', () => {
  const c = connection();
  c.peer.send(large);
  vi.advanceTimersByTime(DRAIN_GRACE_MS);
  expect(c.close).toHaveBeenCalledTimes(1);
  expect(c.diagnostics.mock.calls[0]![0].reason).toBe('drain_timeout');
  expect(vi.getTimerCount()).toBe(0);
});

it('keeps the original deadline while the deferred batch itself is stalled', () => {
  const c = connection();
  c.peer.send(large);
  c.peer.notify('after', {});
  vi.advanceTimersByTime(DRAIN_GRACE_MS - DRAIN_CHECK_MS);
  c.complete(0);
  expect(c.writes).toHaveLength(2);
  vi.advanceTimersByTime(DRAIN_CHECK_MS);
  expect(c.close).toHaveBeenCalledTimes(1);
  expect(c.diagnostics.mock.calls[0]![0]).toMatchObject({ reason: 'drain_timeout', outstandingWrites: 1, deferredFrames: 0 });
});

it('accepts exactly 256 KiB of deferred JSON and refuses more before toJSON', () => {
  const c = connection();
  c.peer.send(large);
  const overhead = Buffer.byteLength(JSON.stringify({ text: '' }));
  c.peer.send({ text: 'x'.repeat(DEFERRED_BYTE_LIMIT - overhead) });
  expect(c.close).not.toHaveBeenCalled();
  const toJSON = vi.fn(() => 'must not serialize');
  c.peer.send({ toJSON });
  expect(toJSON).not.toHaveBeenCalled();
  expect(c.diagnostics.mock.calls[0]![0]).toMatchObject({ reason: 'deferred_byte_limit', deferredBytes: 262144, deferredFrames: 1 });
  c.complete(0);
  expect(c.writes).toHaveLength(1);
});

it('charges each deferred frame against the remaining aggregate byte budget', () => {
  const c = connection();
  c.peer.send(large);
  const first = { text: 'x'.repeat(DEFERRED_BYTE_LIMIT / 2) };
  c.peer.send(first);
  const later = vi.fn(() => 'must not visit');
  c.peer.send({ text: '界'.repeat(DEFERRED_BYTE_LIMIT / 4), get later() { return later(); } });
  expect(later).not.toHaveBeenCalled();
  expect(c.diagnostics.mock.calls[0]![0]).toMatchObject({ reason: 'deferred_byte_limit', deferredFrames: 1, deferredBytes: Buffer.byteLength(JSON.stringify(first)) });
});

it('rejects a second oversized frame before encoding its large literal or visiting later fields', () => {
  const c = connection();
  c.peer.send(large);
  const later = vi.fn(() => 'must not visit');
  c.peer.send({ text: large.text, get later() { return later(); } });
  expect(later).not.toHaveBeenCalled();
  expect(c.writes).toHaveLength(1);
  expect(c.diagnostics.mock.calls[0]![0]).toMatchObject({ reason: 'deferred_byte_limit', deferredBytes: 0, deferredFrames: 0 });
});

it('accepts 32 deferred frames and refuses entry 33 before toJSON', () => {
  const c = connection();
  c.peer.send(large);
  for (let i = 0; i < DEFERRED_FRAME_LIMIT; i++) c.peer.send({});
  expect(c.close).not.toHaveBeenCalled();
  const toJSON = vi.fn(() => 'must not serialize');
  c.peer.send({ toJSON });
  expect(toJSON).not.toHaveBeenCalled();
  expect(c.diagnostics.mock.calls[0]![0]).toMatchObject({ reason: 'deferred_count_limit', deferredFrames: 32, deferredBytes: 64 });
});

it('caps normal outstanding writes at 256 even when local backlog reports zero', () => {
  const c = connection(false);
  for (let i = 0; i < OUTSTANDING_FRAME_LIMIT; i++) c.peer.send({});
  expect(c.close).not.toHaveBeenCalled();
  const toJSON = vi.fn(() => 'must not serialize');
  c.peer.send({ toJSON });
  expect(toJSON).not.toHaveBeenCalled();
  expect(c.writes).toHaveLength(256);
  expect(c.diagnostics.mock.calls[0]![0]).toMatchObject({ reason: 'frame_count_limit', outstandingWrites: 256 });
});

it('counts outstanding writes and deferred entries together', () => {
  const c = connection(false);
  for (let i = 0; i < 224; i++) c.peer.send({});
  c.peer.send(large);
  for (let i = 0; i < 31; i++) c.peer.send({});
  expect(c.close).not.toHaveBeenCalled();
  c.peer.send({});
  expect(c.diagnostics.mock.calls[0]![0]).toMatchObject({ reason: 'frame_count_limit', outstandingWrites: 225, deferredFrames: 31 });
});

it('releases outstanding admission capacity exactly once per completed write', () => {
  const c = connection(false);
  for (let i = 0; i < OUTSTANDING_FRAME_LIMIT; i++) c.peer.send({});
  c.complete(0);
  c.complete(0);
  c.peer.send({});
  expect(c.close).not.toHaveBeenCalled();
  expect(c.writes).toHaveLength(257);
  c.peer.send({});
  expect(c.diagnostics.mock.calls[0]![0]).toMatchObject({ reason: 'frame_count_limit', outstandingWrites: 256 });
});

it('rejects pending questions and discards the FIFO on timeout, then reconnects cleanly', async () => {
  const old = connection();
  old.peer.send(large);
  old.peer.notify('discard', {});
  const pending = old.peer.request('question', {}, 30_000).catch((error: unknown) => error);
  vi.advanceTimersByTime(DRAIN_GRACE_MS);
  expect(await pending).toBeInstanceOf(RpcClosed);
  expect(vi.getTimerCount()).toBe(0);
  old.complete(0);
  old.peer.notify('too late', {});
  expect(old.writes).toHaveLength(1);
  old.peer.close();
  expect(old.close).toHaveBeenCalledTimes(1);

  const fresh = connection();
  fresh.peer.send(large);
  const answer = fresh.peer.request('fresh', {}).catch((error: unknown) => error);
  fresh.complete(0);
  expect(fresh.writes).toHaveLength(2);
  const frame = JSON.parse(fresh.writes[1]!.text!) as { id: number; method: string };
  expect(frame).toMatchObject({ id: 1, method: 'fresh' });
  fresh.complete(1);
  fresh.peer.answered({ id: frame.id, result: 'ok' });
  expect(await answer).toBe('ok');
  expect(vi.getTimerCount()).toBe(0);
  expect(fresh.close).not.toHaveBeenCalled();
});

it.each(['peer', 'write-error', 'overflow'])('cleans pending questions, timers and late completions on %s close', async (ending) => {
  const c = connection();
  c.peer.send(large);
  const pending = c.peer.request('question', {}, 30_000).catch((error: unknown) => error);
  if (ending === 'peer') c.peer.close();
  else if (ending === 'write-error') c.complete(0, new Error('private error text'));
  else c.peer.send(large);
  expect(await pending).toBeInstanceOf(RpcClosed);
  expect(vi.getTimerCount()).toBe(0);
  c.complete(0);
  c.peer.close();
  expect(c.close).toHaveBeenCalledTimes(1);
  expect(c.writes).toHaveLength(1);
});

it('removes an expired queued request while retaining later notifications in order', async () => {
  const c = connection();
  c.peer.send(large);
  const pending = c.peer.request('expire', {}, 100).catch((error: unknown) => error);
  c.peer.notify('keep', {});
  vi.advanceTimersByTime(100);
  expect(await pending).toBeInstanceOf(RpcTimeout);
  c.complete(0);
  expect(c.writes).toHaveLength(2);
  expect(JSON.parse(c.writes[1]!.text!).method).toBe('keep');
  c.complete(1);
  expect(vi.getTimerCount()).toBe(0);
  expect(c.close).not.toHaveBeenCalled();
});

it('contains diagnostic exceptions and emits exactly the payload-free field allowlist once', () => {
  const c = connection(true, () => { throw new Error('private diagnostic failure'); });
  c.peer.send(large);
  c.peer.notify('private method', { identity: 'private identity', path: '/private/path', secret: 'private secret' });
  c.complete(0, new Error('private transport error'));
  c.peer.close();
  expect(c.diagnostics).toHaveBeenCalledTimes(1);
  const diagnostic = c.diagnostics.mock.calls[0]![0];
  expect(Object.keys(diagnostic).sort()).toEqual([
    'bufferedBytes', 'deferredBytes', 'deferredFrames', 'drainElapsedMs', 'event',
    'outstandingWrites', 'oversizedFrameBytes', 'reason', 'runtime',
  ]);
  expect(diagnostic).toMatchObject({ event: 'outbound_close', runtime: 'node', reason: 'write_error' });
  expect(Object.values(diagnostic).filter((value) => typeof value === 'string')).toEqual(['outbound_close', 'node', 'write_error']);
  expect(c.close).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});

it('closes safely on reentrant toJSON instead of bypassing queue admission', () => {
  const c = connection();
  c.peer.send(large);
  c.peer.send({ toJSON: () => { c.peer.notify('reenter', {}); return {}; } });
  expect(c.close).toHaveBeenCalledTimes(1);
  expect(c.writes).toHaveLength(1);
  expect(vi.getTimerCount()).toBe(0);
});

it('retains native JSON rules and exact UTF-8 accounting at the deferred budget boundary', () => {
  const message = {
    text: '界😀\ud800\udc00\ud800\udc00\udc00\ud800\u0000\b\t\n\f\r"\\',
    '界"\\\u0001': [undefined, () => {}, Symbol('omit'), NaN, Infinity, -0, new String('boxed'), new Number(3), new Boolean(false)],
    omitted: undefined,
    hook: { toJSON: () => ({ nested: '界' }) },
    empty: {},
  };
  const native = JSON.stringify(message);
  const bytes = Buffer.byteLength(native);
  expect(boundedJson(message, bytes)).toEqual({ text: native, bytes });
  expect(() => boundedJson(message, bytes - 1)).toThrow(JsonBudgetExceeded);
});

it('handles repeated objects, array holes and root toJSON with native JSON accounting', () => {
  const shared = { x: 1 };
  const array = new Array(3);
  array[1] = shared;
  const message = { toJSON: () => [shared, shared, array, {}, []] };
  const native = JSON.stringify(message);
  const bytes = Buffer.byteLength(native);
  expect(boundedJson(message, bytes)).toEqual({ text: native, bytes });
});

it('bounds escaped keys before encoding them and preserves native circular/BigInt errors', () => {
  const later = vi.fn(() => 'must not visit');
  const message = { ['界'.repeat(DEFERRED_BYTE_LIMIT)]: 1, get later() { return later(); } };
  expect(() => boundedJson(message, DEFERRED_BYTE_LIMIT)).toThrow(JsonBudgetExceeded);
  expect(later).not.toHaveBeenCalled();
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  expect(() => boundedJson(circular, DEFERRED_BYTE_LIMIT)).toThrow(TypeError);
  expect(() => boundedJson({ value: 1n }, DEFERRED_BYTE_LIMIT)).toThrow(TypeError);
});

const rawJson = JSON as typeof JSON & {
  rawJSON?: (text: string) => object;
  isRawJSON?: (value: unknown) => boolean;
};
const rawJsonAvailable = typeof rawJson.rawJSON === 'function' && typeof rawJson.isRawJSON === 'function';

it.skipIf(!rawJsonAvailable)('rejects raw UTF-8 text exceeding the remaining deferred budget before queuing or visiting later fields', () => {
  const c = connection();
  c.peer.send(large);
  const first = { text: 'x'.repeat(DEFERRED_BYTE_LIMIT / 2) };
  const firstBytes = Buffer.byteLength(JSON.stringify(first));
  c.peer.send(first);
  const rawText = `"${'界'.repeat(DEFERRED_BYTE_LIMIT / 4)}"`;
  // The literal fits the total limit but exceeds the *remaining* limit. Its
  // code-unit length still fits, so this specifically requires UTF-8 counting.
  expect(Buffer.byteLength(rawText)).toBeLessThan(DEFERRED_BYTE_LIMIT);
  expect(Buffer.byteLength(rawText)).toBeGreaterThan(DEFERRED_BYTE_LIMIT - firstBytes);
  expect(rawText.length).toBeLessThan(DEFERRED_BYTE_LIMIT - firstBytes);
  const later = vi.fn(() => 'must not visit');
  c.peer.send({ raw: rawJson.rawJSON!(rawText), get later() { return later(); } });
  expect(later).not.toHaveBeenCalled();
  expect(c.close).toHaveBeenCalledTimes(1);
  expect(c.diagnostics.mock.calls[0]![0]).toMatchObject({
    reason: 'deferred_byte_limit', deferredFrames: 1, deferredBytes: firstBytes,
  });
  expect(vi.getTimerCount()).toBe(0);
  c.complete(0);
  expect(c.writes).toHaveLength(1);
});

it.skipIf(!rawJsonAvailable)('preserves within-budget deferred raw literals without quoting or normalizing them', () => {
  const c = connection();
  c.peer.send(large);
  const message = {
    raw: rawJson.rawJSON!(`"${'界😀'.repeat(1024)}"`),
    number: rawJson.rawJSON!('123456789012345678901234567890'),
    hook: { toJSON: () => rawJson.rawJSON!('1.2300e+04') },
  };
  const native = JSON.stringify(message);
  c.peer.send(message);
  expect(c.writes).toHaveLength(1);
  expect(c.close).not.toHaveBeenCalled();
  c.complete(0);
  expect(c.writes).toHaveLength(2);
  expect(c.writes[1]!.text).toBe(native);
  expect(c.writes[1]!.bytes).toBe(Buffer.byteLength(native));
  c.complete(1);
  expect(vi.getTimerCount()).toBe(0);
  expect(c.diagnostics).not.toHaveBeenCalled();
});

it.skipIf(!rawJsonAvailable)('charges exact raw literal bytes at the boundary, including arrays, root toJSON and ordinary lookalikes', () => {
  const literal = rawJson.rawJSON!('"界😀\\n"');
  const messages = [
    { value: literal, array: [literal, rawJson.rawJSON!('true'), rawJson.rawJSON!('null')] },
    { toJSON: () => rawJson.rawJSON!('1.2300e+04') },
    { lookalike: { rawJSON: '"界"' } },
  ];
  for (const message of messages) {
    const native = JSON.stringify(message);
    const bytes = Buffer.byteLength(native);
    expect(boundedJson(message, bytes)).toEqual({ text: native, bytes });
    expect(() => boundedJson(message, bytes - 1)).toThrow(JsonBudgetExceeded);
  }
});
