import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, expect, it, vi } from 'vitest';
import type { Bag, BoundTool } from '@ahpd/sdk';

const sdk = vi.hoisted(() => {
  const state = {
    server: undefined as undefined | { tools: { name: string; handler: (input: Bag) => Promise<Bag> }[] },
    frames: [] as Bag[],
    wake: undefined as undefined | (() => void),
    push(frame: Bag) {
      state.frames.push(frame);
      state.wake?.();
      state.wake = undefined;
    },
    async next(): Promise<Bag> {
      while (state.frames.length === 0) await new Promise<void>((resolve) => { state.wake = resolve; });
      return state.frames.shift() as Bag;
    },
  };
  return state;
});

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  createSdkMcpServer: (given: typeof sdk.server) => {
    sdk.server = given;
    return { type: 'sdk', name: 'ahp', tools: given?.tools };
  },
  query: () => ({
    async *[Symbol.asyncIterator]() { for (;;) yield await sdk.next(); },
    interrupt: async () => {},
    setPermissionMode: async () => {},
    setModel: async () => {},
    applyFlagSettings: async () => {},
    toggleMcpServer: async () => {},
    reconnectMcpServer: async () => {},
    setMcpServers: async () => {},
    initializationResult: async () => ({}),
    mcpServerStatus: async () => [],
    reloadSkills: async () => ({ skills: [] }),
    reloadPlugins: async () => ({ plugins: [] }),
    supportedModels: async () => [],
    streamInput: async () => {},
    close: () => {},
  }),
}));

const { createSession } = await import('../src/session.js');

const until = async (check: () => boolean): Promise<void> => {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await new Promise((resolve) => { setTimeout(resolve, 0); });
  }
  throw new Error('condition not reached');
};

beforeEach(() => {
  sdk.server = undefined;
  sdk.frames = [];
  sdk.wake = undefined;
});

it('asks the owning client to execute an announced Claude tool and removes the request after completion', async () => {
  const sent: { channel: string; action: Bag }[] = [];
  const owner = 'anton-ahp_0ujtsYcgvSTl8PAuAdqWYSMnLOv';
  const unrelatedOwner = 'anton-unrelated-client';
  const input = { code: 'return anton.help()' };
  const antonTools = ['anton_codemode', 'launch_shell', 'shell_write', 'shell_read', 'spawn_teammate'];
  const session = createSession({
    uri: 'claude:/client-tools',
    chatUri: 'ahp-chat:/client-tools',
    cwd: mkdtempSync(join(tmpdir(), 'ahpd-client-tools-')),
    emit: (channel, action) => { sent.push({ channel, action: action as Bag }); },
    tools: [
      ...antonTools.map((name) => ({
        definition: { name: `${owner}__${name}`, title: name, inputSchema: { type: 'object', properties: { code: { type: 'string' } } } },
        owner,
      } as BoundTool)),
      { definition: { name: `${owner}__anton_debug` }, owner } as BoundTool,
      { definition: { name: 'anton_debug' }, owner: 'other-client' } as BoundTool,
      { definition: { name: `${unrelatedOwner}__anton_codemode` }, owner: unrelatedOwner } as BoundTool,
      { definition: { name: 'other-client__git_status' }, owner: 'other-client' } as BoundTool,
    ],
  });
  session.begin('turn-1', 'List Anton APIs');
  await until(() => sdk.server?.tools.some((tool) => tool.name === 'anton_codemode') === true);
  const names = sdk.server?.tools.map((tool) => tool.name) ?? [];
  expect(names).toEqual(expect.arrayContaining(antonTools));
  expect(names).toEqual(expect.arrayContaining(['anton-ahp_0ujtsYcgvSTl8PAuAdqWYSMnLOv__anton_debug', 'anton_debug', 'anton-unrelated-client__anton_codemode', 'other-client__git_status']));
  const tool = sdk.server?.tools.find((one) => one.name === 'anton_codemode');
  if (!tool) throw new Error('client tool was not offered');
  const result = tool.handler(input);
  sdk.push({ type: 'assistant', parent_tool_use_id: null, uuid: 'assistant-1', message: { id: 'message-1', role: 'assistant', content: [{ type: 'tool_use', id: 'call-1', name: 'mcp__ahp__anton_codemode', input }] } });
  await until(() => sent.some(({ action }) => action.type === 'session/inputNeededSet'));
  const request = sent.find(({ action }) => action.type === 'session/inputNeededSet');
  expect(request).toMatchObject({
    channel: 'session',
    action: {
      request: {
        id: 'call-1:client', chat: 'ahp-chat:/client-tools', kind: 'toolClientExecution', turnId: 'turn-1', clientId: owner,
        toolCall: { toolCallId: 'call-1', toolName: 'anton_codemode', toolInput: JSON.stringify(input), contributor: { kind: 'client', clientId: owner }, status: 'running' },
      },
    },
  });
  expect(session.sessionState().inputNeeded).toEqual([request?.action.request]);
  expect(session.completeToolCall?.('call-1', 'someone-else', { text: 'wrong', ok: true })).toBe(false);
  expect(session.completeToolCall?.('call-1', owner, { text: 'help available', ok: true })).toBe(true);
  expect(session.sessionState().inputNeeded ?? []).toEqual([]);
  expect(await result).toMatchObject({ content: [{ type: 'text', text: 'help available' }] });
  expect(sent.some(({ action }) => action.type === 'session/inputNeededRemoved' && action.id === 'call-1:client')).toBe(true);
});

it.each(['cancel', 'disconnect', 'dispose', 'complete-during-publication'] as const)('clears snapshot requests on %s', async (ending) => {
  const owner = 'anton-ahp_0ujtsYcgvSTl8PAuAdqWYSMnLOv';
  const input = { code: 'return anton.builtin.listAPIs()' };
  const observed: Bag[] = [];
  const session = createSession({
    uri: 'claude:/snapshot-tools',
    chatUri: 'ahp-chat:/snapshot-tools',
    cwd: mkdtempSync(join(tmpdir(), 'ahpd-client-snapshot-')),
    emit: (_channel, action) => {
      if (action.type !== 'session/inputNeededSet') return;
      const request = (action as Bag).request;
      observed.push(request as Bag);
      expect(session.sessionState().inputNeeded).toEqual([request]);
      if (ending === 'complete-during-publication') {
        expect(session.completeToolCall?.('snapshot-call', owner, { text: 'catalog', ok: true })).toBe(true);
      }
    },
    tools: [{ definition: { name: `${owner}__anton_codemode`, inputSchema: { type: 'object' } }, owner }],
  });
  session.begin('snapshot-turn', 'List APIs');
  await until(() => sdk.server?.tools.some((tool) => tool.name === 'anton_codemode') === true);
  const tool = sdk.server?.tools.find((one) => one.name === 'anton_codemode');
  if (!tool) throw new Error('client tool was not offered');
  const result = tool.handler(input);
  sdk.push({ type: 'assistant', parent_tool_use_id: null, uuid: 'snapshot-assistant', message: {
    id: 'snapshot-message', role: 'assistant', content: [{ type: 'tool_use', id: 'snapshot-call', name: 'mcp__ahp__anton_codemode', input }],
  } });
  await until(() => observed.length === 1);
  if (ending === 'cancel') session.cancel('snapshot-turn');
  if (ending === 'disconnect') session.clientGone?.(owner);
  if (ending === 'dispose') session.close();
  const response = await result;
  expect(response.isError === true).toBe(ending !== 'complete-during-publication');
  expect(session.sessionState().inputNeeded ?? []).toEqual([]);
});
