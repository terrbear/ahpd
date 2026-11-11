import { lstat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { command, json, sha } from './managed-build.mjs';

const repository = 'https://github.com/terrbear/codex-acp.git';

async function managedCommand(home, path) {
  if (typeof path !== 'string') return false;
  if (path === join(home, 'node_modules/.bin/codex-acp')) return true;
  const install = dirname(dirname(path));
  const revision = /^([a-f0-9]{40})(?:-managed)?$/.exec(basename(install))?.[1];
  if (dirname(install) !== join(home, 'codex-acp') || !revision || path !== join(install, 'dist/index.js')) return false;
  const marker = await json(join(install, '.codex-acp-install.json'), undefined);
  if (marker) return marker.repository === repository && marker.revision === revision;
  if (basename(install) !== revision) return false;
  const manifest = await json(join(install, 'package.json'), {});
  const entry = await lstat(path).catch(() => undefined);
  return manifest.name === '@agentclientprotocol/codex-acp' && manifest.bin?.['codex-acp'] === 'dist/index.js' && entry?.isFile() && (entry.mode & 0o111) !== 0;
}

export async function prepareManagedCodex(config, current, signal, run = command) {
  const home = dirname(config);
  const settings = await json(config, {});
  const commands = new Set();
  for (const plugin of settings.plugins ?? []) {
    if (!plugin || typeof plugin !== 'object' || plugin.enabled === false || plugin.options?.provider !== 'codex') continue;
    const path = plugin.options.command;
    if (await managedCommand(home, path)) commands.add(path);
  }
  if (commands.size === 0) return {};
  const pin = await json(join(current, 'scripts/codex-acp.json'), {});
  if (pin.repository !== repository || !sha.test(pin.revision ?? '')) throw new Error('Invalid managed Codex adapter pin');
  let destination = join(home, 'codex-acp', pin.revision);
  const existing = await lstat(destination).catch((error) => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
  if (existing?.isDirectory() && !await json(join(destination, '.codex-acp-install.json'), undefined)) destination += '-managed';
  await run(process.execPath, ['scripts/install-codex-acp.mjs', destination], current, signal, 900_000);
  return Object.fromEntries([...commands].map((path) => [path, join(destination, 'dist/index.js')]));
}
