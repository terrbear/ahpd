import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { claude } from '../src/claude.js';
import { replacePreToolUseHooks } from '../src/session.js';

const sdk = vi.hoisted(() => ({
  options: [] as Record<string, unknown>[],
  presetHooks: undefined as Record<string, unknown> | undefined,
}));

vi.mock('../src/options.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/options.js')>();
  return {
    ...actual,
    queryOptionsOf: (values: Parameters<typeof actual.queryOptionsOf>[0]) => ({
      ...actual.queryOptionsOf(values),
      ...(sdk.presetHooks === undefined ? {} : { hooks: sdk.presetHooks }),
    }),
  };
});

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  createSdkMcpServer: (given: Record<string, unknown>) => ({ type: 'sdk', name: given.name, tools: given.tools }),
  query: ({ options }: { options: Record<string, unknown> }) => {
    sdk.options.push(options);
    return {
      async *[Symbol.asyncIterator]() { /* nothing streamed */ },
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

const settle = async () => {
  for (let i = 0; i < 8; i++) await new Promise((done) => { setTimeout(done, 0); });
};

const start = (directory: string, settings: Record<string, unknown> = {}) => {
  const agent = claude({ paths: [directory] });
  return agent.create({
    uri: 'ahp-session:/claude-config-isolation',
    chatUri: 'ahp-chat:/claude-config-isolation',
    workingDirectory: directory,
    settings: { ...agent.defaults(), ...settings },
    schema: agent.schema,
    mcpServers: { declared: { type: 'http', url: 'https://declared.example.test/mcp' } },
    tools: [{ definition: { name: 'host_tool', inputSchema: { type: 'object' } }, run: () => 'ok' } as never],
    emit: () => {},
  });
};

const queryFor = async (settings: Record<string, unknown> = {}) => {
  const directory = mkdtempSync(join(tmpdir(), 'ahpd-config-isolation-'));
  writeFileSync(join(directory, '.mcp.json'), JSON.stringify({
    mcpServers: { ambient: { type: 'http', url: 'https://ambient.example.test/mcp' } },
  }));
  sdk.options = [];
  const session = start(directory, settings);
  try {
    await settle();
    const options = sdk.options.at(0);
    if (options === undefined) throw new Error('no SDK query was created');
    return options;
  }
  finally {
    await session.close();
    rmSync(directory, { recursive: true, force: true });
  }
};

it('advertises an immutable per-session selector with the default behavior', () => {
  const agent = claude({ paths: ['/tmp/ahpd-config-isolation-schema'] });
  const properties = agent.schema().properties as Record<string, Record<string, unknown>>;
  expect(properties.claudeConfigIsolation).toMatchObject({
    scope: 'session',
    type: 'string',
    enum: ['default', 'isolated'],
    default: 'default',
    sessionMutable: false,
  });
  expect(properties.claudeConfigIsolation?.description).toContain('settingSources: []');
  expect(properties.claudeConfigIsolation?.description).toContain('strictMcpConfig: true');
  expect(properties.claudeConfigIsolation?.description).toContain('plugins: []');
  expect(properties.claudeConfigIsolation?.description).toContain('~/.claude.json');
  expect(properties.claudeConfigIsolation?.description).toContain('auto-memory');
  expect(properties.claudeConfigIsolation?.description).toContain('administrator policy');
  expect(properties.captureSdkInitToolManifest).toMatchObject({
    scope: 'session',
    type: 'string',
    enum: ['disabled', 'enabled'],
    default: 'disabled',
    sessionMutable: false,
  });
  expect(properties.toolExecutionFence).toMatchObject({
    scope: 'session',
    type: 'string',
    enum: ['off', 'deny-all'],
    default: 'off',
    sessionMutable: false,
  });
  expect(agent.defaults()).toHaveProperty('claudeConfigIsolation', 'default');
  expect(agent.defaults()).toHaveProperty('captureSdkInitToolManifest', 'disabled');
  expect(agent.defaults()).toHaveProperty('toolExecutionFence', 'off');
});

it('does not allow the isolation or execution fence to change on a running session', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ahpd-config-isolation-immutable-'));
  sdk.options = [];
  const session = start(directory, { claudeConfigIsolation: 'default' });
  try {
    await settle();
    expect(await session.setConfig!('claudeConfigIsolation', 'isolated')).toBe(
      'claudeConfigIsolation is not a config key this backend takes',
    );
    expect(await session.setConfig!('toolExecutionFence', 'deny-all')).toBe(
      'toolExecutionFence is not a config key this backend takes',
    );
    expect(sdk.options[0]).not.toHaveProperty('settingSources');
  }
  finally {
    await session.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

it('does not activate preset lifecycle hooks when the execution fence is off', async () => {
  sdk.presetHooks = {
    SessionStart: [{ hooks: [async () => ({})] }],
    Stop: [{ hooks: [async () => ({})] }],
  };
  try {
    const options = await queryFor();
    expect(options.hooks).toMatchObject({
      PreToolUse: [
        { matcher: 'Bash', hooks: [expect.any(Function)] },
        { matcher: 'mcp__.*', hooks: [expect.any(Function)], timeout: 1800 },
      ],
    });
    expect(options.hooks).not.toHaveProperty('SessionStart');
    expect(options.hooks).not.toHaveProperty('Stop');
    expect(options.canUseTool).toBeTypeOf('function');
  }
  finally {
    sdk.presetHooks = undefined;
  }
});

it('preserves ordinary tool behavior when the execution fence is off', async () => {
  const options = await queryFor();
  const hooks = options.hooks as { PreToolUse: { matcher?: string }[] };
  expect(hooks.PreToolUse.map((one) => one.matcher)).toEqual(['Bash', 'mcp__.*']);
  expect(options.canUseTool).toBeTypeOf('function');
});

it('denies every tool class through the unconditional hook and secondary callback', async () => {
  const tools = ['Read', 'Bash', 'Grep', 'ToolSearch', 'Agent', 'Task', 'mcp__arbitrary__run', 'mcp__ahp__host_tool'];
  const options = await queryFor({
    toolExecutionFence: 'deny-all',
    permissions: { allow: tools, deny: [] },
  });
  const hooks = options.hooks as { PreToolUse: { matcher?: string; hooks: ((...args: unknown[]) => Promise<Record<string, unknown>>)[] }[] };
  expect(hooks.PreToolUse).toHaveLength(1);
  expect(hooks.PreToolUse[0]).not.toHaveProperty('matcher');
  const denyHook = hooks.PreToolUse[0]!.hooks[0]!;
  const canUseTool = options.canUseTool as (name: string, input: Record<string, unknown>, options: { signal: AbortSignal }) => Promise<Record<string, unknown>>;
  expect(options.allowedTools).toEqual(tools);
  for (const [index, name] of tools.entries()) {
    const controller = new AbortController();
    if (name === 'Agent') controller.abort();
    const hook = await denyHook(
      { hook_event_name: 'PreToolUse', tool_name: name, tool_input: { fixture: index } },
      `toolu_${index}`,
      { signal: controller.signal },
    );
    expect(hook).toMatchObject({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny' },
    });
    expect(await canUseTool(name, { fixture: index }, { signal: controller.signal })).toMatchObject({ behavior: 'deny' });
  }
});

it('replaces PreToolUse gates while preserving other lifecycle hooks', () => {
  const sessionStart = [{ hooks: ['start'] }];
  const stop = [{ hooks: ['stop'] }];
  const replacement = [{ hooks: ['deny-all'] }];
  expect(replacePreToolUseHooks({ SessionStart: sessionStart, PreToolUse: [{ matcher: 'Bash' }], Stop: stop }, replacement)).toEqual({
    SessionStart: sessionStart,
    PreToolUse: replacement,
    Stop: stop,
  });
});

it('preserves default discovery and adds no isolation options by default', async () => {
  const options = await queryFor();
  expect(options).not.toHaveProperty('settingSources');
  expect(options).not.toHaveProperty('strictMcpConfig');
  expect(options).not.toHaveProperty('plugins');
  expect(options.mcpServers).toMatchObject({
    ambient: { type: 'http', url: 'https://ambient.example.test/mcp' },
    ahp: { type: 'sdk', name: 'ahp', tools: [{ name: 'host_tool' }] },
  });
  expect(options.mcpServers).not.toHaveProperty('declared');
});

it('isolates config with SDK built-ins off while retaining declared MCP and AHP tools', async () => {
  const options = await queryFor({ claudeConfigIsolation: 'isolated', builtInTools: 'none' });
  expect(options).toMatchObject({ tools: [], settingSources: [], strictMcpConfig: true, plugins: [] });
  expect(options.mcpServers).toMatchObject({
    declared: { type: 'http', url: 'https://declared.example.test/mcp' },
    ahp: { type: 'sdk', name: 'ahp', tools: [{ name: 'host_tool' }] },
  });
  expect(options.mcpServers).not.toHaveProperty('ambient');
});

it.each([null, 1, 'enabled'])('rejects invalid execution fence values before SDK query creation: %j', (value) => {
  const directory = mkdtempSync(join(tmpdir(), 'ahpd-config-fence-invalid-'));
  sdk.options = [];
  try {
    expect(() => start(directory, { toolExecutionFence: value })).toThrow('toolExecutionFence must be one of off, deny-all');
    expect(sdk.options).toEqual([]);
  }
  finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

it.each([null, 1, 'unsupported'])('rejects invalid isolation values before SDK query creation: %j', (value) => {
  const directory = mkdtempSync(join(tmpdir(), 'ahpd-config-isolation-invalid-'));
  sdk.options = [];
  try {
    expect(() => start(directory, { claudeConfigIsolation: value })).toThrow('claudeConfigIsolation must be one of default, isolated');
    expect(sdk.options).toEqual([]);
  }
  finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
