import { expect, it, vi } from 'vitest';
import { probe } from '../src/probe.js';

const sdk = vi.hoisted(() => ({ options: [] as Record<string, unknown>[] }));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: ({ options }: { options: Record<string, unknown> }) => {
    sdk.options.push(options);
    return {
      initializationResult: async () => ({}),
      mcpServerStatus: async () => [],
      reloadSkills: async () => ({ skills: [] }),
      reloadPlugins: async () => ({ plugins: [] }),
      close: () => {},
    };
  },
}));

it('disables Claude.ai connectors in the startup probe and preserves its working directory', async () => {
  sdk.options = [];
  await probe('/tmp/ahpd-probe');
  expect(sdk.options).toEqual([{ cwd: '/tmp/ahpd-probe', settings: { disableClaudeAiConnectors: true } }]);
});
