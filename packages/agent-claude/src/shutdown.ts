import { spawn } from 'node:child_process';
import type { Asked, Spawned } from './spawn.js';
import { spawnFailure } from './spawn.js';

export function spawnLocal(asked: Asked): Spawned {
  const child = spawn(asked.command, asked.args, {
    cwd: asked.cwd,
    env: asked.env,
    stdio: ['pipe', 'pipe', 'inherit'],
    windowsHide: true,
  });
  return child as Spawned;
}

export function processExit(child: Spawned) {
  let exited = child.exitCode !== null || child.exited === true;
  let failed: Error | undefined;
  const waiters = new Set<() => void>();
  const finish = () => { exited = true; for (const done of waiters) done(); waiters.clear(); };
  child.once('exit', finish);
  child.on('error', (error) => { failed = error; if (child.exited === true || spawnFailure(error)) finish(); });
  const wait = async (timeout: number): Promise<boolean> => {
    if (exited) return true;
    return await new Promise<boolean>((resolve) => {
      const done = () => { clearTimeout(timer); waiters.delete(done); resolve(exited); };
      const timer = setTimeout(done, timeout);
      waiters.add(done);
    });
  };
  return {
    stop: async () => {
      if (await wait(2_000)) return;
      try { child.kill('SIGTERM'); } catch (error: unknown) { failed = error instanceof Error ? error : new Error(String(error)); }
      if (await wait(2_000)) return;
      try { child.kill('SIGKILL'); } catch (error: unknown) { failed = error instanceof Error ? error : new Error(String(error)); }
      if (await wait(2_000)) return;
      throw new Error(`Claude process did not exit after SIGKILL${failed ? `: ${failed.message}` : ''}`);
    },
  };
}

function attempt(run: () => void | Promise<void>): Promise<void> {
  try { return Promise.resolve(run()); }
  catch (error: unknown) { return Promise.reject(error); }
}

function bounded(cleanup: Promise<void>): Promise<void> {
  return Promise.race([
    cleanup,
    new Promise<void>((_resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Claude runtime cleanup did not finish within 8 seconds')), 8_000);
      timer.unref?.();
      void cleanup.finally(() => clearTimeout(timer)).catch(() => {});
    }),
  ]);
}

export async function stopQuery(
  query: { close: () => void; [Symbol.asyncDispose]?: () => Promise<void> },
  process: ReturnType<typeof processExit> | undefined,
  resources: () => Promise<void> = async () => {},
): Promise<void> {
  const disposed = attempt(() => { query.close(); return query[Symbol.asyncDispose]?.(); });
  const results = await Promise.allSettled([bounded(disposed), process?.stop(), bounded(attempt(resources))]);
  for (const result of results) if (result.status === 'rejected') throw result.reason;
}
