import { afterEach, expect, it, vi } from 'vitest';
import type { ToolCall } from '@agentclientprotocol/sdk';
import type { BoundTool } from '@ahpd/sdk';
import { clientTools } from '../src/clienttools.js';

const tool: BoundTool = {
  owner: 'anton-ahp_test',
  definition: { name: 'anton-ahp_test__anton_codemode' },
};
const input = { code: 'return anton.help();' };
const report = (id: string): ToolCall => ({
  toolCallId: id,
  title: `mcp.ahp.${tool.definition.name}`,
  rawInput: { server: 'ahp', tool: tool.definition.name, arguments: input },
});

afterEach(() => { vi.useRealTimers(); });

it('removes an expired report waiter before the next read-only invocation', async () => {
  vi.useFakeTimers();
  const bridge = clientTools();
  bridge.set([tool]);
  const expired = bridge.run({ tool, input }, () => {});
  const failure = expect(expired).rejects.toThrow(/tool=anton-ahp_test__anton_codemode, client=anton-ahp_test, state=awaiting-agent-report, toolCallId=unavailable/);
  await vi.advanceTimersByTimeAsync(30_000);
  await failure;
  expect(bridge.clientOf(report('call-after-timeout'))).toBe(tool.owner);
  const started = vi.fn();
  const next = bridge.run({ tool, input }, started);
  await Promise.resolve();
  expect(started).toHaveBeenCalledWith('call-after-timeout');
  expect(bridge.complete('call-after-timeout', tool.owner!, { text: 'catalog', ok: true })).toBe(true);
  await expect(next).resolves.toEqual({ text: 'catalog', ok: true });
});

it('releases a waiting report on disconnect without consuming a reconnected call', async () => {
  vi.useFakeTimers();
  const bridge = clientTools();
  bridge.set([tool]);
  const pending = bridge.run({ tool, input }, () => {});
  const failure = expect(pending).rejects.toThrow(/disconnected/);
  bridge.release('Anton disconnected', tool.owner);
  await Promise.resolve();
  expect(vi.getTimerCount()).toBe(0);
  await failure;
  bridge.set([]);
  bridge.set([tool]);
  expect(bridge.clientOf(report('call-reconnected'))).toBe(tool.owner);
  const started = vi.fn();
  const next = bridge.run({ tool, input }, started);
  await Promise.resolve();
  expect(started).toHaveBeenCalledWith('call-reconnected');
  expect(bridge.complete('call-reconnected', tool.owner!, { text: 'catalog', ok: true })).toBe(true);
  await expect(next).resolves.toEqual({ text: 'catalog', ok: true });
});

it('accepts immediate completion when publishing the execution request', async () => {
  const bridge = clientTools();
  bridge.set([tool]);
  bridge.clientOf(report('call-immediate'));
  const next = bridge.run({ tool, input }, (id) => {
    expect(bridge.complete(id, tool.owner!, { text: 'catalog', ok: true })).toBe(true);
  });
  await expect(next).resolves.toEqual({ text: 'catalog', ok: true });
});

it('cancels a claimed call before dispatch when the client disconnects in the same tick', async () => {
  const bridge = clientTools();
  bridge.set([tool]);
  bridge.clientOf(report('call-cancelled-before-dispatch'));
  const started = vi.fn();
  const next = bridge.run({ tool, input }, started);
  bridge.release('Anton disconnected', tool.owner);
  await expect(next).resolves.toMatchObject({ ok: false, text: expect.stringContaining('toolCallId=call-cancelled-before-dispatch') });
  expect(started).not.toHaveBeenCalled();
  expect(bridge.complete('call-cancelled-before-dispatch', tool.owner!, { text: 'late result', ok: true })).toBe(false);
});

it('cancels an already claimed call when its turn ends before dispatch', async () => {
  const bridge = clientTools();
  bridge.set([tool]);
  bridge.clientOf(report('call-ended'));
  const started = vi.fn();
  const next = bridge.run({ tool, input }, started);
  bridge.release('The turn ended');
  await expect(next).resolves.toMatchObject({ ok: false, text: expect.stringContaining('state=cancelled-before-dispatch') });
  expect(started).not.toHaveBeenCalled();
});

it('releases only the disconnected client and rejects its late result without replay', async () => {
  const bridge = clientTools();
  const other = { ...tool, owner: 'another-client', definition: { name: 'another-client__anton_codemode' } };
  bridge.set([tool, other]);
  const started = vi.fn();
  bridge.clientOf(report('call-disconnected'));
  const gone = bridge.run({ tool, input }, started);
  bridge.clientOf({ ...report('call-other'), title: `mcp.ahp.${other.definition.name}` });
  const retained = bridge.run({ tool: other, input }, started);
  await Promise.resolve();
  bridge.release('Anton disconnected', tool.owner);
  await expect(gone).resolves.toMatchObject({ ok: false, text: expect.stringContaining('toolCallId=call-disconnected, client=anton-ahp_test, state=awaiting-client-result') });
  expect(bridge.complete('call-disconnected', tool.owner!, { text: 'late', ok: true })).toBe(false);
  expect(bridge.complete('call-other', other.owner, { text: 'catalog', ok: true })).toBe(true);
  await expect(retained).resolves.toEqual({ text: 'catalog', ok: true });
  expect(started).toHaveBeenCalledTimes(2);
});

it('does not reuse an early result or unclaimed report from a disconnected client', async () => {
  vi.useFakeTimers();
  const bridge = clientTools();
  bridge.set([tool]);
  bridge.clientOf(report('call-old'));
  expect(bridge.complete('call-old', tool.owner!, { text: 'old catalog', ok: true })).toBe(true);
  bridge.release('Anton disconnected', tool.owner);
  bridge.set([]);
  bridge.set([tool]);
  const started = vi.fn();
  const next = bridge.run({ tool, input }, started);
  await Promise.resolve();
  expect(started).not.toHaveBeenCalled();
  bridge.clientOf(report('call-new'));
  await Promise.resolve();
  expect(started).toHaveBeenCalledWith('call-new');
  expect(bridge.complete('call-new', tool.owner!, { text: 'new catalog', ok: true })).toBe(true);
  await expect(next).resolves.toEqual({ text: 'new catalog', ok: true });
  expect(vi.getTimerCount()).toBe(0);
});

it('reports dispatch failure with the call ID and releases the result handler', async () => {
  const bridge = clientTools();
  bridge.set([tool]);
  bridge.clientOf(report('call-dispatch-failed'));
  const next = bridge.run({ tool, input }, () => { throw new Error('connection closed'); });
  await expect(next).rejects.toThrow('toolCallId=call-dispatch-failed, client=anton-ahp_test, state=dispatch-failed: connection closed');
  expect(bridge.owner('call-dispatch-failed')).toBeUndefined();
  expect(bridge.complete('call-dispatch-failed', tool.owner!, { text: 'late', ok: true })).toBe(false);
});
