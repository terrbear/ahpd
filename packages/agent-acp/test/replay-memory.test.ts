import { expect, it } from 'vitest';
import type { SessionUpdate } from '@agentclientprotocol/sdk';
import { createHost } from '../../sdk/src/host.js';
import { REPLAY_BYTES } from '../../sdk/src/replay.js';
import type { Start } from '@ahpd/sdk';
import { echo } from '../../../examples/echo/agent.js';
import { mapUpdate } from '../src/mapping.js';
import type { AcpTurn } from '../src/types.js';

type Bag = Record<string, any>;

async function fixture() {
  const agent = echo({ path: '/tmp/replay-memory', pace: 0 });
  const create = agent.create;
  let start!: Start;
  let onSnapshot: (() => void) | undefined;
  const turn: AcpTurn = { turnId: 'turn', parts: [], calls: new Map() };
  agent.create = (given) => {
    start = given;
    const session = create(given);
    if (session instanceof Promise) throw new Error('Expected synchronous echo backend');
    return { ...session, allTurns: () => [{ id: 'turn', responseParts: turn.parts }], chatState: () => {
      onSnapshot?.();
      return { ...session.chatState(), turns: [{ id: 'turn', responseParts: turn.parts }] };
    } };
  };
  const host = createHost({ path: '/tmp/replay-memory', agents: [agent] });
  let delivered = 0;
  const connection = host.accept({
    send: () => {}, notify: (method) => { if (method === 'action') delivered++; },
    request: async () => ({}), answered: () => {}, close: () => {},
  });
  await connection.handle({ method: 'initialize', params: { clientId: 'memory', protocolVersions: ['0.9.0'] } });
  await connection.handle({ method: 'createSession', params: { channel: 'ahp-session:/memory', provider: 'echo' } });
  const channel = 'ahp-chat:/memory';
  const ask = (method: string, params: Bag = {}): Promise<Bag> => connection.handle({ method, params: { channel, ...params } }) as Promise<Bag>;
  const emit = (update: SessionUpdate): number => {
    const actions = mapUpdate(turn, update);
    for (const action of actions) start.emit('chat', action);
    return actions.length;
  };
  emit({ sessionUpdate: 'tool_call', toolCallId: 'tool', title: 'synthetic output', kind: 'execute', status: 'in_progress' });
  const reconnect = (since: number) => ask('reconnect', { channel: 'ahp-root://', clientId: 'memory', subscriptions: [channel], lastSeenServerSeq: since });
  return { host, ask, emit, reconnect, delivered: () => delivered, onSnapshot: (callback: () => void) => { onSnapshot = callback; } };
}

it('delivers every ACP terminal update and recovers by snapshot after byte eviction', async () => {
  const f = await fixture();
  try {
    const initial = await f.ask('subscribe');
    const before = f.delivered();
    const chunk = '界'.repeat(32 * 1024);
    for (let i = 0; i < 64; i++) {
      expect(f.emit({ sessionUpdate: 'tool_call_update', toolCallId: 'tool', _meta: { terminal_output_delta: { data: chunk } } })).toBe(1);
    }
    expect(f.delivered() - before).toBe(64);
    const recovery = await f.reconnect(initial.snapshot.fromSeq);
    expect(recovery.type).toBe('snapshot');
    const snapshot = recovery.snapshots[0];
    expect(snapshot.state.turns[0].responseParts[0].toolCall.content[0].text).toBe(chunk.repeat(64));
    f.emit({ sessionUpdate: 'tool_call_update', toolCallId: 'tool', _meta: { terminal_output_delta: { data: 'tail' } } });
    const recent = await f.reconnect(snapshot.fromSeq);
    expect(recent.type).toBe('replay');
    expect(recent.actions).toHaveLength(1);
    expect(recent.actions[0].action.content[0].text).toBe(chunk.repeat(64) + 'tail');
    const caughtUp = await f.reconnect(recent.actions[0].serverSeq);
    expect(caughtUp).toMatchObject({ type: 'replay', actions: [] });
  } finally { await f.host.close(); }
});

it('sends oversized actions live and snapshots across an empty replay buffer', async () => {
  const f = await fixture();
  try {
    const initial = await f.ask('subscribe');
    const before = f.delivered();
    const text = 'x'.repeat(REPLAY_BYTES / 2);
    f.emit({ sessionUpdate: 'tool_call_update', toolCallId: 'tool', content: [{ type: 'content', content: { type: 'text', text } }] });
    expect(f.delivered() - before).toBe(1);
    const recovery = await f.reconnect(initial.snapshot.fromSeq);
    expect(recovery.type).toBe('snapshot');
    expect(recovery.snapshots[0].state.turns[0].responseParts[0].toolCall.content[0].text).toBe(text);
    expect(await f.reconnect(recovery.snapshots[0].fromSeq)).toMatchObject({ type: 'replay', actions: [] });
  } finally { await f.host.close(); }
});

it('retakes a subscription snapshot if a large update evicts its catch-up action', async () => {
  const f = await fixture();
  try {
    let once = false;
    const text = 'x'.repeat(REPLAY_BYTES / 2);
    f.onSnapshot(() => {
      if (once) return;
      once = true;
      queueMicrotask(() => f.emit({ sessionUpdate: 'tool_call_update', toolCallId: 'tool', content: [{ type: 'content', content: { type: 'text', text } }] }));
    });
    const result = await f.ask('subscribe');
    expect(result.snapshot.state.turns[0].responseParts[0].toolCall.content[0].text).toBe(text);
    expect(await f.reconnect(result.snapshot.fromSeq)).toMatchObject({ type: 'replay', actions: [] });
  } finally { await f.host.close(); }
});
