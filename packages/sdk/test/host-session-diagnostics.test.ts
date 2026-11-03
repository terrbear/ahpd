import { expect, it, onTestFinished, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHost } from '../src/host.js';
import { memorySessions } from '../src/sessions.js';
import { sessionTools } from '../src/sessiontools.js';
import { echo } from '../../../examples/echo/agent.js';
import type { Start } from '../src/types/agent.js';
import type { Bag } from '../src/types/common.js';
import type { Peer } from '../src/types/rpc.js';
import type { Owner } from '../src/types/usage.js';

it('applies owner checks before reading diagnostic backend state and leaves exact queue/pause state unchanged', async () => {
  const path = mkdtempSync(join(tmpdir(), 'ahpd-context-diagnostics-'));
  const store = memorySessions();
  const starts = new Map<string, Start>();
  const states = new Map<string, Bag>();
  const read = vi.fn();
  const mutated = vi.fn(() => { throw new Error('diagnostic triggered execution'); });
  const base = echo({ path, pace: 0 });
  const host = createHost({ path, sessions: store, tools: sessionTools(), agents: [{ ...base, create: (start) => {
    starts.set(start.uri, start);
    const session = base.create(start);
    const state = { paused: true, queuedMessages: [{ id: 'queued-1' }, { id: 'queued-2' }], turns: [], activeTurn: {
      id: 'existing-turn', responseParts: [{ kind: 'toolCall', toolCall: { toolCallId: 'existing-call', toolName: 'anton_codemode', status: 'running' } }],
    } };
    states.set(start.uri, state);
    return { ...session, begin: mutated, queue: mutated,
      chatState: () => { read(start.uri); return { ...session.chatState(), ...state }; },
      sessionState: () => ({ ...session.sessionState(), paused: true, inputNeeded: [] }),
      toolExecutionDiagnostics: () => ({ scanComplete: true, calls: [{ toolCallId: 'existing-call', announcementRegistered: true,
        announcementAwaitingHandler: true, clientRequestPublished: false }] }),
    };
  } }] });
  onTestFinished(async () => { await host.close(); rmSync(path, { recursive: true, force: true }); });
  const peer: Peer = { send: () => {}, notify: () => {}, request: async () => ({}), answered: () => {}, close: () => {} };
  const client = host.accept(peer);
  await client.handle({ method: 'initialize', params: { clientId: 'read-only-coordinator', protocolVersions: ['0.9.0'] } });
  for (const id of ['caller', 'target']) {
    await client.handle({ method: 'createSession', params: { channel: `echo:/${id}`, provider: 'echo' } });
  }
  const tool = starts.get('echo:/caller')?.tools?.find((one) => one.definition.name === 'get_session_context');
  expect(tool?.run).toBeTypeOf('function');
  store.setOwner('caller', 'user:one');
  store.setOwner('target', 'user:two');
  read.mockClear();
  await expect(tool!.run!({ session: 'echo:/target', executionDiagnostics: true })).rejects.toThrow('owner scope');
  expect(read).not.toHaveBeenCalledWith('echo:/target');
  for (const invalid of ['', '   ', 'user:', 'invalid:one']) {
    store.setOwner('caller', invalid as Owner);
    store.setOwner('target', invalid as Owner);
    await expect(tool!.run!({ session: 'echo:/target', executionDiagnostics: true })).rejects.toThrow('owner scope');
    const self = JSON.parse(await tool!.run!({ session: 'echo:/caller', executionDiagnostics: true }) as string) as Bag;
    expect(self.executionDiagnostics).toMatchObject({ session: 'echo:/caller' });
  }
  store.setOwner('caller', 'user:one');
  store.setOwner('target', 'user:one');
  const before = structuredClone(states.get('echo:/target'));
  const answer = JSON.parse(await tool!.run!({ session: 'echo:/target', executionDiagnostics: true }) as string) as Bag;
  expect(answer.executionDiagnostics).toMatchObject({ backendState: 'observed', calls: [{ toolCallId: 'existing-call', broker: {
    announcementAwaitingHandler: true, clientRequestPublished: false,
  } }] });
  expect(states.get('echo:/target')).toEqual(before);
  expect(mutated).not.toHaveBeenCalled();
  store.setOwner('caller', undefined);
  await expect(tool!.run!({ session: 'echo:/target', executionDiagnostics: true })).rejects.toThrow('owner scope');
  const own = JSON.parse(await tool!.run!({ session: 'echo:/caller', executionDiagnostics: true }) as string) as Bag;
  expect(own.executionDiagnostics).toMatchObject({ session: 'echo:/caller' });
});
