import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';

const pin = JSON.parse(await readFile(new URL('./codex-acp.json', import.meta.url), 'utf8'));
if (pin.repository !== 'https://github.com/terrbear/codex-acp.git' || !/^[a-f0-9]{40}$/.test(pin.revision)) {
  throw new Error('Codex ACP must be pinned to a full commit from terrbear/codex-acp');
}
if (process.argv.length !== 3) throw new Error('Usage: node scripts/install-codex-acp.mjs <install-directory>');
const destination = resolve(process.argv[2]);
const markerName = '.codex-acp-install.json';
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function regularFile(path) {
  try {
    const info = await lstat(path);
    return info.isFile() ? info : undefined;
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
}

async function fileDigest(path) {
  const info = await regularFile(path);
  if (!info) return undefined;
  return digest(await readFile(path));
}

async function installState(path) {
  let marker;
  try {
    marker = JSON.parse(await readFile(join(path, markerName), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return { managed: false, matches: false };
    throw new Error(`Could not verify the existing Codex ACP install at ${path}: ${error.message}`);
  }
  if (marker.repository !== pin.repository || !/^[a-f0-9]{40}$/.test(marker.revision ?? '')) {
    return { managed: false, matches: false };
  }
  if (marker.revision !== pin.revision) return { managed: true, matches: false };
  const entrypoint = join(path, 'dist/index.js');
  const packageFile = join(path, 'package.json');
  const lockFile = join(path, 'package-lock.json');
  const installedLock = join(path, 'node_modules/.package-lock.json');
  const entrypointInfo = await regularFile(entrypoint);
  if (!entrypointInfo || !await regularFile(packageFile) || !await regularFile(lockFile) || !await regularFile(installedLock)) {
    return { managed: true, matches: false };
  }
  if ((entrypointInfo.mode & 0o111) === 0) return { managed: true, matches: false };
  const packageJson = JSON.parse(await readFile(packageFile, 'utf8'));
  if (packageJson.name !== '@agentclientprotocol/codex-acp' || packageJson.bin?.['codex-acp'] !== 'dist/index.js') {
    return { managed: true, matches: false };
  }
  const checks = {
    packageJson: await fileDigest(packageFile),
    packageLock: await fileDigest(lockFile),
    installedDependencies: await fileDigest(installedLock),
    entrypoint: await fileDigest(entrypoint),
  };
  return { managed: true, matches: Object.entries(checks).every(([key, value]) => marker[key] === value) };
}

async function replaceInstall(staging, path, expectedExisting) {
  const current = await lstat(path).catch((error) => {
    if (error.code !== 'ENOENT') throw error;
    return undefined;
  });
  if (expectedExisting === undefined) {
    if (current !== undefined) throw new Error(`Install destination appeared during build and was left untouched: ${path}`);
    await rename(staging, path);
    return;
  }
  if (current === undefined || current.dev !== expectedExisting.dev || current.ino !== expectedExisting.ino || !current.isDirectory()) {
    throw new Error(`Install destination changed during build and was left untouched: ${path}`);
  }
  const state = await installState(path);
  if (!state.managed) throw new Error(`Install destination is no longer a verified terrbear/codex-acp installation: ${path}`);
  const backup = join(dirname(path), `.${basename(path)}.backup-${randomUUID()}`);
  await rename(path, backup);
  try {
    await rename(staging, path);
  } catch (error) {
    await rename(backup, path);
    throw error;
  }
  try {
    await rm(backup, { recursive: true, force: true });
  } catch (error) {
    const failed = join(dirname(path), `.${basename(path)}.failed-${randomUUID()}`);
    await rename(path, failed);
    try {
      await rename(backup, path);
    } catch (restoreError) {
      throw new AggregateError([error, restoreError], `Could not clean up or restore the previous Codex ACP install at ${path}`);
    }
    await rm(failed, { recursive: true, force: true });
    throw new Error(`Could not remove the previous Codex ACP build at ${backup}: ${error.message}`);
  }
}

const existing = await lstat(destination).catch((error) => {
  if (error.code !== 'ENOENT') throw error;
  return undefined;
});
if (existing) {
  if (!existing.isDirectory()) throw new Error(`Install destination is not a directory: ${destination}`);
  const state = await installState(destination);
  if (!state.managed) throw new Error(`Install directory is not a verified terrbear/codex-acp installation: ${destination}`);
  if (state.matches) {
    console.log(`Reusing terrbear/codex-acp@${pin.revision}`);
    console.log(`Codex provider command: ${join(destination, 'dist/index.js')}`);
    process.exit(0);
  }
}

await mkdir(dirname(destination), { recursive: true });
const staging = await mkdtemp(join(dirname(destination), '.codex-acp-'));
try {
  function run(command, args, capture = false) {
    const result = spawnSync(command, args, { cwd: staging, encoding: 'utf8' });
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`${command} failed (${result.signal ?? result.status})`);
    return capture ? result.stdout.trim() : '';
  }
  run('git', ['init', '--quiet']);
  run('git', ['remote', 'add', 'origin', pin.repository]);
  run('git', ['fetch', '--depth=1', 'origin', pin.revision]);
  run('git', ['checkout', '--detach', '--quiet', 'FETCH_HEAD']);
  const checkedOutRevision = run('git', ['rev-parse', 'HEAD'], true);
  if (checkedOutRevision !== pin.revision) throw new Error(`Fetched Codex ACP revision ${checkedOutRevision} instead of pinned ${pin.revision}`);
  run('npm', ['ci', '--no-audit', '--no-fund']);
  run('npm', ['run', 'build']);
  const packageFile = join(staging, 'package.json');
  const lockFile = join(staging, 'package-lock.json');
  const entrypoint = join(staging, 'dist/index.js');
  const installedLock = join(staging, 'node_modules/.package-lock.json');
  const packageJson = JSON.parse(await readFile(packageFile, 'utf8'));
  if (packageJson.name !== '@agentclientprotocol/codex-acp' || packageJson.bin?.['codex-acp'] !== 'dist/index.js') {
    throw new Error('Pinned Codex ACP package does not expose the expected codex-acp entrypoint');
  }
  if (!await regularFile(lockFile) || !await regularFile(installedLock)) {
    throw new Error('Pinned Codex ACP install did not produce its package or dependency lock');
  }
  if (!await regularFile(entrypoint)) throw new Error(`Pinned Codex ACP build did not produce ${entrypoint}`);
  await chmod(entrypoint, 0o755);
  const marker = {
    repository: pin.repository,
    revision: pin.revision,
    packageJson: await fileDigest(packageFile),
    packageLock: await fileDigest(lockFile),
    installedDependencies: await fileDigest(installedLock),
    entrypoint: await fileDigest(entrypoint),
  };
  await writeFile(join(staging, markerName), `${JSON.stringify(marker, null, 2)}\n`, { mode: 0o600 });
  await rm(join(staging, '.git'), { recursive: true, force: true });
  await replaceInstall(staging, destination, existing);
  console.log(`Installed terrbear/codex-acp@${pin.revision}`);
  console.log(`Set the Codex provider command to ${join(destination, 'dist/index.js')}`);
} finally {
  await rm(staging, { recursive: true, force: true });
}
