import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHost } from '../src/host.js';
import { hostTools } from '../src/tools.js';
import { acpAgent } from '../../agent-acp/src/index.js';
import type { Start } from '../src/types/agent.js';
import type { Bag } from '../src/types/common.js';
import type { Peer } from '../src/types/rpc.js';

const fixture = fileURLToPath(new URL('../../agent-acp/test/fixtures/acp-server.mjs', import.meta.url));
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });

async function talking() {
  const path = mkdtempSync(join(tmpdir(), 'ahpd-delivery-'));
  const log = join(path, 'acp.jsonl');
  const starts = new Map<string, Start>();
  const base = acpAgent({ command: process.execPath, args: [fixture], provider: 'codex', env: { ACP_LOG: log } });
  const host = createHost({ path, agents: [{ ...base, create: (start) => {
    starts.set(start.uri, start);
    return base.create(start);
  } }], tools: hostTools() });
  cleanups.push(async () => { await host.close(); rmSync(path, { recursive: true, force: true }); });
  const peer: Peer = { send: () => {}, notify: () => {}, request: async () => ({}), answered: () => {}, close: () => {} };
  const client = host.accept(peer);
  await client.handle({ method: 'initialize', params: { clientId: 'coordinator', protocolVersions: ['0.9.0'] } });
  for (const id of ['caller', 'target']) {
    await client.handle({ method: 'createSession', params: { channel: `codex:/${id}`, provider: 'codex' } });
  }
  const state = async (channel: string): Promise<Bag> => {
    const result = await client.handle({ method: 'subscribe', params: { channel } }) as { snapshot: { state: Bag } };
    return result.snapshot.state;
  };
  const chat = String((await state('codex:/target')).defaultChat);
  const call = async (name: string, input: Bag): Promise<Bag> => {
    const tool = starts.get('codex:/caller')?.tools?.find((one) => one.definition.name === name);
    if (tool?.run === undefined) throw new Error(`Missing collaboration tool ${name}`);
    const answer = await tool.run(input);
    try { return JSON.parse(answer) as Bag; }
    catch { return { text: answer }; }
  };
  const begin = async (text: string) => client.handle({ method: 'dispatchAction', params: {
    channel: chat, action: { type: 'chat/turnStarted', turnId: 'busy-turn', message: { text } },
  } });
  const requests = () => readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as Bag);
  return { host, client, state, chat, call, begin, requests, starts };
}

it('returns the exact busy Codex queue identity and exposes it without settling the permission', async () => {
  const t = await talking();
  await t.begin('ask');
  await expect.poll(async () => (((await t.state(t.chat)).activeTurn as Bag)?.responseParts as Bag[])?.find((part) => (part.toolCall as Bag)?.toolCallId === 'call-perm')?.toolCall).toMatchObject({ status: 'pending-confirmation' });
  const before = await t.state(t.chat);
  const receipt = await t.call('send_message', { session: 'codex:/target', message: 'old validation' });
  expect(receipt.deliveryId).toEqual(expect.any(String));
  expect(receipt).toMatchObject({ resource: 'codex:/target', chat: t.chat, state: 'queued', position: 1 });
  const context = await t.call('get_session_context', { session: 'codex:/target', detail: 'summary' });
  expect(context.deliveries).toEqual(expect.arrayContaining([expect.objectContaining({ deliveryId: receipt.deliveryId, state: 'queued' })]));
  expect((await t.state(t.chat)).activeTurn).toEqual(before.activeTurn);
});

it('supersedes old validation while a real ACP permission stays held and hands off only the correction once', async () => {
  const t = await talking();
  await t.begin('ask');
  const permission = async () => (((await t.state(t.chat)).activeTurn as Bag)?.responseParts as Bag[])?.find((part) => (part.toolCall as Bag)?.toolCallId === 'call-perm')?.toolCall;
  await expect.poll(permission).toMatchObject({ status: 'pending-confirmation' });
  const old = await t.call('send_message', { session: 'codex:/target', message: 'old validation' });
  const current = await t.call('send_message', { session: 'codex:/target', message: 'checks already passed; report only', supersedes: old.deliveryId });
  expect(current).toMatchObject({ state: 'queued', queueId: old.queueId, position: 1 });
  expect(await permission()).toMatchObject({ status: 'pending-confirmation' });
  expect(t.requests().filter((one) => one.method === 'session/prompt')).toHaveLength(1);
  await t.client.handle({ method: 'dispatchAction', params: { channel: t.chat, action: {
    type: 'chat/toolCallConfirmed', turnId: 'busy-turn', toolCallId: 'call-perm', approved: false, selectedOptionId: 'no-once',
  } } });
  await expect.poll(() => t.requests().filter((one) => one.method === 'session/prompt').length).toBe(2);
  await expect.poll(async () => (await t.state(t.chat)).activeTurn).toBeUndefined();
  const prompts = t.requests().filter((one) => one.method === 'session/prompt');
  expect(JSON.stringify(prompts)).toContain('checks already passed; report only');
  expect(JSON.stringify(prompts)).not.toContain('old validation');
  const context = await t.call('get_session_context', { session: 'codex:/target' });
  expect(context.deliveries).toEqual(expect.arrayContaining([
    expect.objectContaining({ deliveryId: old.deliveryId, state: 'superseded', supersededBy: current.deliveryId }),
    expect.objectContaining({ deliveryId: current.deliveryId, state: 'consumed', turnId: expect.any(String) }),
  ]));
  const turns = (await t.state(t.chat)).turns as Bag[];
  const accepted = turns.find((turn) => (turn.message as Bag)?.text === 'checks already passed; report only');
  expect(accepted?.message).toMatchObject({ origin: { kind: 'agent' }, _meta: { 'vscode.chat.delegation': { sourceSession: 'codex:/caller' } } });
  expect(JSON.stringify(turns)).toContain('perm=no-once');
  expect(JSON.stringify(turns)).not.toContain('perm=yes');
});

it('bounds an explicit exact-turn stop, retains the queued message and never silently delivers it', async () => {
  const t = await talking();
  await t.begin('wait');
  await expect.poll(() => t.requests().filter((one) => one.method === 'session/prompt').length).toBe(1);
  const queued = await t.call('send_message', { session: 'codex:/target', message: 'queued validation' });
  const outcome = await t.call('interrupt_session', { session: 'codex:/target', turnId: 'busy-turn' });
  expect(outcome).toMatchObject({ state: 'confirmed', turnId: 'busy-turn', queueRetained: true });
  expect((await t.state(t.chat)).queuedMessages).toMatchObject([{ id: queued.queueId }]);
  expect(t.requests().filter((one) => one.method === 'session/prompt')).toHaveLength(1);
  const correction = await t.call('send_message', { session: 'codex:/target', message: 'current instruction', supersedes: queued.deliveryId });
  expect(correction.state).toBe('consumed');
  await expect.poll(() => t.requests().filter((one) => one.method === 'session/prompt').length).toBe(2);
  expect(JSON.stringify(t.requests().filter((one) => one.method === 'session/prompt'))).not.toContain('queued validation');
  expect(t.requests().filter((one) => one.method === 'session/cancel')).toHaveLength(1);
});

it('rejects unsupported steering and invalid control identities without touching the busy ACP owner', async () => {
  const t = await talking();
  await t.begin('wait');
  await expect.poll(() => t.requests().filter((one) => one.method === 'session/prompt').length).toBe(1);
  const context = await t.call('get_session_context', { session: 'codex:/target' });
  expect(context.capabilities).toMatchObject({ delegatedMidTurnSteering: false, interruptRequiresExpectedTurnId: true });
  const tool = t.starts.get('codex:/caller')?.tools?.find((one) => one.definition.name === 'interrupt_session');
  await expect(tool?.run?.({ session: 'codex:/target', turnId: 'stale-turn' })).rejects.toThrow(/not the active turn/);
  await expect(tool?.run?.({ session: 'codex:/caller', turnId: 'busy-turn' })).rejects.toThrow(/current calling chat/);
  const send = t.starts.get('codex:/caller')?.tools?.find((one) => one.definition.name === 'send_message');
  await expect(send?.run?.({ session: 'codex:/target', message: 'correction', supersedes: 'unknown' })).rejects.toThrow(/not your confirmed pending/);
  expect(t.requests().filter((one) => one.method === 'session/cancel')).toHaveLength(0);
  expect(t.requests().filter((one) => one.method === 'session/prompt')).toHaveLength(1);
});
