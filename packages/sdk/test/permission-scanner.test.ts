import { expect, it, vi } from 'vitest';
import { permissionScannerRequested, permissionScanners } from '../src/permission-scanner.js';
import type { Connection } from '../src/types/host.js';

const request = { chat: 'ahp-chat:/one', turnId: 'turn', toolCallId: 'call', toolName: 'Bash', cwd: '/remote/task', input: { command: 'git status' } };
const client = (id: string, reply: unknown = { decision: 'allow' }): Connection => ({
  clientId: id, root: true, watching: new Set(), aliases: new Map(), tokens: new Map(),
  peer: { request: vi.fn(async () => reply), notify: vi.fn(), send: vi.fn(), answered: vi.fn(), close: vi.fn() },
});

it('only calls the explicitly opted-in original connected session client', async () => {
  const owner = client('owner');
  const other = client('viewer');
  const connected = new Set([owner, other]);
  const scanner = permissionScanners((one) => connected.has(one), () => 'authenticated-owner');
  expect(await scanner.scan('session', request, new AbortController().signal)).toBe('abstain');
  scanner.register('session', owner);
  scanner.rebind('session', other);
  expect(await scanner.scan('session', request, new AbortController().signal)).toBe('allow');
  expect(owner.peer.request).toHaveBeenCalledWith('anton/scanPermission', { ...request, session: 'session' }, 1500);
  expect(other.peer.request).not.toHaveBeenCalled();
  connected.delete(owner);
  expect(await scanner.scan('session', request, new AbortController().signal)).toBe('abstain');
  const resumed = client('owner');
  connected.add(resumed);
  scanner.rebind('session', resumed);
  expect(await scanner.scan('session', request, new AbortController().signal)).toBe('allow');
  scanner.forget('session');
  expect(await scanner.scan('session', request, new AbortController().signal)).toBe('abstain');
});

it('abstains on malformed/deny/error responses, cancellation, ownership change, and host restart', async () => {
  const owner = client('owner');
  let identity = 'original';
  const scanner = permissionScanners(() => true, () => identity);
  scanner.register('session', owner);
  for (const reply of [{ decision: 'deny' }, null, {}, { decision: 'ALLOW' }]) {
    vi.mocked(owner.peer.request).mockResolvedValueOnce(reply);
    expect(await scanner.scan('session', request, new AbortController().signal)).toBe('abstain');
  }
  vi.mocked(owner.peer.request).mockRejectedValueOnce(new Error('deadline'));
  expect(await scanner.scan('session', request, new AbortController().signal)).toBe('abstain');
  const abort = new AbortController();
  vi.mocked(owner.peer.request).mockImplementationOnce(async () => { abort.abort(); return { decision: 'allow' }; });
  expect(await scanner.scan('session', request, abort.signal)).toBe('abstain');
  identity = 'changed';
  expect(await scanner.scan('session', request, new AbortController().signal)).toBe('abstain');
  const restarted = permissionScanners(() => true, () => 'original');
  restarted.rebind('session', owner);
  expect(await restarted.scan('session', request, new AbortController().signal)).toBe('abstain');
  expect(permissionScannerRequested({ 'ahpd.permissionScanner': { version: 1 } })).toBe(true);
  expect(permissionScannerRequested({ 'ahpd.permissionScanner': true })).toBe(false);
});

it('bounds a scanner that never replies and abstains promptly on cancellation', async () => {
  vi.useFakeTimers();
  try {
    const owner = client('owner');
    vi.mocked(owner.peer.request).mockImplementation(() => new Promise(() => {}));
    const scanner = permissionScanners(() => true, () => 'owner');
    scanner.register('session', owner);
    const timed = scanner.scan('session', request, new AbortController().signal);
    await vi.advanceTimersByTimeAsync(1500);
    expect(await timed).toBe('abstain');
    const abort = new AbortController();
    const cancelled = scanner.scan('session', request, abort.signal);
    abort.abort();
    expect(await cancelled).toBe('abstain');
  }
  finally { vi.useRealTimers(); }
});

it('rebinds the same authenticated owner and client id while the creation socket is still connected', async () => {
  const creating = client('anton-session');
  const attached = client('anton-session');
  const viewer = client('viewer');
  const connected = new Set([creating, attached, viewer]);
  const scanner = permissionScanners((one) => connected.has(one), () => 'authenticated-owner');
  scanner.register('session', creating);
  scanner.rebind('session', viewer);
  scanner.rebind('session', attached);
  expect(await scanner.scan('session', request, new AbortController().signal)).toBe('allow');
  expect(creating.peer.request).not.toHaveBeenCalled();
  expect(viewer.peer.request).not.toHaveBeenCalled();
  expect(attached.peer.request).toHaveBeenCalledOnce();
});

it('discards an old socket reply after ownership was rebound during the scan', async () => {
  const creating = client('owner');
  const attached = client('owner');
  let release: ((reply: unknown) => void) | undefined;
  vi.mocked(creating.peer.request).mockImplementation(() => new Promise((resolve) => { release = resolve; }));
  const scanner = permissionScanners(() => true, () => 'same-owner');
  scanner.register('session', creating);
  const pending = scanner.scan('session', request, new AbortController().signal);
  scanner.rebind('session', attached);
  release?.({ decision: 'allow' });
  expect(await pending).toBe('abstain');
});

it('does not transmit unsupported Bash execution flags to the scanner', async () => {
  const owner = client('owner');
  const scanner = permissionScanners(() => true, () => 'owner');
  scanner.register('session', owner);
  expect(await scanner.scan('session', { ...request, input: { command: 'pwd', dangerouslyDisableSandbox: true } }, new AbortController().signal)).toBe('abstain');
  expect(owner.peer.request).not.toHaveBeenCalled();
});

it('requires explicit pure-help opt-in and the registered contributing client', async () => {
  const owner = client('anton-owner');
  const scanner = permissionScanners(() => true, () => 'authenticated-owner');
  const help = { ...request, toolName: 'mcp__ahp__anton_codemode', input: { code: 'return anton.help()' }, clientId: 'anton-owner' };
  scanner.register('session', owner);
  expect(await scanner.scan('session', help, new AbortController().signal)).toBe('abstain');
  scanner.rebind('session', owner, true);
  expect(await scanner.scan('session', { ...help, clientId: 'other' }, new AbortController().signal)).toBe('abstain');
  expect(await scanner.scan('session', { ...help, input: { ...help.input, extra: true } }, new AbortController().signal)).toBe('abstain');
  expect(await scanner.scan('session', help, new AbortController().signal)).toBe('allow');
  expect(owner.peer.request).toHaveBeenCalledTimes(1);
});
