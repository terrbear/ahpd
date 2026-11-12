import { expect, it, vi } from 'vitest';
import { probe } from '../src/probe.js';

const sdk = vi.hoisted(() => ({
  options: [] as Record<string, unknown>[],
  initialization: {} as Record<string, unknown>,
}));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: ({ options }: { options: Record<string, unknown> }) => {
    sdk.options.push(options);
    return {
      initializationResult: async () => sdk.initialization,
      mcpServerStatus: async () => [],
      reloadSkills: async () => ({ skills: [] }),
      reloadPlugins: async () => ({ plugins: [] }),
      close: () => {},
    };
  },
}));

it('disables Claude.ai connectors in the startup probe and preserves its working directory', async () => {
  sdk.options = [];
  sdk.initialization = {};
  await probe('/tmp/ahpd-probe');
  expect(sdk.options).toEqual([{ cwd: '/tmp/ahpd-probe', settings: { disableClaudeAiConnectors: true } }]);
});

it('advertises a model by its resolved SDK id and falls back to its picker value', async () => {
  sdk.initialization = {
    models: [
      { value: 'opus', resolvedModel: 'claude-opus-5-5', displayName: 'Opus 5.5', description: 'Latest Opus' },
      { value: 'claude-opus-5', resolvedModel: 'claude-opus-5', displayName: 'Opus 5', description: 'Opus 5' },
      { value: 'custom/model', displayName: 'Custom', description: 'Custom model' },
      { value: 'default', resolvedModel: 'claude-opus-5-5', displayName: 'Default' },
    ],
  };

  const offered = await probe('/tmp/ahpd-probe');

  expect(offered.models).toEqual([
    { id: 'claude-opus-5-5', name: 'Opus 5.5' },
    { id: 'claude-opus-5', name: 'Opus 5' },
    { id: 'custom/model', name: 'Custom' },
    { id: 'default', name: 'Default' },
  ]);
});
