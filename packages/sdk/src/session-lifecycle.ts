import type { SessionLease, SessionLifecycle, SessionWork } from './types/host.js';
import type { WriterExitProof } from './types/session.js';

type Held = {
  pending: Promise<SessionLease>;
  started: boolean;
  disposed: boolean;
  notified: boolean;
  closing?: Promise<void>;
  notifying?: Promise<void>;
};

export const validWriterExitProof = (proof: WriterExitProof | undefined): proof is WriterExitProof => proof?.kind === 'isolated-process-scope-empty'
  && typeof proof.scope === 'string' && proof.scope.trim() !== '';

export function sessionLifetimes(lifecycle: SessionLifecycle | undefined) {
  const leases = new Map<string, Held>();
  const release = async (chatUri: string, held: Held, proof: WriterExitProof | { kind: 'never-started' }): Promise<void> => {
    held.closing ??= (async () => {
      await (await held.pending).release(proof);
      if (leases.get(chatUri) === held) leases.delete(chatUri);
    })().finally(() => { delete held.closing; });
    await held.closing;
  };
  return {
    async acquire(context: Parameters<SessionLifecycle['acquire']>[0]): Promise<SessionLease | undefined> {
      if (lifecycle === undefined) return undefined;
      let held = leases.get(context.chatUri);
      if (held?.disposed || held?.closing) throw new Error(`${context.chatUri} is disposed and awaiting its owner task fence`);
      if (held === undefined) {
        const pending = lifecycle.acquire(context);
        held = { pending, started: false, disposed: false, notified: false };
        leases.set(context.chatUri, held);
        const acquiring = held;
        void pending.catch(() => { if (leases.get(context.chatUri) === acquiring) leases.delete(context.chatUri); });
      }
      return held.pending;
    },
    async beginWork(chatUri: string, work: SessionWork): Promise<(() => Promise<void>) | undefined> {
      if (lifecycle === undefined) return undefined;
      const held = leases.get(chatUri);
      if (held === undefined || held.disposed || held.closing) throw new Error(`${chatUri} cannot admit work`);
      const lease = await held.pending;
      if (held.disposed || held.closing) throw new Error(`${chatUri} cannot admit work`);
      return lease.beginWork?.(work);
    },
    started(chatUri: string): void {
      const held = leases.get(chatUri);
      if (held !== undefined) held.started = true;
    },
    async cancelUnstarted(chatUri: string): Promise<void> {
      const held = leases.get(chatUri);
      if (held === undefined || held.started) return;
      held.disposed = true;
      await release(chatUri, held, { kind: 'never-started' });
    },
    async dispose(chatUri: string, proof?: WriterExitProof): Promise<void> {
      const held = leases.get(chatUri);
      if (held === undefined) return;
      held.disposed = true;
      if (validWriterExitProof(proof)) {
        await release(chatUri, held, proof);
        return;
      }
      if (held.notified) return;
      held.notifying ??= (async () => {
        await (await held.pending).disposed?.();
        held.notified = true;
      })().finally(() => { delete held.notifying; });
      await held.notifying;
    },
  };
}
