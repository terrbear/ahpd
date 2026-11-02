import { expect, it, vi } from 'vitest';
import { assertDiagnosticTarget, sessionExecutionDiagnostics } from '../src/sessiondiagnostics.js';
import { sessionTools } from '../src/sessiontools.js';
import type { Bag } from '../src/types/common.js';
import type { ToolCall } from '../src/types/host.js';

const part = (id: string, status = 'running', clientId = 'client-1'): Bag => ({
  kind: 'toolCall', toolCall: {
    toolCallId: id, toolName: 'anton_codemode', status, contributor: { kind: 'client', clientId },
    toolInput: 'INPUT-SECRET', result: 'OUTPUT-SECRET', _meta: { token: 'META-SECRET' }, error: { text: 'ERROR-SECRET' },
  },
});
const source = () => ({
  session: 'claude:/owned', chat: 'ahp-chat:/owned',
  snapshot: { turns: [], activeTurn: { id: 'turn-1', responseParts: [part('call-1')] } },
  inputNeeded: [{ kind: 'toolClientExecution', id: 'call-1:client', chat: 'ahp-chat:/owned', turnId: 'turn-1', clientId: 'client-1',
    toolCall: { toolCallId: 'call-1', toolName: 'anton_codemode', contributor: { kind: 'client', clientId: 'client-1' }, toolInput: 'REQUEST-SECRET' } }],
  activeClients: [{ clientId: 'client-1', tools: [{ name: 'anton_codemode', inputSchema: { secret: 'SCHEMA-SECRET' } }] }],
  connectedClients: new Set(['client-1']),
});
const first = (answer: Bag) => (answer.calls as Bag[])[0]!;

it('reports observed pending execution identities without serializing any content fields', () => {
  const probe = vi.fn(() => ({ scanComplete: true, unidentifiedWaitingHandlers: 0, calls: [{ toolCallId: 'call-1',
    announcementRegistered: true, announcementAwaitingHandler: false, handlerAwaitingAnnouncement: false,
    awaitingApproval: false, approvedClaim: 'taken', clientRequestPublished: true, input: 'BACKEND-SECRET' }] }));
  const answer = sessionExecutionDiagnostics({ ...source(), probe });
  expect(probe).toHaveBeenCalledExactlyOnceWith(['call-1']);
  expect(first(answer)).toMatchObject({ toolCallId: 'call-1', turnId: 'turn-1', status: 'running',
    client: { registered: true, connected: true }, clientExecution: { state: 'pending', requestId: 'call-1:client', ownerMatches: true, registrationMatches: true },
    broker: { clientRequestPublished: true, approvedClaim: 'taken' }, completionReceipt: 'unknown', requestAge: 'unknown' });
  expect(JSON.stringify(answer)).not.toContain('SECRET');
});

it('distinguishes absent backend evidence and changed client registration from completed snapshots', () => {
  const input = source();
  input.snapshot.activeTurn.responseParts = [part('call-1', 'completed')];
  input.inputNeeded = [];
  input.activeClients = [{ clientId: 'replacement', tools: [] }];
  input.connectedClients = new Set(['replacement']);
  const answer = sessionExecutionDiagnostics(input);
  expect(first(answer)).toMatchObject({ status: 'completed', broker: { state: 'unknown' },
    client: { clientId: 'client-1', connected: false, registered: false }, clientExecution: { state: 'not-observed' }, completionReceipt: 'unknown' });
  const missing = sessionExecutionDiagnostics({ ...input, inputNeeded: undefined });
  expect(first(missing).clientExecution).toEqual({ state: 'unknown' });
});

it('does not join foreign chat/turn requests or mismatched contributor ownership', () => {
  const input = source();
  input.inputNeeded[0]!.chat = 'ahp-chat:/foreign';
  expect(first(sessionExecutionDiagnostics(input)).clientExecution).toEqual({ state: 'not-observed' });
  input.inputNeeded[0]!.chat = input.chat;
  input.inputNeeded[0]!.clientId = 'replacement';
  expect(first(sessionExecutionDiagnostics(input)).clientExecution).toMatchObject({ state: 'pending', ownerMatches: false });
});

it('fails closed for foreign owners, unknown owners across sessions and borrowed worker chat identities', () => {
  const caller = { session: 'claude:/caller', owner: 'user:one' };
  expect(() => assertDiagnosticTarget(caller, { session: 'claude:/target', owner: 'user:two', chat: 'c', actualChat: 'c' })).toThrow();
  expect(() => assertDiagnosticTarget({ session: 's' }, { session: 'other', chat: 'c', actualChat: 'c' })).toThrow();
  expect(() => assertDiagnosticTarget(caller, { session: 's', owner: 'user:one', chat: 'worker', actualChat: 'parent' })).toThrow();
  expect(() => assertDiagnosticTarget(caller, { session: 's', owner: 'user:one', chat: 'c', actualChat: 'c' })).not.toThrow();
  expect(() => assertDiagnosticTarget({ session: 's' }, { session: 's', chat: 'c', actualChat: 'c' })).not.toThrow();
});

it('bounds calls, scans and serialized UTF8 bytes without truncating identifiers into false matches', () => {
  const input = source();
  input.snapshot.activeTurn.responseParts = Array.from({ length: 2000 }, (_, i) => part(`${i}-${'界'.repeat(160)}`));
  const answer = sessionExecutionDiagnostics(input);
  expect(answer.truncated).toBe(true);
  expect((answer.calls as Bag[]).length).toBeLessThanOrEqual(32);
  expect(Buffer.byteLength(JSON.stringify(answer), 'utf8')).toBeLessThanOrEqual(32768);
  const oversized = source();
  oversized.snapshot.activeTurn.responseParts = [part('界'.repeat(200))];
  expect(first(sessionExecutionDiagnostics(oversized)).toolCallId).toBeNull();
});

it('keeps opt-in off by default, forwards the flag and preserves pending identities and paused state', async () => {
  const queue = ['queued-1', 'queued-2'];
  const state = { paused: true, queue };
  const context = vi.fn(async () => ({ turns: [], hasMoreHistory: false, executionDiagnostics: { backendState: 'unknown' } }));
  const forbidden = vi.fn(() => { throw new Error('mutation invoked'); });
  const at = { session: 'claude:/owned', chat: 'ahp-chat:/owned', sessions: async () => [{ resource: 'claude:/owned', provider: 'claude' }],
    context, send: forbidden, interrupt: forbidden, create: forbidden, createChat: forbidden, remove: forbidden, setWorkspace: forbidden } as unknown as ToolCall;
  const tool = sessionTools().find((one) => one.definition.name === 'get_session_context')!;
  await tool.run({ session: 'claude:/owned' }, at);
  expect(context).toHaveBeenLastCalledWith('claude:/owned', undefined, 0, false);
  const answer = JSON.parse(await tool.run({ session: 'claude:/owned', executionDiagnostics: true }, at)) as Bag;
  expect(context).toHaveBeenLastCalledWith('claude:/owned', undefined, 0, true);
  expect(answer.executionDiagnostics).toEqual({ backendState: 'unknown' });
  expect(forbidden).not.toHaveBeenCalled();
  expect(state).toEqual({ paused: true, queue: ['queued-1', 'queued-2'] });
});


it('keeps malformed or failing backend metadata unknown without exposing exception bodies', () => {
  const answer = sessionExecutionDiagnostics({ ...source(), probe: () => { throw new Error('EXCEPTION-SECRET'); } });
  expect(answer.backendState).toBe('unknown');
  expect(first(answer).broker).toEqual({ state: 'unknown' });
  expect(JSON.stringify(answer)).not.toContain('SECRET');
  const input = source();
  input.inputNeeded.push(structuredClone(input.inputNeeded[0]!));
  expect(first(sessionExecutionDiagnostics(input)).clientExecution).toEqual({ state: 'conflicting' });
});


it.each(['', '   ', 'user:', 'unknown:one', ' user:one', 'user:one ', 'user:one\u0000'])('treats invalid stored owner %j as self-only without normalization', (owner) => {
  expect(() => assertDiagnosticTarget({ session: 'caller', owner }, { session: 'other', owner, chat: 'c', actualChat: 'c' })).toThrow('owner scope');
  expect(() => assertDiagnosticTarget({ session: 'caller', owner }, { session: 'caller', owner, chat: 'c', actualChat: 'c' })).not.toThrow();
});

it.each(['user:one', 'root:host', 'team:engineering', 'project:anton'])('accepts the exact canonical stored owner %s', (owner) => {
  expect(() => assertDiagnosticTarget({ session: 'caller', owner }, { session: 'other', owner, chat: 'c', actualChat: 'c' })).not.toThrow();
  expect(() => assertDiagnosticTarget({ session: 'caller', owner }, { session: 'other', owner: `${owner}x`, chat: 'c', actualChat: 'c' })).toThrow();
});

it.each([null, [], 'invalid', 1, true, {}, { calls: [] }, { scanComplete: true }])('treats malformed backend probe %j as unknown', (value) => {
  const answer = sessionExecutionDiagnostics({ ...source(), probe: () => value as unknown as Bag });
  expect(answer.backendState).toBe('unknown');
  expect(first(answer).broker).toEqual({ state: 'unknown' });
  expect(answer.backendScanComplete).toBe('unknown');
});
