import { connectAcp } from './connection.js';
import type { AcpOptions } from './types.js';

export async function readExternalHistory(options: AcpOptions, provider: string, id: string, signal?: AbortSignal): Promise<{ format: 'codex-thread'; history: Record<string, unknown> } | undefined> {
  if (signal?.aborted || provider !== 'codex' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id)) return undefined;
  const connection = connectAcp({
    command: options.command,
    ...(options.args === undefined ? {} : { args: options.args }),
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    handlers: { update: () => {} },
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let aborted = () => {};
  let stopped = false;
  try {
    const read = async () => {
      const init = await connection.initialize();
      if (stopped || signal?.aborted) return undefined;
      const capability = init.agentCapabilities?._meta?.readOnlyHistory as { version?: unknown } | undefined;
      if (capability?.version !== 1) return undefined;
      const result = await connection.readHistory(id);
      const thread = result.thread as Record<string, unknown> | undefined;
      if (result.version !== 1 || result.format !== 'codex-thread' || result.writable !== false || thread?.id !== id || !Array.isArray(thread.turns) || thread.turns.length === 0) return undefined;
      return { format: 'codex-thread' as const, history: thread };
    };
    return await Promise.race([
      read(),
      new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), 10000); timer.unref(); }),
      new Promise<undefined>(resolve => {
        aborted = () => resolve(undefined);
        signal?.addEventListener('abort', aborted, { once: true });
        if (signal?.aborted) aborted();
      }),
    ]);
  } catch {
    return undefined;
  } finally {
    stopped = true;
    clearTimeout(timer);
    signal?.removeEventListener('abort', aborted);
    await connection.close();
    await connection.ended;
  }
}
