import { setImmediate } from 'node:timers/promises';
import { afterAll, afterEach, expect, it, vi } from 'vitest';
import { Deliveries } from '../src/delivery.js';
import type { Bag } from '../src/types/common.js';
import type { MessageFrom, Session } from '../src/types/session.js';

afterEach(() => vi.useRealTimers());
const execution = { topLevelOperations: 0, sendAttempts: 0, backendCalls: 0, operations: {} as Record<string, number> };

function model(ledger: Deliveries) {
  let active: Bag | undefined = { id: 'busy' };
  const queue: Bag[] = [];
  const turns: Bag[] = [];
  const callbacks: Array<() => void> = [];
  const delivered: string[] = [];
  let calls = 0;
  let mode = 0;
  let holding = false;
  const emit = (action: Bag) => {
    const callback = () => Reflect.apply(ledger.observe, ledger, [target.chat, action, target.session]);
    if (mode === 0) callback();
    else if (mode === 1) callbacks.push(callback);
  };
  const session = {
    chatState: () => ({ activeTurn: active, queuedMessages: queue }),
    allTurns: () => turns,
    queue: (id: string, text: string, _model: unknown, from: MessageFrom) => {
      calls++; execution.backendCalls++;
      const entry = { id, message: { text, ...from } };
      const index = queue.findIndex((one) => one.id === id);
      if (index < 0) queue.push(entry); else queue[index] = entry;
      emit({ type: 'chat/pendingMessageSet', kind: 'queued', ...entry });
    },
    begin: (id: string, text: string, _model: unknown, from: MessageFrom) => {
      calls++; execution.backendCalls++;
      active = { id, message: { text, ...from } };
      delivered.push(text);
      emit({ type: 'chat/turnStarted', turnId: id });
    },
    cancel: (id: string) => { calls++; execution.backendCalls++; if (active?.id === id) end('cancelled'); },
  };
  const target = { resource: 'codex:/target', chat: 'ahp-chat:/target', session: session as unknown as Session };
  const source = { session: 'codex:/coordinator', chat: 'ahp-chat:/coordinator' };
  const from = { origin: { kind: 'agent' as const } };
  const end = (state: string) => {
    if (active === undefined || holding) return;
    const turn = active;
    turns.push({ ...turn, state });
    active = undefined;
    emit({ type: state === 'cancelled' ? 'chat/turnCancelled' : 'chat/turnComplete', turnId: turn.id });
  };
  const consume = () => {
    if (active !== undefined || holding) return;
    const entry = queue.shift();
    if (entry === undefined) return;
    const text = String((entry.message as Bag).text);
    delivered.push(text);
    active = { id: `turn-${delivered.length}`, queuedMessageId: entry.id, message: entry.message };
    emit({ type: 'chat/turnStarted', turnId: active.id, queuedMessageId: entry.id, message: entry.message });
  };
  return { target, source, from, queue, turns, callbacks, delivered, end, consume,
    active: () => active, calls: () => calls, setMode: (next: number) => { mode = next; },
    hold: (next: boolean) => { holding = next; },
    send: (text: string, supersedes?: string) => ledger.send(target, source, text, from, supersedes) };
}

it('seed 0x32240001: ignores an old owner terminal after same-URI recreation and a new stop', async () => {
  vi.useFakeTimers();
  const ledger = new Deliveries();
  const old = model(ledger);
  ledger.forget(old.target.resource);
  const current = model(ledger);
  current.hold(true);
  const outcome = ledger.interrupt(current.target, 'busy');
  Reflect.apply(ledger.observe, ledger, [current.target.chat, { type: 'chat/turnCancelled', turnId: 'busy' }, old.target.session]);
  await vi.advanceTimersByTimeAsync(5000);
  expect(await outcome).toMatchObject({ state: 'unconfirmed' });
  expect(vi.getTimerCount()).toBe(0);
});

function random(seed: number) {
  let value = seed >>> 0;
  return () => { value ^= value << 13; value ^= value >>> 17; value ^= value << 5; return value >>> 0; };
}

const operations = ['send', 'supersede', 'foreign', 'complete', 'consume', 'remove', 'edit', 'duplicate',
  'reorder', 'unverifiable', 'missing', 'reconnect', 'recreate', 'interrupt', 'permission', 'elicitation', 'release', 'capacity', 'evict', 'close'];

async function sequence(seed: number, count: number) {
  const rng = random(seed);
  let ledger = new Deliveries();
  let world = model(ledger);
  const receipts: Bag[] = [];
  const instructions = new Map<string, string>();
  const outcomes: Array<Promise<Bag>> = [];
  const trace: string[] = [];
  let message = 0;
  const attempt = (run: () => Bag, text: string) => {
    const before = world.calls();
    try { const receipt = run(); receipts.push(receipt); instructions.set(String(receipt.deliveryId), text); }
    catch (error) {
      expect(String(error)).toMatch(/256 tracked pending deliveries|not your confirmed pending message/);
      expect(world.calls()).toBe(before);
    }
  };
  const send = () => { execution.sendAttempts++; const text = `instruction-${++message}`; attempt(() => world.send(text), text); };
  for (let index = 0; index < count; index++) {
    const operation = operations[rng() % operations.length]!;
    trace.push(operation);
    execution.topLevelOperations++;
    execution.operations[operation] = (execution.operations[operation] ?? 0) + 1;
    try {
      const before = world.calls();
      if (operation === 'send') send();
      else if (operation === 'supersede') {
        const receipt = receipts[rng() % Math.max(1, receipts.length)];
        const text = `replacement-${++message}`;
        attempt(() => world.send(text, String(receipt?.deliveryId ?? 'unknown')), text);
      } else if (operation === 'foreign') {
        const receipt = receipts[rng() % Math.max(1, receipts.length)];
        expect(() => ledger.send(world.target, { ...world.source, chat: 'foreign' }, 'foreign-write', world.from,
          String(receipt?.deliveryId ?? 'unknown'))).toThrow();
        expect(world.calls()).toBe(before);
      } else if (operation === 'complete') world.end('complete');
      else if (operation === 'consume') world.consume();
      else if (operation === 'remove') {
        const entry = world.queue.shift();
        if (entry !== undefined) ledger.observe(world.target.chat, { type: 'chat/pendingMessageRemoved', kind: 'queued', id: entry.id });
      } else if (operation === 'edit') {
        const entry = world.queue[0];
        if (entry !== undefined) {
          entry.message = { text: `external-${++message}`, origin: { kind: 'user' } };
          ledger.observe(world.target.chat, { type: 'chat/pendingMessageSet', kind: 'queued', ...entry });
        }
      } else if (operation === 'duplicate') {
        world.callbacks[0]?.(); world.callbacks[0]?.();
      } else if (operation === 'reorder') {
        world.callbacks.reverse();
        for (const callback of world.callbacks.splice(0)) callback();
      } else if (operation === 'unverifiable') {
        const entry = world.queue[0];
        if (entry !== undefined) ledger.observe(world.target.chat, { type: 'chat/turnStarted',
          turnId: `unverified-${index}`, queuedMessageId: entry.id }, world.target.session);
      } else if (operation === 'missing') world.setMode(rng() % 3);
      else if (operation === 'reconnect') ledger.context(world.target);
      else if (operation === 'recreate') {
        ledger.forget(world.target.resource);
        const previous = world;
        world = model(ledger);
        for (const callback of previous.callbacks) callback();
      } else if (operation === 'interrupt' && world.active() !== undefined) {
        try { outcomes.push(ledger.interrupt(world.target, String(world.active()?.id))); }
        catch (error) { expect(String(error)).toContain('already pending'); expect(world.calls()).toBe(before); }
      } else if (operation === 'permission' || operation === 'elicitation') world.hold(true);
      else if (operation === 'release') world.hold(false);
      else if (operation === 'capacity') for (let n = 0; n < 260; n++) send();
      else if (operation === 'evict') {
        world.hold(false);
        for (let n = 0; n < 130; n++) { world.end('complete'); if (world.queue.length === 0) send(); else world.consume(); }
      } else if (operation === 'close') {
        ledger.close();
        for (const callback of world.callbacks) callback();
        expect(vi.getTimerCount()).toBe(0);
        ledger = new Deliveries();
        world = model(ledger);
      }
      const context = ledger.context(world.target);
      expect((context.deliveries as Bag[]).length).toBeLessThanOrEqual(384);
      expect(new Set(world.delivered).size).toBe(world.delivered.length);
      expect(world.delivered).not.toContain('foreign-write');
      for (const receipt of context.deliveries as Bag[]) {
        expect(receipt).toMatchObject({ resource: world.target.resource, chat: world.target.chat, source: world.source });
        if (receipt.state === 'consumed') {
          expect(receipt.turnId).toEqual(expect.any(String));
          const turn = [...world.turns, world.active()].find((one) => one?.id === receipt.turnId);
          expect((turn?.message as Bag)?.text).toBe(instructions.get(String(receipt.deliveryId)));
        }
      }
    } catch (error) {
      throw new Error(`seed=0x${seed.toString(16)} prefix=${JSON.stringify(trace)}: ${String(error)}`, { cause: error });
    }
  }
  ledger.close();
  await Promise.all(outcomes);
  expect(vi.getTimerCount()).toBe(0);
}

const start = Number(process.env.AHP_DELIVERY_FUZZ_START ?? 0x32241000);
const count = Number(process.env.AHP_DELIVERY_FUZZ_COUNT ?? 64);
const steps = Number(process.env.AHP_DELIVERY_FUZZ_STEPS ?? 100);
if (![start, count, steps].every(Number.isSafeInteger) || start < 1 || start > 0xffffffff
  || count < 1 || count > 10000 || steps < 1 || steps > 1000 || start + count > 0x100000000) {
  throw new Error('Invalid delivery fuzz seed range or operation count');
}

it.each(Array.from({ length: count }, (_, index) => start + index))('seed %i operation sequences preserve bounded delivery and ownership invariants', async (seed) => {
  vi.useFakeTimers();
  await sequence(seed, steps);
  await setImmediate();
});

afterAll(() => {
  console.info(JSON.stringify({ prng: 'xorshift32', start, count, steps, ...execution }));
});
