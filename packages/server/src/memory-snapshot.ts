import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { freemem, totalmem } from 'node:os';
import { dirname, join, resolve } from 'node:path';

export interface MemorySnapshot {
  used: number;
  available: number;
  total: number;
}

export function processTreeBytes(rows: { pid: number; parent: number; bytes: number }[], root: number): number {
  const children = new Map<number, typeof rows>();
  for (const row of rows) {
    const held = children.get(row.parent) ?? [];
    held.push(row);
    children.set(row.parent, held);
  }
  const initial = rows.find((row) => row.pid === root);
  if (!initial) throw new Error('daemon process was absent from memory measurements');
  const seen = new Set<number>();
  const pending = [initial];
  let bytes = 0;
  while (pending.length > 0) {
    const row = pending.pop()!;
    if (seen.has(row.pid)) continue;
    seen.add(row.pid);
    bytes += row.bytes;
    pending.push(...children.get(row.pid) ?? []);
  }
  return bytes;
}

function linuxProcesses() {
  const rows: { pid: number; parent: number; bytes: number }[] = [];
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/u.test(name)) continue;
    try {
      const status = readFileSync(`/proc/${name}/status`, 'utf8');
      const parent = /^PPid:\s+(\d+)/mu.exec(status)?.[1];
      const rss = /^VmRSS:\s+(\d+)\s+kB/mu.exec(status)?.[1];
      if (parent !== undefined) rows.push({ pid: Number(name), parent: Number(parent), bytes: Number(rss ?? 0) * 1024 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && (error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
  }
  return rows;
}

export function cgroupHeadroom(root: string, current: string, snapshot: MemorySnapshot): MemorySnapshot {
  let path = resolve(current);
  const boundary = resolve(root);
  if (path !== boundary && !path.startsWith(boundary + '/')) throw new Error('invalid cgroup path');
  const result = { ...snapshot };
  while (true) {
    const limitFile = join(path, 'memory.max');
    if (existsSync(limitFile)) {
      const text = readFileSync(limitFile, 'utf8').trim();
      if (text !== 'max') {
        const limit = Number(text);
        const used = Number(readFileSync(join(path, 'memory.current'), 'utf8').trim());
        if (!Number.isFinite(limit) || !Number.isFinite(used) || limit <= 0 || used < 0) throw new Error('invalid cgroup memory accounting');
        result.total = Math.min(result.total, limit);
        result.available = Math.min(result.available, Math.max(0, limit - used));
      }
    }
    if (path === boundary) return result;
    path = dirname(path);
  }
}

export function memorySnapshot(): MemorySnapshot {
  if (process.platform === 'linux') {
    const info = readFileSync('/proc/meminfo', 'utf8');
    const available = Number(/^MemAvailable:\s+(\d+)/mu.exec(info)?.[1]) * 1024;
    const snapshot = { used: processTreeBytes(linuxProcesses(), process.pid), available, total: totalmem() };
    const group = /^0::(.*)$/mu.exec(readFileSync('/proc/self/cgroup', 'utf8'))?.[1];
    if (group === undefined) throw new Error('cgroup v2 memory accounting is unavailable');
    const root = '/sys/fs/cgroup';
    const candidate = resolve(root, '.' + group);
    const current = existsSync(join(candidate, 'cgroup.procs')) ? candidate : root;
    return cgroupHeadroom(root, current, snapshot);
  }
  const output = execFileSync('ps', ['-axo', 'pid=,ppid=,rss='], { encoding: 'utf8', timeout: 2000, maxBuffer: 2 * 1024 * 1024 });
  const rows = output.trim().split('\n').map((line) => {
    const [pid, parent, rss] = line.trim().split(/\s+/u).map(Number);
    return { pid: pid!, parent: parent!, bytes: rss! * 1024 };
  });
  return { used: processTreeBytes(rows, process.pid), available: freemem(), total: totalmem() };
}
