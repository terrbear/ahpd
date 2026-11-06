import type { Bag } from '@ahpd/sdk';

export interface SteeringReceipt {
  id: string;
  turnId: string;
  message: { text: string; origin: { kind: 'user' } };
  createdAt: string;
  status: 'pending' | 'injected' | 'inactive' | 'unknown';
}

export function humanSteering(options: {
  initial?: SteeringReceipt[] | undefined;
  persist: (receipts: SteeringReceipt[]) => void;
  inject: (text: string) => Promise<{ outcome: string }>;
  emit: (action: Bag) => void;
  settled: () => void;
}) {
  const receipts = structuredClone(options.initial ?? []);
  for (const receipt of receipts) if (receipt.status === 'pending') receipt.status = 'unknown';
  let pending: SteeringReceipt | undefined;
  const save = () => options.persist(structuredClone(receipts));
  return {
    busy: () => pending?.status === 'pending',
    metadata: () => ({ version: 1, receipts: structuredClone(receipts) }),
    pending: () => pending === undefined ? undefined : { id: pending.id, message: pending.message },
    steer: (id: string, text: string, turnId: string): boolean => {
      if (id === '' || id.length > 256 || text.trim() === '' || Buffer.byteLength(text) > 128 * 1024) return false;
      const previous = receipts.find((one) => one.id === id);
      if (previous !== undefined) return previous.message.text === text && previous.turnId === turnId;
      if (pending !== undefined) return false;
      while (receipts.length >= 256 || Buffer.byteLength(JSON.stringify(receipts)) + Buffer.byteLength(text) > 512 * 1024) {
        const at = receipts.findIndex((one) => one.status === 'injected' || one.status === 'inactive');
        if (at < 0) return false;
        receipts.splice(at, 1);
      }
      const receipt: SteeringReceipt = { id, turnId, message: { text, origin: { kind: 'user' } }, createdAt: new Date().toISOString(), status: 'pending' };
      receipts.push(receipt);
      try { save(); } catch { receipts.pop(); return false; }
      pending = receipt;
      options.emit({ type: 'chat/pendingMessageSet', kind: 'steering', id, message: receipt.message });
      void (async () => {
        try {
          const result = await options.inject(text);
          if (result.outcome === 'injected' || result.outcome === 'inactive') receipt.status = result.outcome;
          else receipt.status = 'unknown';
        } catch { receipt.status = 'unknown'; }
        try { save(); } catch { receipt.status = 'unknown'; }
        if (receipt.status === 'injected' || receipt.status === 'inactive') {
          pending = undefined;
          options.emit({ type: 'chat/pendingMessageRemoved', kind: 'steering', id });
        }
        options.settled();
      })();
      return true;
    },
  };
}
