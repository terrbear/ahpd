import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

const settle = async () => {
  for (let i = 0; i < 8; i++) await new Promise((done) => { setTimeout(done, 0); });
};

const start = (directory: string, configIsolation?: unknown) => {
  const agent = claude({ paths: [directory] });
  return agent.create({
    uri: 'ahp-session:/claude-config-isolation',
    chatUri: 'ahp-chat:/claude-config-isolation',
    workingDirectory: directory,
    settings: {
      ...agent.defaults(),
      ...(configIsolation === undefined ? {} : { claudeConfigIsolation: configIsolation }),
    },
    schema: agent.schema,
    mcpServers: { declared: { type: 'http', url: 'https://declared.example.test/mcp' } },
    tools: [{ definition: { name: 'host_tool', inputSchema: { type: 'object' } }, run: () => 'ok' } as never],
    emit: () => {},
  });
};

const queryFor = async (configIsolation?: unknown) => {
  const directory = mkdtempSync(join(tmpdir(), 'ahpd-config-isolation-'));
  writeFileSync(join(directory, '.mcp.json'), JSON.stringify({
    mcpServers: { ambient: { type: 'http', url: 'https://ambient.example.test/mcp' } },
  }));
  sdk.options = [];
  const session = start(directory, configIsolation);
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
  expect(agent.defaults()).toHaveProperty('claudeConfigIsolation', 'default');
});

it('does not allow the selector to change on a running session', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ahpd-config-isolation-immutable-'));
  sdk.options = [];
  const session = start(directory, 'default');
  try {
    await settle();
    expect(await session.setConfig!('claudeConfigIsolation', 'isolated')).toBe(
      'claudeConfigIsolation is not a config key this backend takes',
    );
    expect(sdk.options[0]).not.toHaveProperty('settingSources');
  }
  finally {
    await session.close();
    rmSync(directory, { recursive: true, force: true });
  }
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

it('isolates filesystem settings and MCP while retaining host MCP and AHP tools', async () => {
  const options = await queryFor('isolated');
  expect(options).toMatchObject({ settingSources: [], strictMcpConfig: true, plugins: [] });
  expect(options.mcpServers).toMatchObject({
    declared: { type: 'http', url: 'https://declared.example.test/mcp' },
    ahp: { type: 'sdk', name: 'ahp', tools: [{ name: 'host_tool' }] },
  });
  expect(options.mcpServers).not.toHaveProperty('ambient');
});

it.each([null, 1, 'unsupported'])('rejects invalid isolation values before SDK query creation: %j', (value) => {
  const directory = mkdtempSync(join(tmpdir(), 'ahpd-config-isolation-invalid-'));
  sdk.options = [];
  try {
    expect(() => start(directory, value)).toThrow('claudeConfigIsolation must be one of default, isolated');
    expect(sdk.options).toEqual([]);
  }
  finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
