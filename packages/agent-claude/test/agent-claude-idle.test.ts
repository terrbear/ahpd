import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ProcessFixture } from './fixtures/process.js';
import { idleQuery } from '../src/idle.js';

const sdk = vi.hoisted(() => ({ nativeId: '11111111-1111-4111-8111-111111111111', preInitSessionId: undefined as string | undefined, initTools: undefined as unknown, control: undefined as undefined | ((stage: string, index: number) => Promise<void>), inputGatedInit: false, initialize: undefined as undefined | ((index: number) => Promise<unknown>), spawn: false, localSpawn: undefined as undefined | (() => unknown), resources: [] as { closed: boolean }[], runs: [] as {
  options: Record<string, unknown>;
  closed: boolean;
  prompts: unknown[];
  send: (frame: Record<string, unknown>) => void;
}[] }));

vi.mock('node:child_process', async (original) => ({
  ...await original<typeof import('node:child_process')>(),
  spawn: () => { if (!sdk.localSpawn) throw new Error('No fixture process configured'); return sdk.localSpawn(); },
}));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  listSessions: async () => [{ sessionId: 'saved', lastModified: 0 }],
  getSessionMessages: async () => [],
  createSdkMcpServer: (given: Record<string, unknown>) => {
    const resource = { closed: false };
    sdk.resources.push(resource);
    return { type: 'sdk', name: given.name, tools: given.tools, instance: { close: async () => { resource.closed = true; } } };
  },
  query: (given: { options: Record<string, unknown>; prompt: AsyncIterable<unknown> }) => {
    if (sdk.spawn) (given.options.spawnClaudeCodeProcess as (asked: unknown) => unknown)({ command: 'fixture', args: [], env: {} });
    const init: Record<string, unknown> = { type: 'system', subtype: 'init', session_id: sdk.nativeId };
    if (sdk.initTools !== undefined) init.tools = sdk.initTools;
    const frames: Record<string, unknown>[] = sdk.inputGatedInit ? [] : [
      ...(sdk.preInitSessionId === undefined ? [] : [{ type: 'system', subtype: 'hook_started', session_id: sdk.preInitSessionId }]),
      init,
    ];
    let wake: (() => void) | undefined;
    const run = {
      options: given.options,
      closed: false,
      prompts: [] as unknown[],
      send: (frame: Record<string, unknown>) => { frames.push(frame); wake?.(); },
    };
    sdk.runs.push(run);
    void (async () => { for await (const item of given.prompt) { run.prompts.push(item); if (sdk.inputGatedInit) run.send(init); } })();
    return {
      async *[Symbol.asyncIterator]() {
        while (!run.closed) {
          while (frames.length > 0) yield frames.shift();
          if (!run.closed) await new Promise<void>((resolve) => { wake = resolve; });
        }
      },
      initializationResult: () => sdk.initialize?.(sdk.runs.indexOf(run)) ?? Promise.resolve({}),
      mcpServerStatus: async () => [],
      reloadSkills: async () => ({ skills: [] }),
      reloadPlugins: async () => ({ plugins: [] }),
      supportedModels: async () => [],
      setModel: async () => { await sdk.control?.('model_selection', sdk.runs.indexOf(run)); },
      applyFlagSettings: async () => { await sdk.control?.('effort_application', sdk.runs.indexOf(run)); },
      setPermissionMode: async () => {},
      interrupt: async () => {},
      toggleMcpServer: async () => {},
      close: () => { run.closed = true; wake?.(); },
      [Symbol.asyncDispose]: async () => {},
    };
  },
}));

const { createSession } = await import('../src/session.js');
const { claude } = await import('../src/claude.js');
const directories: string[] = [];
const sessions: ReturnType<typeof createSession>[] = [];
const settle = async () => { for (let i = 0; i < 60; i++) await Promise.resolve(); };
const session = (options: Partial<Parameters<typeof createSession>[0]> = {}) => {
  const cwd = mkdtempSync(join(tmpdir(), 'ahpd-idle-'));
  directories.push(cwd);
  const held = createSession({ uri: 'ahp-session:/11111111-1111-4111-8111-111111111111', chatUri: 'ahp-chat:/idle', cwd, emit: () => {}, ...options });
  sessions.push(held);
  return held;
};
const claudeSession = (options: {
  settings?: Record<string, unknown>;
  mcpServers?: Record<string, unknown>;
  resume?: string;
  forkAt?: string;
} = {}) => {
  const cwd = mkdtempSync(join(tmpdir(), 'ahpd-idle-claude-'));
  directories.push(cwd);
  writeFileSync(join(cwd, '.mcp.json'), JSON.stringify({
    mcpServers: { ambient: { type: 'http', url: 'https://ambient.example.test/mcp' } },
  }));
  const agent = claude({ paths: [cwd], idleTimeoutMs: 100 });
  const held = agent.create({
    uri: 'ahp-session:/11111111-1111-4111-8111-111111111111',
    chatUri: 'ahp-chat:/idle',
    workingDirectory: cwd,
    schema: agent.schema,
    settings: { ...agent.defaults(), ...options.settings },
    mcpServers: options.mcpServers as never,
    tools: [{ definition: { name: 'host_tool', inputSchema: { type: 'object' } }, run: () => 'ok' } as never],
    emit: () => {},
    ...(options.resume === undefined ? {} : { resume: options.resume }),
    ...(options.forkAt === undefined ? {} : { forkAt: options.forkAt }),
  });
  sessions.push(held);
  return held;
};

beforeEach(() => { vi.useFakeTimers(); sdk.runs.length = 0; sdk.resources.length = 0; sdk.nativeId = '11111111-1111-4111-8111-111111111111'; sdk.preInitSessionId = undefined; sdk.initTools = undefined; sdk.inputGatedInit = false; sdk.initialize = undefined; sdk.control = undefined; sdk.spawn = false; sdk.localSpawn = undefined; });
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((held) => held.close()));
  for (const cwd of directories.splice(0)) rmSync(cwd, { recursive: true, force: true });
  vi.useRealTimers();
});

const sdkManifestOf = (held: ReturnType<typeof createSession>): Record<string, unknown> | undefined => {
  const meta = held.sessionState()._meta;
  return typeof meta === 'object' && meta !== null
    ? (meta as Record<string, unknown>)['ahpd.claudeSdkInitToolManifest'] as Record<string, unknown> | undefined
    : undefined;
};

it('delivers steering to an active Claude query', async () => {
  const held = claudeSession();
  const initial = { type: 'user', message: { role: 'user', content: 'Start working' }, parent_tool_use_id: null };
  held.begin('first', 'Start working');
  await settle();
  expect(sdk.runs[0]!.prompts).toEqual([initial]);
  expect(held.steer).toBeDefined();
  expect(held.steer?.('steer-1', 'Check the edge case')).toBe(true);
  await settle();
  expect(sdk.runs[0]!.prompts).toEqual([
    initial,
    { type: 'user', message: { role: 'user', content: 'Check the edge case' }, parent_tool_use_id: null },
  ]);
});

it('captures only observed SDK init tool names when the per-session opt-in is enabled', async () => {
  sdk.initTools = ['Bash', 'mcp__ahp__read'];
  const held = claudeSession({ settings: { captureSdkInitToolManifest: 'enabled' } });
  await settle();
  expect(sdkManifestOf(held)).toEqual({
    status: 'observed',
    sessionUri: held.uri,
    generation: 0,
    nativeSessionId: sdk.nativeId,
    toolNames: ['Bash', 'mcp__ahp__read'],
  });
  (sdk.initTools as string[]).push('late mutation');
  expect(sdkManifestOf(held)?.toolNames).toEqual(['Bash', 'mcp__ahp__read']);
});

it('distinguishes a reported empty tool list from an unobserved manifest', async () => {
  sdk.initTools = [];
  const observed = claudeSession({ settings: { captureSdkInitToolManifest: 'enabled' } });
  await settle();
  expect(sdkManifestOf(observed)).toMatchObject({ status: 'observed', toolNames: [] });

  sdk.inputGatedInit = true;
  const unobserved = claudeSession({ settings: { captureSdkInitToolManifest: 'enabled' } });
  await settle();
  expect(sdkManifestOf(unobserved)).toMatchObject({ status: 'unknown', sessionUri: unobserved.uri });
  expect(sdkManifestOf(unobserved)).not.toHaveProperty('toolNames');
});

it('keeps malformed init tool data unknown instead of retaining objects', async () => {
  sdk.initTools = ['Bash', { name: 'untrusted tool detail', input_schema: { secret: 'not metadata' } }];
  const held = claudeSession({ settings: { captureSdkInitToolManifest: 'enabled' } });
  await settle();
  expect(sdkManifestOf(held)).toMatchObject({ status: 'unknown', sessionUri: held.uri });
  expect(sdkManifestOf(held)).not.toHaveProperty('toolNames');
});

it('does not report tools from an unrelated native session', async () => {
  sdk.nativeId = 'a-different-native-session';
  sdk.preInitSessionId = sdk.nativeId;
  sdk.initTools = ['Bash'];
  const held = claudeSession({
    resume: '11111111-1111-4111-8111-111111111111',
    settings: { captureSdkInitToolManifest: 'enabled' },
  });
  await settle();
  expect(sdkManifestOf(held)).toMatchObject({ status: 'unknown', sessionUri: held.uri });
  expect(sdkManifestOf(held)).not.toHaveProperty('nativeSessionId');
  expect(sdkManifestOf(held)).not.toHaveProperty('toolNames');
});

it('re-observes init tools after a resumed query generation', async () => {
  sdk.initTools = ['Bash', 'mcp__ahp__read'];
  const held = claudeSession({ settings: { captureSdkInitToolManifest: 'enabled' } });
  await settle();
  expect(sdkManifestOf(held)).toMatchObject({ status: 'observed', generation: 0 });
  await vi.advanceTimersByTimeAsync(100);
  expect(sdk.runs[0]!.closed).toBe(true);
  held.begin('after-idle', 'Resume the session');
  await settle();
  expect(sdk.runs).toHaveLength(2);
  expect(sdkManifestOf(held)).toEqual({
    status: 'observed',
    sessionUri: held.uri,
    generation: 1,
    nativeSessionId: sdk.nativeId,
    toolNames: ['Bash', 'mcp__ahp__read'],
  });
});

it('keeps the deny-all fence on initial, recreated, resumed, and forked queries', async () => {
  const assertFence = (run: (typeof sdk.runs)[number] | undefined) => {
    expect(run).toBeDefined();
    const hooks = run!.options.hooks as { PreToolUse: { matcher?: string; hooks: unknown[] }[] };
    expect(hooks.PreToolUse).toHaveLength(1);
    expect(hooks.PreToolUse[0]).not.toHaveProperty('matcher');
    expect(hooks.PreToolUse[0]!.hooks).toHaveLength(1);
    expect(run!.options.canUseTool).toBeTypeOf('function');
  };
  const held = claudeSession({ settings: { toolExecutionFence: 'deny-all' } });
  await settle();
  assertFence(sdk.runs[0]);
  await vi.advanceTimersByTimeAsync(100);
  expect(sdk.runs[0]!.closed).toBe(true);
  held.begin('after-idle', 'Resume the session');
  await settle();
  assertFence(sdk.runs[1]);
  await held.close();

  const resumed = claudeSession({ resume: sdk.nativeId, settings: { toolExecutionFence: 'deny-all' } });
  await settle();
  expect(sdk.runs[2]!.options.resume).toBe(sdk.nativeId);
  assertFence(sdk.runs[2]);
  await resumed.close();

  const forked = claudeSession({ resume: sdk.nativeId, forkAt: 'cut', settings: { toolExecutionFence: 'deny-all' } });
  await settle();
  expect(sdk.runs[3]!.options).toMatchObject({ forkSession: true, resumeSessionAt: 'cut' });
  assertFence(sdk.runs[3]);
});

it('retains the exact allowlist across idle recreation, restore and fork without affecting another session', async () => {
  const name = 'mcp__fixture__read';
  const assertFence = async (index: number) => {
    const options = sdk.runs[index]!.options;
    const hooks = options.hooks as { PreToolUse: { hooks: ((input: unknown, id: string, context: unknown) => Promise<unknown>)[] }[] };
    const gate = hooks.PreToolUse[0]!.hooks[0]!;
    const callback = options.canUseTool as (name: string, input: object, options: object) => Promise<unknown>;
    expect(await gate({ tool_name: name }, 'id', {})).toEqual({});
    expect(await gate({ tool_name: 'mcp__late__read' }, 'id', {})).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } });
    expect(await callback(name, {}, { signal: new AbortController().signal })).toMatchObject({ behavior: 'allow' });
    expect(await callback('Bash', {}, { signal: new AbortController().signal })).toMatchObject({ behavior: 'deny' });
  };
  const held = claudeSession({ settings: {
    toolExecutionFence: 'allowlist', toolExecutionAllowlist: [name],
    permissions: { allow: [name, 'Bash'] },
  } });
  await settle();
  await assertFence(0);
  const saved = JSON.parse(JSON.stringify(held.settings!()));
  await vi.advanceTimersByTimeAsync(100);
  held.begin('after-idle', 'Resume');
  await settle();
  await assertFence(1);
  await held.close();
  const resumed = claudeSession({ resume: sdk.nativeId, settings: saved });
  await settle();
  await assertFence(2);
  await resumed.close();
  const forked = claudeSession({ resume: sdk.nativeId, forkAt: 'cut', settings: saved });
  await settle();
  expect(sdk.runs[3]!.options).toMatchObject({ forkSession: true, resumeSessionAt: 'cut' });
  await assertFence(3);
  await forked.close();
  const independent = claudeSession({ settings: { toolExecutionFence: 'allowlist', toolExecutionAllowlist: ['Bash'], permissions: { allow: ['Bash', name] } } });
  await settle();
  const callback = sdk.runs[4]!.options.canUseTool as (name: string, input: object, options: object) => Promise<unknown>;
  expect(await callback('Bash', {}, {})).toMatchObject({ behavior: 'allow' });
  expect(await callback(name, {}, {})).toMatchObject({ behavior: 'deny' });
  await independent.close();
});

it('recaptures tools when the AHP session is recreated for native resume', async () => {
  sdk.initTools = ['Bash', 'mcp__ahp__read'];
  const original = claudeSession({ settings: { captureSdkInitToolManifest: 'enabled' } });
  await settle();
  expect(sdkManifestOf(original)).toMatchObject({ status: 'observed', generation: 0 });
  await original.close();

  const recreated = claudeSession({
    resume: sdk.nativeId,
    settings: { captureSdkInitToolManifest: 'enabled' },
  });
  await settle();
  expect(sdk.runs).toHaveLength(2);
  expect(sdkManifestOf(recreated)).toEqual({
    status: 'observed',
    sessionUri: recreated.uri,
    generation: 0,
    nativeSessionId: sdk.nativeId,
    toolNames: ['Bash', 'mcp__ahp__read'],
  });
});

it('binds a fork manifest to the new native session id', async () => {
  sdk.nativeId = 'forked-native-session';
  sdk.initTools = ['Bash'];
  const held = claudeSession({
    resume: '11111111-1111-4111-8111-111111111111',
    forkAt: 'turn-1',
    settings: { captureSdkInitToolManifest: 'enabled' },
  });
  await settle();
  expect(sdk.runs[0]?.options).toMatchObject({ forkSession: true, resume: '11111111-1111-4111-8111-111111111111' });
  expect(sdkManifestOf(held)).toEqual({
    status: 'observed',
    sessionUri: held.uri,
    generation: 0,
    nativeSessionId: sdk.nativeId,
    toolNames: ['Bash'],
  });
});

it('does not capture init data when the opt-in is disabled', async () => {
  sdk.initTools = ['Bash'];
  const held = claudeSession();
  await settle();
  expect(sdkManifestOf(held)).toBeUndefined();
});

it('records startup stages without prompt data and waits for initialization before enqueue', async () => {
  const lines: string[] = [];
  let release: (() => void) | undefined;
  sdk.spawn = true;
  sdk.localSpawn = () => {
    const child = new ProcessFixture();
    child.exitCode = 0;
    return child;
  };
  let initializationCalls = 0;
  sdk.initialize = () => initializationCalls++ > 0
    ? Promise.resolve({})
    : new Promise((resolve) => { release = () => resolve({}); });
  const held = session({ log: (line) => lines.push(line) });
  held.begin('first', 'private prompt sentinel', { id: 'opus' });
  await settle();
  const records = () => lines.map((line) => JSON.parse(line.slice('[claude-startup] '.length)) as Record<string, unknown>);
  expect(records().filter((one) => one.stage === 'sdk_spawn_hook').map((one) => one.outcome)).toEqual(['start', 'returned']);
  expect(records().filter((one) => one.stage !== 'sdk_spawn_hook' && !String(one.stage).startsWith('describe')).map((one) => [one.stage, one.outcome])).toEqual([
    ['begin_turn', 'start'],
    ['ready', 'start'],
    ['initialization', 'start'],
  ]);
  expect(lines.join('\n')).not.toContain('private prompt sentinel');
  expect(records().every((one) => one.session_id === '11111111-1111-4111-8111-111111111111' && one.generation === 0 && typeof one.elapsed_ms === 'number' && Object.keys(one).filter((key) => key !== 'turn_id').sort().join(',') === 'elapsed_ms,generation,outcome,session_id,stage')).toBe(true);
  release?.();
  await settle();
  expect(Object.fromEntries(records().filter((one) => String(one.stage).startsWith('describe')).map((one) => [one.stage, one.outcome]))).toMatchObject({
    describe: 'ok',
    describe_initialization: 'ok',
    describe_mcp_server_status: 'ok',
    describe_reload_skills: 'ok',
    describe_reload_plugins: 'ok',
    describe_handshake: 'ok',
  });
  expect(records().filter((one) => one.stage !== 'sdk_spawn_hook' && !String(one.stage).startsWith('describe')).map((one) => [one.stage, one.outcome])).toEqual([
    ['begin_turn', 'start'],
    ['ready', 'start'],
    ['initialization', 'start'],
    ['initialization', 'ok'],
    ['prepare', 'start'],
    ['prepare', 'ok'],
    ['ready', 'ok'],
    ['model_selection', 'start'],
    ['model_selection', 'ok'],
    ['ready', 'start'],
    ['ready', 'ok'],
    ['enqueue', 'start'],
    ['enqueue', 'ok'],
    ['sdk_user_input', 'yield'],
  ]);
});

it.each(['model_selection', 'effort_application'])('bounds %s after a completed turn, recovers the queue, and ignores late acknowledgements', async (stage) => {
  const lines: string[] = [];
  const events: Record<string, unknown>[] = [];
  const held = session({ log: (line) => lines.push(line), emit: (_channel, event) => events.push(event) });
  held.begin('first', 'private first prompt', { id: 'opus' });
  await settle();
  sdk.runs[0]!.send({ type: 'result', subtype: 'success', is_error: false, duration_ms: 1 });
  await settle();
  let release!: () => void;
  sdk.control = (operation, index) => operation === stage && index === 0
    ? new Promise<void>((resolve) => { release = resolve; })
    : Promise.resolve();
  held.begin('stalled', 'private stalled prompt', { id: 'sonnet', config: { thinkingLevel: 'high' } });
  held.queue('queued', 'private queued prompt');
  await settle();
  await vi.advanceTimersByTimeAsync(29_999);
  expect(sdk.runs[0]!.prompts).toHaveLength(1);
  expect(sdk.runs).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(1);
  await settle();
  expect(sdk.runs[0]!.closed).toBe(true);
  expect(sdk.runs).toHaveLength(2);
  expect(sdk.runs[1]!.options.resume).toBe(sdk.nativeId);
  expect(JSON.stringify(sdk.runs[1]!.prompts)).toContain('private queued prompt');
  expect(JSON.stringify(sdk.runs[1]!.prompts)).not.toContain('private stalled prompt');
  expect(held.chatState().queuedMessages).toEqual([]);
  expect(JSON.stringify(events.filter((event) => event.type === 'chat/error' && event.turnId === 'stalled'))).toContain(`${stage} exceeded 30 seconds`);
  const records = lines.map((line) => JSON.parse(line.slice('[claude-startup] '.length)) as Record<string, unknown>);
  expect(records.find((record) => record.stage === stage && record.outcome === 'timeout')).toMatchObject({
    session_id: '11111111-1111-4111-8111-111111111111', generation: 0, turn_id: 'stalled', timeout_ms: 30_000, duration_ms: 30_000,
  });
  expect(records.filter((record) => record.stage === 'timeout_recovery').map((record) => record.outcome)).toEqual(['start', 'ok']);
  expect(lines.join('\n')).not.toContain('private');
  release();
  await settle();
  expect(sdk.runs[1]!.prompts).toHaveLength(1);
  expect(held.settings().effortLevel).not.toBe('high');
});

it.each(['model_selection', 'effort_application'])('releases a cancelled %s wait without letting its timeout clear the replacement turn', async (operation) => {
  const lines: string[] = [];
  const held = session({ log: (line) => lines.push(line) });
  sdk.control = (stage, index) => stage === operation && index === 0 ? new Promise<void>(() => {}) : Promise.resolve();
  held.begin('cancelled', 'private cancelled prompt', { id: 'opus', config: { thinkingLevel: 'high' } });
  await settle();
  held.cancel('cancelled');
  held.begin('replacement', 'private replacement prompt');
  await settle();
  await vi.advanceTimersByTimeAsync(30_000);
  await settle();
  expect(sdk.runs).toHaveLength(2);
  expect(sdk.runs[0]!.closed).toBe(true);
  expect(sdk.runs[1]!.prompts).toHaveLength(1);
  expect(JSON.stringify(sdk.runs[1]!.prompts)).toContain('private replacement prompt');
  expect(JSON.stringify(sdk.runs[1]!.prompts)).not.toContain('private cancelled prompt');
  expect(held.chatState().activeTurn).toMatchObject({ id: 'replacement' });
  const timeout = lines.map((line) => JSON.parse(line.slice('[claude-startup] '.length)) as Record<string, unknown>).find((record) => record.outcome === 'timeout');
  expect(timeout?.turn_id).toBe('cancelled');
});

it('does not let timing sink errors fail startup', async () => {
  const held = session({ log: () => { throw new Error('diagnostic sink failed'); } });
  held.begin('first', 'Start normally');
  await settle();
  expect(sdk.runs[0]!.prompts).toHaveLength(1);
});

it('attributes the startup watchdog to the pending initialization stage', async () => {
  const records: [string, string][] = [];
  const pending = new Promise<unknown>(() => {});
  const idle = idleQuery({
    timeout: 0,
    eligible: () => true,
    create: () => ({
      query: { initializationResult: () => pending, close: () => {}, async *[Symbol.asyncIterator]() {} },
      signal: new AbortController(),
      stop: async () => {},
    }),
    timing: (stage, outcome) => records.push([stage, outcome]),
  });
  const ready = idle.ready().then(() => undefined, () => undefined);
  await settle();
  await vi.advanceTimersByTimeAsync(30_000);
  await ready;
  expect(records).toEqual([['initialization', 'start'], ['initialization', 'timeout']]);
  await idle.dispose();
});

it('attributes the startup watchdog to prepare when initialization has completed', async () => {
  const records: [string, string][] = [];
  const idle = idleQuery({
    timeout: 0,
    eligible: () => true,
    create: () => ({
      query: { initializationResult: async () => ({}), close: () => {}, async *[Symbol.asyncIterator]() {} },
      signal: new AbortController(),
      stop: async () => {},
    }),
    prepare: async () => new Promise<void>(() => {}),
    timing: (stage, outcome) => records.push([stage, outcome]),
  });
  const ready = idle.ready().then(() => undefined, () => undefined);
  await settle();
  expect(records).toEqual([['initialization', 'start'], ['initialization', 'ok'], ['prepare', 'start']]);
  await vi.advanceTimersByTimeAsync(30_000);
  await ready;
  expect(records).toEqual([['initialization', 'start'], ['initialization', 'ok'], ['prepare', 'start'], ['prepare', 'timeout']]);
  await idle.dispose();
});

it('releases an idle Claude query after one hour while retaining the logical chat', async () => {
  const held = session();
  await settle();
  await vi.advanceTimersByTimeAsync(3_599_999);
  expect(sdk.runs[0]!.closed).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  await settle();
  expect(sdk.runs[0]!.closed).toBe(true);
  expect(sdk.runs).toHaveLength(1);
  expect(held.chatState()).toBeDefined();
});


const complete = async (index = 0) => {
  sdk.runs[index]!.send({ type: 'result', subtype: 'success', session_id: '11111111-1111-4111-8111-111111111111' });
  await settle();
};

it('keeps active and queued turns alive, then resets inactivity after the queue drains', async () => {
  const held = session({ idleTimeoutMs: 100 });
  held.begin('first', 'Create the file');
  await settle();
  held.queue!('second', 'Check the file');
  await vi.advanceTimersByTimeAsync(1_000);
  expect(sdk.runs[0]!.closed).toBe(false);
  await complete();
  expect(sdk.runs[0]!.prompts).toHaveLength(2);
  await vi.advanceTimersByTimeAsync(1_000);
  expect(sdk.runs[0]!.closed).toBe(false);
  await complete();
  await vi.advanceTimersByTimeAsync(99);
  expect(sdk.runs[0]!.closed).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect(sdk.runs[0]!.closed).toBe(true);
});

it('resumes exactly the same native session with only the new prompt and retained config and history', async () => {
  const mcpServers = { fixture: { type: 'http' as const, url: 'https://fixture.example.test/mcp' } };
  const held = claudeSession({
    resume: '11111111-1111-4111-8111-111111111111',
    forkAt: 'fork-point',
    settings: { permissionMode: 'plan', builtInTools: 'none', claudeConfigIsolation: 'isolated' },
    mcpServers,
  });
  held.begin('first', 'Make one change');
  await settle();
  await complete();
  const before = held.chatState();
  await held.setConfig!('model', 'chosen-model');
  await held.setConfig!('effortLevel', 'high');
  await settle();
  await vi.advanceTimersByTimeAsync(100);
  expect(held.chatState()).toEqual(before);
  for (let i = 0; i < 5; i++) { held.chatState(); held.sessionState(); }
  expect(sdk.runs).toHaveLength(1);
  held.begin('next', 'Read the result');
  await settle();
  expect(sdk.runs).toHaveLength(2);
  for (const run of sdk.runs) {
    expect(run.options).toMatchObject({ tools: [], settingSources: [], strictMcpConfig: true, plugins: [] });
    expect(run.options.mcpServers).toMatchObject({
      ...mcpServers,
      ahp: { type: 'sdk', name: 'ahp', tools: [{ name: 'host_tool' }] },
    });
    expect(run.options.mcpServers).not.toHaveProperty('ambient');
  }
  expect(sdk.runs[1]!.options).toMatchObject({ resume: '11111111-1111-4111-8111-111111111111', model: 'chosen-model', effort: 'high', permissionMode: 'plan' });
  expect(sdk.runs[1]!.options).not.toHaveProperty('forkSession');
  expect(sdk.runs[1]!.options).not.toHaveProperty('resumeSessionAt');
  expect(sdk.runs[1]!.prompts).toEqual([{ type: 'user', message: { role: 'user', content: 'Read the result' }, parent_tool_use_id: null }]);
  expect(sdk.runs[0]!.prompts).toHaveLength(1);
});

it('recreates an unused native session with its exact ID rather than resuming an unwritten transcript', async () => {
  const mcpServers = { fixture: { type: 'http' as const, url: 'https://fixture.example.test/mcp' } };
  const held = claudeSession({ settings: { builtInTools: 'none', claudeConfigIsolation: 'isolated' }, mcpServers });
  await settle();
  await vi.advanceTimersByTimeAsync(100);
  held.begin('first', 'First prompt');
  await settle();
  for (const run of sdk.runs) {
    expect(run.options).toMatchObject({ tools: [], settingSources: [], strictMcpConfig: true, plugins: [] });
    expect(run.options.mcpServers).toMatchObject({
      ...mcpServers,
      ahp: { type: 'sdk', name: 'ahp', tools: [{ name: 'host_tool' }] },
    });
    expect(run.options.mcpServers).not.toHaveProperty('ambient');
  }
  expect(sdk.runs[1]!.options).toMatchObject({ sessionId: '11111111-1111-4111-8111-111111111111' });
  expect(sdk.runs[1]!.options).not.toHaveProperty('resume');
  expect(sdk.runs[1]!.prompts).toHaveLength(1);
});

it('protects the authoritative full background set including ambient dependencies and ignores late edges', async () => {
  session({ idleTimeoutMs: 100 });
  await settle();
  const run = sdk.runs[0]!;
  run.send({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'watch', task_type: 'local_bash', ambient: true }] });
  await settle();
  await vi.advanceTimersByTimeAsync(1_000);
  expect(run.closed).toBe(false);
  run.send({ type: 'system', subtype: 'background_tasks_changed', tasks: [] });
  run.send({ type: 'system', subtype: 'task_started', task_id: 'watch', tool_use_id: 'old-edge' });
  await settle();
  await vi.advanceTimersByTimeAsync(100);
  expect(run.closed).toBe(true);
});

it('protects legacy task edges until a matching terminal notification', async () => {
  session({ idleTimeoutMs: 100 });
  await settle();
  const run = sdk.runs[0]!;
  run.send({ type: 'system', subtype: 'task_started', task_id: 'task', tool_use_id: 'tool' });
  await settle();
  await vi.advanceTimersByTimeAsync(1_000);
  expect(run.closed).toBe(false);
  run.send({ type: 'system', subtype: 'task_notification', task_id: 'other', status: 'completed' });
  await settle();
  await vi.advanceTimersByTimeAsync(100);
  expect(run.closed).toBe(false);
  run.send({ type: 'system', subtype: 'task_notification', task_id: 'task', tool_use_id: 'tool', status: 'completed' });
  await settle();
  await vi.advanceTimersByTimeAsync(100);
  expect(run.closed).toBe(true);
});

it('invalidates a nearly expired timer when a new turn arrives', async () => {
  const held = session({ idleTimeoutMs: 100 });
  await settle();
  await vi.advanceTimersByTimeAsync(99);
  held.begin('first', 'Work');
  await settle();
  await vi.advanceTimersByTimeAsync(1_000);
  expect(sdk.runs).toHaveLength(1);
  expect(sdk.runs[0]!.closed).toBe(false);
});

it('allows idle eviction to be disabled and rejects invalid intervals', async () => {
  session({ idleTimeoutMs: 0 });
  await settle();
  await vi.advanceTimersByTimeAsync(7_200_000);
  expect(sdk.runs[0]!.closed).toBe(false);
  for (const idleTimeoutMs of [-1, 0.5, Number.NaN, 2_147_483_648]) expect(() => session({ idleTimeoutMs })).toThrow('idleTimeoutMs');
});


it('keeps outstanding input alive even after a native result until the answer is settled', async () => {
  const held = session({ idleTimeoutMs: 100 });
  await settle();
  const ask = sdk.runs[0]!.options.canUseTool as (name: string, input: Record<string, unknown>, about: Record<string, unknown>) => Promise<unknown>;
  const answer = ask('AskUserQuestion', { questions: [{ question: 'Continue?', options: [{ label: 'Yes' }] }] }, { toolUseID: 'question' });
  await settle();
  await complete();
  await vi.advanceTimersByTimeAsync(1_000);
  expect(sdk.runs[0]!.closed).toBe(false);
  held.answer!('question', false, {});
  await answer;
  await vi.advanceTimersByTimeAsync(100);
  expect(sdk.runs[0]!.closed).toBe(true);
});

it('protects contributed host work before its tool frame arrives and cleans it after completion', async () => {
  let finish: ((value: string) => void) | undefined;
  session({ idleTimeoutMs: 100, tools: [{ definition: { name: 'held' }, run: () => new Promise<string>((resolve) => { finish = resolve; }) }] });
  await settle();
  const servers = sdk.runs[0]!.options.mcpServers as { ahp: { tools: { handler: (input: Record<string, unknown>) => Promise<unknown> }[] } };
  const result = servers.ahp.tools[0]!.handler({});
  await vi.advanceTimersByTimeAsync(1_000);
  expect(sdk.runs[0]!.closed).toBe(false);
  finish!('done');
  await result;
  await vi.advanceTimersByTimeAsync(100);
  expect(sdk.runs[0]!.closed).toBe(true);
});

it('protects a real captured background subagent beyond the lead turn', async () => {
  const ended: string[] = [];
  session({ idleTimeoutMs: 100, subagent: (id) => ({ uri: `ahp-chat:/worker/${id}`, turnId: `worker-${id}`, emit: () => {}, end: (state) => { ended.push(state); } }) });
  await settle();
  const frames = readFileSync(new URL('./fixtures/claude-subagent-background.jsonl', import.meta.url), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
  const boundary = frames.findIndex((frame) => frame.type === 'result');
  expect(boundary).toBeGreaterThan(0);
  const run = sdk.runs[0]!;
  for (const frame of frames.slice(0, boundary + 1)) run.send(frame);
  await settle();
  await vi.advanceTimersByTimeAsync(1_000);
  expect(run.closed).toBe(false);
  expect(ended).toEqual([]);
  for (const frame of frames.slice(boundary + 1)) run.send(frame);
  await settle();
  expect(ended).toEqual(['complete']);
  await vi.advanceTimersByTimeAsync(100);
  expect(run.closed).toBe(true);
});

it.each([false, true])('halts a mismatched native resume when identity is input-gated: %s', async (inputGated) => {
  const sent: Record<string, unknown>[] = [];
  const held = session({ idleTimeoutMs: 100, resume: sdk.nativeId, emit: (_channel, action) => { sent.push(action as Record<string, unknown>); } });
  await settle();
  await vi.advanceTimersByTimeAsync(100);
  sdk.inputGatedInit = inputGated;
  sdk.nativeId = '22222222-2222-4222-8222-222222222222';
  held.begin('refused', 'Do not replay');
  await settle();
  expect(sdk.runs).toHaveLength(2);
  expect(sdk.runs[0]!.prompts).toEqual([]);
  expect(sdk.runs[1]!.prompts).toHaveLength(inputGated ? 1 : 0);
  expect(sdk.runs[1]!.closed).toBe(true);
  expect(JSON.stringify(sent)).toContain('resumed a different native session');
});

it('reads saved history through the agent without creating a query', async () => {
  const { claude } = await import('../src/claude.js');
  const backend = claude({ paths: ['/fixture'] });
  expect(await backend.transcript!('saved')).toEqual([]);
  expect(sdk.runs).toEqual([]);
});


it('evicts an unused query and resumes when native init is emitted only after the first input', async () => {
  sdk.inputGatedInit = true;
  const held = session({ idleTimeoutMs: 100 });
  await settle();
  await vi.advanceTimersByTimeAsync(100);
  expect(sdk.runs[0]!.closed).toBe(true);
  held.begin('first', 'Start working');
  await settle();
  expect(sdk.runs[1]!.options.sessionId).toBe('11111111-1111-4111-8111-111111111111');
  expect(sdk.runs[1]!.prompts).toHaveLength(1);
});


it('does not replace a child until its real exit even when SDK disposal resolves first', async () => {
  sdk.spawn = true;
  const children: ProcessFixture[] = [];
  sdk.localSpawn = () => { const child = new ProcessFixture(); children.push(child); return child; };
  const held = session({ idleTimeoutMs: 100 });
  try {
    await settle();
    await vi.advanceTimersByTimeAsync(100);
    held.begin('next', 'One new prompt');
    await settle();
    expect(sdk.runs).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(children[0]!.killed).toBe(true);
    expect(sdk.runs).toHaveLength(1);
    children[0]!.exit();
    await settle();
    expect(sdk.runs).toHaveLength(2);
    expect(children).toHaveLength(2);
    expect(sdk.runs[0]!.prompts).toEqual([]);
    expect(sdk.runs[1]!.prompts).toHaveLength(1);
  } finally { for (const child of children) child.exit(); }
});


it('leaves computer or custom transport processes running without native-exit ownership', async () => {
  session({ idleTimeoutMs: 100, spawn: () => new ProcessFixture() });
  await settle();
  await vi.advanceTimersByTimeAsync(10_000);
  expect(sdk.runs[0]!.closed).toBe(false);
});

it('preserves an unused non-UUID logical chat and its allocated native UUID through recreation', async () => {
  sdk.inputGatedInit = true;
  const held = session({ idleTimeoutMs: 100, uri: 'ahp-session:/named-chat', chatUri: 'ahp-chat:/named-chat' });
  await settle();
  const allocated = sdk.runs[0]!.options.sessionId;
  expect(allocated).toMatch(/^[0-9a-f-]{36}$/iu);
  expect(held.agentId?.()).toBeUndefined();
  await vi.advanceTimersByTimeAsync(100);
  sdk.nativeId = allocated as string;
  held.begin('first', 'First prompt');
  await settle();
  expect(sdk.runs[1]!.options.sessionId).toBe(allocated);
  expect(sdk.runs[1]!.options).not.toHaveProperty('resume');
  expect(held.chatState().resource).toBe('ahp-chat:/named-chat');
  expect(sdk.runs[1]!.prompts).toHaveLength(1);
});


it('disposes contributed SDK servers and recreates a fresh server for the same tools', async () => {
  const held = session({ idleTimeoutMs: 100, tools: [{ definition: { name: 'held' }, run: async () => 'ok' }] });
  await settle();
  expect(sdk.resources).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(100);
  expect(sdk.resources[0]!.closed).toBe(true);
  held.begin('next', 'Use the existing tool');
  await settle();
  expect(sdk.resources).toHaveLength(2);
  expect(sdk.resources[1]!.closed).toBe(false);
  expect(sdk.runs[1]!.options.mcpServers).not.toBe(sdk.runs[0]!.options.mcpServers);
});

it('removes the shell init resource during idle and restores its saved content for resume', async () => {
  const held = session({ idleTimeoutMs: 100, settings: { shellInitScripts: [{ shell: 'bash', script: 'export FIXTURE=1' }] } });
  await settle();
  const hooks = sdk.runs[0]!.options.hooks as { PreToolUse: { hooks: ((input: Record<string, unknown>) => Promise<{ hookSpecificOutput: { updatedInput: { command: string } } }>)[] }[] };
  const result = await hooks.PreToolUse[0]!.hooks[0]!({ hook_event_name: 'PreToolUse', tool_input: { command: 'printf fixture' } });
  const path = result.hookSpecificOutput.updatedInput.command.match(/\/[^'\s]*ahpd-shell-init-[^'\s]+\.sh/u)?.[0];
  expect(path).toBeDefined();
  expect(readFileSync(path!, 'utf8')).toBe('export FIXTURE=1');
  await vi.advanceTimersByTimeAsync(100);
  expect(existsSync(path!)).toBe(false);
  held.begin('next', 'Use the shell');
  await settle();
  expect(readFileSync(path!, 'utf8')).toBe('export FIXTURE=1');
  await held.close();
  expect(existsSync(path!)).toBe(false);
});

it.each([{ forkAt: 'cut' }, { rewindAt: 'cut' }])('retains unused one-shot resume modifiers until a prompt consumes them: %j', async (modifier) => {
  const held = session({ idleTimeoutMs: 100, resume: sdk.nativeId, ...modifier });
  await settle();
  await vi.advanceTimersByTimeAsync(1_000);
  expect(sdk.runs[0]!.closed).toBe(false);
  expect(sdk.runs[0]!.options.resumeSessionAt).toBe('cut');
  held.begin('first', 'Continue at the selected cut');
  await settle();
  await complete();
  await vi.advanceTimersByTimeAsync(100);
  expect(sdk.runs[0]!.closed).toBe(true);
  held.begin('second', 'Continue with the next prompt');
  await settle();
  expect(sdk.runs[1]!.options.resume).toBe(sdk.nativeId);
  expect(sdk.runs[1]!.options).not.toHaveProperty('resumeSessionAt');
  expect(sdk.runs[1]!.options).not.toHaveProperty('forkSession');
});

it('never delivers a cancelled new prompt when resume waits for the old process to exit', async () => {
  sdk.spawn = true;
  const children: ProcessFixture[] = [];
  sdk.localSpawn = () => { const child = new ProcessFixture(); children.push(child); return child; };
  const held = session({ idleTimeoutMs: 100 });
  try {
    await settle();
    await vi.advanceTimersByTimeAsync(100);
    held.begin('cancelled', 'Must never reach Claude');
    held.cancel('cancelled');
    children[0]!.exit();
    await settle();
    expect(sdk.runs.flatMap((run) => run.prompts)).toEqual([]);
    expect(held.chatState().turns).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'cancelled', state: 'cancelled' })]));
  } finally { for (const child of children) child.exit(); }
});

it('records an actionable failed resume turn without replaying any prompt or starting another process', async () => {
  const held = session({ idleTimeoutMs: 100 });
  await settle();
  await vi.advanceTimersByTimeAsync(100);
  sdk.initialize = async () => { throw new Error('native transcript unavailable'); };
  held.begin('failed', 'Must not run without context');
  await settle();
  expect(sdk.runs.flatMap((run) => run.prompts)).toEqual([]);
  expect(sdk.runs[1]!.closed).toBe(true);
  expect(JSON.stringify(held.chatState())).toContain('Claude session could not resume: native transcript unavailable');
  expect(held.chatState().turns).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'failed', state: 'error' })]));
  await vi.advanceTimersByTimeAsync(1_000);
  expect(sdk.runs).toHaveLength(2);
});


it('restarts an evicted query with the pinned model and its context suffix', async () => {
  const held = session({ idleTimeoutMs: 100 });
  held.begin('first', 'Hello', { id: 'sonnet[1m]' });
  await settle();
  await complete();
  await vi.advanceTimersByTimeAsync(100);
  expect(sdk.runs[0]!.closed).toBe(true);
  held.begin('next', 'Continue');
  await settle();
  expect(sdk.runs[1]!.options.model).toBe('claude-sonnet-5-5[1m]');
  expect(held.settings!().model).toBe('sonnet[1m]');
});

it('reports memory backpressure without spawning or replaying and resumes after recovery', async () => {
  let blocked = true;
  const sent: Record<string, unknown>[] = [];
  const held = session({ idleTimeoutMs: 100, admitResume: () => {
    if (blocked) throw new Error('Host capacity temporarily unavailable: memory pressure');
    return () => {};
  }, emit: (_channel, action) => { sent.push(action as Record<string, unknown>); } });
  await settle();
  await vi.advanceTimersByTimeAsync(100);
  held.begin('blocked', 'Do not lose this request');
  await settle();
  expect(sdk.runs).toHaveLength(1);
  expect(sdk.runs[0]!.prompts).toHaveLength(0);
  expect(JSON.stringify(sent)).toContain('memory pressure');
  blocked = false;
  held.begin('retry', 'Retry explicitly');
  await settle();
  expect(sdk.runs).toHaveLength(2);
  expect(sdk.runs[1]!.prompts).toHaveLength(1);
  expect(JSON.stringify(sdk.runs[1]!.prompts)).toContain('Retry explicitly');
  expect(JSON.stringify(sdk.runs[1]!.prompts)).not.toContain('Do not lose this request');
});

it('claims the reserved Claude native ID before the query is created', async () => {
  let allow!: () => void;
  const blocked = new Promise<void>((resolve) => { allow = resolve; });
  const claim = vi.fn(() => blocked);
  const held = session({ claimSessionId: claim });
  held.begin('first', 'hello');
  await settle();
  expect(claim).toHaveBeenCalledWith(sdk.nativeId);
  expect(sdk.runs).toHaveLength(0);
  allow();
  await settle();
  expect(sdk.runs).toHaveLength(1);
  expect(sdk.runs[0]!.options.sessionId).toBe(sdk.nativeId);
});

it('refuses an owned Claude resume before starting a query', async () => {
  const claim = vi.fn(async () => { throw new Error('another task owns this native session'); });
  const held = session({ resume: 'saved-native', claimSessionId: claim });
  held.begin('first', 'hello');
  await settle();
  expect(claim).toHaveBeenCalledWith('saved-native');
  expect(sdk.runs).toHaveLength(0);
});

it('keeps a lifecycle-owned Claude process through idle time without containment proof', async () => {
  const claim = vi.fn(async () => {});
  const held = session({ claimSessionId: claim, idleTimeoutMs: 100 });
  held.begin('first', 'hello');
  await settle();
  await complete();
  await vi.advanceTimersByTimeAsync(1_000);
  expect(sdk.runs).toHaveLength(1);
  expect(sdk.runs[0]!.closed).toBe(false);
  held.begin('next', 'continue');
  await settle();
  expect(sdk.runs).toHaveLength(1);
  expect(claim).toHaveBeenCalledOnce();
});

it('awaits prompt work admission before sending to Claude and finishes on its result', async () => {
  let admit!: () => void;
  const gate = new Promise<void>((resolve) => { admit = resolve; });
  const finish = vi.fn(async () => {});
  const beginWork = vi.fn(async () => { await gate; return finish; });
  const held = session({ beginWork });
  held.begin('gated', 'hello');
  await settle();
  expect(beginWork).toHaveBeenCalledOnce();
  expect(sdk.runs[0]!.prompts).toHaveLength(0);
  admit();
  await settle();
  expect(sdk.runs).toHaveLength(1);
  expect(finish).not.toHaveBeenCalled();
  sdk.runs[0]!.send({ type: 'result', subtype: 'success', duration_ms: 1 });
  await settle();
  expect(finish).toHaveBeenCalledOnce();
});

it('retains Claude prompt permits after cancellation even when a result arrives later', async () => {
  const finish = vi.fn(async () => {});
  const held = session({ beginWork: async () => finish });
  held.begin('cancelled', 'hello');
  await settle();
  held.cancel('cancelled');
  sdk.runs[0]!.send({ type: 'result', subtype: 'success', duration_ms: 1 });
  await settle();
  expect(finish).not.toHaveBeenCalled();
});

it('rejects Claude prompt admission without sending user input', async () => {
  const held = session({ beginWork: async () => { throw new Error('task sealed'); } });
  held.begin('rejected', 'hello');
  await settle();
  expect(sdk.runs[0]!.prompts).toHaveLength(0);
  expect(JSON.stringify(held.chatState())).toContain('task sealed');
});

it('gates Claude retry admission independently from the failed prompt', async () => {
  let admit!: () => void;
  const gate = new Promise<void>((resolve) => { admit = resolve; });
  const finish = vi.fn(async () => {});
  let calls = 0;
  const held = session({ beginWork: async () => { if (++calls > 1) await gate; return finish; } });
  held.begin('retry', 'hello');
  await settle();
  sdk.runs[0]!.send({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['test error'] });
  await settle();
  expect(finish).toHaveBeenCalledOnce();
  expect(held.resume!('retry')).toBe(true);
  await settle();
  expect(sdk.runs[0]!.prompts).toHaveLength(1);
  admit();
  await settle();
  expect(sdk.runs[0]!.prompts).toHaveLength(2);
  sdk.runs[0]!.send({ type: 'result', subtype: 'success', duration_ms: 1 });
  await settle();
  expect(finish).toHaveBeenCalledTimes(2);
});

it('holds a question permit beyond the native prompt result and finishes only its answer', async () => {
  const inputFinished = vi.fn(async () => {});
  const held = session({ beginWork: async (work) => work.kind === 'input' ? inputFinished : async () => {} });
  held.begin('question-turn', 'hello');
  await settle();
  const ask = sdk.runs[0]!.options.canUseTool as (name: string, input: Record<string, unknown>, about: Record<string, unknown>) => Promise<unknown>;
  const pending = ask('AskUserQuestion', { questions: [{ question: 'Continue?', options: [{ label: 'Yes' }] }] }, { toolUseID: 'work-question' });
  await settle();
  sdk.runs[0]!.send({ type: 'result', subtype: 'success', duration_ms: 1 });
  await settle();
  expect(inputFinished).not.toHaveBeenCalled();
  held.answer('work-question', false, {});
  await pending;
  expect(inputFinished).toHaveBeenCalledOnce();
});

it('retains an unanswered question permit on disposal', async () => {
  const inputFinished = vi.fn(async () => {});
  const held = session({ beginWork: async (work) => work.kind === 'input' ? inputFinished : async () => {} });
  held.begin('question-turn', 'hello');
  await settle();
  const ask = sdk.runs[0]!.options.canUseTool as (name: string, input: Record<string, unknown>, about: Record<string, unknown>) => Promise<unknown>;
  const pending = ask('AskUserQuestion', { questions: [{ question: 'Continue?', options: [{ label: 'Yes' }] }] }, { toolUseID: 'work-question' });
  await settle();
  await held.close();
  await pending;
  expect(inputFinished).not.toHaveBeenCalled();
});
