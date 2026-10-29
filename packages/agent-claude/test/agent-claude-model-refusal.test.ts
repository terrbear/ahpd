import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { Bag } from '@ahpd/sdk';
import type { ClaudeSessionOptions } from '../src/session.js';

/*
 * A turn that names a model the CLI will not take.
 *
 * `setModel` is the only thing that knows whether the CLI has the model, and
 * the switch is the one call a turn makes before its prompt goes out. Fired
 * and forgotten it answers two questions at once - it moves the session onto
 * the named model and then, when it refuses, leaves the turn labelled with a
 * model that never ran it and answered by whichever one it was on before.
 */

const sdk = vi.hoisted(() => {
  interface Feed { held: Record<string, unknown>[]; wake: (() => void) | undefined }
  const feed: Feed = { held: [], wake: undefined };
  return {
    feed,
    /** The stream the session pushes prompts onto, which nothing else reads. */
    prompt: undefined as AsyncGenerator<Bag> | undefined,
    /** Every model the CLI was asked for, in the order it was asked. */
    asked: [] as string[],
    /** What the CLI says about a model it will not take. */
    refuses: {} as Record<string, string>,
    /** How long each model takes to be taken, so a switch can be waited on. */
    takes: {} as Record<string, number>,
    reset() {
      feed.held = [];
      feed.wake = undefined;
      sdk.asked = [];
      sdk.refuses = {};
      sdk.takes = {};
    },
    push(...frames: Record<string, unknown>[]) {
      feed.held.push(...frames);
      feed.wake?.();
      feed.wake = undefined;
    },
    async next(): Promise<Record<string, unknown>> {
      while (feed.held.length === 0) await new Promise<void>((resolve) => { feed.wake = resolve; });
      return feed.held.shift() as Record<string, unknown>;
    },
  };
});

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  createSdkMcpServer: (given: Record<string, unknown>) => ({ type: 'sdk', name: given.name, tools: given.tools }),
  query: (given: { prompt: AsyncGenerator<Bag> }) => {
    sdk.prompt = given.prompt;
    return {
      async *[Symbol.asyncIterator]() {
        for (;;) yield await sdk.next();
      },
      interrupt: async () => {},
      setPermissionMode: async () => {},
      setModel: async (model?: string) => {
        const said = String(model);
        sdk.asked.push(said);
        const wait = sdk.takes[said] ?? 0;
        if (wait > 0) await new Promise((resolve) => { setTimeout(resolve, wait); });
        const why = sdk.refuses[said];
        if (why !== undefined) throw new Error(why);
      },
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
afterEach(() => vi.unstubAllEnvs());

const settle = async (times = 30): Promise<void> => {
  for (let i = 0; i < times; i++) await new Promise((r) => { setTimeout(r, 0); });
};

/** The frame a turn ends with, with no round under it. */
const ended = (): Record<string, unknown> => ({ type: 'result', subtype: 'success', is_error: false, duration_ms: 1 });

/**
 * A real session over a CLI that answers nothing, and the two things it says:
 * what it emitted, and what it pushed at the CLI.
 *
 * The prompts are read by one reader for the whole session, because a second
 * `next()` on the same generator queues behind the first - which would make an
 * absent prompt look like a late one.
 */
async function open(options: Partial<ClaudeSessionOptions> = {}) {
  sdk.reset();
  const said: Bag[] = [];
  const prompts: string[] = [];
  const session = createSession({
    uri: 'ahp-session:/model',
    chatUri: 'ahp-chat:/model',
    cwd: mkdtempSync(join(tmpdir(), 'ahpd-model-')),
    emit: (_channel, action) => { said.push(action as Bag); },
    ...options,
  });
  await settle();
  const stream = sdk.prompt as AsyncGenerator<Bag>;
  void (async () => {
    for (;;) {
      const one = await stream.next();
      if (one.done === true) return;
      prompts.push(String(((one.value as Bag).message as Bag).content));
    }
  })();
  /** The kinds of the actions the chat received, in order. */
  const chat = (): string[] => said.filter((one) => String(one.type).startsWith('chat/')).map((one) => String(one.type));
  /** The turn-started message for one turn. */
  const message = (turnId: string): Bag => (said.find((one) => one.type === 'chat/turnStarted' && one.turnId === turnId)?.message ?? {}) as Bag;
  /** What the failure part says, for one turn. */
  const failure = (turnId: string): string => String(((said.find((one) => one.type === 'chat/error' && one.turnId === turnId)?.part as Bag)?.error as Bag).message);
  return { session, said, prompts, chat, message, failure };
}

it('fails the turn on a model the CLI refuses, sends nothing, and stays on the model it had', async () => {
  const { session, prompts, chat, message, failure } = await open();
  sdk.refuses['claude-2.1'] = "Model 'claude-2.1' not found";

  session.begin('t1', 'first', { id: 'opus' });
  await settle();
  sdk.push(ended());
  await settle();
  expect(prompts).toEqual(['first']);

  session.begin('t2', 'second', { id: 'claude-2.1' });
  await settle();

  // Started and then failed, both events, so a client clears its own row.
  expect(chat().slice(-2)).toEqual(['chat/turnStarted', 'chat/error']);
  expect(failure('t2')).toBe("The harness would not take model claude-2.1: Model 'claude-2.1' not found");
  // Nothing reached the CLI, and the turn is not credited to the model it named.
  expect(prompts).toEqual(['first']);
  expect(message('t2').model).toBeUndefined();

  session.begin('t3', 'third');
  await settle();
  expect(message('t3').model).toEqual({ id: 'opus' });
});

it('runs on a model the CLI takes, and says which one, as before', async () => {
  const { session, prompts, chat, message } = await open();

  session.begin('t1', 'first', { id: 'opus' });
  await settle();

  expect(sdk.asked).toEqual(['claude-opus-5-5']);
  expect(message('t1').model).toEqual({ id: 'opus' });
  expect(prompts).toEqual(['first']);
  expect(chat().filter((one) => one === 'chat/turnStarted' || one === 'chat/error')).toEqual(['chat/turnStarted']);
});

it('holds the queue behind a turn that is switching models, and sends the prompts in order', async () => {
  const { session, prompts } = await open();
  // Long enough that the queue is still waiting on it a few ticks later.
  sdk.takes.slow = 25;

  session.begin('t1', 'first', { id: 'slow' });
  session.queue('q1', 'second');
  await settle(5);

  // The turn is busy before it has an id the session can report, so the
  // message behind it waits: nothing of the second turn has reached the CLI,
  // and it is still a queued message rather than a turn.
  expect(prompts).toEqual([]);
  expect(session.chatState().activeTurn).toBeUndefined();
  expect(session.chatState().queuedMessages).toMatchObject([{ id: 'q1' }]);

  await settle(60);
  // The switch has gone through and the first turn is running alone. A turn
  // naming no model skips the wait entirely, so this is where it would have
  // overtaken it.
  expect(prompts).toEqual(['first']);

  sdk.push(ended());
  await settle(30);
  expect(prompts).toEqual(['first', 'second']);
  expect(sdk.asked).toEqual(['slow']);
});

it.each([
  ['fable', 'claude-fable-5-1'],
  ['opus', 'claude-opus-5-5'],
  ['sonnet', 'claude-sonnet-5-5'],
  ['haiku', 'claude-haiku-5-5'],
  ['sonnet[1m]', 'claude-sonnet-5-5[1m]'],
  ['haiku[200k]', 'claude-haiku-5-5[200k]'],
  ['claude-sonnet-5', 'claude-sonnet-5'],
  ['claude-haiku-4-5-20251001[1m]', 'claude-haiku-4-5-20251001[1m]'],
  ['custom/sonnet', 'custom/sonnet'],
  ['default', 'undefined'],
])('sends %s as %s while retaining the requested selection', async (id, resolved) => {
  const { session, prompts, message } = await open();
  session.begin('pin', 'hello', { id });
  await settle();
  expect(sdk.asked).toEqual([resolved]);
  expect(prompts).toEqual(['hello']);
  expect(message('pin').model).toEqual({ id });
});

it('fails an unavailable pinned alias without sending its prompt or asking for an older model', async () => {
  const { session, prompts, failure } = await open();
  sdk.refuses['claude-haiku-5-5'] = 'model unavailable';
  session.begin('missing', 'hello', { id: 'haiku' });
  await settle();
  expect(sdk.asked).toEqual(['claude-haiku-5-5']);
  expect(prompts).toEqual([]);
  expect(failure('missing')).toContain('model unavailable');
});

it('pins config changes and retains the previous selection when the pinned model is refused', async () => {
  const { session } = await open();
  expect(await session.setConfig!('model', 'sonnet[1m]')).toBe(true);
  sdk.refuses['claude-haiku-5-5'] = 'model unavailable';
  expect(await session.setConfig!('model', 'haiku')).toContain('would not take');
  expect(sdk.asked).toEqual(['claude-sonnet-5-5[1m]', 'claude-haiku-5-5']);
  expect(session.settings!().model).toBe('sonnet[1m]');
});

it.each([
  { env: { ANTHROPIC_BASE_URL: 'https://gateway.example.test' } },
  { env: { CLAUDE_CODE_USE_VERTEX: 'true' } },
  { env: { CLAUDE_CODE_USE_FOUNDRY: '1' } },
  { offerModels: async (models: { id: string; name: string }[]) => models },
  { presets: { custom: { env: { CLAUDE_CODE_USE_BEDROCK: '1' } } } },
])('preserves custom provider aliases for %j', async (options) => {
  const { session } = await open(options);
  session.begin('custom', 'hello', { id: 'sonnet' });
  await settle();
  expect(sdk.asked).toEqual(['sonnet']);
});


it('preserves a provider selected in the daemon environment', async () => {
  vi.stubEnv('ANTHROPIC_BASE_URL', 'https://gateway.example.test');
  const { session } = await open();
  session.begin('custom', 'hello', { id: 'haiku[1m]' });
  await settle();
  expect(sdk.asked).toEqual(['haiku[1m]']);
});

it('pins first-party requests even with older CLI alias defaults', async () => {
  const { session } = await open({ env: {
    ANTHROPIC_BASE_URL: 'https://api.anthropic.com/',
    ANTHROPIC_DEFAULT_HAIKU_MODEL: 'claude-haiku-4-5-20251001',
    CLAUDE_CODE_USE_BEDROCK: '0',
  } });
  session.begin('pinned', 'hello', { id: 'haiku' });
  await settle();
  expect(sdk.asked).toEqual(['claude-haiku-5-5']);
});
