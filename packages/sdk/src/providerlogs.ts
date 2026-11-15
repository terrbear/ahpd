import { constants } from 'node:fs';
import { mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DebugLogs } from './debuglogs.js';

export const PROVIDER_LOG_LIMIT = 20 * 1024 * 1024;

export function matchesProviderLog(content: Buffer, provider: string, id: string): boolean {
  let matched = false;
  try {
    for (const line of new TextDecoder('utf-8', { fatal: true }).decode(content).split('\n')) {
      if (line.trim() === '') continue;
      const value = JSON.parse(line) as Record<string, unknown>;
      if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
      if (provider === 'claude' && value.sessionId !== undefined) {
        if (value.sessionId !== id) return false;
        matched = true;
      }
      if (provider === 'codex' && value.type === 'session_meta') {
        if ((value.payload as Record<string, unknown> | undefined)?.id !== id) return false;
        matched = true;
      }
    }
  } catch { return false; }
  return matched;
}

export async function collectProviderLog(logs: DebugLogs, file: string | undefined, provider: string, id: string, owner: object) {
  if (file === undefined) return { status: 'unavailable' as const, reason: 'missing' };
  let snapshot: Buffer;
  try {
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const before = await handle.stat();
      if (!before.isFile()) return { status: 'unavailable' as const, reason: 'unreadable' };
      if (before.size > PROVIDER_LOG_LIMIT) return { status: 'unavailable' as const, reason: 'oversized' };
      const buffer = Buffer.alloc(before.size + 1);
      let used = 0;
      while (used < buffer.length) {
        const read = await handle.read(buffer, used, buffer.length - used, used);
        if (read.bytesRead === 0) break;
        used += read.bytesRead;
      }
      const after = await handle.stat();
      if (used !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs) return { status: 'unavailable' as const, reason: 'changed' };
      snapshot = buffer.subarray(0, used);
    } finally { await handle.close(); }
  } catch (error) {
    return { status: 'unavailable' as const, reason: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unreadable' };
  }
  if (!matchesProviderLog(snapshot, provider, id)) return { status: 'unavailable' as const, reason: 'invalid-log' };
  const staging = await mkdtemp(join(tmpdir(), 'ahpd-provider-log-'));
  try {
    const source = join(staging, 'events.jsonl');
    await writeFile(source, snapshot, { mode: 0o600 });
    const collected = await logs.collect([{ path: 'events.jsonl', from: source, provider: true }], 'archive', owner);
    return { status: 'included' as const, coverage: 'snapshot' as const, ...collected };
  } finally { await rm(staging, { recursive: true, force: true }); }
}
