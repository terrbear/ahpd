import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createHost } from '../src/host.js';
import { echo } from '../../../examples/echo/agent.js';
import type { Peer } from '../src/types/rpc.js';
import { checker } from '../../../tools/wire.mjs';

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

it.each([false, true])('only acknowledges an absent turn when idle: active=%s', async (active) => {
  const path = mkdtempSync(join(tmpdir(), 'ahpd-cancel-idle-'));
  cleanups.push(() => rmSync(path, { recursive: true, force: true }));
  const backend = echo({ path, pace: 1000 });
  const cancel = vi.fn();
  const host = createHost({ path, agents: [{ ...backend, create: (start) => ({ ...backend.create(start), cancel }) }] });
  cleanups.push(() => host.close());
  const notes: { method: string; params: unknown }[] = [];
  const peer: Peer = { send: () => {}, notify: (method, params) => { notes.push({ method, params }); }, request: async () => ({}), answered: () => {}, close: () => {} };
  const client = host.accept(peer);
  await client.handle({ method: 'initialize', params: { clientId: 'cancel-probe', protocolVersions: ['0.9.0'], initialSubscriptions: ['ahp-root://'] } });
  await client.handle({ method: 'createSession', params: { channel: 'echo:/cancel-idle', provider: 'echo' } });
  const session = await client.handle({ method: 'subscribe', params: { channel: 'echo:/cancel-idle' } }) as { snapshot: { state: { defaultChat: string } } };
  const channel = session.snapshot.state.defaultChat;
  await client.handle({ method: 'subscribe', params: { channel } });
  if (active) await client.handle({ method: 'dispatchAction', params: { channel, action: { type: 'chat/turnStarted', turnId: 'running', message: { text: 'synthetic active turn' } } } });
  await client.handle({ method: 'dispatchAction', params: { channel, clientSeq: 42, action: { type: 'chat/turnCancelled', turnId: 'unconfirmed' } } });
  const receipt = notes.find((note) => {
    const p = note.params as { origin?: { clientSeq: number }; action?: { type: string } };
    return note.method === 'action' && p.origin?.clientSeq === 42 && p.action?.type === 'chat/turnCancelled';
  });
  expect(cancel).toHaveBeenCalledExactlyOnceWith('unconfirmed');
  if (active) expect(receipt).toBeUndefined();
  else {
    expect(receipt).toBeDefined();
    expect(checker().frame({ jsonrpc: '2.0', ...receipt })).toEqual([]);
  }
  const snapshot = await client.handle({ method: 'subscribe', params: { channel } }) as { snapshot: { state: { activeTurn?: unknown; turns: unknown[] } } };
  if (active) expect(snapshot.snapshot.state.activeTurn).toBeDefined();
  else expect(snapshot.snapshot.state.activeTurn).toBeUndefined();
  expect(snapshot.snapshot.state.turns).toEqual([]);
});
