import { expect, it } from 'vitest';
import type { SessionUpdate } from '@agentclientprotocol/sdk';
import { mapUpdate } from '../src/mapping.js';
import { turnsOf } from '../src/transcript.js';
import type { AcpTurn, WatchedSession } from '../src/types.js';

const url = 'https://github.com/trustgrid/anton/pull/3325';
const updates: SessionUpdate[] = [
  { sessionUpdate: 'tool_call', toolCallId: 'create', title: 'gh pr create --draft --fill', kind: 'execute', status: 'in_progress', rawInput: { command: 'gh pr create --draft --fill' } },
  { sessionUpdate: 'tool_call_update', toolCallId: 'create', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: url } }] },
];

it('retains tool arguments and results in live and restored snapshots', () => {
  const turn: AcpTurn = { turnId: 'turn', parts: [], calls: new Map() };
  for (const update of updates) mapUpdate(turn, update);
  const expected = { toolCall: { toolInput: JSON.stringify({ command: 'gh pr create --draft --fill' }), status: 'completed', success: true, content: [{ type: 'text', text: url }] } };
  expect(turn.parts).toMatchObject([expected]);
  const record = { turns: [{ turnId: 'turn', startedAt: '2026-10-12T00:00:00Z', message: { text: 'create it' }, updates, state: 'complete' }] } as WatchedSession;
  expect(turnsOf(record)[0]!.responseParts).toMatchObject([expected]);
});

it('retains an updated input and result when completion omits content', () => {
  const turn: AcpTurn = { turnId: 'turn', parts: [], calls: new Map() };
  mapUpdate(turn, updates[0]!);
  mapUpdate(turn, { sessionUpdate: 'tool_call_update', toolCallId: 'create', rawInput: { command: 'gh pr create --fill' }, content: [{ type: 'content', content: { type: 'text', text: url } }] });
  const actions = mapUpdate(turn, { sessionUpdate: 'tool_call_update', toolCallId: 'create', status: 'completed' });
  expect(turn.parts).toMatchObject([{ toolCall: { toolInput: JSON.stringify({ command: 'gh pr create --fill' }), content: [{ type: 'text', text: url }] } }]);
  expect(actions).toMatchObject([{ result: { content: [{ type: 'text', text: url }] } }]);
});

it('retains the Codex terminal output delta used for gh pr create across replay', () => {
  const turn: AcpTurn = { turnId: 'turn', parts: [], calls: new Map() };
  const wire: SessionUpdate[] = [
    updates[0]!,
    { sessionUpdate: 'tool_call_update', toolCallId: 'create', _meta: { terminal_output_delta: { data: url.slice(0, 25), terminal_id: 'create' } } },
    { sessionUpdate: 'tool_call_update', toolCallId: 'create', _meta: { terminal_output_delta: { data: url.slice(25) + '\n', terminal_id: 'create' } } },
    { sessionUpdate: 'tool_call_update', toolCallId: 'create', status: 'completed', _meta: { terminal_exit: { exit_code: 0, terminal_id: 'create' } } },
  ];
  for (const update of wire) mapUpdate(turn, update);
  expect(turn.parts).toMatchObject([{ toolCall: { content: [{ text: url + '\n' }] } }]);
  const record = { turns: [{ turnId: 'turn', startedAt: '2026-10-12T00:00:00Z', message: { text: 'create it' }, updates: wire, state: 'complete' }] } as WatchedSession;
  expect(turnsOf(record)[0]!.responseParts).toEqual(turn.parts);
});
