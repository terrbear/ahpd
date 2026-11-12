import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { expect, it } from 'vitest';
const modelIds = ['claude-fable-5-2', 'claude-mythos-5-2'] as const;

const bounded = async <T>(work: Promise<T>, milliseconds: number, name: string): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${name} exceeded ${milliseconds}ms`)), milliseconds);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

/** Keep the SDK's streaming input open without ever yielding a prompt. */
const noPrompts = async function* () {
  await new Promise<void>(() => {});
};

it.skipIf(process.env.AHPD_CLAUDE_SDK_SMOKE_AUTH !== '1')('accepts native Fable and Mythos 5.2 IDs without picker overrides', async () => {
  const require = createRequire(import.meta.url);
  const sdkEntry = require.resolve('@anthropic-ai/claude-agent-sdk');
  const manifest = JSON.parse(readFileSync(join(dirname(sdkEntry), 'manifest.json'), 'utf8')) as { version?: unknown };
  expect(manifest.version).toBe('2.1.322');

  const home = mkdtempSync(join(tmpdir(), 'ahpd-claude-model-picker-'));
  const settings = { disableClaudeAiConnectors: true };
  expect(settings).not.toHaveProperty('modelPicker');

  // Keep the signed-in CLI auth, but disable settings sources and connectors.
  // The input stream stays open but never yields, so this cannot send a prompt.
  const handle = query({
    prompt: noPrompts(),
    options: {
      cwd: home,
      env: {
        ...process.env,
        TMPDIR: home,
        CLAUDE_CODE_DISABLE_NON_ESSENTIAL_TRAFFIC: '1',
      },
      persistSession: false,
      settingSources: [],
      settings,
    },
  });

  try {
    await bounded(handle.initializationResult(), 15_000, 'Bundled Claude initialization');
    const models = await bounded(handle.supportedModels(), 10_000, 'Bundled Claude model list');
    for (const model of modelIds) {
      expect(models.some((offered) => offered.resolvedModel === model)).toBe(true);
      await bounded(handle.setModel(model), 5_000, `setModel(${model})`);
    }
  } finally {
    handle.close();
    rmSync(home, { recursive: true, force: true });
  }
}, 30_000);
