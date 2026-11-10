import { expect, it, vi } from 'vitest';
import { createHost } from '../src/host.js';
import { admittedStart } from '../src/admission.js';
import { echo } from '../../../examples/echo/agent.js';
import type { Peer } from '../src/types/rpc.js';

it('rejects new sessions before backend creation while existing sessions stay readable', async () => {
  let blocked = false;
  const backend = echo({ path: '/tmp', pace: 0 });
  const create = vi.fn(backend.create);
  const host = createHost({ path: '/tmp', agents: [{ ...backend, create }], admitSession: () => {
    if (blocked) throw new Error('Host capacity temporarily unavailable');
    return () => {};
  } });
  try {
    const peer: Peer = { send: () => {}, notify: () => {}, request: async () => ({}), answered: () => {}, close: () => {} };
    const client = host.accept(peer);
    await client.handle({ method: 'initialize', params: { clientId: 'admission', protocolVersions: ['0.9.0'], initialSubscriptions: ['ahp-root://'] } });
    await client.handle({ method: 'createSession', params: { channel: 'echo:/existing', provider: 'echo' } });
    expect(create).toHaveBeenCalledTimes(1);
    blocked = true;
    await expect(client.handle({ method: 'createSession', params: { channel: 'echo:/burst', provider: 'echo' } })).rejects.toThrow(/capacity/u);
    expect(create).toHaveBeenCalledTimes(1);
    await expect(client.handle({ method: 'subscribe', params: { channel: 'echo:/existing' } })).resolves.toBeDefined();
    blocked = false;
    await expect(client.handle({ method: 'createSession', params: { channel: 'echo:/burst', provider: 'echo' } })).resolves.toBeDefined();
    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[1]![0].admitResume).toBeTypeOf('function');
  } finally { host.close(); }
});

it('returns the startup reservation when backend creation fails', () => {
  const cancel = vi.fn();
  expect(() => admittedStart(() => cancel, () => { throw new Error('failed spawn'); })).toThrow('failed spawn');
  expect(cancel).toHaveBeenCalledOnce();
});

it('gates restored sessions after restart while historical reads remain available', async () => {
  let blocked = true;
  const backend = echo({ path: '/tmp', pace: 0 });
  const create = vi.fn(backend.create);
  const host = createHost({ path: '/tmp', agents: [{
    ...backend,
    create,
    list: async () => [{ id: 'restored', title: 'Saved chat', createdAt: '2026-11-03T00:00:00Z', modifiedAt: '2026-11-03T00:00:00Z', workingDirectories: ['file:///tmp'] }],
    transcript: async () => [],
  }], admitSession: () => {
    if (blocked) throw new Error('Host capacity temporarily unavailable');
    return () => {};
  } });
  try {
    const notices: unknown[] = [];
    const peer: Peer = { send: () => {}, notify: (_method, params) => { notices.push(params); }, request: async () => ({}), answered: () => {}, close: () => {} };
    const client = host.accept(peer);
    await client.handle({ method: 'initialize', params: { clientId: 'restored-admission', protocolVersions: ['0.9.0'], initialSubscriptions: ['ahp-root://'] } });
    await client.handle({ method: 'listSessions', params: { channel: 'ahp-root://' } });
    await client.handle({ method: 'subscribe', params: { channel: 'ahp-chat:/restored' } });
    expect(create).not.toHaveBeenCalled();
    const start = () => client.handle({ method: 'dispatchAction', params: { channel: 'ahp-chat:/restored', action: { type: 'chat/turnStarted', turnId: 'resume', message: { text: 'continue' } } } });
    await start();
    await vi.waitFor(() => expect(JSON.stringify(notices)).toContain("capacity temporarily unavailable"));
    expect(create).not.toHaveBeenCalled();
    blocked = false;
    await start();
    await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(create.mock.calls[0]![0].resume).toBe('restored');
  } finally { host.close(); }
});

it('reports current loaded sessions for starts, side chats, and idle resumes', async () => {
  const backend = echo({ path: '/tmp', pace: 0 });
  const create = vi.fn(backend.create);
  const admit = vi.fn(() => () => {});
  const host = createHost({ path: '/tmp', agents: [{ ...backend, create }], admitSession: admit });
  try {
    const peer: Peer = { send: () => {}, notify: () => {}, request: async () => ({}), answered: () => {}, close: () => {} };
    const client = host.accept(peer);
    await client.handle({ method: 'initialize', params: { clientId: 'session-count', protocolVersions: ['0.9.0'] } });
    for (let index = 0; index < 3; index++) {
      await client.handle({ method: 'createSession', params: { channel: `echo:/count-${index}`, provider: 'echo' } });
      expect(admit).toHaveBeenLastCalledWith({ activeSessions: index });
    }
    const resume = create.mock.calls[0]![0].admitResume!;
    resume();
    expect(admit).toHaveBeenLastCalledWith({ activeSessions: 3 });
    const callsBeforeSideChat = admit.mock.calls.length;
    await client.handle({ method: 'createChat', params: { channel: 'echo:/count-0', chat: 'ahp-chat:/extra-count' } });
    expect(admit).toHaveBeenCalledTimes(callsBeforeSideChat + 1);
    expect(admit).toHaveBeenLastCalledWith({ activeSessions: 3 });
    await client.handle({ method: 'disposeSession', params: { channel: 'echo:/count-2' } });
    resume();
    expect(admit).toHaveBeenLastCalledWith({ activeSessions: 2 });
    await client.handle({ method: 'createSession', params: { channel: 'echo:/replacement', provider: 'echo' } });
    expect(admit).toHaveBeenLastCalledWith({ activeSessions: 2 });
  } finally { host.close(); }
});
