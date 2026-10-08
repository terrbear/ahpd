import { fileURLToPath } from 'node:url';
import { mkdtemp, mkdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { acpAgent } from '../src/agent.js';

const fixture = fileURLToPath(new URL('./fixtures/account-status.mjs', import.meta.url));

it('reads the configured Codex ACP process account in the selected directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ahpd-codex-account-'));
  const command = join(root, 'codex-acp');
  await symlink(process.execPath, command);
  const one = join(root, 'one');
  const two = join(root, 'two');
  await mkdir(one);
  await mkdir(two);
  const agent = acpAgent({ command, args: [fixture], provider: 'codex' });
  expect(await agent.accountIdentity?.()).toEqual({ status: 'unavailable' });
  expect(await agent.accountIdentity?.(one)).toEqual({ status: 'verified', name: 'one@example.com' });
  expect(await agent.accountIdentity?.(two)).toEqual({ status: 'verified', name: 'two@example.com' });
});

it('declines API key, credential override, and unrelated ACP providers', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ahpd-codex-account-'));
  const command = join(root, 'codex-acp');
  await symlink(process.execPath, command);
  const key = acpAgent({ command, args: [fixture, '--key'], provider: 'codex' });
  expect(await key.accountIdentity?.(root)).toEqual({ status: 'unavailable' });
  const override = acpAgent({ command, args: [fixture], provider: 'codex', env: { CODEX_HOME: root } });
  expect(await override.accountIdentity?.(root)).toEqual({ status: 'unavailable' });
  const unrelated = acpAgent({ command, args: [fixture], provider: 'other' });
  expect(await unrelated.accountIdentity?.(root)).toEqual({ status: 'unavailable' });
});

it('bounds account-probe teardown when the ACP process ignores SIGTERM', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ahpd-codex-account-'));
  const command = join(root, 'codex-acp');
  await symlink(process.execPath, command);
  const agent = acpAgent({ command, args: [fixture, '--ignore-term'], provider: 'codex' });
  const started = Date.now();
  expect(await agent.accountIdentity?.(root)).toEqual({ status: 'verified', name: `${root.split('/').at(-1)}@example.com` });
  expect(Date.now() - started).toBeGreaterThanOrEqual(200);
  expect(Date.now() - started).toBeLessThan(2000);
});
