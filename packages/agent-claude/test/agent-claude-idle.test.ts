import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ProcessFixture } from './fixtures/process.js';

const sdk = vi.hoisted(() => ({ nativeId: '11111111-1111-4111-8111-111111111111', inputGatedInit: false, initialize: undefined as undefined | ((index: number) => Promise<unknown>), spawn: false, localSpawn: undefined as undefined | (() => unknown), resources: [] as { closed: boolean }[], runs: [] as {
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
    const init = { type: 'system', subtype: 'init', session_id: sdk.nativeId };
    const frames: Record<string, unknown>[] = sdk.inputGatedInit ? [] : [init];
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
      setModel: async () => {},
      applyFlagSettings: async () => {},
      setPermissionMode: async () => {},
      interrupt: async () => {},
      toggleMcpServer: async () => {},
      close: () => { run.closed = true; wake?.(); },
      [Symbol.asyncDispose]: async () => {},
    };
  },
}));

const { createSession } = await import('../src/session.js');
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

beforeEach(() => { vi.useFakeTimers(); sdk.runs.length = 0; sdk.resources.length = 0; sdk.nativeId = '11111111-1111-4111-8111-111111111111'; sdk.inputGatedInit = false; sdk.initialize = undefined; sdk.spawn = false; sdk.localSpawn = undefined; });
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((held) => held.close()));
  for (const cwd of directories.splice(0)) rmSync(cwd, { recursive: true, force: true });
  vi.useRealTimers();
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
  const held = session({ idleTimeoutMs: 100, resume: '11111111-1111-4111-8111-111111111111', forkAt: 'fork-point', settings: { permissionMode: 'plan' } });
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
  expect(sdk.runs[1]!.options).toMatchObject({ resume: '11111111-1111-4111-8111-111111111111', model: 'chosen-model', effort: 'high', permissionMode: 'plan' });
  expect(sdk.runs[1]!.options).not.toHaveProperty('forkSession');
  expect(sdk.runs[1]!.options).not.toHaveProperty('resumeSessionAt');
  expect(sdk.runs[1]!.prompts).toEqual([{ type: 'user', message: { role: 'user', content: 'Read the result' }, parent_tool_use_id: null }]);
  expect(sdk.runs[0]!.prompts).toHaveLength(1);
});

it('recreates an unused native session with its exact ID rather than resuming an unwritten transcript', async () => {
  const held = session({ idleTimeoutMs: 100 });
  await settle();
  await vi.advanceTimersByTimeAsync(100);
  held.begin('first', 'First prompt');
  await settle();
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
