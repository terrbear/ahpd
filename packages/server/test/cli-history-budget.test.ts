import { afterEach, expect, it, vi } from 'vitest';
import type { Agent } from '@ahpd/sdk';
import { cliHistoryProvider } from '../src/cli-history.js';

const sdk = vi.hoisted(() => ({ listSessions: vi.fn(), getSessionMessages: vi.fn() }));
vi.mock('@anthropic-ai/claude-agent-sdk', () => sdk);
const { readExternalHistory } = await import('../../agent-claude/src/external-history.js');
const id = '11111111-2222-4333-8444-555555555555';
const other = 'aaaaaaaa-2222-4333-8444-555555555555';
const identity = { host: 'fixture', user: '123' };
const uri = (nativeId = id) => `ahpd-cli-history://claude/${nativeId}?host=fixture&user=123`;
const unavailable = { version: 1, status: 'unavailable', writable: false };
const rows = [{ sessionId: id, lastModified: 1 }];
const messages = [{ session_id: id, type: 'assistant', message: { content: 'prior synthetic history' } }];

function deferred<T>() {
 let resolve!: (value: T) => void;
 let reject!: (reason: Error) => void;
 const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
 return { promise, resolve, reject };
}

afterEach(() => { vi.useRealTimers(); vi.resetAllMocks(); });

it.each([
 ['catalogue', 'resolve'], ['catalogue', 'reject'], ['history', 'resolve'], ['history', 'reject'],
] as const)('bounds stalled %s across same/different IDs until late %s', async (stage, settlement) => {
 vi.useFakeTimers();
 const stalled = deferred<any[]>();
 sdk.listSessions.mockResolvedValue(rows);
 sdk.getSessionMessages.mockResolvedValue(messages);
 const backend = stage === 'catalogue' ? sdk.listSessions : sdk.getSessionMessages;
 backend.mockReturnValueOnce(stalled.promise);
 const read = vi.fn(readExternalHistory);
 const agent = { provider: 'claude', externalHistory: (nativeId, signal) => read(nativeId, ['/fixture'], signal) } as Agent;
 const handler = cliHistoryProvider([agent], identity);
 let result: string | undefined;
 const pending = handler.read(uri()).then(reply => { result = reply.data; });
 const concurrent = await Promise.all([uri(), uri(other), uri()].map(target => handler.read(target)));
 expect(concurrent.map(reply => JSON.parse(reply.data))).toEqual([unavailable, unavailable, unavailable]);
 await vi.advanceTimersByTimeAsync(10001);
 expect(result).toBe(JSON.stringify(unavailable));
 await pending;
 for (let i = 0; i < 20; i++) {
  const nativeId = i % 2 ? id : `${i.toString(16).padStart(8, '0')}-2222-4333-8444-555555555555`;
  expect(JSON.parse((await handler.read(uri(nativeId))).data)).toEqual(unavailable);
 }
 expect(read).toHaveBeenCalledTimes(1);
 expect(sdk.listSessions).toHaveBeenCalledTimes(1);
 expect(sdk.getSessionMessages).toHaveBeenCalledTimes(stage === 'catalogue' ? 0 : 1);
 if (settlement === 'reject') stalled.reject(new Error('credential/provider sentinel'));
 else stalled.resolve(stage === 'catalogue' ? rows : messages);
 await vi.advanceTimersByTimeAsync(0);
 expect(sdk.getSessionMessages).toHaveBeenCalledTimes(stage === 'catalogue' ? 0 : 1);
 expect(JSON.parse((await handler.read(uri())).data)).toMatchObject({status:'available', history:{id, turns:messages}});
 expect(read).toHaveBeenCalledTimes(2);
 expect(vi.getTimerCount()).toBe(0);
});

it('holds the slot after disconnect and releases it after a late rejection without leaking errors', async () => {
 vi.useFakeTimers();
 const { createHost, fileResources } = await import('@ahpd/sdk');
 const { echo } = await import('../../../examples/echo/agent.js');
 const stalled = deferred<never>();
 const externalHistory = vi.fn().mockReturnValueOnce(stalled.promise).mockResolvedValue({format:'claude-messages',history:{id,turns:messages}});
 const agent: Agent = {...echo({path:'/fixture',pace:0}), provider:'claude', externalHistory, create:() => {throw new Error('must not create');}};
 const handler = cliHistoryProvider([agent], identity);
 const host = createHost({path:'/fixture',agents:[agent],resources:fileResources(),resourceProviders:{'ahpd-cli-history':handler}});
 const client = host.accept({send:()=>{},notify:()=>{},request:async()=>({}),answered:()=>{},close:()=>{}});
 try {
  await client.handle({method:'initialize',params:{clientId:'fixture',protocolVersions:['0.9.0']}});
  let reply: unknown;
  const pending = client.handle({method:'resourceRead',params:{channel:'ahp-root://',uri:uri()}}).then(value => {reply=value;});
  await vi.advanceTimersByTimeAsync(1);
  client.close();
  await vi.advanceTimersByTimeAsync(10000);
  expect(reply).toMatchObject({data:JSON.stringify(unavailable)});
  await pending;
  expect(JSON.parse((await handler.read(uri(other))).data)).toEqual(unavailable);
  expect(externalHistory).toHaveBeenCalledTimes(1);
  stalled.reject(new Error('credential/provider sentinel'));
  await vi.advanceTimersByTimeAsync(0);
  expect(JSON.parse((await handler.read(uri())).data).status).toBe('available');
  expect(externalHistory).toHaveBeenCalledTimes(2);
 } finally {await host.close();}
});

it('signals supported cancellation at the deadline and recovers after the backend settles', async () => {
 vi.useFakeTimers();
 const aborted = vi.fn();
 const externalHistory = vi.fn((_id: string, signal?: AbortSignal) => new Promise<undefined>(resolve => {
  signal?.addEventListener('abort', () => {aborted(); resolve(undefined);}, {once:true});
 }));
 const handler = cliHistoryProvider([{provider:'claude',externalHistory} as unknown as Agent],identity);
 let reply: string | undefined;
 const pending = handler.read(uri()).then(value => {reply=value.data;});
 await vi.advanceTimersByTimeAsync(10001);
 expect(reply).toBe(JSON.stringify(unavailable));
 await pending;
 expect(aborted).toHaveBeenCalledTimes(1);
 externalHistory.mockResolvedValueOnce(undefined);
 expect(JSON.parse((await handler.read(uri(other))).data)).toEqual(unavailable);
 expect(externalHistory).toHaveBeenCalledTimes(2);
 expect(vi.getTimerCount()).toBe(0);
});
