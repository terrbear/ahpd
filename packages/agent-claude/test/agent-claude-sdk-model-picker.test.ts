import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { expect, it } from 'vitest';
import { withModelPickerCompatibility } from '../src/models.js';

const modelIds = [
  ['claude-fable-5-2', 'claude-fable-5-1'],
  ['claude-mythos-5-2', 'claude-mythos-5-1'],
] as const;

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

it('accepts Fable and Mythos 5.2 with the bundled Claude 2.1.293 model picker', async () => {
  const require = createRequire(import.meta.url);
  const sdkEntry = require.resolve('@anthropic-ai/claude-agent-sdk');
  const manifest = JSON.parse(readFileSync(join(dirname(sdkEntry), 'manifest.json'), 'utf8')) as { version?: unknown };
  expect(manifest.version).toBe('2.1.293');

  const home = mkdtempSync(join(tmpdir(), 'ahpd-claude-model-picker-'));
  const settings = withModelPickerCompatibility({ disableClaudeAiConnectors: true }, {});
  const picker = settings.modelPicker as { options: unknown[] };
  expect(picker.options).toEqual(expect.arrayContaining(modelIds.map(([model, behavesAs]) => ({
    model,
    label: model === 'claude-fable-5-2' ? 'Fable 5.2' : 'Mythos 5.2',
    behavesAs,
  }))));

  // This SDK env replaces the subprocess env. It contains no auth variables.
  // The input stream stays open but never yields, so this cannot send a prompt.
  const handle = query({
    prompt: noPrompts(),
    options: {
      cwd: home,
      env: {
        PATH: process.env.PATH ?? '',
        HOME: home,
        TMPDIR: home,
        CLAUDE_CONFIG_DIR: home,
        CLAUDE_CODE_DISABLE_NON_ESSENTIAL_TRAFFIC: '1',
      },
      settingSources: [],
      settings,
    },
  });

  try {
    await bounded(handle.initializationResult(), 15_000, 'Bundled Claude initialization');
    for (const [model] of modelIds) {
      await bounded(handle.setModel(model), 5_000, `setModel(${model})`);
    }
  } finally {
    handle.close();
    rmSync(home, { recursive: true, force: true });
  }
}, 30_000);
