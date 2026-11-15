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

const directories: string[] = [];
const sessions: ReturnType<ReturnType<typeof claude>['create']>[] = [];
const settle = async () => { for (let i = 0; i < 60; i++) await Promise.resolve(); };
const start = (settings: Record<string, unknown> = {}, resume?: string, forkAt?: string) => {
  const directory = mkdtempSync(join(tmpdir(), 'ahpd-tool-profile-'));
  directories.push(directory);
  writeFileSync(join(directory, '.keep'), '');
  const agent = claude({ paths: [directory], idleTimeoutMs: 100 });
  const held = agent.create({
    uri: `ahp-session:/${crypto.randomUUID()}`,
    chatUri: 'ahp-chat:/tool-profile',
    workingDirectory: directory,
    schema: agent.schema,
    settings,
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
const lean = ['Workflow', 'ScheduleWakeup', 'ShareOnboardingGuide', 'ReportFindings'];
const protectedTools = ['Bash', 'Read', 'Edit', 'Write', 'ToolSearch', 'AskUserQuestion', 'mcp__ahp__host_tool'];
const comparable = (options: Record<string, unknown>) => JSON.parse(JSON.stringify(options,
  (key, value: unknown) => key === 'cwd' || key === 'sessionId' || key === 'disallowedTools' ? undefined : typeof value === 'function' ? '[function]' : value));

beforeEach(() => { vi.useFakeTimers(); sdk.runs.length = 0; });
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((held) => held.close()));
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  vi.useRealTimers();
});

it('advertises an immutable session selector with a default value', () => {
  const agent = claude({ paths: ['/tmp/ahpd-tool-profile-schema'] });
  const properties = agent.schema().properties as Record<string, Record<string, unknown>>;
  expect(properties.claudeToolProfile).toMatchObject({
    scope: 'session',
    type: 'string',
    enum: ['default', 'lean', 'lean-no-catalogs'],
    default: 'default',
    sessionMutable: false,
  });
  expect(agent.defaults()).toHaveProperty('claudeToolProfile', 'default');
});

it('removes only the profile tools from the SDK query', async () => {
  const omitted = start();
  const leanHeld = start({ claudeToolProfile: 'lean' });
  const noCatalogs = start({ claudeToolProfile: 'lean-no-catalogs' });
  await settle();
  expect(sdk.runs).toHaveLength(3);
  expect(sdk.runs[0]!.options).not.toHaveProperty('disallowedTools');
  expect(sdk.runs[1]!.options.disallowedTools).toEqual(lean);
  expect(sdk.runs[2]!.options.disallowedTools).toEqual([...lean, 'Agent', 'Skill']);
  expect(valuesOf(omitted)).toHaveProperty('claudeToolProfile', 'default');
  expect(valuesOf(leanHeld)).toHaveProperty('claudeToolProfile', 'lean');
  expect(valuesOf(noCatalogs)).toHaveProperty('claudeToolProfile', 'lean-no-catalogs');
  for (const run of sdk.runs) {
    expect(comparable(run.options)).toEqual(comparable(sdk.runs[0]!.options));
    for (const name of protectedTools) expect(run.options.disallowedTools ?? []).not.toContain(name);
    expect(run.options).not.toHaveProperty('tools');
    expect(run.options).not.toHaveProperty('settingSources');
  }
});

it('merges profile tools with session denials and keeps session permissions unchanged', async () => {
  const held = start({ claudeToolProfile: 'lean', permissions: { allow: ['Read'], deny: ['Bash', 'Workflow'] } });
  await settle();
  expect(sdk.runs[0]!.options.allowedTools).toEqual(['Read']);
  expect(sdk.runs[0]!.options.disallowedTools).toEqual(['Bash', ...lean]);
  expect(valuesOf(held).permissions).toEqual({ allow: ['Read'], deny: ['Bash', 'Workflow'] });
});

it('refuses a profile-removed tool if it is called anyway', async () => {
  start({ claudeToolProfile: 'lean-no-catalogs' });
  await settle();
  const canUseTool = sdk.runs[0]!.options.canUseTool as (name: string, input: Record<string, unknown>, asked: Record<string, unknown>) => Promise<Record<string, unknown>>;
  const answer = await canUseTool('Agent', {}, { toolUseID: 'agent-call', signal: new AbortController().signal });
  expect(answer).toMatchObject({ behavior: 'deny' });
});

it('refuses runtime mutation', async () => {
  const held = start({ claudeToolProfile: 'lean' });
  await settle();
  expect(await held.setConfig!('claudeToolProfile', 'default')).toBe('claudeToolProfile is not a config key this backend takes');
  expect(valuesOf(held).claudeToolProfile).toBe('lean');
});

it.each([null, 1, true, {}, [], '', 'none', 'isolated'])('rejects invalid profile %j before SDK query creation', (claudeToolProfile) => {
  expect(() => start({ claudeToolProfile })).toThrow('claudeToolProfile must be one of default, lean, lean-no-catalogs');
  expect(sdk.runs).toEqual([]);
});

it('keeps the profile across idle recreation, restoration and fork using saved settings', async () => {
  const original = start({ claudeToolProfile: 'lean-no-catalogs' });
  const expected = [...lean, 'Agent', 'Skill'];
  await settle();
  const nativeId = sdk.runs[0]!.options.sessionId as string;
  const saved = JSON.parse(JSON.stringify(original.settings!())) as Record<string, unknown>;
  await vi.advanceTimersByTimeAsync(100);
  expect(sdk.runs[0]!.closed).toBe(true);
  original.begin('after-idle', 'Resume the session');
  await settle();
  expect(sdk.runs[1]!.options.disallowedTools).toEqual(expected);
  await original.close();

  const restored = start(saved, nativeId);
  await settle();
  expect(sdk.runs.at(-1)!.options.disallowedTools).toEqual(expected);
  expect(valuesOf(restored).claudeToolProfile).toBe('lean-no-catalogs');
  await restored.close();

  const forked = start(saved, nativeId, 'cut');
  await settle();
  expect(sdk.runs.at(-1)!.options).toMatchObject({ disallowedTools: expected, resume: nativeId, forkSession: true });
  expect(valuesOf(forked).claudeToolProfile).toBe('lean-no-catalogs');
});
