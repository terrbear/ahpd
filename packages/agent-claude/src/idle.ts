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
  eligible: () => boolean;
  create: (generation: number) => IdleRuntime<Q>;
  prepare?: (query: Q, generation: number) => Promise<void>;
  completed?: (key: PropertyKey, args: unknown[]) => void;
}) {
  let generation = 0;
  let runtime: IdleRuntime<Q> | undefined = options.create(generation);
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
  const changed = () => {
    invalidate();
    if (closed || failure || stopping || !runtime || leases > 0 || options.timeout === 0 || !options.eligible()) return;
    const ticket = timerGeneration;
    timer = setTimeout(() => {
      if (ticket !== timerGeneration || closed || leases > 0 || !runtime || !options.eligible()) return;
      const held = runtime;
      held.signal.abort();
      stopping = held.stop().then(() => {
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
      runtime = options.create(++generation);
      initializing = undefined;
      notify();
    }
    const held = runtime;
    initializing ??= new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Claude initialization exceeded 30 seconds')), 30_000);
      timer.unref?.();
      void held.query.initializationResult().then(async () => {
        if (closed || held.signal.signal.aborted) throw new Error('The Claude query was disposed during initialization');
        await options.prepare?.(held.query, generation);
      }).then(resolve, reject).finally(() => clearTimeout(timer));
    });
    try { await initializing; }
    catch (error: unknown) {
      failure = new Error(`Claude session could not resume: ${error instanceof Error ? error.message : String(error)}`);
      held.signal.abort();
      stopping ??= held.stop().then(() => { if (runtime === held) runtime = undefined; }).catch((error: unknown) => {
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
    if (stopping) await stopping;
    const held = runtime;
    if (!held) return;
    held.signal.abort();
    await held.stop();
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
          return Promise.resolve(method.apply(query, args)).then((result) => {
            options.completed?.(key, args);
            return result;
          });
        };
        let operation: Promise<unknown>;
        try {
          operation = runtime && !stopping && !closed && !failure ? invoke(runtime.query) : ensure().then(invoke);
        } catch (error: unknown) { operation = Promise.reject(error); }
        return operation.finally(() => { leases--; changed(); });
      };
    },
  });
  return { handle, ready, changed, dispose, generation: () => generation };
}
