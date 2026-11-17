import { RpcError } from '@ahpd/sdk';
import { memorySnapshot, type MemorySnapshot } from './memory-snapshot.js';

export interface AdmissionSettings {
  enabled?: boolean;
  memoryLimitMb?: number;
  minimumFreeMb?: number;
  startupReservationMb?: number;
  startupReservationMs?: number;
}

const MB = 1024 * 1024;

export function memoryAdmission(settings: AdmissionSettings = {}, dependencies: {
  sample?: () => MemorySnapshot;
  now?: () => number;
  log?: (message: string) => void;
} = {}) {
  const sample = dependencies.sample ?? memorySnapshot;
  const now = dependencies.now ?? Date.now;
  const reservations = new Map<symbol, { expires: number; baseline: number | undefined }>();
  const reservation = (settings.startupReservationMb ?? 384) * MB;
  const lifetime = settings.startupReservationMs ?? 30_000;
  let blocked = false;
  let reason = '';
  const transition = (next: boolean, message: string) => {
    if (next !== blocked) dependencies.log?.(`Session admission ${next ? 'paused' : 'resumed'}: ${message}`);
    blocked = next;
    reason = message;
  };
  const reserve = ({ activeSessions }: { activeSessions: number }) => {
    if (settings.enabled !== true) return () => {};
    const at = now();
    for (const [id, held] of reservations) if (held.expires <= at) reservations.delete(id);
    const hold = (baseline: number | undefined) => {
      const id = Symbol();
      reservations.set(id, { expires: at + lifetime, baseline });
      return () => { reservations.delete(id); };
    };
    const enforce = activeSessions >= 3;
    if (!enforce) transition(false, 'fewer than three active sessions');
    let snapshot: MemorySnapshot;
    try {
      snapshot = sample();
      if (![snapshot.used, snapshot.available, snapshot.total].every(Number.isFinite) || snapshot.used < 0 || snapshot.available < 0 || snapshot.total <= 0) {
        throw new Error('invalid memory measurements');
      }
    } catch {
      // The first three sessions can start even when accounting is unavailable.
      // Keep their startup allowance for a later admission that must enforce it.
      if (!enforce) return hold(undefined);
      transition(true, 'memory measurements are unavailable');
      throw new RpcError(-32000, 'Host capacity temporarily unavailable: memory measurements are unavailable. Retry later.', { reason: 'host_memory_unavailable', retryAfterMs: lifetime });
    }
    // Establish a conservative baseline for starts whose memory was unmeasurable.
    for (const held of reservations.values()) held.baseline ??= snapshot.used;
    if (!enforce) return hold(snapshot.used);
    const limit = settings.memoryLimitMb === undefined ? snapshot.total * 0.85 : settings.memoryLimitMb * MB;
    const minimumFree = settings.minimumFreeMb === undefined ? Math.max(512 * MB, snapshot.total * 0.1) : settings.minimumFreeMb * MB;
    let used = snapshot.used;
    let remaining = reservations.size;
    for (const held of reservations.values()) {
      used = Math.max(used, held.baseline! + remaining * reservation);
      remaining--;
    }
    const reserved = used - snapshot.used;
    const available = snapshot.available - reserved;
    if (blocked && used <= limit * 0.8 && available >= minimumFree * 1.25) transition(false, 'memory headroom recovered');
    if (used + reservation > limit || available - reservation < minimumFree) {
      transition(true, `memory budget reached (process tree ${Math.ceil(snapshot.used / MB)} MiB, reserved ${Math.ceil(reserved / MB)} MiB, available ${Math.floor(snapshot.available / MB)} MiB)`);
    }
    if (blocked) throw new RpcError(-32000, 'Host capacity temporarily unavailable: memory pressure. Existing sessions remain available; retry after memory usage falls.', { reason: 'host_memory_pressure', retryAfterMs: lifetime });
    return hold(snapshot.used);
  };
  return { reserve, status: () => ({ blocked, reason, starting: reservations.size }) };
}
