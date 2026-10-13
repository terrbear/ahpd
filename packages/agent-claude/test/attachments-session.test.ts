import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';

const capture = vi.hoisted(() => ({ messages: [] as unknown[] }));
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  createSdkMcpServer: (value: Record<string, unknown>) => ({ type: 'sdk', ...value }),
  query: ({ prompt }: { prompt: AsyncIterable<unknown> }) => ({
    async *[Symbol.asyncIterator]() {
      for await (const message of prompt) {
        capture.messages.push(message);
        yield { type: 'result', subtype: 'success', result: 'red', duration_ms: 1, num_turns: 1, is_error: false, session_id: 'fixture', usage: { input_tokens: 1, output_tokens: 1 } };
      }
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
  }),
}));
const { createSession } = await import('../src/session.js');

it('delivers an attachment-only prompt to the Claude SDK input stream and retains attachments on the turn', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'ahpd-image-'));
  const events: unknown[] = [];
  const red = { type: 'embeddedResource' as const, label: 'red.png', contentType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==' };
  const session = createSession({ uri: 'ahp-session:/image', chatUri: 'ahp-chat:/image', cwd, emit: (_channel, action) => { events.push(action); } });
  try {
    session.begin?.('image', '', undefined, { attachments: [red] });
    await vi.waitFor(() => expect(capture.messages).toHaveLength(1));
    expect(capture.messages[0]).toMatchObject({ type: 'user', message: { content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: red.data } }] } });
    expect(events).toContainEqual(expect.objectContaining({ type: 'chat/turnStarted', message: expect.objectContaining({ attachments: [red] }) }));
  } finally {
    await session.close();
    rmSync(cwd, { recursive: true, force: true });
  }
});
