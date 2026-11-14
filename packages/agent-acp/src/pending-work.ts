import type { Start } from '@ahpd/sdk';

export function pendingWork(beginWork?: Start['beginWork']) {
  const entries = new Map<string, { pending: Promise<void>; finish?: () => Promise<void> }>();
  return {
    track(id: string): void {
      if (beginWork === undefined || entries.has(id)) return;
      const held: { pending: Promise<void>; finish?: () => Promise<void> } = { pending: Promise.resolve() };
      entries.set(id, held);
      held.pending = beginWork({ kind: 'async-input', operationId: crypto.randomUUID() }).then((finish) => { held.finish = finish; });
      void held.pending.catch(() => {});
    },
    check(id: string): void {
      if (beginWork !== undefined && entries.get(id)?.finish === undefined) throw new Error('Question work admission is not complete');
    },
    complete(id: string): void {
      const held = entries.get(id);
      if (held?.finish === undefined) return;
      void held.finish().then(() => { entries.delete(id); }, () => {});
    },
    async ready(): Promise<void> {
      await Promise.all([...entries.values()].map((held) => held.pending));
    },
  };
}
