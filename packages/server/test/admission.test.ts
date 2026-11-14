import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createHost, type Peer } from '@ahpd/sdk';
import { echo } from '../../../examples/echo/agent.js';
import { memoryAdmission as createMemoryAdmission } from '../src/admission.js';
import { cgroupHeadroom, memorySnapshot, processTreeBytes } from '../src/memory-snapshot.js';

const memoryAdmission = (settings: Parameters<typeof createMemoryAdmission>[0] = {}, dependencies: Parameters<typeof createMemoryAdmission>[1] = {}) =>
  createMemoryAdmission({ enabled: true, ...settings }, dependencies);

const MB = 1024 * 1024;
const folders: string[] = [];
afterEach(() => { for (const path of folders.splice(0)) rmSync(path, { recursive: true, force: true }); });

it('does not block sessions or sample memory unless admission is enabled', () => {
  for (const settings of [{}, { enabled: false, memoryLimitMb: 64 }]) {
    const sample = vi.fn(() => ({ used: 900 * MB, available: 0, total: 1024 * MB }));
    const gate = createMemoryAdmission(settings, { sample });
    expect(() => gate.reserve({ activeSessions: 3 })).not.toThrow();
    expect(sample).not.toHaveBeenCalled();
    expect(gate.status()).toEqual({ blocked: false, reason: '', starting: 0 });
  }
});

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
  gate.reserve({ activeSessions: 3 });
  gate.reserve({ activeSessions: 3 });
  gate.reserve({ activeSessions: 3 });
  expect(() => gate.reserve({ activeSessions: 3 })).toThrow(/capacity temporarily unavailable/u);
  expect(gate.status().starting).toBe(3);
  now = 30_001;
  expect(() => gate.reserve({ activeSessions: 3 })).not.toThrow();
});

it('holds admission until the lower recovery threshold and leaves active sessions alone', () => {
  let used = 950 * MB;
  const logs: string[] = [];
  const gate = memoryAdmission({ memoryLimitMb: 1000, minimumFreeMb: 128, startupReservationMb: 100 }, {
    sample: () => ({ used, available: 4096 * MB, total: 8192 * MB }),
    log: (message) => logs.push(message),
  });
  expect(() => gate.reserve({ activeSessions: 3 })).toThrow(/memory pressure/u);
  used = 850 * MB;
  expect(() => gate.reserve({ activeSessions: 3 })).toThrow(/memory pressure/u);
  used = 700 * MB;
  expect(() => gate.reserve({ activeSessions: 3 })).not.toThrow();
  expect(logs.some((line) => line.includes('resumed'))).toBe(true);
});

it('reserves host headroom and returns failed startup reservations', () => {
  const gate = memoryAdmission({ memoryLimitMb: 4096, minimumFreeMb: 512, startupReservationMb: 256 }, {
    sample: () => ({ used: 100 * MB, available: 900 * MB, total: 8192 * MB }),
  });
  const cancel = gate.reserve({ activeSessions: 3 });
  cancel();
  cancel();
  gate.reserve({ activeSessions: 3 });
  expect(() => gate.reserve({ activeSessions: 3 })).toThrow(/memory pressure/u);
});

it('fails closed when measurements disappear and recovers on a valid sample', () => {
  let healthy = false;
  const gate = memoryAdmission({}, { sample: () => {
    if (!healthy) throw new Error('unreadable');
    return { used: 100 * MB, available: 4096 * MB, total: 8192 * MB };
  } });
  expect(() => gate.reserve({ activeSessions: 3 })).toThrow(/measurements are unavailable/u);
  healthy = true;
  expect(() => gate.reserve({ activeSessions: 3 })).not.toThrow();
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
  expect(() => gate.reserve({ activeSessions: 3 })).toThrow(/memory pressure/u);
});

it('counts observed startup RSS once across sequential admissions', () => {
  let used = 256 * MB;
  const gate = memoryAdmission({ memoryLimitMb: 1536, minimumFreeMb: 128, startupReservationMb: 256 }, {
    sample: () => ({ used, available: 2048 * MB - used, total: 4096 * MB }),
  });
  for (let index = 0; index < 5; index++) {
    expect(() => gate.reserve({ activeSessions: 3 })).not.toThrow();
    used += 256 * MB;
  }
  expect(() => gate.reserve({ activeSessions: 3 })).toThrow(/capacity/u);
});

it('retains the unobserved portion of a partial startup allocation', () => {
  let used = 256 * MB;
  const gate = memoryAdmission({ memoryLimitMb: 1024, minimumFreeMb: 128, startupReservationMb: 256 }, {
    sample: () => ({ used, available: 4096 * MB, total: 8192 * MB }),
  });
  gate.reserve({ activeSessions: 3 });
  used += 128 * MB;
  gate.reserve({ activeSessions: 3 });
  gate.reserve({ activeSessions: 3 });
  expect(() => gate.reserve({ activeSessions: 3 })).toThrow(/capacity/u);
});

it('credits observed growth to host headroom as well as the process budget', () => {
  let used = 100 * MB;
  const gate = memoryAdmission({ memoryLimitMb: 4096, minimumFreeMb: 512, startupReservationMb: 256 }, {
    sample: () => ({ used, available: 1280 * MB - used, total: 8192 * MB }),
  });
  gate.reserve({ activeSessions: 3 });
  used += 256 * MB;
  expect(() => gate.reserve({ activeSessions: 3 })).not.toThrow();
  used += 256 * MB;
  expect(() => gate.reserve({ activeSessions: 3 })).toThrow(/capacity/u);
});

it('releases failed and expired reservations without releasing another start', () => {
  let now = 0;
  const gate = memoryAdmission({ memoryLimitMb: 1024, minimumFreeMb: 128, startupReservationMb: 256, startupReservationMs: 1000 }, {
    now: () => now,
    sample: () => ({ used: 256 * MB, available: 4096 * MB, total: 8192 * MB }),
  });
  const cancel = gate.reserve({ activeSessions: 3 });
  now = 500;
  gate.reserve({ activeSessions: 3 });
  cancel();
  cancel();
  gate.reserve({ activeSessions: 3 });
  gate.reserve({ activeSessions: 3 });
  expect(() => gate.reserve({ activeSessions: 3 })).toThrow(/capacity/u);
  now = 1501;
  expect(() => gate.reserve({ activeSessions: 3 })).not.toThrow();
});

it('does not lose startup reservations when measured memory falls', () => {
  let used = 256 * MB;
  const gate = memoryAdmission({ memoryLimitMb: 1024, minimumFreeMb: 128, startupReservationMb: 256 }, {
    sample: () => ({ used, available: 4096 * MB, total: 8192 * MB }),
  });
  gate.reserve({ activeSessions: 3 });
  used = 512 * MB;
  gate.reserve({ activeSessions: 3 });
  used = 256 * MB;
  gate.reserve({ activeSessions: 3 });
  expect(() => gate.reserve({ activeSessions: 3 })).toThrow(/capacity/u);
});

it('admits the reported 22-session startup burst within a 24 GiB service budget', () => {
  let used = 1024 * MB;
  const gate = memoryAdmission({}, {
    sample: () => ({ used, available: 24 * 1024 * MB - used, total: 24 * 1024 * MB }),
  });
  for (let index = 0; index < 22; index++) {
    expect(() => gate.reserve({ activeSessions: 3 })).not.toThrow();
    used += 224 * MB;
  }
  expect(gate.status().blocked).toBe(false);
});

it('defaults the process-tree budget to 85% of effective RAM', () => {
  const total = 24 * 1024 * MB;
  let used = Math.floor(total * 0.7);
  const gate = memoryAdmission({ startupReservationMb: 1 }, {
    sample: () => ({ used, available: total - used, total }),
  });
  expect(() => gate.reserve({ activeSessions: 3 })).not.toThrow();
  used = Math.ceil(total * 0.85);
  expect(() => gate.reserve({ activeSessions: 3 })).toThrow(/memory pressure/u);
});


it.each([0, 1, 2])('allows starts with %i existing sessions despite memory pressure', (activeSessions) => {
  const gate = memoryAdmission({}, { sample: () => ({ used: 900 * MB, available: 0, total: 1024 * MB }) });
  expect(() => gate.reserve({ activeSessions })).not.toThrow();
  expect(gate.status().blocked).toBe(false);
});

it.each([0, 1, 2])('allows starts with %i existing sessions when measurements are unavailable', (activeSessions) => {
  const gate = memoryAdmission({}, { sample: () => { throw new Error('unreadable'); } });
  expect(() => gate.reserve({ activeSessions })).not.toThrow();
  expect(gate.status().blocked).toBe(false);
});

it('enforces memory pressure starting at three existing sessions', () => {
  const gate = memoryAdmission({}, { sample: () => ({ used: 900 * MB, available: 0, total: 1024 * MB }) });
  for (let activeSessions = 0; activeSessions < 3; activeSessions++) gate.reserve({ activeSessions });
  expect(() => gate.reserve({ activeSessions: 3 })).toThrow(/memory pressure/u);
  expect(() => gate.reserve({ activeSessions: 4 })).toThrow(/memory pressure/u);
});

it('clears a previous pause below three sessions without waiting for memory recovery', () => {
  const gate = memoryAdmission({}, { sample: () => ({ used: 900 * MB, available: 0, total: 1024 * MB }) });
  expect(() => gate.reserve({ activeSessions: 3 })).toThrow(/memory pressure/u);
  expect(gate.status().blocked).toBe(true);
  expect(() => gate.reserve({ activeSessions: 2 })).not.toThrow();
  expect(gate.status().blocked).toBe(false);
  expect(() => gate.reserve({ activeSessions: 3 })).toThrow(/memory pressure/u);
});

it('retains startup reservations made below the session threshold', () => {
  const gate = memoryAdmission({ memoryLimitMb: 1024, minimumFreeMb: 128, startupReservationMb: 256 }, {
    sample: () => ({ used: 256 * MB, available: 4096 * MB, total: 8192 * MB }),
  });
  for (let activeSessions = 0; activeSessions < 3; activeSessions++) gate.reserve({ activeSessions });
  expect(gate.status().starting).toBe(3);
  expect(() => gate.reserve({ activeSessions: 3 })).toThrow(/memory pressure/u);
});

it('reserves unmeasured starts conservatively once memory sampling recovers', () => {
  let healthy = false;
  const gate = memoryAdmission({ memoryLimitMb: 1024, minimumFreeMb: 128, startupReservationMb: 256 }, {
    sample: () => {
      if (!healthy) throw new Error('unreadable');
      return { used: 256 * MB, available: 4096 * MB, total: 8192 * MB };
    },
  });
  const cancel = gate.reserve({ activeSessions: 0 });
  gate.reserve({ activeSessions: 1 });
  gate.reserve({ activeSessions: 2 });
  healthy = true;
  expect(() => gate.reserve({ activeSessions: 3 })).toThrow(/memory pressure/u);
  cancel();
  expect(() => gate.reserve({ activeSessions: 2 })).not.toThrow();
});


it('enforces the session threshold across concurrent host starts, side chats, and resumes', async () => {
  const gate = memoryAdmission({}, { sample: () => ({ used: 900 * MB, available: 0, total: 1024 * MB }) });
  const backend = echo({ path: '/tmp', pace: 0 });
  const create = vi.fn(backend.create);
  const host = createHost({ path: '/tmp', agents: [{ ...backend, create }], admitSession: gate.reserve });
  try {
    const peer: Peer = { send: () => {}, notify: () => {}, request: async () => ({}), answered: () => {}, close: () => {} };
    const client = host.accept(peer);
    await client.handle({ method: 'initialize', params: { clientId: 'memory-threshold', protocolVersions: ['0.9.0'] } });
    const outcomes = await Promise.allSettled(Array.from({ length: 5 }, (_, index) =>
      client.handle({ method: 'createSession', params: { channel: `echo:/threshold-${index}`, provider: 'echo' } })));
    expect(outcomes.filter((result) => result.status === 'fulfilled')).toHaveLength(3);
    expect(outcomes.filter((result) => result.status === 'rejected')).toHaveLength(2);
    expect(create).toHaveBeenCalledTimes(3);
    const first = create.mock.calls[0]![0];
    const resume = first.admitResume!;
    expect(() => resume()).toThrow(/memory pressure/u);
    await expect(client.handle({ method: 'createChat', params: { channel: first.uri, chat: 'ahp-chat:/blocked-side' } })).rejects.toThrow(/memory pressure/u);
    await client.handle({ method: 'disposeSession', params: { channel: create.mock.calls[2]![0].uri } });
    expect(() => resume()).not.toThrow();
    await expect(client.handle({ method: 'createChat', params: { channel: first.uri, chat: 'ahp-chat:/allowed-side' } })).resolves.toBeDefined();
    await expect(client.handle({ method: 'createSession', params: { channel: 'echo:/replacement', provider: 'echo' } })).resolves.toBeDefined();
    await expect(client.handle({ method: 'createSession', params: { channel: 'echo:/blocked-again', provider: 'echo' } })).rejects.toThrow(/memory pressure/u);
  } finally { host.close(); }
});

it('ignores saved catalogue rows and applies the threshold to restored sessions', async () => {
  const gate = memoryAdmission({}, { sample: () => { throw new Error('unreadable'); } });
  const backend = echo({ path: '/tmp', pace: 0 });
  const create = vi.fn(backend.create);
  const host = createHost({ path: '/tmp', agents: [{
    ...backend,
    create,
    list: async () => Array.from({ length: 5 }, (_, index) => ({ id: `saved-${index}`, title: 'Saved chat', createdAt: '2026-11-03T00:00:00Z', modifiedAt: '2026-11-03T00:00:00Z', workingDirectories: ['file:///tmp'] })),
    transcript: async () => [],
  }], admitSession: gate.reserve });
  try {
    const notices: unknown[] = [];
    const peer: Peer = { send: () => {}, notify: (_method, params) => { notices.push(params); }, request: async () => ({}), answered: () => {}, close: () => {} };
    const client = host.accept(peer);
    await client.handle({ method: 'initialize', params: { clientId: 'restored-threshold', protocolVersions: ['0.9.0'], initialSubscriptions: ['ahp-root://'] } });
    await client.handle({ method: 'listSessions', params: { channel: 'ahp-root://' } });
    for (let index = 0; index < 4; index++) {
      const channel = `ahp-chat:/saved-${index}`;
      await client.handle({ method: 'subscribe', params: { channel } });
      await client.handle({ method: 'dispatchAction', params: { channel, action: { type: 'chat/turnStarted', turnId: `resume-${index}`, message: { text: 'continue' } } } });
      if (index < 3) await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(index + 1));
    }
    await vi.waitFor(() => expect(JSON.stringify(notices)).toContain('memory measurements are unavailable'));
    expect(create).toHaveBeenCalledTimes(3);
    expect(create.mock.calls.map(([start]) => start.resume)).toEqual(['saved-0', 'saved-1', 'saved-2']);
  } finally { host.close(); }
});
