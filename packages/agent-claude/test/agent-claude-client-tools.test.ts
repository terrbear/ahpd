import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { beforeEach, expect, it, onTestFinished, vi } from 'vitest';
import type { Bag, BoundTool } from '@ahpd/sdk';

const sdk = vi.hoisted(() => {
  const state = {
    canUseTool: undefined as undefined | ((name: string, input: Bag, about?: Bag) => Promise<unknown>),
    server: undefined as undefined | { tools: { name: string; inputSchema: Record<string, z.ZodTypeAny>; handler: (input: Bag) => Promise<Bag> }[] },
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
  query: ({ options }: { options: Bag }) => {
    sdk.canUseTool = options.canUseTool as typeof sdk.canUseTool;
    return {
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
    };
  },
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
  sdk.canUseTool = undefined;
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

const shellOwner = 'anton-ahp_0ujtsYcgvSTl8PAuAdqWYSMnLOv';
const otherShellOwner = 'anton-ahp_1ujtsYcgvSTl8PAuAdqWYSMnLOv';
const shellInputSchema = {
  type: 'object' as const,
  properties: { command: { type: 'string' } },
  additionalProperties: false,
};
const shellTool = (owner: string): BoundTool => ({
  definition: {
    name: `${owner}__launch_shell`,
    inputSchema: shellInputSchema,
  },
  owner,
});
const permissionContributors = [
  { label: 'Anton client', name: 'mcp__ahp__launch_shell', tools: [shellTool(shellOwner)], contributor: { kind: 'client', clientId: shellOwner } },
  { label: 'foreign client', name: 'mcp__ahp__foreign__launch_shell', tools: [shellTool('foreign')], contributor: { kind: 'client', clientId: 'foreign' } },
  { label: 'unadvertised alias', name: 'mcp__ahp__launch_shell', tools: [shellTool('foreign')], contributor: { kind: 'mcp', customizationId: 'mcp:ahp' } },
  { label: 'ambiguous alias', name: 'mcp__ahp__launch_shell', tools: [shellTool(shellOwner), shellTool(otherShellOwner)], contributor: { kind: 'mcp', customizationId: 'mcp:ahp' } },
  { label: 'host collision', name: 'mcp__ahp__launch_shell', tools: [shellTool(shellOwner), { definition: { name: 'launch_shell' }, handler: async () => ({ text: 'unused' }) } as BoundTool], contributor: { kind: 'mcp', customizationId: 'mcp:ahp' } },
  { label: 'external MCP', name: 'mcp__other__launch_shell', tools: [shellTool(shellOwner)], contributor: { kind: 'mcp', customizationId: 'mcp:other' } },
  { label: 'built-in', name: 'Bash', tools: [shellTool(shellOwner)], contributor: undefined },
];

for (const order of ['permission-first', 'streaming-first', 'assistant-first', 'streaming-assistant-first']) {
  it.each(permissionContributors)(`preserves $label permission contributor with ${order}`, async ({ name, tools, contributor }) => {
    const sent: Bag[] = [];
    const input = { command: 'pwd' };
    const session = createSession({
      uri: 'claude:/permission-contributor',
      chatUri: 'ahp-chat:/permission-contributor',
      cwd: mkdtempSync(join(tmpdir(), 'ahpd-permission-contributor-')),
      emit: (_channel, action) => { sent.push(structuredClone(action) as Bag); },
      tools,
    });
    const controller = new AbortController();
    onTestFinished(() => { controller.abort(); session.close(); });
    session.begin('permission-turn', 'Inspect the working directory');
    await until(() => sdk.canUseTool !== undefined);
    const streaming = {
      type: 'stream_event', parent_tool_use_id: null, uuid: 'stream-1',
      event: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'permission-call', name, input: {} } },
    };
    const assistant = {
      type: 'assistant', parent_tool_use_id: null, uuid: 'assistant-1',
      message: { id: 'message-1', role: 'assistant', content: [{ type: 'tool_use', id: 'permission-call', name, input }] },
    };
    if (order.startsWith('streaming')) {
      sdk.push(streaming);
      await until(() => sent.some((action) => action.type === 'chat/toolCallStart'));
    }
    if (order.includes('assistant')) {
      sdk.push(assistant);
      await until(() => sent.some((action) => action.type === 'chat/toolCallReady'));
    }
    const answer = sdk.canUseTool!(name, input, { toolUseID: 'permission-call', signal: controller.signal });
    await until(() => sent.some((action) => action.type === 'session/inputNeededSet'));
    const requests = session.sessionState().inputNeeded as Bag[];
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ chat: 'ahp-chat:/permission-contributor', turnId: 'permission-turn', kind: 'toolConfirmation' });
    const call = requests[0]!.toolCall as Bag;
    expect.soft(call.contributor).toEqual(contributor);
    expect(call).toMatchObject({ toolCallId: 'permission-call', toolName: name, status: 'pending-confirmation' });
    const chat = session.chatState();
    const turns = [...(chat.turns ?? []) as Bag[], ...(chat.activeTurn ? [chat.activeTurn as Bag] : [])];
    const parts = turns.flatMap((turn) => (turn.responseParts ?? []) as Bag[]);
    const snapshot = parts.find((part) => part.kind === 'toolCall')?.toolCall as Bag;
    expect.soft(snapshot.contributor).toEqual(contributor);
    const published = sent.find((action) => action.type === 'session/inputNeededSet')!.request as Bag;
    expect.soft((published.toolCall as Bag).contributor).toEqual(contributor);
    for (const action of sent.filter((action) => action.type === 'chat/toolCallStart' || action.type === 'chat/toolCallReady')) {
      expect.soft(action.contributor).toEqual(contributor);
    }
    expect(sent.some((action) => action.type === 'session/inputNeededSet' && (action.request as Bag).kind === 'toolClientExecution')).toBe(false);
    controller.abort();
    await expect(answer).resolves.toMatchObject({ behavior: 'deny' });
  });
}

for (const order of ['approval-before-canonical', 'canonical-before-approval', 'canonical-before-permission', 'streaming-before-permission'] as const) {
  it.each([true, false])(`settles the actual client handler with ${order} (approved: %s), without replaying claims`, async (approved) => {
    const sent: Bag[] = [];
    const input = { command: 'pwd' };
    const name = 'mcp__ahp__launch_shell';
    const contributor = { kind: 'client', clientId: shellOwner };
    const session = createSession({
      uri: 'claude:/permission-execution',
      chatUri: 'ahp-chat:/permission-execution',
      cwd: mkdtempSync(join(tmpdir(), 'ahpd-permission-execution-')),
      emit: (_channel, action) => { sent.push(structuredClone(action) as Bag); },
      tools: [shellTool(shellOwner)],
    });
    const controller = new AbortController();
    onTestFinished(() => { controller.abort(); session.close(); });
    session.begin('execution-turn', 'Inspect the working directory');
    await until(() => sdk.canUseTool !== undefined && sdk.server !== undefined);
    const tool = sdk.server!.tools.find((one) => one.name === 'launch_shell')!;
    expect(tool).toBeDefined();
    const executions = () => sent.filter((action) => action.type === 'session/inputNeededSet'
      && (action.request as Bag).kind === 'toolClientExecution');
    let frame = 0;
    const canonical = async (id: string) => {
      // A fresh text part after the tool block acknowledges that even an
      // ignored/replayed tool block was consumed, without a timing sleep.
      const marker = `frame-${++frame}`;
      sdk.push({ type: 'assistant', uuid: marker, parent_tool_use_id: null, message: {
        id: marker, role: 'assistant', content: [
          { type: 'tool_use', id, name, input },
          { type: 'text', text: marker },
        ],
      } });
      await until(() => sent.some((action) => action.type === 'chat/responsePart' && (action.part as Bag).content === marker));
    };
    const permission = (id: string) => sdk.canUseTool!(name, input, { toolUseID: id, signal: controller.signal });
    const finish = async (id: string, result: Promise<Bag>, count: number) => {
      await until(() => executions().length === count);
      expect(executions().at(-1)!.request).toMatchObject({
        id: `${id}:client`, kind: 'toolClientExecution', clientId: shellOwner,
        chat: 'ahp-chat:/permission-execution', turnId: 'execution-turn',
        toolCall: { toolCallId: id, toolName: 'launch_shell', toolInput: JSON.stringify(input), contributor },
      });
      expect(session.completeToolCall?.(id, 'wrong-client', { text: 'wrong', ok: true })).toBe(false);
      expect(session.completeToolCall?.(id, shellOwner, { text: `receipt ${id}`, ok: true })).toBe(true);
      await expect(result).resolves.toMatchObject({ content: [{ type: 'text', text: `receipt ${id}` }] });
      expect(session.sessionState().inputNeeded ?? []).toEqual([]);
    };

    if (order === 'streaming-before-permission') {
      sdk.push({ type: 'stream_event', parent_tool_use_id: null, uuid: 'stream-first', event: {
        type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'first', name, input: {} },
      } });
      await until(() => sent.some((action) => action.type === 'chat/toolCallStart'));
    }
    if (order === 'canonical-before-permission') await canonical('first');
    const answer = permission('first');
    await until(() => (session.sessionState().inputNeeded as Bag[] | undefined)?.some((request) => request.kind === 'toolConfirmation') === true);
    expect((session.sessionState().inputNeeded as Bag[])[0]!.toolCall).toMatchObject({ status: 'pending-confirmation', contributor });
    if (order === 'canonical-before-approval' || order === 'streaming-before-permission') {
      await canonical('first');
      await canonical('first');
      expect((session.sessionState().inputNeeded as Bag[])[0]!.toolCall).toMatchObject({ status: 'pending-confirmation', contributor });
    }
    expect(executions()).toHaveLength(0);
    session.confirm('first', approved);
    await expect(answer).resolves.toMatchObject(approved ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny' });
    await canonical('first');
    await canonical('first');
    // Exercise the exact approval/canonical orders before handler dispatch.
    const result = approved ? tool.handler(input) : undefined;
    const activeTurn = session.chatState().activeTurn as Bag;
    const firstCall = (activeTurn.responseParts as Bag[]).find((part) => part.id === 'first')!.toolCall;
    expect(firstCall).toMatchObject({ status: approved ? 'running' : 'cancelled', contributor, ...(approved ? { confirmed: 'user-action' } : {}) });
    if (result) await finish('first', result, 1);
    else expect(executions()).toHaveLength(0);
    await canonical('first');
    expect(sent.filter((action) => action.type === 'chat/toolCallStart' && action.toolCallId === 'first')).toHaveLength(1);

    // Identical arguments must claim the next call, never a replayed or
    // denied predecessor. Start its handler before its canonical frame.
    const nextAnswer = permission('next');
    session.confirm('next', true);
    await expect(nextAnswer).resolves.toMatchObject({ behavior: 'allow', updatedInput: input });
    const nextResult = tool.handler(input);
    await canonical('next');
    await finish('next', nextResult, approved ? 2 : 1);
  });
}

const claimFixture = async (definition = shellTool(shellOwner), onAction?: (action: Bag) => void) => {
  const sent: Bag[] = [];
  const session = createSession({
    uri: 'claude:/claim-lifecycle', chatUri: 'ahp-chat:/claim-lifecycle',
    cwd: mkdtempSync(join(tmpdir(), 'ahpd-claim-lifecycle-')),
    emit: (_channel, action) => { sent.push(structuredClone(action) as Bag); onAction?.(action as Bag); },
    tools: [definition],
  });
  onTestFinished(() => { session.close(); });
  session.begin('claim-turn', 'Run the contributed tools');
  await until(() => sdk.canUseTool !== undefined && sdk.server !== undefined);
  const tool = sdk.server!.tools.find((one) => one.name === 'launch_shell')!;
  const name = 'mcp__ahp__launch_shell';
  let frame = 0;
  const canonical = async (id: string, input: Bag) => {
    const marker = `claim-frame-${++frame}`;
    sdk.push({ type: 'assistant', uuid: marker, parent_tool_use_id: null, message: {
      id: marker, role: 'assistant', content: [{ type: 'tool_use', id, name, input }, { type: 'text', text: marker }],
    } });
    await until(() => sent.some((action) => action.type === 'chat/responsePart' && (action.part as Bag).content === marker));
  };
  const approve = async (id: string, input: Bag) => {
    const answer = sdk.canUseTool!(name, input, { toolUseID: id });
    session.confirm(id, true);
    await expect(answer).resolves.toMatchObject({ behavior: 'allow' });
  };
  const executions = () => sent.filter((action) => action.type === 'session/inputNeededSet'
    && (action.request as Bag).kind === 'toolClientExecution').map((action) => action.request as Bag);
  return { session, tool, canonical, approve, executions };
};

it.each(['canonical-first', 'handler-first'] as const)('matches concurrent calls by input with reversed %s arrivals and canonical replay', async (order) => {
  const { session, tool, canonical, approve, executions } = await claimFixture();
  const a = { command: 'first' };
  const b = { command: 'second' };
  await approve('a', a);
  await approve('b', b);
  if (order === 'canonical-first') {
    await canonical('b', b);
    await canonical('b', b);
  }
  const first = tool.handler(a);
  const second = tool.handler(b);
  session.clientGone?.(otherShellOwner);
  await canonical('b', b);
  await canonical('a', a);
  await canonical('a', a);
  await until(() => executions().length === 2);
  expect(executions().map((request) => request.toolCall)).toEqual(expect.arrayContaining([
    expect.objectContaining({ toolCallId: 'a', toolInput: JSON.stringify(a), contributor: { kind: 'client', clientId: shellOwner } }),
    expect.objectContaining({ toolCallId: 'b', toolInput: JSON.stringify(b), contributor: { kind: 'client', clientId: shellOwner } }),
  ]));
  expect(session.completeToolCall?.('a', otherShellOwner, { text: 'wrong', ok: true })).toBe(false);
  expect(session.completeToolCall?.('a', shellOwner, { text: 'first receipt', ok: true })).toBe(true);
  expect(session.completeToolCall?.('b', shellOwner, { text: 'second receipt', ok: true })).toBe(true);
  await expect(first).resolves.toMatchObject({ content: [{ text: 'first receipt' }] });
  await expect(second).resolves.toMatchObject({ content: [{ text: 'second receipt' }] });
});

for (const ending of ['cancel', 'disconnect', 'dispose'] as const) {
  it.each(['waiting', 'queued', 'joining'] as const)(`cleans client registrations on ${ending} while %s`, async (phase) => {
    const { session, tool, canonical, approve, executions } = await claimFixture();
    const input = { command: 'same-input' };
    await approve('old', input);
    if (phase !== 'waiting') await canonical('old', input);
    const result = phase !== 'queued' ? tool.handler(input) : undefined;
    if (ending === 'cancel') session.cancel('claim-turn');
    if (ending === 'disconnect') session.clientGone?.(shellOwner);
    if (ending === 'dispose') session.close();
    if (result) await expect(result).resolves.toMatchObject({ isError: true });
    expect(executions()).toHaveLength(0);
    expect(session.sessionState().inputNeeded ?? []).toEqual([]);
    if (ending === 'dispose') return;
    if (ending === 'cancel') session.begin('next-turn', 'Continue');
    await approve('next', input);
    const next = tool.handler(input);
    await canonical('old', input);
    await canonical('next', input);
    await until(() => executions().length === 1);
    expect(executions()[0]!.toolCall).toMatchObject({ toolCallId: 'next' });
    expect(session.completeToolCall?.('old', shellOwner, { text: 'stale', ok: true })).toBe(false);
    expect(session.completeToolCall?.('next', shellOwner, { text: 'next receipt', ok: true })).toBe(true);
    await expect(next).resolves.toMatchObject({ content: [{ text: 'next receipt' }] });
  });
}

it.each(['canonical-first', 'handler-first'] as const)('matches MCP-validated reordered nested input with %s', async (order) => {
  const definition = shellTool(shellOwner);
  definition.definition.inputSchema = {
    type: 'object', properties: {
      first: { type: 'string' },
      nested: { type: 'object', properties: { a: { type: 'string' }, b: { type: 'string' } } },
      items: { type: 'array', items: { type: 'object', properties: { x: { type: 'string' }, y: { type: 'string' } } } },
    },
  };
  const { session, tool, canonical, approve, executions } = await claimFixture(definition);
  const input = { items: [{ y: 'Y', x: 'X' }], nested: { b: 'B', a: 'A' }, first: 'F', extra: 'stripped by MCP' };
  const parsed = z.object(tool.inputSchema).parse(input);
  expect(JSON.stringify(parsed)).not.toBe(JSON.stringify(input));
  await approve('validated', input);
  if (order === 'canonical-first') await canonical('validated', input);
  const result = tool.handler(parsed);
  if (order === 'handler-first') await canonical('validated', input);
  await until(() => executions().length === 1);
  expect(executions()[0]!.toolCall).toMatchObject({ toolCallId: 'validated', toolInput: JSON.stringify(parsed) });
  expect(session.completeToolCall?.('validated', shellOwner, { text: 'validated receipt', ok: true })).toBe(true);
  await expect(result).resolves.toMatchObject({ content: [{ text: 'validated receipt' }] });
});

for (const order of ['permission-first', 'canonical-first'] as const) {
  it.each([true, false])(`does not let a pending ${order} call satisfy another approved handler (identical input: %s)`, async (identical) => {
    const { session, tool, canonical, approve, executions } = await claimFixture();
    const pendingInput = { command: 'pending' };
    const approvedInput = identical ? pendingInput : { command: 'approved' };
    if (order === 'canonical-first') await canonical('pending-b', pendingInput);
    const pendingAnswer = sdk.canUseTool!('mcp__ahp__launch_shell', pendingInput, { toolUseID: 'pending-b' });
    await until(() => (session.sessionState().inputNeeded as Bag[] | undefined)?.some((request) => request.id === 'pending-b') === true);
    await canonical('pending-b', pendingInput);
    await approve('approved-a', approvedInput);
    const result = tool.handler(approvedInput);
    await canonical('pending-b', pendingInput);
    expect(executions()).toHaveLength(0);
    await canonical('approved-a', approvedInput);
    await until(() => executions().length === 1);
    expect(executions()[0]!.toolCall).toMatchObject({ toolCallId: 'approved-a', contributor: { kind: 'client', clientId: shellOwner } });
    expect(session.completeToolCall?.('pending-b', shellOwner, { text: 'must not execute', ok: true })).toBe(false);
    expect(session.completeToolCall?.('approved-a', otherShellOwner, { text: 'wrong owner', ok: true })).toBe(false);
    expect(session.completeToolCall?.('approved-a', shellOwner, { text: 'approved receipt', ok: true })).toBe(true);
    await expect(result).resolves.toMatchObject({ content: [{ text: 'approved receipt' }] });
    session.confirm('pending-b', false);
    await expect(pendingAnswer).resolves.toMatchObject({ behavior: 'deny' });
    await approve('approved-c', pendingInput);
    const next = tool.handler(pendingInput);
    await canonical('pending-b', pendingInput);
    await canonical('approved-c', pendingInput);
    await until(() => executions().length === 2);
    expect(executions()[1]!.toolCall).toMatchObject({ toolCallId: 'approved-c' });
    expect(session.completeToolCall?.('approved-c', shellOwner, { text: 'next receipt', ok: true })).toBe(true);
    await expect(next).resolves.toMatchObject({ content: [{ text: 'next receipt' }] });
  });
}

it.each(['during-canonical', 'after-canonical'] as const)('reserves an approved handler ID when another permission arrives %s', async (order) => {
  const input = { command: 'identical' };
  let pendingAnswer: Promise<unknown> | undefined;
  const askB = () => { pendingAnswer = sdk.canUseTool!('mcp__ahp__launch_shell', input, { toolUseID: 'pending-b' }); };
  const { session, tool, canonical, approve, executions } = await claimFixture(shellTool(shellOwner), (action) => {
    if (order === 'during-canonical' && action.type === 'chat/toolCallStart' && action.toolCallId === 'pending-b') askB();
  });
  await approve('approved-a', input);
  const result = tool.handler(input);
  await canonical('pending-b', input);
  if (order === 'after-canonical') askB();
  expect(pendingAnswer).toBeDefined();
  expect(executions()).toHaveLength(0);
  await canonical('approved-a', input);
  await until(() => executions().length === 1);
  expect(executions()[0]!.toolCall).toMatchObject({ toolCallId: 'approved-a' });
  session.confirm('pending-b', false);
  await expect(pendingAnswer).resolves.toMatchObject({ behavior: 'deny' });
  expect(session.completeToolCall?.('pending-b', shellOwner, { text: 'unapproved', ok: true })).toBe(false);
  expect(session.completeToolCall?.('approved-a', shellOwner, { text: 'A receipt', ok: true })).toBe(true);
  await expect(result).resolves.toMatchObject({ content: [{ text: 'A receipt' }] });
});

it('invalidates a permission aborted before its prompt for a later SDK-autoallowed handler', async () => {
  const { session, tool, canonical, executions } = await claimFixture();
  const input = { command: 'identical' };
  const signal = AbortSignal.abort();
  await expect(sdk.canUseTool!('mcp__ahp__launch_shell', input, { toolUseID: 'aborted', signal })).resolves.toMatchObject({ behavior: 'deny' });
  await canonical('aborted', input);
  const result = tool.handler(input);
  await canonical('autoallowed', input);
  await until(() => executions().length === 1);
  expect(executions()[0]!.toolCall).toMatchObject({ toolCallId: 'autoallowed' });
  expect(session.completeToolCall?.('autoallowed', shellOwner, { text: 'auto receipt', ok: true })).toBe(true);
  await expect(result).resolves.toMatchObject({ content: [{ text: 'auto receipt' }] });
});

it.each(['cancel', 'disconnect'] as const)('tombstones an allowed-list reservation without a transcript row on %s', async (ending) => {
  const { session, tool, canonical, executions } = await claimFixture();
  const input = { command: 'identical' };
  await session.setConfig?.('permissions', { allow: ['mcp__ahp__launch_shell'], deny: [] });
  await expect(sdk.canUseTool!('mcp__ahp__launch_shell', input, { toolUseID: 'early-allow' })).resolves.toMatchObject({ behavior: 'allow' });
  if (ending === 'cancel') {
    session.cancel('claim-turn');
    session.begin('next-turn', 'Continue');
  } else session.clientGone?.(shellOwner);
  await canonical('early-allow', input);
  const result = tool.handler(input);
  await canonical('autoallowed-next', input);
  await until(() => executions().length === 1);
  expect(executions()[0]!.toolCall).toMatchObject({ toolCallId: 'autoallowed-next' });
  expect(session.completeToolCall?.('autoallowed-next', shellOwner, { text: 'next receipt', ok: true })).toBe(true);
  await expect(result).resolves.toMatchObject({ content: [{ text: 'next receipt' }] });
});
