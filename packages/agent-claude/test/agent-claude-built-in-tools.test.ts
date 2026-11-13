import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { claude } from '../src/claude.js';

const sdk = vi.hoisted(() => ({ options: [] as Record<string, unknown>[] }));

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

const { createSession } = await import('../src/session.js');

const start = (directory: string, settings: Record<string, unknown>) => {
  const agent = claude({ paths: [directory] });
  return agent.create({
    uri: 'ahp-session:/built-in-tools',
    chatUri: 'ahp-chat:/built-in-tools',
    workingDirectory: directory,
    settings,
    schema: agent.schema,
    emit: () => {},
  });
};

const queried = async (settings?: Record<string, unknown>): Promise<Record<string, unknown>> => {
  const directory = mkdtempSync(join(tmpdir(), 'ahpd-built-in-tools-'));
  sdk.options = [];
  const agent = claude({ paths: [directory] });
  const session = start(directory, settings ?? agent.defaults());
  try {
    for (let i = 0; i < 8; i++) await new Promise((done) => { setTimeout(done, 0); });
    const options = sdk.options.at(0);
    if (options === undefined) throw new Error('no query was built');
    return options;
  }
  finally {
    await session.close();
    rmSync(directory, { recursive: true, force: true });
  }
};

it('advertises a fixed per-session built-in tools selector with the normal default', () => {
  const agent = claude({ paths: ['/tmp/ahpd-built-in-tools-schema'] });
  const properties = agent.schema().properties as Record<string, Record<string, unknown>>;
  expect(properties.builtInTools).toMatchObject({
    scope: 'session',
    type: 'string',
    enum: ['default', 'none'],
    enumLabels: ['Default built-in tools', 'No built-in tools'],
    default: 'default',
    sessionMutable: false,
  });
  expect(agent.defaults()).toHaveProperty('builtInTools', 'default');
});

it('leaves the SDK default unchanged unless a session opts out', async () => {
  const ordinary = await queried();
  expect(ordinary).not.toHaveProperty('tools');

  const optedOut = await queried({ builtInTools: 'none' });
  expect(optedOut.tools).toEqual([]);
});

it.each([null, 1, 'unsupported'])('rejects unsupported built-in tool config %j before query creation', (builtInTools) => {
  const directory = mkdtempSync(join(tmpdir(), 'ahpd-built-in-tools-invalid-'));
  sdk.options = [];
  try {
    expect(() => start(directory, { builtInTools })).toThrow('builtInTools must be one of default, none');
    expect(sdk.options).toEqual([]);
  }
  finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

it('keeps deferred host tools searchable when built-in tools are disabled', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ahpd-built-in-tools-mcp-'));
  sdk.options = [];
  const session = createSession({
    uri: 'ahp-session:/built-in-tools-mcp',
    chatUri: 'ahp-chat:/built-in-tools-mcp',
    cwd: directory,
    settings: { builtInTools: 'none' },
    mcpServers: { fixture: { type: 'http', url: 'https://fixture.example.test/mcp' } },
    tools: [{ definition: { name: 'host_tool', inputSchema: { type: 'object' } }, deferLoading: true, run: () => 'ok' } as never],
    emit: () => {},
  });
  try {
    for (let i = 0; i < 8; i++) await new Promise((done) => { setTimeout(done, 0); });
    const options = sdk.options.at(0);
    expect(options?.tools).toEqual(['ToolSearch']);
    expect(options?.mcpServers).toMatchObject({
      fixture: { type: 'http', url: 'https://fixture.example.test/mcp' },
      ahp: { type: 'sdk', name: 'ahp' },
    });
    const ahp = options?.mcpServers as { ahp?: { tools?: { name: string; _meta?: Record<string, unknown> }[] } };
    expect(ahp.ahp?.tools?.[0]).toMatchObject({
      name: 'host_tool',
      _meta: { 'anthropic/alwaysLoad': false },
    });
  }
  finally {
    await session.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

it('does not enable ToolSearch for eager host tools when built-in tools are disabled', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ahpd-built-in-tools-eager-'));
  sdk.options = [];
  const session = createSession({
    uri: 'ahp-session:/built-in-tools-eager',
    chatUri: 'ahp-chat:/built-in-tools-eager',
    cwd: directory,
    settings: { builtInTools: 'none' },
    tools: [{ definition: { name: 'eager_tool', inputSchema: { type: 'object' } }, run: () => 'ok' } as never],
    emit: () => {},
  });
  try {
    for (let i = 0; i < 8; i++) await new Promise((done) => { setTimeout(done, 0); });
    expect(sdk.options.at(0)?.tools).toEqual([]);
  }
  finally {
    await session.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
