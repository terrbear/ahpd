import { expect, it, vi } from 'vitest';
import type { Peer } from '../src/types/rpc.js';

/*
 * The per-tool load policy, as the Claude SDK is handed it.
 *
 * A host tool's `deferLoading` never reaches a published `ToolDefinition`; the
 * backend turns it into `_meta['anthropic/alwaysLoad']` on the raw definition
 * `createSdkMcpServer` receives, because the SDK's `tool()` helper is not used
 * here. The SDK is mocked because what is under test is the object this host
 * builds, not the SDK's reading of it - a rename in the SDK should fail this
 * test rather than silently defer the one tool the instruction names.
 */

const sdk = vi.hoisted(() => {
  interface Fake {
    frames: Record<string, unknown>[];
    wake: (() => void) | undefined;
    closed: boolean;
    options: Record<string, unknown>;
  }
  return { queries: [] as Fake[] };
});

const sessionQueries = () => sdk.queries.filter((q) => q.options.canUseTool !== undefined);

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  createSdkMcpServer: (given: Record<string, unknown>) => ({ type: 'sdk', name: given.name, tools: given.tools }),
  listSessions: async () => [],
  getSessionMessages: async () => [],
  query: ({ prompt, options }: { prompt: AsyncIterable<unknown>; options: Record<string, unknown> }) => {
    const fake = { frames: [] as Record<string, unknown>[], wake: undefined as undefined | (() => void), closed: false, options };
    sdk.queries.push(fake);
    void (async () => { for await (const _ of prompt) { /* drained */ } })();
    return {
      async *[Symbol.asyncIterator]() {
        for (;;) {
          while (fake.frames.length > 0) yield fake.frames.shift() as Record<string, unknown>;
          if (fake.closed) return;
          await new Promise<void>((resolve) => { fake.wake = resolve; });
        }
      },
      interrupt: async () => {},
      setPermissionMode: async () => {},
      setModel: async () => {},
      applyFlagSettings: async () => {},
      toggleMcpServer: async () => {},
      reconnectMcpServer: async () => {},
      initializationResult: async () => ({}),
      mcpServerStatus: async () => [],
      reloadSkills: async () => ({ skills: [] }),
      supportedModels: async () => [],
      streamInput: async () => {},
      close: () => { fake.closed = true; fake.wake?.(); },
    };
  },
}));

const { createHost } = await import('../src/host.js');
const { claude } = await import('../../agent-claude/src/claude.js');
const { hostTools } = await import('../src/tools.js');

const settle = async (times = 8): Promise<void> => {
  for (let i = 0; i < times; i++) await new Promise((r) => { setTimeout(r, 0); });
};

function peer(): Peer {
  return { send: () => {}, notify: () => {}, request: async () => ({}), answered: () => {}, close: () => {} };
}

it('marks host tools for discovery and keeps client-published tools eager', async () => {
  // Include the full inventory so new host tools must get an explicit load policy.
  const host = createHost({
    path: '/home/softov',
    agents: [claude({ paths: ['/home/softov'] })],
    tools: hostTools(),
  });
  const client = host.accept(peer());
  await client.handle({ method: 'initialize', params: { clientId: 'probe', protocolVersions: ['0.9.0'] } });
  await client.handle({
    method: 'createSession',
    params: {
      channel: 'ahp-session:/policy', provider: 'claude',
      activeClient: { clientId: 'probe', tools: [{ name: 'client_tool', description: 'A fixture client tool.', inputSchema: { type: 'object' } }] },
    },
  });
  await settle();

  const tools = (sessionQueries().at(-1)?.options.mcpServers as Record<string, { tools: { name: string; _meta?: Record<string, unknown> }[] }>).ahp?.tools ?? [];
  const byName = new Map(tools.map((one) => [one.name, one]));
  const eager = ['add_artifact_or_reference'];
  const deferred = [
    'remove_artifact_or_reference', 'list_artifacts_and_references',
    'list_sessions', 'get_current_session', 'set_workspace', 'create_session', 'create_chat',
    'rename_chat', 'send_message', 'interrupt_session', 'get_session_context', 'delete_session',
    'ahp_resource', 'ahp_terminals',
  ];
  expect([...byName.keys()].sort()).toEqual([...eager, ...deferred, 'probe__client_tool'].sort());
  expect(eager).toHaveLength(1);
  expect(deferred).toHaveLength(14);
  for (const name of eager) expect(byName.get(name)?._meta).toEqual({ 'anthropic/alwaysLoad': true });
  for (const name of deferred) expect(byName.get(name)?._meta).toEqual({ 'anthropic/alwaysLoad': false });
  expect(byName.get('probe__client_tool')?._meta).toEqual({ 'anthropic/alwaysLoad': true });
});
