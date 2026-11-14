import type { SessionLease, SessionLifecycle } from './types/host.js';

export function sessionLifetimes(lifecycle: SessionLifecycle | undefined) {
  const releasing = new Map<string, Promise<void>>();
  const leases = new Map<string, Promise<SessionLease>>();
  return {
    async acquire(context: Parameters<SessionLifecycle['acquire']>[0]): Promise<SessionLease | undefined> {
      if (lifecycle === undefined) return undefined;
      if (releasing.has(context.chatUri)) throw new Error(`${context.chatUri} is being disposed`);
      let pending = leases.get(context.chatUri);
      if (pending === undefined) {
        pending = lifecycle.acquire(context);
        leases.set(context.chatUri, pending);
        const held = pending;
        void pending.catch(() => { if (leases.get(context.chatUri) === held) leases.delete(context.chatUri); });
      }
      return pending;
    },
    async release(chatUri: string): Promise<void> {
      const pending = leases.get(chatUri);
      if (pending === undefined) return;
      let closing = releasing.get(chatUri);
      if (closing === undefined) {
        closing = (async () => {
          await (await pending).release();
          if (leases.get(chatUri) === pending) leases.delete(chatUri);
        })().finally(() => { releasing.delete(chatUri); });
        releasing.set(chatUri, closing);
      }
      await closing;
    },
  };
}
