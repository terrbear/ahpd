import { ProcessFixture as Process } from './fixtures/process.js';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { idleQuery } from '../src/idle.js';
import { processExit, stopQuery } from '../src/shutdown.js';

class Query {
  closed = false;
  initialized: () => Promise<unknown> = async () => ({});
  async *[Symbol.asyncIterator]() { await new Promise<void>(() => {}); }
  initializationResult() { return this.initialized(); }
  close() { this.closed = true; }
}

const settle = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

it('waits for actual process exit even after SDK disposal has resolved', async () => {
  const child = new Process();
  let done = false;
  const stop = stopQuery({ close: () => {}, [Symbol.asyncDispose]: async () => {} }, processExit(child)).then(() => { done = true; });
  await vi.advanceTimersByTimeAsync(1_999);
  expect(done).toBe(false);
  expect(child.signals).toEqual([]);
  child.exit();
  await stop;
  expect(done).toBe(true);
  expect(child.signals).toEqual([]);
});

it('escalates bounded shutdown and never treats a sent kill signal as an exit', async () => {
  const child = new Process();
  let done = false;
  const stop = processExit(child).stop().then(() => { done = true; });
  await vi.advanceTimersByTimeAsync(2_000);
  expect(child.signals).toEqual(['SIGTERM']);
  expect(child.killed).toBe(true);
  expect(done).toBe(false);
  await vi.advanceTimersByTimeAsync(2_000);
  expect(child.signals).toEqual(['SIGTERM', 'SIGKILL']);
  expect(done).toBe(false);
  child.exit();
  await stop;
  expect(done).toBe(true);
});

it('reports a process that ignores SIGKILL within six seconds', async () => {
  const child = new Process();
  const result = processExit(child).stop().catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(6_000);
  expect(await result).toEqual(expect.objectContaining({ message: expect.stringContaining('did not exit after SIGKILL') }));
});

it('does not confuse a kill error with a process exit', async () => {
  const child = new Process();
  let done = false;
  const stop = processExit(child).stop().then(() => { done = true; });
  child.emit('error', Object.assign(new Error('permission denied'), { syscall: 'kill', code: 'EPERM' }));
  await vi.advanceTimersByTimeAsync(4_000);
  expect(done).toBe(false);
  expect(child.signals).toEqual(['SIGTERM', 'SIGKILL']);
  child.exit();
  await stop;
});

it('bounds SDK cleanup even when the process has already exited', async () => {
  const child = new Process();
  child.exitCode = 0;
  const result = stopQuery({ close: () => {}, [Symbol.asyncDispose]: () => new Promise<void>(() => {}) }, processExit(child)).catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(8_000);
  expect(await result).toEqual(expect.objectContaining({ message: expect.stringContaining('cleanup did not finish') }));
  expect(child.signals).toEqual([]);
});

it('waits for shutdown before one shared replacement and ignores stale timer generations', async () => {
  let eligible = true;
  let release: (() => void) | undefined;
  const queries: Query[] = [];
  const idle = idleQuery({
    timeout: 100,
    eligible: () => eligible,
    create: () => {
      const query = new Query();
      queries.push(query);
      return { query, signal: new AbortController(), stop: async () => {
        query.close();
        if (queries.length === 1) await new Promise<void>((resolve) => { release = resolve; });
      } };
    },
  });
  idle.changed();
  await vi.advanceTimersByTimeAsync(99);
  idle.changed();
  await vi.advanceTimersByTimeAsync(1);
  expect(queries[0]!.closed).toBe(false);
  await vi.advanceTimersByTimeAsync(99);
  expect(queries[0]!.closed).toBe(true);
  eligible = false;
  const one = idle.ready();
  const two = idle.ready();
  await settle();
  expect(queries).toHaveLength(1);
  release!();
  await Promise.all([one, two]);
  expect(queries).toHaveLength(2);
  await idle.dispose();
});

it('refuses replacement when actual shutdown fails', async () => {
  let starts = 0;
  const idle = idleQuery({
    timeout: 100,
    eligible: () => true,
    create: () => {
      starts++;
      return { query: new Query(), signal: new AbortController(), stop: async () => { throw new Error('child still running'); } };
    },
  });
  idle.changed();
  await vi.advanceTimersByTimeAsync(100);
  await expect(idle.ready()).rejects.toThrow('replacement process was not started: child still running');
  expect(starts).toBe(1);
  await idle.dispose().catch(() => {});
});

it('bounds failed resume initialization and cleans the failed process without replay', async () => {
  const queries: Query[] = [];
  const idle = idleQuery({
    timeout: 100,
    eligible: () => true,
    create: () => {
      const query = new Query();
      if (queries.length > 0) query.initialized = () => new Promise<void>(() => {});
      queries.push(query);
      return { query, signal: new AbortController(), stop: async () => { query.close(); } };
    },
  });
  idle.changed();
  await vi.advanceTimersByTimeAsync(100);
  const resumed = idle.ready().catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(await resumed).toEqual(expect.objectContaining({ message: expect.stringContaining('initialization exceeded 30 seconds') }));
  expect(queries).toHaveLength(2);
  expect(queries[1]!.closed).toBe(true);
  await expect(idle.ready()).rejects.toThrow('could not resume');
  expect(queries).toHaveLength(2);
  await idle.dispose();
});

it('cannot create a replacement after disposal races a waiting resume', async () => {
  let release: (() => void) | undefined;
  let starts = 0;
  const idle = idleQuery({
    timeout: 100,
    eligible: () => true,
    create: () => {
      starts++;
      return { query: new Query(), signal: new AbortController(), stop: () => new Promise<void>((resolve) => { release = resolve; }) };
    },
  });
  idle.changed();
  await vi.advanceTimersByTimeAsync(100);
  const resumed = idle.ready().catch((error: unknown) => error);
  const closed = idle.dispose();
  release!();
  await closed;
  expect(await resumed).toEqual(expect.objectContaining({ message: expect.stringContaining('disposed') }));
  expect(starts).toBe(1);
});

it('cleans related resources and still kills the process if SDK close throws', async () => {
  const child = new Process();
  let resources = false;
  const result = stopQuery({ close: () => { throw new Error('close failed'); } }, processExit(child), async () => { resources = true; }).catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(4_000);
  expect(resources).toBe(true);
  expect(child.signals).toEqual(['SIGTERM', 'SIGKILL']);
  child.exit();
  expect(await result).toEqual(expect.objectContaining({ message: 'close failed' }));
});
