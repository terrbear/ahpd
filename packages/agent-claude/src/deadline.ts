export class StartupTimeout extends Error {
  readonly stage: string;
  readonly timeoutMs: number;

  constructor(stage: string, timeoutMs: number) {
    super(`Claude startup stage ${stage} exceeded ${timeoutMs / 1000} seconds`);
    this.stage = stage;
    this.timeoutMs = timeoutMs;
  }
}

export async function withDeadline<T>(stage: string, run: () => Promise<T>, timeoutMs = 30_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new StartupTimeout(stage, timeoutMs)), timeoutMs);
        timer.unref?.();
      }),
      run(),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function initializeQuery(
  initialize: () => Promise<unknown>,
  prepare: () => Promise<void>,
  timing: (stage: string, outcome: string, metadata?: { timeout_ms: number; duration_ms: number }) => void,
): Promise<void> {
  for (const [stage, run] of [['initialization', initialize], ['prepare', prepare]] as const) {
    const started = Date.now();
    timing(stage, 'start');
    try {
      await withDeadline(stage, run);
      timing(stage, 'ok');
    } catch (error: unknown) {
      if (error instanceof StartupTimeout) {
        timing(stage, 'timeout', { timeout_ms: error.timeoutMs, duration_ms: Date.now() - started });
      } else {
        timing(stage, 'error');
      }
      throw error;
    }
  }
}
