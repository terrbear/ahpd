import { expect, it } from 'vitest';
import { createHost } from '../src/host.js';
import { echo } from '../../../examples/echo/agent.js';
import type { Agent, Start } from '../src/types/agent.js';
import type { Peer } from '../src/types/rpc.js';

const KEY = 'ahpd.clientSystemInstructions';
const DIR = '/tmp/ahpd-client-system-instructions';

const peer = (): Peer => ({ send: () => {}, notify: () => {}, request: async () => ({}), answered: () => {}, close: () => {} });

const host = () => {
  const starts: Start[] = [];
  const make = (provider: string, acceptsSystemInstructions: boolean): Agent => {
    const base = echo({ path: DIR, pace: 0 });
    return {
      ...base,
      provider,
      multipleDirectories: true,
      ...(acceptsSystemInstructions ? { acceptsSystemInstructions: true } : {}),
      create: (start) => {
        starts.push(start);
        return base.create(start);
      },
    };
  };
  const held = createHost({ path: DIR, agents: [make('supported', true), make('legacy', false)] });
  return { held, starts };
};

it('advertises support by provider and passes accepted instructions to each chat', async () => {
  const { held, starts } = host();
  const client = held.accept(peer());
  const initialized = await client.handle({ method: 'initialize', params: { clientId: 'anton', protocolVersions: ['0.9.0'] } }) as { _meta: Record<string, unknown> };
  expect(initialized._meta[KEY]).toEqual(['supported']);
  const result = await client.handle({
    method: 'createSession',
    params: { channel: 'ahp-session:/accepted', provider: 'supported', _meta: { [KEY]: 'Follow these instructions.' } },
  });
  expect(result).toEqual({});
  expect(starts[0]?.instructions).toContain('Follow these instructions.');
  await client.handle({ method: 'createChat', params: { channel: 'ahp-session:/accepted', chat: 'ahp-chat:/second' } });
  expect(starts[1]?.instructions).toContain('Follow these instructions.');
  await client.handle({ method: 'createSession', params: { channel: 'ahp-session:/legacy', provider: 'legacy' } });
  expect(starts[2]?.instructions).toBeUndefined();
});

it('retains accepted instructions when the host restarts a session to add a directory', async () => {
  const { held, starts } = host();
  const client = held.accept(peer());
  await client.handle({ method: 'initialize', params: { clientId: 'anton', protocolVersions: ['0.9.0'] } });
  await client.handle({
    method: 'createSession',
    params: { channel: 'ahp-session:/restarted', provider: 'supported', _meta: { [KEY]: 'Keep this on restart.' } },
  });
  await client.handle({
    method: 'dispatchAction',
    params: {
      channel: 'ahp-session:/restarted',
      action: { type: 'session/workingDirectorySet', directory: `file://${DIR}/extra` },
    },
  });
  await expect.poll(() => starts.length).toBe(2);
  expect(starts[1]?.instructions).toContain('Keep this on restart.');
});

it('rejects unsupported and invalid instructions before creating a session', async () => {
  const { held, starts } = host();
  const client = held.accept(peer());
  await client.handle({ method: 'initialize', params: { clientId: 'anton', protocolVersions: ['0.9.0'] } });
  const cases: Array<{ provider: string; instructions: unknown }> = [
    { provider: 'legacy', instructions: 'Do this.' },
    { provider: 'supported', instructions: null },
    { provider: 'supported', instructions: '' },
    { provider: 'supported', instructions: 'é'.repeat(70_000) },
  ];
  for (const [index, one] of cases.entries()) {
    const channel = `ahp-session:/rejected-${index}`;
    await expect(client.handle({
      method: 'createSession',
      params: { channel, provider: one.provider, _meta: { [KEY]: one.instructions } },
    })).rejects.toMatchObject({ code: -32602 });
    await client.handle({ method: 'createSession', params: { channel, provider: one.provider } });
  }
  expect(starts).toHaveLength(cases.length);
  expect(starts.every((start) => !start.instructions?.includes('Do this.'))).toBe(true);
});
