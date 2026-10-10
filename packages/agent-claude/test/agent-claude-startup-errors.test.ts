import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';

/*
 * A Claude process that failed before it could answer.
 *
 * Node's child-process error carries the useful errno alongside fields that
 * must not reach a session transcript: the executable path and spawn args.
 * The SDK can wrap that error, so this exercises both new and resumed query
 * setup through the same safe session boundary.
 */
const sdk = vi.hoisted(() => ({
  options: [] as Record<string, unknown>[],
  failure: undefined as unknown,
}));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  createSdkMcpServer: (given: Record<string, unknown>) => ({ type: 'sdk', name: given.name, tools: given.tools }),
  query: ({ options }: { options: Record<string, unknown> }) => {
    sdk.options.push(options);
    const failure = sdk.failure;
    return {
      async *[Symbol.asyncIterator]() {
        if (failure !== undefined) throw failure;
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

const settle = async (times = 8): Promise<void> => {
  for (let i = 0; i < times; i++) await new Promise((done) => { setTimeout(done, 0); });
};

const SESSION = '01234567-89ab-4cde-8fab-0123456789ab';

it.each([
  { path: 'fresh', resume: undefined },
  { path: 'resumed', resume: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' },
])('$path startup reports only the child spawn errno', async ({ path, resume }) => {
  sdk.options = [];
  const childError = Object.assign(new Error('spawn failed'), {
    code: 'ENOENT',
    syscall: 'spawn /private/native/claude',
    path: '/private/native/claude',
    spawnargs: ['--api-key', 'must-not-escape'],
  });
  sdk.failure = new Error('The native binary failed to launch; perhaps libc is missing.', { cause: childError });
  const events: Record<string, unknown>[] = [];
  const session = createSession({
    uri: `ahp-session:/${SESSION}`,
    chatUri: `ahp-chat:/${SESSION}`,
    cwd: mkdtempSync(join(tmpdir(), 'ahpd-spawn-failure-')),
    ...(resume === undefined ? {} : { resume }),
    emit: (_channel: string, event: Record<string, unknown>) => events.push(event),
  });

  await settle();
  const queryOptions = sdk.options[0];
  expect(queryOptions).toBeDefined();
  expect(queryOptions?.resume).toBe(resume);
  if (resume === undefined) expect(queryOptions?.sessionId).toBe(SESSION);
  else expect(queryOptions?.sessionId).toBeUndefined();

  expect(session.sessionState().error).toBe('Claude Code process could not start (ENOENT)');
  expect(session.status()).toBe(2);
  session.begin(`${path}-turn`, 'hello');
  await settle();

  const failedTurn = events.find((event) => event.type === 'chat/error');
  expect(failedTurn).toBeDefined();
  const shown = JSON.stringify(failedTurn);
  expect(shown).toContain('ENOENT');
  expect(shown).not.toContain('/private/native/claude');
  expect(shown).not.toContain('--api-key');
  expect(shown).not.toContain('must-not-escape');
  session.close();
});
