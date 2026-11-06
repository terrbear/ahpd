import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { createHost } from '../../sdk/src/host.js';
import { acpAgent } from '../src/index.js';
import type { Peer } from '../../sdk/src/types/rpc.js';

it('delivers human steering over ACP without cancelling or creating another turn', async () => {
  const notes: { method: string; params: unknown }[] = [];
  const peer: Peer = { send: () => {}, notify: (method, params) => notes.push({ method, params }), request: async () => ({}), answered: () => {}, close: async () => {} };
  const path = mkdtempSync(join(tmpdir(), 'ahpd-steering-'));
  const host = createHost({ path, agents: [acpAgent({ command: process.execPath, args: [fileURLToPath(new URL('./fixtures/steering.mjs', import.meta.url))], provider: 'codex', stateDirectory: path })] });
  const client = host.accept(peer);
  const uri = 'codex:/steering';
  try {
    const init = await client.handle({ method: 'initialize', params: { clientId: 'fixture-client', protocolVersions: ['0.9.0'] } }) as Record<string, unknown>;
    expect((init._meta as Record<string, unknown>)['ahpd.humanSteering']).toMatchObject({ version: 1 });
    await client.handle({ method: 'createSession', params: { channel: uri, provider: 'codex' } });
    const session = await client.handle({ method: 'subscribe', params: { channel: uri } }) as { snapshot: { state: { defaultChat: string } } };
    const actualChat = session.snapshot.state.defaultChat;
    await client.handle({ method: 'subscribe', params: { channel: actualChat } });
    await client.handle({ method: 'dispatchAction', params: { channel: actualChat, clientSeq: 1, action: { type: 'chat/turnStarted', turnId: 'initial', message: { text: 'first command, then continue' } } } });
    await expect.poll(() => notes.some((n) => JSON.stringify(n.params).includes('First command'))).toBe(true);
    await client.handle({ method: 'dispatchAction', params: { channel: actualChat, clientSeq: 2, action: { type: 'chat/pendingMessageSet', kind: 'steering', id: 'correction', message: { text: 'stop after this command', origin: { kind: 'user' } } } } });
    await expect.poll(() => notes.some((n) => {
      const p = n.params as { action?: { type?: string; id?: string } };
      return p.action?.type === 'chat/pendingMessageRemoved' && p.action.id === 'correction';
    })).toBe(true);
    const snapshot = await client.handle({ method: 'subscribe', params: { channel: actualChat } }) as { snapshot: { state: { _meta: Record<string, unknown>; turns: { id: string }[]; activeTurn?: unknown } } };
    expect(snapshot.snapshot.state._meta['ahpd.humanSteering']).toMatchObject({ version: 1, receipts: [{ id: 'correction', turnId: 'initial', status: 'injected' }] });
    await expect.poll(async () => {
      const value = await client.handle({ method: 'subscribe', params: { channel: actualChat } }) as typeof snapshot;
      return value.snapshot.state.turns.map((t) => t.id);
    }).toEqual(['initial']);
    expect(notes.some((n) => JSON.stringify(n.params).includes('Applied correction before the next command'))).toBe(true);
  } finally {
    await client.handle({ method: 'disposeSession', params: { channel: uri } });
  }
});
