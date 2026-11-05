import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { memoryAdmission } from '../src/admission.js';
import { cgroupHeadroom, memorySnapshot, processTreeBytes } from '../src/memory-snapshot.js';

const MB = 1024 * 1024;
const folders: string[] = [];
afterEach(() => { for (const path of folders.splice(0)) rmSync(path, { recursive: true, force: true }); });

it.skipIf(process.platform !== 'linux' && process.platform !== 'darwin')('reads the current process tree and effective memory budget', () => {
  const snapshot = memorySnapshot();
  expect(snapshot.used).toBeGreaterThan(0);
  expect(snapshot.available).toBeGreaterThanOrEqual(0);
  expect(snapshot.total).toBeGreaterThan(0);
  expect(snapshot.available).toBeLessThanOrEqual(snapshot.total);
});

it('reserves startup memory atomically across a burst before child RSS is visible', () => {
  let now = 0;
  const gate = memoryAdmission({ memoryLimitMb: 1024, minimumFreeMb: 128, startupReservationMb: 256 }, {
    now: () => now,
    sample: () => ({ used: 256 * MB, available: 4096 * MB, total: 8192 * MB }),
  });
  gate.reserve();
  gate.reserve();
  gate.reserve();
  expect(() => gate.reserve()).toThrow(/capacity temporarily unavailable/u);
  expect(gate.status().starting).toBe(3);
  now = 30_001;
  expect(() => gate.reserve()).not.toThrow();
});

it('holds admission until the lower recovery threshold and leaves active sessions alone', () => {
  let used = 950 * MB;
  const logs: string[] = [];
  const gate = memoryAdmission({ memoryLimitMb: 1000, minimumFreeMb: 128, startupReservationMb: 100 }, {
    sample: () => ({ used, available: 4096 * MB, total: 8192 * MB }),
    log: (message) => logs.push(message),
  });
  expect(() => gate.reserve()).toThrow(/memory pressure/u);
  used = 850 * MB;
  expect(() => gate.reserve()).toThrow(/memory pressure/u);
  used = 700 * MB;
  expect(() => gate.reserve()).not.toThrow();
  expect(logs.some((line) => line.includes('resumed'))).toBe(true);
});

it('reserves host headroom and returns failed startup reservations', () => {
  const gate = memoryAdmission({ memoryLimitMb: 4096, minimumFreeMb: 512, startupReservationMb: 256 }, {
    sample: () => ({ used: 100 * MB, available: 900 * MB, total: 8192 * MB }),
  });
  const cancel = gate.reserve();
  cancel();
  cancel();
  gate.reserve();
  expect(() => gate.reserve()).toThrow(/memory pressure/u);
});

it('fails closed when measurements disappear and recovers on a valid sample', () => {
  let healthy = false;
  const gate = memoryAdmission({}, { sample: () => {
    if (!healthy) throw new Error('unreadable');
    return { used: 100 * MB, available: 4096 * MB, total: 8192 * MB };
  } });
  expect(() => gate.reserve()).toThrow(/measurements are unavailable/u);
  healthy = true;
  expect(() => gate.reserve()).not.toThrow();
});

it('counts daemon descendants rather than only the daemon or unrelated processes', () => {
  expect(processTreeBytes([
    { pid: 1, parent: 0, bytes: 10 },
    { pid: 2, parent: 1, bytes: 200 },
    { pid: 3, parent: 2, bytes: 300 },
    { pid: 4, parent: 0, bytes: 9000 },
  ], 1)).toBe(510);
  expect(() => processTreeBytes([], 1)).toThrow(/absent/u);
});

it('uses the tightest cgroup ancestor including memory consumed by siblings', () => {
  const root = mkdtempSync(join(tmpdir(), 'ahpd-memory-'));
  folders.push(root);
  const child = join(root, 'service');
  mkdirSync(child);
  writeFileSync(join(root, 'memory.max'), String(2048 * MB));
  writeFileSync(join(root, 'memory.current'), String(1900 * MB));
  writeFileSync(join(child, 'memory.max'), 'max');
  const sample = cgroupHeadroom(root, child, { used: 100 * MB, available: 8192 * MB, total: 16384 * MB });
  expect(sample.total).toBe(2048 * MB);
  expect(sample.available).toBe(148 * MB);
  const gate = memoryAdmission({}, { sample: () => sample });
  expect(() => gate.reserve()).toThrow(/memory pressure/u);
});

it('counts observed startup RSS once across sequential admissions', () => {
  let used = 256 * MB;
  const gate = memoryAdmission({ memoryLimitMb: 1536, minimumFreeMb: 128, startupReservationMb: 256 }, {
    sample: () => ({ used, available: 2048 * MB - used, total: 4096 * MB }),
  });
  for (let index = 0; index < 5; index++) {
    expect(() => gate.reserve()).not.toThrow();
    used += 256 * MB;
  }
  expect(() => gate.reserve()).toThrow(/capacity/u);
});

it('retains the unobserved portion of a partial startup allocation', () => {
  let used = 256 * MB;
  const gate = memoryAdmission({ memoryLimitMb: 1024, minimumFreeMb: 128, startupReservationMb: 256 }, {
    sample: () => ({ used, available: 4096 * MB, total: 8192 * MB }),
  });
  gate.reserve();
  used += 128 * MB;
  gate.reserve();
  gate.reserve();
  expect(() => gate.reserve()).toThrow(/capacity/u);
});

it('credits observed growth to host headroom as well as the process budget', () => {
  let used = 100 * MB;
  const gate = memoryAdmission({ memoryLimitMb: 4096, minimumFreeMb: 512, startupReservationMb: 256 }, {
    sample: () => ({ used, available: 1280 * MB - used, total: 8192 * MB }),
  });
  gate.reserve();
  used += 256 * MB;
  expect(() => gate.reserve()).not.toThrow();
  used += 256 * MB;
  expect(() => gate.reserve()).toThrow(/capacity/u);
});

it('releases failed and expired reservations without releasing another start', () => {
  let now = 0;
  const gate = memoryAdmission({ memoryLimitMb: 1024, minimumFreeMb: 128, startupReservationMb: 256, startupReservationMs: 1000 }, {
    now: () => now,
    sample: () => ({ used: 256 * MB, available: 4096 * MB, total: 8192 * MB }),
  });
  const cancel = gate.reserve();
  now = 500;
  gate.reserve();
  cancel();
  cancel();
  gate.reserve();
  gate.reserve();
  expect(() => gate.reserve()).toThrow(/capacity/u);
  now = 1501;
  expect(() => gate.reserve()).not.toThrow();
});

it('does not lose startup reservations when measured memory falls', () => {
  let used = 256 * MB;
  const gate = memoryAdmission({ memoryLimitMb: 1024, minimumFreeMb: 128, startupReservationMb: 256 }, {
    sample: () => ({ used, available: 4096 * MB, total: 8192 * MB }),
  });
  gate.reserve();
  used = 512 * MB;
  gate.reserve();
  used = 256 * MB;
  gate.reserve();
  expect(() => gate.reserve()).toThrow(/capacity/u);
});

it('admits the reported 22-session startup burst within a 24 GiB service budget', () => {
  let used = 1024 * MB;
  const gate = memoryAdmission({}, {
    sample: () => ({ used, available: 24 * 1024 * MB - used, total: 24 * 1024 * MB }),
  });
  for (let index = 0; index < 22; index++) {
    expect(() => gate.reserve()).not.toThrow();
    used += 224 * MB;
  }
  expect(gate.status().blocked).toBe(false);
});
