import { spawnSync } from 'node:child_process';
import { chmod, lstat, mkdir, mkdtemp, readFile, rename, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

const pin = JSON.parse(await readFile(new URL('./codex-acp.json', import.meta.url), 'utf8'));
if (pin.repository !== 'https://github.com/terrbear/codex-acp.git' || !/^[a-f0-9]{40}$/.test(pin.revision)) {
  throw new Error('Codex ACP must be pinned to a full commit from terrbear/codex-acp');
}
if (process.argv.length !== 3) throw new Error('Usage: node scripts/install-codex-acp.mjs <new-install-directory>');
const destination = resolve(process.argv[2]);
const existing = await lstat(destination).catch((error) => {
  if (error.code !== 'ENOENT') throw error;
  return undefined;
});
if (existing) throw new Error(`Install directory already exists: ${destination}`);
await mkdir(dirname(destination), { recursive: true });
const staging = await mkdtemp(join(dirname(destination), '.codex-acp-'));
function run(command, args) {
  const result = spawnSync(command, args, { cwd: staging, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed (${result.signal ?? result.status})`);
}
try {
  run('git', ['init', '--quiet']);
  run('git', ['remote', 'add', 'origin', pin.repository]);
  run('git', ['fetch', '--depth=1', 'origin', pin.revision]);
  run('git', ['checkout', '--detach', '--quiet', 'FETCH_HEAD']);
  run('npm', ['ci', '--no-audit', '--no-fund']);
  run('npm', ['run', 'build']);
  await chmod(join(staging, 'dist/index.js'), 0o755);
  await rename(staging, destination);
  console.log(`Installed terrbear/codex-acp@${pin.revision}`);
  console.log(`Set the Codex provider command to ${join(destination, 'dist/index.js')}`);
} finally {
  await rm(staging, { recursive: true, force: true });
}
