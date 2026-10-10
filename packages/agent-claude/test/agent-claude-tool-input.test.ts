import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import type { Bag } from '@ahpd/sdk';

/*
 * A tool call's `toolInput`, live and read back.
 *
 * `toolInput` is the call's whole input as JSON, so a client can parse it;
 * `invocationMessage` is the short line the row draws. Bash is the one tool
 * whose `toolInput` is its command, because a terminal row reads the command
 * there.
 *
 * The row line is never cut JSON. It is the call's `description` for Bash, Task,
 * Agent and Monitor; otherwise VS Code's line for a tool VS Code maps, as
 * markdown where VS Code sends markdown; otherwise the subject of
 * AskUserQuestion, WebSearch or an MCP tool, or the display name. The past
 * tense is the same rule, success or not.
 */

const sdk = vi.hoisted(() => ({
  frames: [] as Record<string, unknown>[],
  /** What the stream waits on after its frames, so a test can keep it open. */
  hold: Promise.resolve() as Promise<void>,
  canUseTool: undefined as undefined | ((name: string, input: Record<string, unknown>, about?: Record<string, unknown>) => Promise<unknown>),
  queryOptions: undefined as Record<string, unknown> | undefined,
}));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  createSdkMcpServer: (given: Record<string, unknown>) => ({ type: 'sdk', name: given.name, tools: given.tools }),
  getSessionMessages: async () => sdk.frames,
  query: ({ options }: { options: Record<string, unknown> }) => {
    sdk.queryOptions = options;
    return {
      async *[Symbol.asyncIterator]() {
        sdk.canUseTool = options.canUseTool as typeof sdk.canUseTool;
        for (const frame of sdk.frames) yield frame;
        await sdk.hold;
      },
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
const { turnsOf } = await import('../src/transcript.js');

/** An input whose JSON is well past 400 characters, for a tool with no subject. */
const long = { todos: [{ content: 'x'.repeat(500), status: 'pending', activeForm: 'Doing x' }], nested: { keep: true } };

const calls = [
  { type: 'tool_use', id: 'toolu_long', name: 'TodoWrite', input: long },
  { type: 'tool_use', id: 'toolu_bash', name: 'Bash', input: { command: 'ls -la', description: 'List files' } },
  {
    type: 'tool_use', id: 'toolu_ask', name: 'AskUserQuestion', input: {
      questions: [
        { question: 'Which colour?', header: 'Colour', multiSelect: false, options: [{ label: 'Red' }, { label: 'Blue' }] },
        { question: 'Which size?', header: 'Size', multiSelect: false, options: [{ label: 'S' }, { label: 'L' }] },
      ],
    },
  },
  { type: 'tool_use', id: 'toolu_fetch', name: 'WebFetch', input: { prompt: 'Summarize it', url: 'https://example.com/page' } },
  { type: 'tool_use', id: 'toolu_search', name: 'WebSearch', input: { allowed_domains: ['example.com'], query: 'kqueue linux' } },
  { type: 'tool_use', id: 'toolu_mcp', name: 'mcp__docs__search', input: { limit: 5, topic: 'kqueue', scope: 'all' } },
  { type: 'tool_use', id: 'toolu_numbers', name: 'mcp__pager__page', input: { page: 2, size: 50 } },
];

/** Each call's row line and past tense, as the task names them. */
const rows: [string, unknown, unknown][] = [
  ['toolu_long', 'Update todo list', 'Update todo list'],
  ['toolu_bash', 'List files', 'List files'],
  ['toolu_ask', 'Which colour?', 'Which colour?'],
  ['toolu_fetch', { markdown: 'Fetching [https://example.com/page](https://example.com/page)' }, { markdown: 'Fetched [https://example.com/page](https://example.com/page)' }],
  ['toolu_search', 'kqueue linux', 'kqueue linux'],
  ['toolu_mcp', 'kqueue', 'kqueue'],
  ['toolu_numbers', 'mcp__pager__page', 'mcp__pager__page'],
];

/** The text of a line, whether it is a string or markdown. */
const textOf = (line: unknown): string => (typeof line === 'string' ? line : String((line as Bag | undefined)?.markdown));

const settle = async (times = 30): Promise<void> => {
  for (let i = 0; i < times; i++) await new Promise((r) => { setTimeout(r, 0); });
};

/** The calls as a live session announces them: its snapshot calls and its ready actions. */
async function live(frames: Record<string, unknown>[] = [{
  type: 'assistant', parent_tool_use_id: null, uuid: 'a1',
  message: { id: 'msg_1', role: 'assistant', content: calls },
}], asking?: () => void, options: { settings?: Bag; mcpServers?: Record<string, Bag> } = {}): Promise<{ held: Map<string, Bag>; ready: Map<string, Bag>; session: ReturnType<typeof createSession>; sent: Bag[] }> {
  sdk.frames = frames;
  const sent: Bag[] = [];
  const session = createSession({
    uri: 'ahp-session:/input',
    chatUri: 'ahp-chat:/input',
    cwd: mkdtempSync(join(tmpdir(), 'ahpd-input-')),
    emit: (_channel, action) => { sent.push(action as Bag); },
    ...options,
  });
  await settle();
  if (asking !== undefined) {
    asking();
    await settle();
  }
  const ready = new Map<string, Bag>();
  for (const action of sent) {
    if (action.type === 'chat/toolCallReady') ready.set(action.toolCallId as string, action);
  }
  const chat = session.chatState() as Bag;
  const turns = [...(chat.turns ?? []) as Bag[], ...(chat.activeTurn ? [chat.activeTurn as Bag] : [])];
  const held = new Map<string, Bag>();
  for (const part of turns.flatMap((turn) => (turn.responseParts ?? []) as Bag[])) {
    if (part.kind === 'toolCall') {
      const call = part.toolCall as Bag;
      held.set(call.toolCallId as string, call);
    }
  }
  return { held, ready, session, sent };
}

/** The same calls read back from a transcript, with any frames that follow them. */
async function restored(content: Bag[] = calls, after: Record<string, unknown>[] = []): Promise<Map<string, Bag>> {
  sdk.frames = [
    { type: 'user', uuid: 'u1', timestamp: '2020-01-01T00:00:00.000Z', message: { role: 'user', content: 'go' } },
    { type: 'assistant', uuid: 'a1', timestamp: '2020-01-01T00:00:00.000Z', message: { id: 'msg_1', role: 'assistant', content } },
    ...after,
  ];
  const turns = await turnsOf('session', '/tmp/project') as unknown as Bag[];
  const out = new Map<string, Bag>();
  for (const part of (turns[0]?.responseParts ?? []) as Bag[]) {
    if (part.kind === 'toolCall') {
      const call = part.toolCall as Bag;
      out.set(call.toolCallId as string, call);
    }
  }
  return out;
}

it('carries a live call\'s whole input in toolInput', async () => {
  const { held, ready } = await live();
  for (const call of [ready.get('toolu_long'), held.get('toolu_long')]) {
    expect(JSON.parse(call?.toolInput as string)).toEqual(long);
    expect(call?.invocationMessage).toBe('Update todo list');
  }
});

it('carries a restored call\'s whole input in toolInput', async () => {
  const call = (await restored()).get('toolu_long');
  expect(JSON.parse(call?.toolInput as string)).toEqual(long);
  expect(call?.invocationMessage).toBe('Update todo list');
});

it('keeps Bash\'s command in toolInput, live and restored', async () => {
  const { held, ready } = await live();
  const back = (await restored()).get('toolu_bash');
  for (const call of [ready.get('toolu_bash'), held.get('toolu_bash'), back]) {
    expect(call?.toolInput).toBe('ls -la');
    expect(call?.invocationMessage).toBe('List files');
  }
});

it('draws each live call\'s row line as its subject or its display name', async () => {
  const { held, ready } = await live();
  for (const [id, line] of rows) {
    for (const call of [ready.get(id), held.get(id)]) {
      expect(call?.invocationMessage, id).toEqual(line);
      expect(textOf(call?.invocationMessage), id).not.toMatch(/^\{/);
    }
  }
});

it('draws a restored call\'s row line as the live one does', async () => {
  const back = await restored();
  for (const [id, line, past] of rows) {
    const call = back.get(id);
    expect(call?.invocationMessage, id).toEqual(line);
    expect(call?.pastTenseMessage, id).toEqual(past);
    expect(textOf(call?.invocationMessage), id).not.toMatch(/^\{/);
  }
});

it('gives a call confirmed while it streams its whole input', async () => {
  const input = { url: 'https://example.com/page', prompt: 'y'.repeat(500) };
  sdk.hold = new Promise(() => {});
  const { held, ready } = await live([
    {
      type: 'stream_event', parent_tool_use_id: null, uuid: 's1',
      event: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_held', name: 'WebFetch', input: {} } },
    },
    {
      type: 'stream_event', parent_tool_use_id: null, uuid: 's2',
      event: { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"url":"https://exa' } },
    },
  ], () => { void sdk.canUseTool?.('WebFetch', input, { toolUseID: 'toolu_held' }); });
  sdk.hold = Promise.resolve();
  const call = held.get('toolu_held');
  expect(call?.status).toBe('pending-confirmation');
  expect(JSON.parse(call?.toolInput as string)).toEqual(input);
  expect(call).not.toHaveProperty('partialInput');
  expect(JSON.parse(ready.get('toolu_held')?.toolInput as string)).toEqual(input);
});

/** Calls whose row lines mirror VS Code's, each with its line and past tense. */
const mirrored: { block: Bag; line: unknown; past: unknown }[] = [
  {
    block: { type: 'tool_use', id: 'toolu_said', name: 'Bash', input: { command: 'ls -la /tmp/scratch', description: 'Check scratch directory' } },
    line: 'Check scratch directory', past: 'Check scratch directory',
  },
  {
    block: { type: 'tool_use', id: 'toolu_plain', name: 'Bash', input: { command: 'ls -la' } },
    line: { markdown: 'Running `ls -la`' }, past: { markdown: 'Ran `ls -la`' },
  },
  {
    block: { type: 'tool_use', id: 'toolu_lines', name: 'Bash', input: { command: 'cd /tmp\nls -la' } },
    line: { markdown: 'Running `cd /tmp`' }, past: { markdown: 'Ran `cd /tmp`' },
  },
  {
    block: { type: 'tool_use', id: 'toolu_wide', name: 'Bash', input: { command: `echo ${'a'.repeat(100)}` } },
    line: { markdown: `Running \`echo ${'a'.repeat(75)}…\`` }, past: { markdown: `Ran \`echo ${'a'.repeat(75)}…\`` },
  },
  {
    block: { type: 'tool_use', id: 'toolu_ticks', name: 'Bash', input: { command: 'echo `date`' } },
    line: { markdown: 'Running `` echo `date` ``' }, past: { markdown: 'Ran `` echo `date` ``' },
  },
  {
    block: { type: 'tool_use', id: 'toolu_grep', name: 'Grep', input: { pattern: 'kqueue', path: '/src' } },
    line: { markdown: 'Search for `kqueue`' }, past: { markdown: 'Search for `kqueue`' },
  },
  {
    block: { type: 'tool_use', id: 'toolu_glob', name: 'Glob', input: { pattern: '**/*.ts' } },
    line: { markdown: 'Find files matching `**/*.ts`' }, past: { markdown: 'Find files matching `**/*.ts`' },
  },
  {
    block: { type: 'tool_use', id: 'toolu_read', name: 'Read', input: { file_path: '/tmp/a b(1).txt' } },
    line: { markdown: 'Read [a b(1).txt](file:///tmp/a%20b%281%29.txt)' }, past: { markdown: 'Read [a b(1).txt](file:///tmp/a%20b%281%29.txt)' },
  },
  {
    block: { type: 'tool_use', id: 'toolu_skill', name: 'Skill', input: { skill: 'do-spec' } },
    line: { markdown: 'Running skill `do-spec`' }, past: { markdown: 'Ran skill `do-spec`' },
  },
  {
    block: { type: 'tool_use', id: 'toolu_task', name: 'Task', input: { description: 'Find the reducer', prompt: 'Look for it', subagent_type: 'Explore' } },
    line: 'Find the reducer', past: 'Find the reducer',
  },
  {
    block: { type: 'tool_use', id: 'toolu_monitor', name: 'Monitor', input: { description: 'Watch the build log', command: 'tail -f build.log', timeout_ms: 1000 } },
    line: 'Watch the build log', past: 'Watch the build log',
  },
  {
    block: { type: 'tool_use', id: 'toolu_done', name: 'TaskUpdate', input: { taskId: '3', status: 'completed', description: 'A new body for the task' } },
    line: 'Complete task', past: 'Complete task',
  },
  {
    block: { type: 'tool_use', id: 'toolu_create', name: 'TaskCreate', input: { subject: 'Write the docs', description: 'Every page, in full' } },
    line: 'Create task: Write the docs', past: 'Create task: Write the docs',
  },
  {
    block: { type: 'tool_use', id: 'toolu_topic', name: 'mcp__docs__search', input: { limit: 5, topic: 'kqueue' } },
    line: 'kqueue', past: 'kqueue',
  },
];

/** A result for each mirrored call; the first one failed. */
const answered = {
  type: 'user', parent_tool_use_id: null, uuid: 'u2', timestamp: '2020-01-01T00:00:00.000Z',
  message: {
    role: 'user',
    content: mirrored.map(({ block }, index) => ({
      type: 'tool_result', tool_use_id: block.id, content: 'ok', ...(index === 0 ? { is_error: true } : {}),
    })),
  },
};

it('draws a live call\'s row line as its description or VS Code\'s line, and its past tense the same way', async () => {
  const { held, ready } = await live([
    { type: 'assistant', parent_tool_use_id: null, uuid: 'a1', message: { id: 'msg_1', role: 'assistant', content: mirrored.map(({ block }) => block) } },
    answered,
  ]);
  for (const { block, line, past } of mirrored) {
    const id = block.id as string;
    expect(ready.get(id)?.invocationMessage, id).toEqual(line);
    expect(held.get(id)?.invocationMessage, id).toEqual(line);
    expect(held.get(id)?.pastTenseMessage, id).toEqual(past);
    const input = block.input as Bag;
    expect(held.get(id)?.toolInput, id).toBe(block.name === 'Bash' ? input.command : JSON.stringify(input));
  }
  expect(held.get('toolu_said')?.success).toBe(false);
});

it('draws a restored call\'s row line and past tense as the live one does', async () => {
  const back = await restored(mirrored.map(({ block }) => block), [answered]);
  for (const { block, line, past } of mirrored) {
    const id = block.id as string;
    expect(back.get(id)?.invocationMessage, id).toEqual(line);
    expect(back.get(id)?.pastTenseMessage, id).toEqual(past);
    const input = block.input as Bag;
    expect(back.get(id)?.toolInput, id).toBe(block.name === 'Bash' ? input.command : JSON.stringify(input));
  }
  expect(back.get('toolu_said')?.success).toBe(false);
});

it('gives a confirmation card the row line, not the CLI\'s title', async () => {
  sdk.hold = new Promise(() => {});
  const input = { command: 'rm -rf /tmp/scratch', description: 'Clear scratch directory' };
  const { held, ready } = await live([], () => {
    void sdk.canUseTool?.('Bash', input, { toolUseID: 'toolu_card', title: 'Claude wants to run rm -rf /tmp/scratch' });
  });
  sdk.hold = Promise.resolve();
  expect(held.get('toolu_card')?.invocationMessage).toBe('Clear scratch directory');
  expect(ready.get('toolu_card')?.invocationMessage).toBe('Clear scratch directory');
  expect(held.get('toolu_card')?.confirmationTitle).toBe('Claude wants to run rm -rf /tmp/scratch');
  expect(held.get('toolu_card')?.toolInput).toBe('rm -rf /tmp/scratch');
});

const asBag = (value: unknown): Bag => (typeof value === 'object' && value !== null ? value as Bag : {});
type BeforeToolHook = (input: Bag, toolUseID: string | undefined, options: { signal: AbortSignal }) => Promise<Bag>;
// Match the case-sensitive server and operation name reported by the live AHP tool call.
const jiraTool = 'mcp__claude_ai_Atlassian__editJiraIssue';
const jiraServers = { claude_ai_Atlassian: { type: 'http', url: 'https://mcp.atlassian.com/v1' } };

function jiraPreToolUse(): { hook: BeforeToolHook; timeout: number | undefined } {
  const hooks = asBag(sdk.queryOptions?.hooks);
  const groups = Array.isArray(hooks.PreToolUse) ? hooks.PreToolUse.map(asBag) : [];
  const group = groups.find((entry) => entry.matcher === 'mcp__.*');
  const callbacks = Array.isArray(group?.hooks) ? group.hooks : [];
  return { hook: callbacks[0] as BeforeToolHook, timeout: typeof group?.timeout === 'number' ? group.timeout : undefined };
}

function requestFor(sent: Bag[], toolUseId: string, from = 0): Bag | undefined {
  const action = sent.slice(from).find((one) => one.type === 'session/inputNeededSet'
    && asBag(one.request).kind === 'toolConfirmation'
    && asBag(asBag(one.request).toolCall).toolCallId === toolUseId);
  return action === undefined ? undefined : asBag(action.request);
}

function callFromSnapshot(session: ReturnType<typeof createSession>, toolUseId: string): Bag | undefined {
  const state = asBag(session.chatState());
  const turns = [
    ...(Array.isArray(state.turns) ? state.turns.map(asBag) : []),
    ...(state.activeTurn === undefined ? [] : [asBag(state.activeTurn)]),
  ];
  for (const turn of turns) {
    const parts = Array.isArray(turn.responseParts) ? turn.responseParts.map(asBag) : [];
    const part = parts.find((entry) => entry.kind === 'toolCall' && asBag(entry.toolCall).toolCallId === toolUseId);
    if (part) return asBag(part.toolCall);
  }
  return undefined;
}

const hookDecision = (output: Bag): string | undefined => asBag(output.hookSpecificOutput).permissionDecision as string | undefined;

it('awaits a fresh AHP confirmation on each of 15 Atlassian issue edits, despite auto mode and an allowedTools rule', async () => {
  const { session, sent } = await live([], undefined, {
    settings: { permissionMode: 'auto', permissions: { allow: [jiraTool] } },
    mcpServers: jiraServers,
  });
  const { hook, timeout } = jiraPreToolUse();
  expect(sdk.queryOptions?.permissionMode).toBe('auto');
  expect(sdk.queryOptions?.allowedTools).toContain(jiraTool);
  expect(timeout).toBe(1800);
  // A version-only search may supply candidates, but it creates no write scope.
  expect(await hook({
    hook_event_name: 'PreToolUse', tool_name: 'mcp__atlassian__searchJiraIssuesUsingJql', tool_use_id: 'toolu_version_search',
    tool_input: { jql: 'project = WOR AND fixVersion = "2026.10"' },
  }, undefined, { signal: new AbortController().signal })).toEqual({});
  expect(sent.some((one) => one.type === 'session/inputNeededSet')).toBe(false);

  for (let index = 0; index < 15; index++) {
    const toolUseId = `toolu_atlassian_${index + 1}`;
    const payload = {
      issueKey: `WOR-${501 + index}`,
      fields: { summary: `Scoped edit ${index + 1}`, description: `Proposed full description ${index + 1}` },
    };
    let finished = false;
    const before = sent.length;
    const result = hook({ hook_event_name: 'PreToolUse', tool_name: jiraTool, tool_input: payload, tool_use_id: toolUseId }, undefined, { signal: new AbortController().signal })
      .then((value) => { finished = true; return value; });
    await settle();
    expect(finished, `call ${index + 1} waits for its own human answer`).toBe(false);
    const request = requestFor(sent, toolUseId, before);
    expect(request, `call ${index + 1} has a distinct pending confirmation`).toBeDefined();
    const confirmation = asBag(request?.toolCall);
    expect(confirmation.confirmationTitle).toBe(`Confirm ${jiraTool} for WOR-${501 + index}?`);
    expect(confirmation.invocationMessage).toContain(`WOR-${501 + index}`);
    expect(JSON.parse(confirmation.toolInput as string)).toEqual(payload);
    expect(confirmation).not.toHaveProperty('options');
    expect(confirmation._meta).toMatchObject({ requiresHumanConfirmation: true });
    const ready = sent.slice(before).find((one) => one.type === 'chat/toolCallReady' && one.toolCallId === toolUseId);
    expect(ready?._meta).toMatchObject({ requiresHumanConfirmation: true });
    expect(callFromSnapshot(session, toolUseId)?._meta).toMatchObject({ requiresHumanConfirmation: true });

    session.confirm(toolUseId, true);
    expect(hookDecision(await result)).toBe('allow');
  }
  expect(sent.filter((one) => one.type === 'chat/toolCallReady' && String(one.toolCallId).startsWith('toolu_atlassian_'))).toHaveLength(15);
});

it('recognizes issueIdOrKey on the case-sensitive managed Atlassian edit tool and shows the full proposal', async () => {
  const { session, sent } = await live([], undefined, {
    settings: { permissionMode: 'auto', permissions: { allow: [jiraTool] } },
    mcpServers: jiraServers,
  });
  const { hook } = jiraPreToolUse();
  const toolUseId = 'toolu_managed_atlassian_edit';
  const payload = {
    cloudId: 'https://trustgrid.atlassian.net',
    issueIdOrKey: 'WOR-999999999',
    fields: { summary: 'ahpd guard smoke test' },
  };
  let finished = false;
  const before = sent.length;
  const pending = hook({
    hook_event_name: 'PreToolUse', tool_name: jiraTool, tool_input: payload, tool_use_id: toolUseId,
  }, undefined, { signal: new AbortController().signal }).then((value) => { finished = true; return value; });
  await settle();
  expect(finished).toBe(false);
  const request = requestFor(sent, toolUseId, before);
  const confirmation = asBag(request?.toolCall);
  expect(confirmation.confirmationTitle).toBe(`Confirm ${jiraTool} for WOR-999999999?`);
  expect(JSON.parse(confirmation.toolInput as string)).toEqual(payload);
  expect(confirmation._meta).toMatchObject({ requiresHumanConfirmation: true });

  session.confirm(toolUseId, true);
  expect(hookDecision(await pending)).toBe('allow');
});

it('keeps each of 15 sequential Jira edits pending without a human, then denies on hook abort', async () => {
  const { sent } = await live([], undefined, { settings: { permissionMode: 'auto' }, mcpServers: jiraServers });
  const { hook } = jiraPreToolUse();
  expect(await hook({
    hook_event_name: 'PreToolUse', tool_name: 'mcp__atlassian__searchJiraIssuesUsingJql', tool_use_id: 'toolu_search_only',
    tool_input: { jql: 'fixVersion = "2026.10"' },
  }, undefined, { signal: new AbortController().signal })).toEqual({});

  for (let index = 0; index < 15; index++) {
    const toolUseId = `toolu_unapproved_${index + 1}`;
    const controller = new AbortController();
    let finished = false;
    const before = sent.length;
    const pending = hook({
      hook_event_name: 'PreToolUse', tool_name: jiraTool, tool_use_id: toolUseId,
      tool_input: { issueKey: `WOR-${601 + index}`, fields: { summary: `Unapproved edit ${index + 1}` } },
    }, undefined, { signal: controller.signal }).then((value) => { finished = true; return value; });
    await settle();
    expect(finished, `target ${index + 1} remains blocked without a human`).toBe(false);
    expect(requestFor(sent, toolUseId, before)).toBeDefined();
    controller.abort();
    expect(hookDecision(await pending)).toBe('deny');
  }
  expect(sent.filter((one) => one.type === 'session/inputNeededSet' && String(asBag(one.request).id).startsWith('toolu_unapproved_'))).toHaveLength(15);
  expect(sent.filter((one) => one.type === 'session/inputNeededRemoved' && String(one.id).startsWith('toolu_unapproved_'))).toHaveLength(15);
});

it('does not let a settled allow permission skip AHP confirmation in canUseTool', async () => {
  const { session, sent } = await live([], undefined, {
    settings: { permissionMode: 'auto', permissions: { allow: [jiraTool] } },
    mcpServers: jiraServers,
  });
  expect(sdk.queryOptions?.allowedTools).toContain(jiraTool);
  const payload = { issueKey: 'WOR-700', fields: { summary: 'Explicitly reviewed' } };
  let finished = false;
  const result = sdk.canUseTool?.(jiraTool, payload, { toolUseID: 'toolu_settled_allow', suggestions: [{ type: 'addRules' }] })
    .then((value) => { finished = true; return asBag(value); });
  expect(result).toBeDefined();
  await settle();
  expect(finished).toBe(false);
  const request = requestFor(sent, 'toolu_settled_allow');
  expect(asBag(request?.toolCall)).not.toHaveProperty('options');
  expect(asBag(request?.toolCall)._meta).toMatchObject({ requiresHumanConfirmation: true });
  session.confirm('toolu_settled_allow', true);
  expect(asBag(await result)._meta).toBeUndefined();
  expect(asBag(await result).behavior).toBe('allow');
});

it('denies Jira mutations when keys appear only inside fields, comments, or search results', async () => {
  const { sent } = await live([], undefined, { mcpServers: jiraServers });
  const { hook } = jiraPreToolUse();
  const output = await hook({
    hook_event_name: 'PreToolUse', tool_name: jiraTool, tool_use_id: 'toolu_hidden_key',
    tool_input: { fields: { summary: 'A change for WOR-901' }, comment: 'Found WOR-901 in search', searchResults: [{ key: 'WOR-901' }] },
  }, undefined, { signal: new AbortController().signal });
  expect(hookDecision(output)).toBe('deny');
  expect(sent.some((one) => one.type === 'session/inputNeededSet')).toBe(false);
  expect(sent.some((one) => one.type === 'chat/toolCallReady')).toBe(false);
});

it('preserves Jira reads and exact new-issue creation while guarding create_issue_link', async () => {
  const { session, sent } = await live([], undefined, { mcpServers: jiraServers });
  const { hook } = jiraPreToolUse();
  const invoke = (name: string, input: Bag, id: string) => hook({ hook_event_name: 'PreToolUse', tool_name: name, tool_input: input, tool_use_id: id }, undefined, { signal: new AbortController().signal });
  expect(await invoke('mcp__atlassian__getJiraIssue', {}, 'toolu_read')).toEqual({});
  expect(await invoke('mcp__atlassian__createJiraIssue', { fields: { summary: 'New issue' } }, 'toolu_create')).toEqual({});
  const payload = { issueKey: 'WOR-10', targetIssueKey: 'WOR-11', linkType: 'Blocks' };
  let finished = false;
  const before = sent.length;
  const link = invoke('mcp__atlassian__create_issue_link', payload, 'toolu_link').then((value) => { finished = true; return value; });
  await settle();
  expect(finished).toBe(false);
  const request = requestFor(sent, 'toolu_link', before);
  const confirmation = asBag(request?.toolCall);
  expect(confirmation.confirmationTitle).toBe('Confirm mcp__atlassian__create_issue_link for WOR-10, WOR-11?');
  expect(JSON.parse(confirmation.toolInput as string)).toEqual(payload);
  expect(confirmation._meta).toMatchObject({ requiresHumanConfirmation: true });
  session.confirm('toolu_link', true);
  expect(hookDecision(await link)).toBe('allow');
  expect(session.chatState()).toBeDefined();
});

it('denies a human refusal and aborts timed-out confirmations without leaving or re-emitting a card', async () => {
  const { session, sent } = await live([], undefined, { mcpServers: jiraServers });
  const { hook } = jiraPreToolUse();
  const payload = { issueKey: 'WOR-800', fields: { summary: 'Should not run' } };
  const denied = hook({ hook_event_name: 'PreToolUse', tool_name: jiraTool, tool_input: payload, tool_use_id: 'toolu_human_denied' }, undefined, { signal: new AbortController().signal });
  await settle();
  session.confirm('toolu_human_denied', false);
  expect(hookDecision(await denied)).toBe('deny');

  const alreadyAborted = new AbortController();
  alreadyAborted.abort();
  const preAborted = await hook({ hook_event_name: 'PreToolUse', tool_name: jiraTool, tool_input: payload, tool_use_id: 'toolu_pre_aborted' }, undefined, { signal: alreadyAborted.signal });
  expect(hookDecision(preAborted)).toBe('deny');

  let raceAborted = false;
  const raceSignal = {
    get aborted() { return raceAborted; },
    addEventListener: () => { raceAborted = true; },
    removeEventListener: () => {},
  } as unknown as AbortSignal;
  const beforeRace = sent.length;
  const raced = await hook({ hook_event_name: 'PreToolUse', tool_name: jiraTool, tool_input: payload, tool_use_id: 'toolu_abort_registration_race' }, undefined, { signal: raceSignal });
  expect(hookDecision(raced)).toBe('deny');
  expect(sent.slice(beforeRace).some((one) => one.type === 'session/inputNeededSet' || one.type === 'chat/toolCallReady')).toBe(false);

  const duringWait = new AbortController();
  const before = sent.length;
  const waiting = hook({ hook_event_name: 'PreToolUse', tool_name: jiraTool, tool_input: payload, tool_use_id: 'toolu_aborted_wait' }, undefined, { signal: duringWait.signal });
  await settle();
  const request = requestFor(sent, 'toolu_aborted_wait', before);
  expect(request).toBeDefined();
  duringWait.abort();
  expect(hookDecision(await waiting)).toBe('deny');
  const afterAbort = sent.slice(before);
  expect(afterAbort.filter((one) => one.type === 'session/inputNeededSet')).toHaveLength(1);
  expect(afterAbort.filter((one) => one.type === 'session/inputNeededRemoved' && one.id === request?.id)).toHaveLength(1);
  session.confirm('toolu_aborted_wait', true);
  expect(hookDecision(await Promise.resolve(await waiting))).toBe('deny');
  expect(callFromSnapshot(session, 'toolu_aborted_wait')?.status).toBe('cancelled');
  expect(afterAbort.filter((one) => one.type === 'chat/toolCallReady' && one.toolCallId === 'toolu_aborted_wait')).toHaveLength(1);
});
