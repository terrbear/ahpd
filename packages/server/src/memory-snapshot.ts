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

export function cgroupHeadroom(root: string, current: string, snapshot: MemorySnapshot, version: 1 | 2 = 2): MemorySnapshot {
  let path = resolve(current);
  const boundary = resolve(root);
  if (path !== boundary && !path.startsWith(boundary + '/')) throw new Error('invalid cgroup path');
  const result = { ...snapshot };
  let measured = false;
  let inheritedLimit = Infinity;
  let visibleLimit = Infinity;
  while (true) {
    const limitFile = join(path, version === 1 ? 'memory.limit_in_bytes' : 'memory.max');
    if (existsSync(limitFile)) {
      measured = true;
      const text = readFileSync(limitFile, 'utf8').trim();
      if (text !== 'max') {
        const limit = Number(text);
        const used = Number(readFileSync(join(path, version === 1 ? 'memory.usage_in_bytes' : 'memory.current'), 'utf8').trim());
        if (!Number.isFinite(limit) || !Number.isFinite(used) || limit <= 0 || used < 0) throw new Error('invalid cgroup memory accounting');
        visibleLimit = Math.min(visibleLimit, limit);
        let effective = limit;
        if (version === 1) {
          const stats = readFileSync(join(path, 'memory.stat'), 'utf8');
          const inherited = /^hierarchical_memory_limit\s+(\d+)$/mu.exec(stats)?.[1];
          if (inherited !== undefined) {
            const ceiling = Number(inherited);
            if (!Number.isFinite(ceiling) || ceiling <= 0) throw new Error('invalid cgroup inherited memory limit');
            inheritedLimit = Math.min(inheritedLimit, ceiling);
            effective = Math.min(effective, ceiling);
          }
        }
        result.total = Math.min(result.total, effective);
        result.available = Math.min(result.available, Math.max(0, effective - used));
      }
    }
    if (path === boundary) {
      if (!measured) throw new Error('cgroup memory accounting is unavailable');
      if (inheritedLimit < visibleLimit) throw new Error('inherited cgroup memory usage is unavailable');
      return result;
    }
    path = dirname(path);
  }
}

export function mountedMemoryHeadroom(groups: string, mounts: string, snapshot: MemorySnapshot): MemorySnapshot {
  const entries = groups.trim().split('\n').map((line) => {
    const match = /^\d+:([^:]*):(.*)$/u.exec(line);
    return match === null ? undefined : { controllers: match[1]!.split(','), path: match[2]! };
  });
  const v1 = entries.find((entry) => entry?.controllers.includes('memory'));
  const group = v1 ?? entries.find((entry) => entry?.controllers.length === 1 && entry.controllers[0] === '');
  if (group === undefined) throw new Error('cgroup memory membership is unavailable');
  const version = v1 === undefined ? 2 : 1;
  const unescape = (value: string) => value.replace(/\\([0-7]{3})/gu, (_, octal: string) => String.fromCharCode(parseInt(octal, 8)));
  for (const line of mounts.trim().split('\n')) {
    const [before, after] = line.split(' - ');
    if (before === undefined || after === undefined) continue;
    const fields = before.split(' ');
    const fs = after.split(' ');
    if (version === 1 ? fs[0] !== 'cgroup' || !fs[2]?.split(',').includes('memory') : fs[0] !== 'cgroup2') continue;
    if (fields[3] === undefined || fields[4] === undefined) continue;
    const mountRoot = unescape(fields[3]);
    const root = unescape(fields[4]);
    if (group.path !== mountRoot && !group.path.startsWith(mountRoot === '/' ? '/' : mountRoot + '/')) continue;
    const relative = group.path.slice(mountRoot === '/' ? 1 : mountRoot.length);
    const current = resolve(root, '.' + (relative.startsWith('/') ? relative : '/' + relative));
    if (!existsSync(join(current, version === 1 ? 'memory.limit_in_bytes' : 'memory.max'))) continue;
    return cgroupHeadroom(root, current, snapshot, version);
  }
  throw new Error('mounted cgroup memory controller is unavailable');
}

export function memorySnapshot(): MemorySnapshot {
  if (process.platform === 'linux') {
    const info = readFileSync('/proc/meminfo', 'utf8');
    const available = Number(/^MemAvailable:\s+(\d+)/mu.exec(info)?.[1]) * 1024;
    const snapshot = { used: processTreeBytes(linuxProcesses(), process.pid), available, total: totalmem() };
    return mountedMemoryHeadroom(readFileSync('/proc/self/cgroup', 'utf8'), readFileSync('/proc/self/mountinfo', 'utf8'), snapshot);
  }
  const output = execFileSync('ps', ['-axo', 'pid=,ppid=,rss='], { encoding: 'utf8', timeout: 2000, maxBuffer: 2 * 1024 * 1024 });
  const rows = output.trim().split('\n').map((line) => {
    const [pid, parent, rss] = line.trim().split(/\s+/u).map(Number);
    return { pid: pid!, parent: parent!, bytes: rss! * 1024 };
  });
  return { used: processTreeBytes(rows, process.pid), available: freemem(), total: totalmem() };
}
