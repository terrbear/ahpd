import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { claude } from '../src/claude.js';

const sdk = vi.hoisted(() => ({ runs: [] as {
  options: Record<string, unknown>;
  closed: boolean;
  send: (frame: Record<string, unknown>) => void;
}[] }));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  createSdkMcpServer: (given: Record<string, unknown>) => ({ type: 'sdk', name: given.name, tools: given.tools }),
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
      close: () => { run.closed = true; wake?.(); },
    };
  },
}));

const extraArgs = {
  settings: JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'fixture-hook' }] }] } }),
  'plugin-dir': '/fixture/plugin',
  allowedTools: 'Bash(fixture:*)',
  'dangerously-skip-permissions': null,
};
const presets = {
  work: {
    extraArgs,
    sandbox: 'on',
    thinking: 'disabled',
    outputStyle: 'concise',
    env: { ANTHROPIC_API_KEY: 'fixture-preset-key', ANTHROPIC_BASE_URL: 'https://provider.example.test', AHPD_POLICY_FIXTURE: 'keep' },
  },
};
const directories: string[] = [];
const sessions: ReturnType<ReturnType<typeof claude>['create']>[] = [];
const settle = async () => { for (let i = 0; i < 60; i++) await Promise.resolve(); };
const start = (settings: Record<string, unknown> = {}, resume?: string, forkAt?: string) => {
  const directory = mkdtempSync(join(tmpdir(), 'ahpd-extra-args-policy-'));
  directories.push(directory);
  writeFileSync(join(directory, '.mcp.json'), JSON.stringify({
    mcpServers: { declared: { type: 'http', url: 'https://declared.example.test/mcp' } },
  }));
  const agent = claude({ paths: [directory], presets, idleTimeoutMs: 100 });
  const held = agent.create({
    uri: `ahp-session:/${crypto.randomUUID()}`,
    chatUri: 'ahp-chat:/extra-args-policy',
    workingDirectory: directory,
    schema: agent.schema,
    settings,
    credentials: { 'https://api.anthropic.com': 'fixture-session-key' },
    tools: [{ definition: { name: 'host_tool', inputSchema: { type: 'object' } }, run: () => 'ok' } as never],
    instructions: ['Keep these instructions.'],
    emit: () => {},
    ...(resume === undefined ? {} : { resume }),
    ...(forkAt === undefined ? {} : { forkAt }),
  });
  sessions.push(held);
  return held;
};
const valuesOf = (held: (typeof sessions)[number]) => (held.sessionState().config as { values: Record<string, unknown> }).values;
const comparable = (options: Record<string, unknown>) => JSON.parse(JSON.stringify(options,
  (key, value: unknown) => key === 'cwd' || key === 'sessionId' || key === 'extraArgs' ? undefined : typeof value === 'function' ? '[function]' : value));

beforeEach(() => { vi.useFakeTimers(); sdk.runs.length = 0; });
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((held) => held.close()));
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  vi.useRealTimers();
});

it('advertises an immutable session selector without exposing raw preset arguments', () => {
  const agent = claude({ paths: ['/tmp/ahpd-extra-args-policy-schema'], presets });
  const properties = agent.schema().properties as Record<string, Record<string, unknown>>;
  expect(properties.extraArgsPolicy).toMatchObject({
    scope: 'session',
    type: 'string',
    enum: ['preset', 'none'],
    default: 'preset',
    sessionMutable: false,
  });
  expect(agent.defaults()).toHaveProperty('extraArgsPolicy', 'preset');
  expect(properties).not.toHaveProperty('extraArgs');
  expect(JSON.stringify(agent.schema())).not.toContain('fixture-hook');
});

it('retains preset arguments for explicit and omitted defaults without cross-session leakage', async () => {
  const omitted = start();
  const none = start({ extraArgsPolicy: 'none' });
  const explicit = start({ extraArgsPolicy: 'preset' });
  await settle();
  expect(sdk.runs).toHaveLength(3);
  expect(sdk.runs[0]!.options.extraArgs).toEqual(extraArgs);
  expect(sdk.runs[1]!.options).not.toHaveProperty('extraArgs');
  expect(sdk.runs[2]!.options.extraArgs).toEqual(extraArgs);
  expect(valuesOf(omitted)).toHaveProperty('extraArgsPolicy', 'preset');
  expect(valuesOf(none)).toHaveProperty('extraArgsPolicy', 'none');
  expect(valuesOf(explicit)).toHaveProperty('extraArgsPolicy', 'preset');
  expect(presets.work.extraArgs).toEqual(extraArgs);
  for (const held of [omitted, none, explicit]) {
    expect(valuesOf(held)).not.toHaveProperty('extraArgs');
    expect(JSON.stringify(held.sessionState())).not.toContain('fixture-hook');
  }
});

it('changes only preset arguments and preserves credentials, provider env, controls, MCP, tools and defaults', async () => {
  const settings = { effortLevel: 'high', permissionMode: 'plan', permissions: { allow: ['Read'], deny: ['Bash'] } };
  const preset = start({ ...settings, extraArgsPolicy: 'preset' });
  const none = start({ ...settings, extraArgsPolicy: 'none' });
  await settle();
  expect(sdk.runs).toHaveLength(2);
  expect(comparable(sdk.runs[1]!.options)).toEqual(comparable(sdk.runs[0]!.options));
  expect(await preset.setConfig!('model', 'fixture-model')).toBe(true);
  expect(await none.setConfig!('model', 'fixture-model')).toBe(true);
  await vi.advanceTimersByTimeAsync(100);
  preset.begin('preset-model', 'Use the selected model');
  none.begin('none-model', 'Use the selected model');
  await settle();
  expect(sdk.runs).toHaveLength(4);
  const ordinary = sdk.runs[2]!.options;
  const optedOut = sdk.runs[3]!.options;
  expect(comparable(optedOut)).toEqual(comparable(ordinary));
  expect(optedOut).not.toHaveProperty('extraArgs');
  expect(optedOut).toMatchObject({
    model: 'fixture-model',
    effort: 'high',
    permissionMode: 'plan',
    allowedTools: ['Read'],
    disallowedTools: ['Bash'],
    thinking: { type: 'disabled' },
    settings: { sandbox: { enabled: true }, disableClaudeAiConnectors: true },
    env: { ANTHROPIC_API_KEY: 'fixture-session-key', ANTHROPIC_BASE_URL: 'https://provider.example.test', AHPD_POLICY_FIXTURE: 'keep', PATH: process.env.PATH },
    mcpServers: { declared: { type: 'http' }, ahp: { type: 'sdk', tools: [{ name: 'host_tool' }] } },
    canUseTool: expect.any(Function),
    hooks: { PreToolUse: expect.any(Array) },
    includePartialMessages: true,
    forwardSubagentText: true,
  });
  expect(optedOut).not.toHaveProperty('tools');
  expect(optedOut).not.toHaveProperty('settingSources');
  expect(optedOut).not.toHaveProperty('strictMcpConfig');
  expect(optedOut).not.toHaveProperty('plugins');
});

it('refuses runtime mutation without changing the selected policy or SDK options', async () => {
  for (const policy of ['preset', 'none']) {
    const held = start({ extraArgsPolicy: policy });
    await settle();
    expect(await held.setConfig!('extraArgsPolicy', policy === 'preset' ? 'none' : 'preset')).toBe(
      'extraArgsPolicy is not a config key this backend takes',
    );
    expect(valuesOf(held).extraArgsPolicy).toBe(policy);
    expect(sdk.runs.at(-1)!.options.extraArgs).toEqual(policy === 'preset' ? extraArgs : undefined);
  }
});

it.each([null, 1, true, {}, [], '', 'default', 'isolated'])('rejects invalid policy %j before SDK query creation', (extraArgsPolicy) => {
  expect(() => start({ extraArgsPolicy })).toThrow('extraArgsPolicy must be one of preset, none');
  expect(sdk.runs).toEqual([]);
});

it.each(['none', 'preset'] as const)('keeps %s across idle recreation, restoration and fork using saved settings', async (extraArgsPolicy) => {
  const original = start({ extraArgsPolicy });
  const assertPolicy = (index: number) => {
    expect(sdk.runs[index]).toBeDefined();
    if (extraArgsPolicy === 'none') expect(sdk.runs[index]!.options).not.toHaveProperty('extraArgs');
    else expect(sdk.runs[index]!.options.extraArgs).toEqual(extraArgs);
  };
  await settle();
  assertPolicy(0);
  const nativeId = sdk.runs[0]!.options.sessionId as string;
  const saved = JSON.parse(JSON.stringify(original.settings!())) as Record<string, unknown>;
  await vi.advanceTimersByTimeAsync(100);
  expect(sdk.runs[0]!.closed).toBe(true);
  original.begin('after-idle', 'Resume the session');
  await settle();
  assertPolicy(1);
  expect(sdk.runs[1]!.options).toHaveProperty('sessionId', nativeId);
  expect(sdk.runs[1]!.options).not.toHaveProperty('resume');
  sdk.runs[1]!.send({ type: 'result', subtype: 'success', session_id: nativeId });
  await settle();
  await vi.advanceTimersByTimeAsync(100);
  expect(sdk.runs[1]!.closed).toBe(true);
  original.begin('after-second-idle', 'Resume the existing transcript');
  await settle();
  assertPolicy(2);
  expect(sdk.runs[2]!.options.resume).toBe(nativeId);
  await original.close();

  const restored = start(saved, nativeId);
  await settle();
  assertPolicy(3);
  expect(valuesOf(restored).extraArgsPolicy).toBe(extraArgsPolicy);
  expect(sdk.runs[3]!.options.resume).toBe(nativeId);
  await restored.close();

  const forked = start(saved, nativeId, 'cut');
  await settle();
  assertPolicy(4);
  expect(valuesOf(forked).extraArgsPolicy).toBe(extraArgsPolicy);
  expect(sdk.runs[4]!.options).toMatchObject({ resume: nativeId, forkSession: true, resumeSessionAt: 'cut' });
});
