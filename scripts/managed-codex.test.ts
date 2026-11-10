import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { prepareManagedCodex } from './managed-codex.mjs';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const oldRevision = '1111111111111111111111111111111111111111';
const revision = '2222222222222222222222222222222222222222';
const repository = 'https://github.com/terrbear/codex-acp.git';

function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'managed-codex-'));
  roots.push(home);
  const current = join(home, 'release');
  mkdirSync(join(current, 'scripts'), { recursive: true });
  writeFileSync(join(current, 'scripts/codex-acp.json'), JSON.stringify({ repository, revision }));
  const old = join(home, 'codex-acp', oldRevision);
  const executable = join(old, 'dist/index.js');
  mkdirSync(join(old, 'dist'), { recursive: true });
  writeFileSync(executable, 'old adapter');
  chmodSync(executable, 0o755);
  writeFileSync(join(old, 'package.json'), JSON.stringify({ name: '@agentclientprotocol/codex-acp', bin: { 'codex-acp': 'dist/index.js' } }));
  const config = join(home, 'host-settings.json');
  const settings = { connectionTokenFile: 'relative-token', plugins: [
    { name: '/source/packages/agent-acp', options: { provider: 'codex', command: executable, env: { KEEP: 'yes' } } },
    { name: '/custom/adapter', options: { provider: 'codex', command: '/custom/codex-acp' } },
    { name: '/source/packages/agent-acp', enabled: false, options: { provider: 'codex', command: '/disabled/adapter' } },
  ] };
  writeFileSync(config, JSON.stringify(settings));
  return { home, current, config, settings, old, executable, run: vi.fn(async () => '') };
}

it('stages the release pin for existing installs without changing configuration or custom paths', async () => {
  const f = fixture();
  const signal = new AbortController().signal;
  expect(await prepareManagedCodex(f.config, f.current, signal, f.run)).toEqual({ [f.executable]: join(f.home, 'codex-acp', revision, 'dist/index.js') });
  expect(f.run).toHaveBeenCalledExactlyOnceWith(process.execPath, ['scripts/install-codex-acp.mjs', join(f.home, 'codex-acp', revision)], f.current, signal, 900_000);
  expect(JSON.parse(readFileSync(f.config, 'utf8'))).toEqual(f.settings);
  expect(readFileSync(f.executable, 'utf8')).toBe('old adapter');
});

it('accepts a verified managed marker and rejects markers for another repository', async () => {
  const f = fixture();
  const marker = join(f.old, '.codex-acp-install.json');
  writeFileSync(marker, JSON.stringify({ repository, revision: oldRevision }));
  expect(await prepareManagedCodex(f.config, f.current, undefined, f.run)).toHaveProperty([f.executable]);
  f.run.mockClear();
  writeFileSync(marker, JSON.stringify({ repository: 'https://example.com/other.git', revision: oldRevision }));
  expect(await prepareManagedCodex(f.config, f.current, undefined, f.run)).toEqual({});
  expect(f.run).not.toHaveBeenCalled();
});

it('does not install an adapter for disabled or non-Codex providers', async () => {
  const f = fixture();
  f.settings.plugins[0].enabled = false;
  writeFileSync(f.config, JSON.stringify(f.settings));
  expect(await prepareManagedCodex(f.config, f.current, undefined, f.run)).toEqual({});
  expect(f.run).not.toHaveBeenCalled();
});

it('preserves markerless destinations and recognizes verified managed siblings', async () => {
  const f = fixture();
  const destination = join(f.home, 'codex-acp', revision);
  mkdirSync(destination);
  writeFileSync(join(destination, 'keep'), 'untouched');
  const sibling = `${f.old}-managed`;
  mkdirSync(sibling);
  writeFileSync(join(sibling, '.codex-acp-install.json'), JSON.stringify({ repository, revision: oldRevision }));
  const command = join(sibling, 'dist/index.js');
  f.settings.plugins[0].options.command = command;
  writeFileSync(f.config, JSON.stringify(f.settings));
  expect(await prepareManagedCodex(f.config, f.current, undefined, f.run)).toEqual({ [command]: join(`${destination}-managed`, 'dist/index.js') });
  expect(readFileSync(join(destination, 'keep'), 'utf8')).toBe('untouched');
});

it('fails before activation when the pin is invalid or installation fails', async () => {
  const f = fixture();
  f.run.mockRejectedValueOnce(new Error('offline'));
  await expect(prepareManagedCodex(f.config, f.current, undefined, f.run)).rejects.toThrow('offline');
  writeFileSync(join(f.current, 'scripts/codex-acp.json'), JSON.stringify({ repository, revision: 'main' }));
  await expect(prepareManagedCodex(f.config, f.current, undefined, f.run)).rejects.toThrow('Invalid managed Codex adapter pin');
  expect(f.run).toHaveBeenCalledTimes(1);
  expect(JSON.parse(readFileSync(f.config, 'utf8'))).toEqual(f.settings);
});
