import { expect, it, vi } from 'vitest';
import type { Agent } from '@ahpd/sdk';
import { cliHistoryProvider } from '../src/cli-history.js';

const id = '11111111-2222-4333-8444-555555555555';
const identity = { host: 'fixture', user: '123' };
const uri = (provider = 'claude') => `ahpd-cli-history://${provider}/${id}?host=fixture&user=123`;
const turns = [{ id: 'old', message: { text: 'earlier' }, responseParts: [{ kind: 'tool-call', toolCall: { id: 'tool', result: 'synthetic', status: 'pending' } }] }];

it('reads exact prior Claude turns without creating a runtime', async () => {
 const create = vi.fn(() => { throw new Error('must not start'); });
 const transcript = vi.fn(async () => ({ format: 'claude-messages', history: { id, turns } }));
 const agent = { provider: 'claude', externalHistory: transcript, create } as unknown as Agent;
 const provider = cliHistoryProvider([agent], identity);
 const out = JSON.parse((await provider.read(uri())).data);
 expect(out).toMatchObject({ status: 'available', writable: false, nativeId: id, history: { id, turns } });
 expect(transcript).toHaveBeenCalledWith(id, expect.any(AbortSignal));
 expect(create).not.toHaveBeenCalled();
});

it('reads external unwatched Codex history through the explicit read capability', async () => {
 const history = { id, sessionId: 'different-root', turns };
 const externalHistory = vi.fn(async () => ({ format: 'codex-thread', history }));
 const agent = { provider: 'codex', externalHistory, transcript: vi.fn(async () => undefined), create: vi.fn() } as unknown as Agent;
 const out = JSON.parse((await cliHistoryProvider([agent], identity).read(uri('codex'))).data);
 expect(out).toMatchObject({ status: 'available', history });
 expect(agent.transcript).not.toHaveBeenCalled();
 expect(agent.create).not.toHaveBeenCalled();
});

it('refuses wrong identity, unavailable history, old capabilities and signed-in cross-user readers', async () => {
 const read = vi.fn(async () => { throw new Error('secret sentinel'); });
 const agent = { provider: 'claude', externalHistory: read } as unknown as Agent;
 const provider = cliHistoryProvider([agent, { provider: 'codex' } as Agent], identity);
 for (const target of [uri().replace('user=123', 'user=999'), uri().replace('host=fixture', 'host=other'), uri() + '&user=123', uri('codex')]) {
  expect(JSON.parse((await provider.read(target)).data)).toEqual({ version: 1, status: 'unavailable', writable: false });
 }
 expect(read).not.toHaveBeenCalled();
 expect((await provider.read(uri())).data).not.toContain('sentinel');
 expect(JSON.parse((await provider.read(uri(), undefined, { id: 'other', roles: [], can: () => true })).data).status).toBe('unavailable');
 expect(provider.authorize).toBeUndefined();
});

it('uses the normal resource read boundary and exposes no writer operation', async () => {
 const { createHost, fileResources } = await import('@ahpd/sdk');
 const { echo } = await import('../../../examples/echo/agent.js');
 const backend: Agent = { ...echo({path:'/fixture',pace:0}), provider:'claude', externalHistory:async () => ({format:'claude-messages', history:{id,turns}}), create:() => { throw new Error('runtime must not start'); } };
 const host = createHost({path:'/fixture', agents:[backend], resources:fileResources(), resourceProviders:{'ahpd-cli-history':cliHistoryProvider([backend],identity)}});
 const client = host.accept({send:()=>{},notify:()=>{},request:async()=>({}),answered:()=>{},close:()=>{}});
 try {
  await client.handle({method:'initialize',params:{clientId:'read-fixture',protocolVersions:['0.9.0']}});
  const read = await client.handle({method:'resourceRead',params:{channel:'ahp-root://',uri:uri()}}) as {data:string};
  expect(JSON.parse(read.data)).toMatchObject({status:'available',writable:false,history:{id,turns}});
  await expect(client.handle({method:'resourceWrite',params:{channel:'ahp-root://',uri:uri(),data:'takeover',encoding:'utf-8'}})).rejects.toMatchObject({code:-32601});
 } finally { await host.close(); }
});
