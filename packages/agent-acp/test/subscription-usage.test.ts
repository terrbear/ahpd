import { fileURLToPath } from 'node:url';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { expect, test } from 'vitest';
import { acpAgent } from '../src/agent.js';

test('probes the configured adapter in the daemon cwd and requires its opt-in capability', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ahpd-codex-quota-'));
  try {
    const command = join(root, 'codex-acp');
    await symlink(process.execPath, command);
    const fixture = fileURLToPath(new URL('./fixtures/account-status.mjs', import.meta.url));
    const base = { provider: 'codex', command, cwd: root, env: { OPENAI_API_KEY: '', OPENAI_BASE_URL: '' } };
    const ready = acpAgent({ ...base, args: [fixture, '--quota'] });
    expect(await ready.subscriptionUsage?.()).toMatchObject({
      status: 'verified', name: `${basename(root)}@example.com`, windows: [{ used: 0.23, windowSeconds: 604800 }],
    });
    const older = acpAgent({ ...base, args: [fixture] });
    expect(await older.subscriptionUsage?.()).toEqual({ status: 'unavailable' });
    const api = acpAgent({ ...base, env: { OPENAI_API_KEY: 'fixture-key' }, args: [fixture, '--quota'] });
    expect(await api.subscriptionUsage?.()).toEqual({ status: 'unavailable' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
