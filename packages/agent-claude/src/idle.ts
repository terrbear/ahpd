import { StartupTimeout, withDeadline, initializeQuery } from './deadline.js';

export interface IdleRuntime<Q> {
  query: Q;
  signal: AbortController;
  stop: () => Promise<void>;
}

interface ManagedQuery extends AsyncIterable<unknown> {
  close: () => void;
  initializationResult: () => Promise<unknown>;
}

export function idleQuery<Q extends ManagedQuery>(options: {
  timeout: number;
  admitResume?: () => () => void;
  eligible: () => boolean;
  beforeCreate?: () => Promise<void>;
  replacementAllowed?: boolean;
  create: (generation: number) => IdleRuntime<Q>;
  prepare?: (query: Q, generation: number) => Promise<void>;
  completed?: (key: PropertyKey, args: unknown[]) => void;
  context?: () => { turn_id?: string };
  timing?: (stage: string, outcome: string, metadata?: { timeout_ms: number; duration_ms: number; turn_id?: string }) => void;
}) {
  const timing = (stage: string, outcome: string, metadata?: { timeout_ms: number; duration_ms: number; turn_id?: string }): void => {
    try { options.timing?.(stage, outcome, metadata); } catch {}
  };
  let generation = 0;
  let runtime: IdleRuntime<Q> | undefined = options.beforeCreate === undefined ? options.create(generation) : undefined;
  let creating: Promise<void> | undefined;
  let everCreated = runtime !== undefined;
  let stopping: Promise<void> | undefined;
  let initializing: Promise<void> | undefined;
  let failure: Error | undefined;
  let closed = false;
  let closing: Promise<void> | undefined;
  let leases = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timerGeneration = 0;
  const waiters = new Set<() => void>();
  const notify = () => { for (const resolve of waiters) resolve(); waiters.clear(); };
  const invalidate = () => {
    timerGeneration++;
    clearTimeout(timer);
    timer = undefined;
  };
  const stop = async (held: IdleRuntime<Q>): Promise<void> => {
    const started = Date.now();
    try { await withDeadline('runtime_shutdown', held.stop, 10_000); }
    catch (error: unknown) {
      if (error instanceof StartupTimeout) {
        timing(error.stage, 'timeout', { timeout_ms: error.timeoutMs, duration_ms: Date.now() - started });
      }
      throw error;
    }
  };
  const recycle = (held: IdleRuntime<Q>): Promise<void> => {
    if (stopping) return stopping;
    if (closed || runtime !== held) return Promise.resolve();
    invalidate();
    held.signal.abort();
    timing('timeout_recovery', 'start');
    stopping = stop(held).then(() => {
      if (runtime === held) runtime = undefined;
      initializing = undefined;
      if (options.replacementAllowed === false) failure = new Error('Claude runtime replacement requires writer containment; fence the owner task first');
      timing('timeout_recovery', 'ok');
    }).catch((error: unknown) => {
      failure = new Error(`Claude startup timeout recovery failed; a replacement process was not started: ${error instanceof Error ? error.message : String(error)}`);
      timing('timeout_recovery', error instanceof StartupTimeout ? 'timeout' : 'error');
    }).finally(() => { stopping = undefined; notify(); });
    return stopping;
  };
  const changed = () => {
    invalidate();
    if (closed || failure || stopping || !runtime || leases > 0 || options.timeout === 0 || !options.eligible()) return;
    const ticket = timerGeneration;
    timer = setTimeout(() => {
      if (ticket !== timerGeneration || closed || leases > 0 || !runtime || !options.eligible()) return;
      const held = runtime;
      held.signal.abort();
      stopping = stop(held).then(() => {
        if (runtime === held) runtime = undefined;
        initializing = undefined;
      }).catch((error: unknown) => {
        failure = new Error(`Claude idle shutdown failed; a replacement process was not started: ${error instanceof Error ? error.message : String(error)}`);
      }).finally(() => { stopping = undefined; notify(); });
      void stopping;
    }, options.timeout);
    timer.unref?.();
  };
  const ensure = async (): Promise<Q> => {
    invalidate();
    if (closed) throw new Error('The Claude session was disposed');
    await stopping;
    if (closed) throw new Error('The Claude session was disposed');
    if (failure) throw failure;
    if (!runtime) {
      if (everCreated && options.replacementAllowed === false) throw new Error('Claude runtime replacement requires writer containment; fence the owner task first');
      creating ??= (async () => {
        await options.beforeCreate?.();
        if (closed) throw new Error('The Claude session was disposed');
        const cancel = everCreated ? options.admitResume?.() : undefined;
        try {
          const next = everCreated ? generation + 1 : generation;
          runtime = options.create(next);
          generation = next;
          everCreated = true;
        } catch (error) {
          cancel?.();
          throw error;
        }
        initializing = undefined;
        notify();
      })().finally(() => { creating = undefined; });
      await creating;
    }
    const held = runtime!;
    initializing ??= initializeQuery(
      () => held.query.initializationResult(),
      async () => {
        if (closed || held.signal.signal.aborted) throw new Error('The Claude query was disposed during initialization');
        await options.prepare?.(held.query, generation);
      },
      timing,
    );
    try { await initializing; }
    catch (error: unknown) {
      failure = new Error(`Claude session could not resume: ${error instanceof Error ? error.message : String(error)}`);
      held.signal.abort();
      stopping ??= stop(held).then(() => { if (runtime === held) runtime = undefined; }).catch((error: unknown) => {
        failure = new Error(`${failure!.message}; shutdown also failed: ${error instanceof Error ? error.message : String(error)}`);
      }).finally(() => { stopping = undefined; notify(); });
      await stopping;
      throw failure;
    }
    if (closed) throw new Error('The Claude session was disposed');
    return held.query;
  };
  const ready = async () => {
    leases++;
    try { await ensure(); }
    finally { leases--; changed(); }
  };
  const close = async () => {
    closed = true;
    invalidate();
    notify();
    if (creating) await creating.catch(() => undefined);
    if (stopping) await stopping;
    const held = runtime;
    if (!held) return;
    held.signal.abort();
    await stop(held);
    runtime = undefined;
    notify();
  };
  const dispose = () => { closing ??= close(); return closing; };
  async function* stream() {
    while (!closed) {
      const held = runtime;
      if (!held) {
        if (failure) throw failure;
        await new Promise<void>((resolve) => { waiters.add(resolve); });
        continue;
      }
      try {
        for await (const raw of held.query) {
          if (held.signal.signal.aborted) break;
          yield raw;
          changed();
        }
      } catch (error: unknown) {
        if (!held.signal.signal.aborted) throw error;
      }
      if (!held.signal.signal.aborted) return;
      await stopping;
      if (failure) throw failure;
      if (runtime === held && !closed) await new Promise<void>((resolve) => { waiters.add(resolve); });
    }
  }
  const handle = new Proxy({} as Q, {
    get: (_target, key) => {
      if (key === Symbol.asyncIterator) return stream;
      if (key === Symbol.asyncDispose) return dispose;
      if (key === 'close') return () => { void dispose().catch(() => {}); };
      if ((key === 'interrupt' || key === 'stopTask') && (!runtime || stopping)) return async () => {};
      return (...args: unknown[]) => {
        leases++;
        invalidate();
        const invoke = (query: Q) => {
          const method = Reflect.get(query, key) as (...given: unknown[]) => unknown;
          const held = runtime;
          let stage: string | undefined;
          if (key === 'setModel') stage = 'model_selection';
          if (key === 'applyFlagSettings') stage = 'effort_application';
          const started = Date.now();
          const context = options.context?.();
          const run = () => Promise.resolve(method.apply(query, args));
          const operation = stage === undefined ? run() : withDeadline(stage, run);
          return operation.catch(async (error: unknown) => {
            if (error instanceof StartupTimeout && held !== undefined) {
              timing(error.stage, 'timeout', { timeout_ms: error.timeoutMs, duration_ms: Date.now() - started, ...context });
              await recycle(held);
              if (failure) throw failure;
            }
            throw error;
          }).then((result) => {
            options.completed?.(key, args);
            return result;
          });
        };
        let operation: Promise<unknown>;
        try {
          operation = key !== 'initializationResult' && runtime && !stopping && !closed && !failure ? invoke(runtime.query) : ensure().then(invoke);
        } catch (error: unknown) { operation = Promise.reject(error); }
        return operation.finally(() => { leases--; changed(); });
      };
    },
  });
  return { handle, ready, changed, dispose, generation: () => generation };
}
