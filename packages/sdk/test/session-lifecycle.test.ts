import { afterEach, expect, it, vi } from 'vitest';
import { createHost } from '../src/host.js';
import { sessionLifetimes } from '../src/session-lifecycle.js';
import { echo } from '../../../examples/echo/agent.js';
import type { Host, SessionLifecycle, SessionLease, WriterExitProof, Peer } from '../src/index.js';

const hosts: Host[] = [];
afterEach(async () => { for (const host of hosts.splice(0)) await host.close(); });
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
};
const peer: Peer = { send: () => {}, notify: () => {}, request: async () => ({}), answered: () => {}, close: () => {} };

const proof: WriterExitProof = { kind: 'isolated-process-scope-empty', scope: 'test-contained-scope' };

async function setup(lifecycle: SessionLifecycle, close: () => Promise<void> = async () => {}, contained = true) {
  const base = echo({ path: '/tmp', pace: 0 });
  const starts = vi.fn(base.create);
  const host = createHost({ path: '/tmp', agents: [{ ...base, multipleDirectories: true, create: (start) => {
    const session = starts(start);
    return { ...session, ...(contained ? { writerExitProof: () => proof } : {}), close: async () => { await close(); await session.close(); } };
  } }], sessionLifecycle: lifecycle });
  hosts.push(host);
  const notes = vi.fn();
  const client = host.accept({ ...peer, notify: notes });
  await client.handle({ method: 'initialize', params: { clientId: 'anton-chat-one', protocolVersions: ['0.9.0'] } });
  const create = () => client.handle({ method: 'createSession', params: { channel: 'echo:/one', provider: 'echo', workingDirectories: ['file:///tmp', 'file:///var/tmp'] } });
  const dispose = () => client.handle({ method: 'disposeSession', params: { channel: 'echo:/one' } });
  return { client, host, starts, create, dispose, notes };
}

it('waits for admission before create and carries the authenticated connection identity', async () => {
  const gate = deferred();
  const release = vi.fn(async () => {});
  const acquire = vi.fn(async (_context: Parameters<SessionLifecycle['acquire']>[0]) => { await gate.promise; return { claim: async () => {}, release }; });
  const t = await setup({ acquire });
  const creating = t.create();
  await vi.waitFor(() => expect(acquire).toHaveBeenCalledOnce());
  expect(t.starts).not.toHaveBeenCalled();
  expect(acquire.mock.calls[0]).toEqual([{ provider: 'echo', sessionUri: 'echo:/one', chatUri: 'ahp-chat://default/ZWNobzovb25l', clientId: 'anton-chat-one' }]);
  gate.resolve();
  await creating;
  expect(t.starts).toHaveBeenCalledOnce();
  await t.dispose();
  expect(release).toHaveBeenCalledOnce();
});

it('retains ownership until asynchronous disposal finishes', async () => {
  const gone = deferred();
  const release = vi.fn(async () => {});
  const t = await setup({ acquire: async () => ({ claim: async () => {}, release }) }, () => gone.promise);
  await t.create();
  let disposed = false;
  const disposing = t.dispose().then(() => { disposed = true; });
  await Promise.resolve();
  expect(disposed).toBe(false);
  expect(release).not.toHaveBeenCalled();
  gone.resolve();
  await disposing;
  expect(release).toHaveBeenCalledOnce();
});

it('does not release a session whose close rejects', async () => {
  const release = vi.fn(async () => {});
  let failing = true;
  const t = await setup({ acquire: async () => ({ claim: async () => {}, release }) }, async () => { if (failing) throw new Error('writer still alive'); });
  await t.create();
  await expect(t.dispose()).rejects.toThrow('writer still alive');
  expect(release).not.toHaveBeenCalled();
  failing = false;
  await t.dispose();
  expect(release).toHaveBeenCalledOnce();
});

it('retains a logical lease across repeated admission and failed release', async () => {
  let failing = true;
  const lease: SessionLease = { claim: async () => {}, release: vi.fn(async () => { if (failing) throw new Error('registry unavailable'); }) };
  const acquire = vi.fn(async () => lease);
  const lifetimes = sessionLifetimes({ acquire });
  const context = { provider: 'echo', sessionUri: 'echo:/one', chatUri: 'chat:/one' };
  expect(await lifetimes.acquire(context)).toBe(lease);
  expect(await lifetimes.acquire(context)).toBe(lease);
  await expect(lifetimes.dispose(context.chatUri, proof)).rejects.toThrow('registry unavailable');
  await expect(lifetimes.acquire(context)).rejects.toThrow('awaiting its owner task fence');
  expect(acquire).toHaveBeenCalledOnce();
  failing = false;
  await lifetimes.dispose(context.chatUri, proof);
  await lifetimes.acquire(context);
  expect(acquire).toHaveBeenCalledTimes(2);
});

it('does not start a provider after ownership admission fails', async () => {
  const t = await setup({ acquire: async () => { throw new Error('another task owns this session'); } });
  await expect(t.create()).rejects.toThrow('another task owns');
  expect(t.starts).not.toHaveBeenCalled();
});

it('waits for restart disposal while keeping the same logical lease', async () => {
  const gone = deferred();
  const release = vi.fn(async () => {});
  const acquire = vi.fn(async () => ({ claim: async () => {}, release }));
  const t = await setup({ acquire }, () => gone.promise);
  await t.create();
  await t.client.handle({ method: 'dispatchAction', params: {
    channel: 'ahp-chat://default/ZWNobzovb25l',
    action: { type: 'chat/workingDirectoryRemoved', directory: 'file:///var/tmp' },
  } });
  expect(t.starts).toHaveBeenCalledOnce();
  expect(release).not.toHaveBeenCalled();
  gone.resolve();
  await vi.waitFor(() => expect(t.starts).toHaveBeenCalledTimes(2));
  expect(acquire).toHaveBeenCalledOnce();
  expect(release).not.toHaveBeenCalled();
  await t.dispose();
  expect(release).toHaveBeenCalledOnce();
});

it('keeps ownership after successful direct-child close without containment proof', async () => {
  const release = vi.fn(async () => {});
  const disposed = vi.fn(async () => {});
  const t = await setup({ acquire: async () => ({ claim: async () => {}, release, disposed }) }, async () => {}, false);
  await t.create();
  await t.dispose();
  expect(release).not.toHaveBeenCalled();
  expect(disposed).toHaveBeenCalledOnce();
  await expect(t.create()).rejects.toThrow('awaiting its owner task fence');
  expect(t.starts).toHaveBeenCalledOnce();
});

it('refuses same-task restart without containment before stopping the current provider', async () => {
  const close = vi.fn(async () => {});
  const release = vi.fn(async () => {});
  const t = await setup({ acquire: async () => ({ claim: async () => {}, release }) }, close, false);
  await t.create();
  await t.client.handle({ method: 'dispatchAction', params: {
    channel: 'ahp-chat://default/ZWNobzovb25l',
    action: { type: 'chat/workingDirectoryRemoved', directory: 'file:///var/tmp' },
  } });
  await vi.waitFor(() => expect(JSON.stringify(t.notes.mock.calls)).toContain('containment'));
  expect(close).not.toHaveBeenCalled();
  expect(t.starts).toHaveBeenCalledOnce();
  expect(release).not.toHaveBeenCalled();
});

it('does not release malformed proof or a partially started factory on cancellation', async () => {
  const release = vi.fn(async () => {});
  const disposed = vi.fn(async () => {});
  const lifetimes = sessionLifetimes({ acquire: async () => ({ claim: async () => {}, release, disposed }) });
  const context = { provider: 'echo', sessionUri: 'echo:/one', chatUri: 'chat:/one' };
  await lifetimes.acquire(context);
  lifetimes.started(context.chatUri);
  await lifetimes.cancelUnstarted(context.chatUri);
  expect(release).not.toHaveBeenCalled();
  await lifetimes.dispose(context.chatUri, { kind: 'isolated-process-scope-empty', scope: '' });
  expect(release).not.toHaveBeenCalled();
  expect(disposed).toHaveBeenCalledOnce();
  await expect(lifetimes.acquire(context)).rejects.toThrow('task fence');
});

it('can release admission that provably never entered the provider factory', async () => {
  const release = vi.fn(async () => {});
  const lifetimes = sessionLifetimes({ acquire: async () => ({ claim: async () => {}, release }) });
  const context = { provider: 'echo', sessionUri: 'echo:/one', chatUri: 'chat:/one' };
  await lifetimes.acquire(context);
  await lifetimes.cancelUnstarted(context.chatUri);
  expect(release).toHaveBeenCalledWith({ kind: 'never-started' });
});

it('reports concurrent logical disposal once without interpreting it as exit proof', async () => {
  const gate = deferred();
  const release = vi.fn(async () => {});
  const disposed = vi.fn(() => gate.promise);
  const lifetimes = sessionLifetimes({ acquire: async () => ({ claim: async () => {}, release, disposed }) });
  const context = { provider: 'echo', sessionUri: 'echo:/one', chatUri: 'chat:/one' };
  await lifetimes.acquire(context);
  lifetimes.started(context.chatUri);
  const stopping = Promise.all([lifetimes.dispose(context.chatUri), lifetimes.dispose(context.chatUri)]);
  await vi.waitFor(() => expect(disposed).toHaveBeenCalledOnce());
  gate.resolve();
  await stopping;
  await lifetimes.dispose(context.chatUri);
  expect(disposed).toHaveBeenCalledOnce();
  expect(release).not.toHaveBeenCalled();
});

it('passes awaited work admission to the provider with its logical lease', async () => {
  const gate = deferred();
  const finish = vi.fn(async () => {});
  const beginWork = vi.fn(async () => { await gate.promise; return finish; });
  const t = await setup({ acquire: async () => ({ claim: async () => {}, release: async () => {}, beginWork }) });
  await t.create();
  const start = t.starts.mock.calls[0]![0];
  let admitted = false;
  const pending = start.beginWork!({ kind: 'prompt', operationId: 'unique-operation' }).then((done) => { admitted = true; return done; });
  await vi.waitFor(() => expect(beginWork).toHaveBeenCalledOnce());
  expect(admitted).toBe(false);
  gate.resolve();
  await (await pending)();
  expect(finish).toHaveBeenCalledOnce();
  await t.dispose();
  await expect(start.beginWork!({ kind: 'prompt', operationId: 'later' })).rejects.toThrow('cannot admit work');
});

it('refuses new work while asynchronous disposal notification is pending', async () => {
  const notification = deferred();
  const beginWork = vi.fn(async () => async () => {});
  const lifetimes = sessionLifetimes({ acquire: async () => ({ claim: async () => {}, release: async () => {}, disposed: () => notification.promise, beginWork }) });
  await lifetimes.acquire({ provider: 'test', sessionUri: 'test:/one', chatUri: 'chat:/one' });
  lifetimes.started('chat:/one');
  const disposal = lifetimes.dispose('chat:/one');
  await expect(lifetimes.beginWork('chat:/one', { kind: 'prompt', operationId: 'one' })).rejects.toThrow('cannot admit work');
  expect(beginWork).not.toHaveBeenCalled();
  notification.resolve();
  await disposal;
});
