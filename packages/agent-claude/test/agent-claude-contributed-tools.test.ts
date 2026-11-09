import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createHost } from '../../sdk/src/host.js';
import type { BoundTool, ComputerPort, Start } from '@ahpd/sdk';
import { claude } from '../src/claude.js';

const sdk = vi.hoisted(() => ({
  servers: [] as Record<string, unknown>[],
  updates: [] as Record<string, unknown>[],
  runs: [] as {
    options: Record<string, unknown>;
    closed: boolean;
    send: (frame: Record<string, unknown>) => void;
  }[],
}));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  createSdkMcpServer: (given: Record<string, unknown>) => {
    sdk.servers.push(given);
    return { type: 'sdk', name: given.name, tools: given.tools };
  },
  query: ({ options, prompt }: { options: Record<string, unknown>; prompt: AsyncIterable<unknown> }) => {
    const frames: Record<string, unknown>[] = [{ type: 'system', subtype: 'init', session_id: options.resume ?? options.sessionId }];
    let wake: (() => void) | undefined;
    const run = { options, closed: false, send: (frame: Record<string, unknown>) => { frames.push(frame); wake?.(); } };
    sdk.runs.push(run);
    void (async () => { for await (const item of prompt) void item; })();
    return {
      async *[Symbol.asyncIterator]() {
        while (!run.closed) {
          while (frames.length > 0) yield frames.shift();
          if (!run.closed) await new Promise<void>((resolve) => { wake = resolve; });
        }
      },
      initializationResult: async () => ({}),
      mcpServerStatus: async () => [],
      reloadSkills: async () => ({ skills: [] }),
      reloadPlugins: async () => ({ plugins: [] }),
      supportedModels: async () => [],
      setModel: async () => {},
      applyFlagSettings: async () => {},
      setPermissionMode: async () => {},
      interrupt: async () => {},
      toggleMcpServer: async () => {},
      setMcpServers: async (servers: Record<string, unknown>) => {
        sdk.updates.push(servers);
        return { added: [], removed: [], errors: {} };
      },
      close: () => { run.closed = true; wake?.(); },
    };
  },
}));

const tools: BoundTool[] = [
  { definition: { name: 'host_tool', inputSchema: { type: 'object' } }, run: () => 'ok' },
  { definition: { name: 'client__client_tool', inputSchema: { type: 'object' } }, owner: 'client' },
];
const external = { declared: { type: 'http' as const, url: 'https://declared.example.test/mcp' } };
const directories: string[] = [];
const sessions: ReturnType<ReturnType<typeof claude>['create']>[] = [];
const settle = async () => { for (let i = 0; i < 60; i++) await Promise.resolve(); };
const start = (settings: Record<string, unknown> = {}, resume?: string, forkAt?: string, inventory = tools, computers?: ComputerPort) => {
  const directory = mkdtempSync(join(tmpdir(), 'ahpd-contributed-tools-'));
  directories.push(directory);
  writeFileSync(join(directory, '.mcp.json'), JSON.stringify({
    mcpServers: { ambient: { type: 'http', url: 'https://ambient.example.test/mcp' } },
  }));
  const agent = claude({ paths: [directory], idleTimeoutMs: 100 });
  const held = agent.create({
    uri: `ahp-session:/${crypto.randomUUID()}`,
    chatUri: `ahp-chat:/${crypto.randomUUID()}`,
    workingDirectory: directory,
    schema: agent.schema,
    settings,
    ...(computers === undefined ? {} : { computers }),
    mcpServers: external,
    tools: inventory,
    emit: () => {},
    ...(resume === undefined ? {} : { resume }),
    ...(forkAt === undefined ? {} : { forkAt }),
  });
  sessions.push(held);
  return held;
};
const valuesOf = (held: (typeof sessions)[number]) => (held.sessionState().config as { values: Record<string, unknown> }).values;

beforeEach(() => { vi.useFakeTimers(); sdk.runs.length = 0; sdk.servers.length = 0; sdk.updates.length = 0; });
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((held) => held.close()));
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  vi.useRealTimers();
});

it('defers marked host tools while keeping other host and client tools eager', async () => {
  const inventory: BoundTool[] = [
    { definition: { name: 'deferred_host_tool', inputSchema: { type: 'object' } }, deferLoading: true, run: () => 'ok' },
    { definition: { name: 'eager_host_tool', inputSchema: { type: 'object' } }, deferLoading: false, run: () => 'ok' },
    { definition: { name: 'client_tool', inputSchema: { type: 'object' } }, owner: 'client' },
  ];
  start({}, undefined, undefined, inventory);
  await settle();
  const server = sdk.servers[0] as { tools: { name: string; _meta?: Record<string, unknown> }[] } | undefined;
  expect(server?.tools.map(({ name, _meta }) => [name, _meta])).toEqual([
    ['deferred_host_tool', { 'anthropic/alwaysLoad': false }],
    ['eager_host_tool', { 'anthropic/alwaysLoad': true }],
    ['client_tool', { 'anthropic/alwaysLoad': true }],
  ]);
});

it('advertises an immutable session selector and resolves the omitted default', async () => {
  const agent = claude({ paths: ['/tmp/ahpd-contributed-tools-schema'] });
  const properties = agent.schema().properties as Record<string, Record<string, unknown>>;
  expect(properties.contributedTools).toMatchObject({
    scope: 'session', type: 'string', enum: ['default', 'none', 'artifacts'], default: 'default', sessionMutable: false,
  });
  expect(agent.defaults()).toHaveProperty('contributedTools', 'default');
  const held = start();
  await settle();
  expect(valuesOf(held).contributedTools).toBe('default');
  expect(held.settings!().contributedTools).toBe('default');
  expect(sdk.runs[0]!.options.env).toBeUndefined();
});

const artifactInventory: BoundTool[] = [
  { definition: { name: 'add_artifact_or_reference', inputSchema: { type: 'object' } }, deferLoading: false, run: () => 'ok' },
  { definition: { name: 'list_artifacts_and_references', inputSchema: { type: 'object' } }, deferLoading: true, run: () => 'ok' },
  { definition: { name: 'remove_artifact_or_reference', inputSchema: { type: 'object' } }, deferLoading: true, run: () => 'ok' },
  { definition: { name: 'list_sessions', inputSchema: { type: 'object' } }, deferLoading: true, run: () => 'ok' },
  { definition: { name: 'set_workspace', inputSchema: { type: 'object' } }, run: () => 'ok' },
  { definition: { name: 'ahp_terminals', inputSchema: { type: 'object' } }, deferLoading: true, run: () => 'ok' },
  { definition: { name: 'anton_codemode', inputSchema: { type: 'object' } }, owner: 'client' },
];
const artifactNames = ['add_artifact_or_reference', 'list_artifacts_and_references', 'remove_artifact_or_reference'];
const offered = (index: number) => (sdk.runs[index]!.options.mcpServers as { ahp: { tools: { name: string }[] } }).ahp.tools.map((one) => one.name);

it('offers only the artifact host tools and client tools for artifacts', async () => {
  const held = start({ contributedTools: 'artifacts', builtInTools: 'none' }, undefined, undefined, artifactInventory);
  await settle();
  expect(offered(0)).toEqual([...artifactNames, 'anton_codemode']);
  expect(sdk.runs[0]!.options.tools).toEqual(['ToolSearch']);
  expect(valuesOf(held).contributedTools).toBe('artifacts');
  expect(held.settings!().contributedTools).toBe('artifacts');
  // late inventories are filtered the same way
  const late = [...artifactInventory, { definition: { name: 'create_session' }, run: () => 'ok' }, { definition: { name: 'late_client' }, owner: 'client2' }];
  expect(await held.setTools!(late)).toBe(true);
  expect((sdk.updates.at(-1) as { ahp: { tools: { name: string }[] } }).ahp.tools.map((one) => one.name))
    .toEqual([...artifactNames, 'anton_codemode', 'late_client']);
});

it('keeps client tools and the host instruction for artifacts, and leaves default and none alone', async () => {
  start({ contributedTools: 'default' }, undefined, undefined, artifactInventory);
  start({ contributedTools: 'none' }, undefined, undefined, artifactInventory);
  await settle();
  expect(offered(0)).toHaveLength(artifactInventory.length);
  expect(sdk.runs[1]!.options.mcpServers).toEqual({ ambient: { type: 'http', url: 'https://ambient.example.test/mcp' } });
});

it('enables ToolSearch for artifacts when artifact tools are deferred', async () => {
  const moved: { env?: Record<string, string> }[] = [];
  const computers: ComputerPort = {
    how: async (_id, options) => { moved.push({ ...(options.env === undefined ? {} : { env: options.env }) }); return undefined; },
  };
  start({ computer: 'computer://fixture', contributedTools: 'artifacts' }, undefined, undefined, artifactInventory, computers);
  await settle();
  const spawn = sdk.runs[0]!.options.spawnClaudeCodeProcess as (asked: { command: string; args: string[]; env: Record<string, string | undefined> }) => unknown;
  spawn({ command: 'claude', args: [], env: {} });
  await settle();
  expect(moved[0]!.env).toEqual({ ENABLE_TOOL_SEARCH: 'true' });
});

it('does not construct or declare host or active-client tools when opted out', async () => {
  const held = start({ contributedTools: 'none', builtInTools: 'none', claudeConfigIsolation: 'isolated' });
  await settle();
  expect(sdk.servers).toEqual([]);
  expect(sdk.runs[0]!.options).toMatchObject({ tools: [], settingSources: [], strictMcpConfig: true, plugins: [] });
  expect(sdk.runs[0]!.options.mcpServers).toEqual(external);
  expect((sdk.runs[0]!.options.env as Record<string, unknown> | undefined)?.ENABLE_TOOL_SEARCH).toBeUndefined();
  expect(valuesOf(held).contributedTools).toBe('none');
});

it.each([
  { contributedTools: 'default', enabled: true },
  { contributedTools: 'none', enabled: false },
])('enables ToolSearch for remote sessions only when contributions are enabled: $contributedTools', async ({ contributedTools, enabled }) => {
  const moved: { id: string; env?: Record<string, string> }[] = [];
  const computers: ComputerPort = {
    how: async (id, options) => { moved.push({ id, ...(options.env === undefined ? {} : { env: options.env }) }); return undefined; },
  };
  start({ computer: 'computer://fixture', contributedTools }, undefined, undefined, tools, computers);
  await settle();
  const spawn = sdk.runs[0]!.options.spawnClaudeCodeProcess as (asked: {
    command: string; args: string[]; env: Record<string, string | undefined>;
  }) => unknown;
  spawn({ command: 'claude', args: [], env: { ANTHROPIC_API_KEY: 'fixture', HOME: '/host/home' } });
  await settle();
  expect(moved).toHaveLength(1);
  expect(moved[0]!.id).toBe('fixture');
  expect(moved[0]!.env).toEqual({
    ANTHROPIC_API_KEY: 'fixture', HOME: '/host/home',
    ...(enabled ? { ENABLE_TOOL_SEARCH: 'true' } : {}),
  });
});

it.each([true, false])('suppresses late host and active-client inventories with initial inventory=%s', async (initial) => {
  const held = start({ contributedTools: 'none', claudeConfigIsolation: 'isolated' }, undefined, undefined, initial ? tools : []);
  await settle();
  for (const next of [tools, [], [...tools, { definition: { name: 'replacement' }, run: () => 'ok' }]]) {
    expect(await held.setTools!(next)).toBe(true);
  }
  expect(sdk.servers).toEqual([]);
  expect(sdk.updates).toEqual([]);
  expect(sdk.runs[0]!.options.mcpServers).toEqual(external);
});

it('preserves default publication, later replacement, discovery and session independence', async () => {
  const omitted = start();
  const none = start({ contributedTools: 'none' });
  const explicit = start({ contributedTools: 'default' });
  await settle();
  for (const index of [0, 2]) {
    expect(sdk.runs[index]!.options.mcpServers).toMatchObject({
      ambient: { type: 'http' }, ahp: { type: 'sdk', tools: [{ name: 'host_tool' }, { name: 'client__client_tool' }] },
    });
  }
  expect(sdk.runs[1]!.options.mcpServers).toEqual({ ambient: { type: 'http', url: 'https://ambient.example.test/mcp' } });
  expect(sdk.runs[1]!.options).not.toHaveProperty('tools');
  expect(sdk.runs[1]!.options).not.toHaveProperty('strictMcpConfig');
  const replacement: BoundTool[] = [{ definition: { name: 'replacement' }, run: () => 'ok' }];
  expect(await omitted.setTools!(replacement)).toBe(true);
  expect(sdk.updates.at(-1)).toMatchObject({ ahp: { tools: [{ name: 'replacement' }] } });
  expect(await none.setTools!(replacement)).toBe(true);
  expect(valuesOf(explicit).contributedTools).toBe('default');
  expect(sdk.servers).toHaveLength(3);
});

it.each(['default', 'none', 'artifacts'])('rejects mutation of %s without changing settings or declarations', async (contributedTools) => {
  const held = start({ contributedTools });
  await settle();
  const before = sdk.runs[0]!.options.mcpServers;
  expect(await held.setConfig!('contributedTools', contributedTools === 'none' ? 'default' : 'none')).toBe(
    'contributedTools is not a config key this backend takes',
  );
  expect(valuesOf(held).contributedTools).toBe(contributedTools);
  expect(sdk.runs[0]!.options.mcpServers).toBe(before);
});

it.each([null, 1, true, {}, [], '', 'isolated', 'off', 'Artifacts'])('rejects invalid policy %j before constructing servers or SDK queries', (contributedTools) => {
  expect(() => start({ contributedTools })).toThrow('contributedTools must be one of default, none, artifacts');
  expect(sdk.servers).toEqual([]);
  expect(sdk.runs).toEqual([]);
});

it.each(['none', 'default'])('keeps %s across late inventories, idle recreation, restore, fork and new-chat settings', async (contributedTools) => {
  const original = start({ contributedTools, claudeConfigIsolation: 'isolated' });
  const assertPolicy = (index: number) => {
    const servers = sdk.runs[index]!.options.mcpServers;
    if (contributedTools === 'none') expect(servers).toEqual(external);
    else expect(servers).toMatchObject({ ...external, ahp: { type: 'sdk', tools: expect.any(Array) } });
  };
  await settle();
  assertPolicy(0);
  const nativeId = sdk.runs[0]!.options.sessionId as string;
  const saved = JSON.parse(JSON.stringify(original.settings!())) as Record<string, unknown>;
  expect(await original.setTools!(tools)).toBe(true);
  await vi.advanceTimersByTimeAsync(100);
  expect(sdk.runs[0]!.closed).toBe(true);
  expect(await original.setTools!([...tools, { definition: { name: 'late_tool' }, owner: 'late' }])).toBe(true);
  original.begin('after-idle', 'Resume the session');
  await settle();
  assertPolicy(1);
  sdk.runs[1]!.send({ type: 'result', subtype: 'success', session_id: nativeId });
  await settle();
  await vi.advanceTimersByTimeAsync(100);
  expect(sdk.runs[1]!.closed).toBe(true);
  original.begin('after-second-idle', 'Resume the saved transcript');
  await settle();
  assertPolicy(2);
  expect(sdk.runs[2]!.options.resume).toBe(nativeId);
  await original.close();
  const restored = start(saved, nativeId);
  await settle();
  assertPolicy(3);
  expect(valuesOf(restored).contributedTools).toBe(contributedTools);
  expect(sdk.runs[3]!.options.resume).toBe(nativeId);
  await restored.close();
  const forked = start(saved, nativeId, 'cut');
  await settle();
  assertPolicy(4);
  expect(valuesOf(forked).contributedTools).toBe(contributedTools);
  expect(sdk.runs[4]!.options).toMatchObject({ resume: nativeId, forkSession: true, resumeSessionAt: 'cut' });
  start(saved);
  await settle();
  assertPolicy(5);
  expect(sdk.runs[5]!.options).not.toHaveProperty('resume');
  if (contributedTools === 'none') {
    expect(sdk.servers).toEqual([]);
    expect(sdk.updates).toEqual([]);
  }
});

it.each([{}, external])('retains isolated host MCP declarations %j before dynamic controls and suppresses contributions in side chats', async (mcpServers) => {
  const directory = mkdtempSync(join(tmpdir(), 'ahpd-contributed-host-'));
  directories.push(directory);
  const agent = claude({ paths: [directory] });
  delete agent.probe;
  delete agent.accountIdentity;
  const starts: Start[] = [];
  const host = createHost({
    path: directory,
    mcpServers,
    tools: [{ definition: { name: 'host_tool', inputSchema: { type: 'object' } }, run: () => 'ok' }],
    agents: [{
      ...agent,
      list: async () => [],
      stateFile: () => undefined,
      create: (start) => { starts.push(start); return agent.create(start); },
    }],
  });
  const client = host.accept({ send: () => {}, notify: () => {}, request: async () => ({}), answered: () => {}, close: () => {} });
  const channel = 'ahp-session:/contributed-host';
  const chat = `ahp-chat://default/${Buffer.from(channel, 'utf8').toString('base64url')}`;
  try {
    await client.handle({ method: 'initialize', params: { channel: 'ahp-root://', clientId: 'fixture', protocolVersions: ['0.9.0'] } });
    await client.handle({ method: 'createSession', params: {
      channel, provider: 'claude', workingDirectories: [`file://${directory}`],
      config: { contributedTools: 'none', claudeConfigIsolation: 'isolated', builtInTools: 'none' },
    } });
    await settle();
    await client.handle({ method: 'dispatchAction', params: {
      channel, action: { type: 'session/activeClientSet', activeClient: { clientId: 'fixture', tools: [{ name: 'client_tool', inputSchema: { type: 'object' } }] } },
    } });
    await client.handle({ method: 'dispatchAction', params: {
      channel: chat, action: { type: 'chat/turnStarted', turnId: 'source', message: { text: 'Source context' } },
    } });
    await settle();
    sdk.runs[0]!.send({ type: 'result', subtype: 'success', session_id: sdk.runs[0]!.options.sessionId });
    await settle();
    await client.handle({ method: 'createChat', params: {
      channel, chat: 'ahp-chat:/contributed-side', source: { kind: 'sideChat', chat, turnId: 'source' },
    } });
    await settle();
    host.setTools([{ definition: { name: 'replacement_host_tool' }, run: () => 'ok' }]);
    await settle();
    expect(starts).toHaveLength(2);
    for (const start of starts) {
      expect(start.settings?.contributedTools).toBe('none');
      expect(start.mcpServers ?? {}).toEqual(mcpServers);
      expect(start.tools?.some((tool) => tool.definition.name === 'host_tool')).toBe(true);
    }
    expect(starts[1]!.tools?.some((tool) => tool.owner === 'fixture')).toBe(true);
    expect(sdk.runs).toHaveLength(2);
    for (const run of sdk.runs) {
      expect(run.options).toMatchObject({ tools: [], settingSources: [], strictMcpConfig: true, plugins: [] });
      expect(run.options.mcpServers ?? {}).toEqual(mcpServers);
    }
    expect(sdk.servers).toEqual([]);
    expect(sdk.updates).toEqual([]);
  } finally {
    client.close();
    await host.close();
  }
});
