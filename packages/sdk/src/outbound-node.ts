import { boundedJson, JsonBudgetExceeded, utf8Bytes } from './bounded-json.js';
import type { OutboundClose, OutboundCloseReason, Wire } from './types/rpc.js';

export const DEFERRED_BYTE_LIMIT = 256 * 1024;
export const DEFERRED_FRAME_LIMIT = 32;
export const OUTSTANDING_FRAME_LIMIT = 256;
export const DRAIN_GRACE_MS = 5000;
export const DRAIN_CHECK_MS = 10;

/** Only the Node listener supplies both completion and backlog capabilities. */
export function createNodeOutbound(wire: Wire, closePeer: () => void, highWater: number): {
  send(message: Record<string, unknown>, question?: number): void;
  cancel(question: number): void;
  close(): void;
} {
  const queue: Array<{ text: string; bytes: number; question: number | undefined }> = [];
  let deferredBytes = 0;
  let outstanding = 0;
  let oversizedBytes: number | null = null;
  let oversizedPending = false;
  let started: number | undefined;
  let check: ReturnType<typeof setInterval> | undefined;
  let stopped = false;
  let serializing = false;
  let pumping = false;

  const finishGrace = (): void => {
    if (check !== undefined) clearInterval(check);
    check = undefined;
    started = undefined;
    oversizedBytes = null;
    oversizedPending = false;
  };
  const overload = (reason: OutboundCloseReason): void => {
    if (stopped) return;
    const diagnostic: OutboundClose = {
      event: 'outbound_close', runtime: 'node', reason,
      bufferedBytes: wire.bufferedBytes!(), deferredBytes,
      deferredFrames: queue.length, outstandingWrites: outstanding,
      oversizedFrameBytes: oversizedBytes,
      drainElapsedMs: started === undefined ? 0 : Math.max(0, Math.floor(performance.now() - started)),
    };
    // Closing releases strings and timers before any user diagnostic callback.
    try { closePeer(); }
    finally { try { wire.onOutboundClose?.(diagnostic); } catch {} }
  };
  const expired = (): boolean => {
    if (started !== undefined && performance.now() - started >= DRAIN_GRACE_MS) {
      overload('drain_timeout');
      return true;
    }
    return false;
  };
  const write = (text: string, oversized: boolean): void => {
    outstanding++;
    let settled = false;
    const done = (error?: Error): void => {
      if (settled || stopped) return;
      settled = true;
      outstanding--;
      if (error) { overload('write_error'); return; }
      if (oversized) oversizedPending = false;
      pump();
    };
    try { wire.sendCompleted!(text, done); }
    catch { done(new Error()); }
  };
  const pump = (): void => {
    if (stopped || pumping || serializing || started === undefined) return;
    if (!wire.isOpen()) { closePeer(); return; }
    // Observe real backlog even before completion; grace does not conceal the
    // oversized frame's high-water excursion from the transport or its tests.
    const buffered = wire.bufferedBytes!();
    if (expired() || oversizedPending || outstanding !== 0 || buffered !== 0) return;
    pumping = true;
    try {
      // The entire FIFO is <=256 KiB. No new oversized frame can enter here.
      while (!stopped && queue.length > 0) {
        if (expired()) return;
        const frame = queue.shift()!;
        deferredBytes -= frame.bytes;
        write(frame.text, false);
      }
      if (!stopped && outstanding === 0 && wire.bufferedBytes!() === 0) finishGrace();
    } finally { pumping = false; }
  };

  return {
    send(message, question) {
      if (stopped) return;
      if (!wire.isOpen()) { closePeer(); return; }
      // User toJSON/getters must not reenter and bypass admission reservations.
      if (serializing) { overload('write_error'); return; }
      pump();
      if (stopped || expired()) return;
      if (outstanding + queue.length >= OUTSTANDING_FRAME_LIMIT) { overload('frame_count_limit'); return; }
      if (started !== undefined) {
        if (queue.length >= DEFERRED_FRAME_LIMIT) { overload('deferred_count_limit'); return; }
        const budget = DEFERRED_BYTE_LIMIT - deferredBytes;
        if (budget === 0) { overload('deferred_byte_limit'); return; }
        let frame: { text: string; bytes: number };
        serializing = true;
        try { frame = boundedJson(message, budget); }
        catch (error) {
          overload(error instanceof JsonBudgetExceeded ? 'deferred_byte_limit' : 'write_error');
          return;
        } finally { serializing = false; }
        if (stopped || expired()) return;
        if (!wire.isOpen()) { closePeer(); return; }
        queue.push({ ...frame, question });
        deferredBytes += frame.bytes;
        pump();
        return;
      }
      // Preserve immediate rejection before serialization for ordinary stalls.
      if (wire.bufferedBytes!() >= highWater) { overload('backlog_limit'); return; }
      let text: string;
      serializing = true;
      try { text = JSON.stringify(message); }
      catch (error) { overload('write_error'); throw error; }
      finally { serializing = false; }
      if (stopped) return;
      if (!wire.isOpen()) { closePeer(); return; }
      if (typeof text !== 'string') { overload('write_error'); return; }
      const bytes = utf8Bytes(text);
      const oversized = bytes > highWater;
      if (oversized) {
        started = performance.now();
        oversizedBytes = bytes;
        oversizedPending = true;
        check = setInterval(pump, DRAIN_CHECK_MS);
        (check as unknown as { unref?(): void }).unref?.();
      }
      write(text, oversized);
    },
    cancel(question) {
      const index = queue.findIndex((frame) => frame.question === question);
      if (index !== -1) {
        deferredBytes -= queue[index]!.bytes;
        queue.splice(index, 1);
      }
      pump();
    },
    close() {
      if (stopped) return;
      stopped = true;
      queue.length = 0;
      deferredBytes = 0;
      outstanding = 0;
      serializing = false;
      finishGrace();
    },
  };
}
