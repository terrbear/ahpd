import type { Agent, Principal } from '@ahpd/sdk';
import { expect, test } from 'vitest';
import { subscriptionProvider } from '../src/subscription.js';

const uri = 'ahpd-subscription://codex';
const now = Date.now();
const usage = {
  status: 'verified', name: 'owner@example.com', reportedAt: new Date(now).toISOString(),
  windows: [{ used: 0.3, windowSeconds: 604800, resetsAt: new Date(now + 60_000).toISOString() }],
};
const codex = (answer?: unknown) => ({ provider: 'codex', subscriptionUsage: async () => answer }) as Agent;

test('read only returns verified, current usage and allowlisted fields', async () => {
  const provider = subscriptionProvider([codex({
    ...usage, auth: 'private', windows: [...usage.windows, { used: 0.1, windowSeconds: 18000, resetsAt: new Date(now - 1000).toISOString() }],
  })]);
  expect(JSON.parse((await provider.read(uri)).data)).toEqual(usage);
  expect(provider.write).toBeUndefined();
});

test('unknown adapters, malformed data, and non-root principals get no quota', async () => {
  for (const provider of [subscriptionProvider([]), subscriptionProvider([codex({ ...usage, name: 'invalid name' })])]) {
    expect(JSON.parse((await provider.read(uri)).data)).toEqual({ status: 'unavailable' });
  }
  const provider = subscriptionProvider([codex(usage)]);
  expect(JSON.parse((await provider.read(uri + '?cwd=/tmp')).data)).toEqual({ status: 'unavailable' });
  expect(JSON.parse((await provider.read(uri, undefined, {} as Principal)).data)).toEqual({ status: 'unavailable' });
});
