import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);
export const repository = 'https://github.com/terrbear/ahpd.git';
export const releaseTag = 'anton-ahpd';
/** Moved by CI only after a successful push to `develop`. Main never fetches it. */
export const developReleaseTag = 'anton-ahpd-develop';
export const sha = /^[a-f0-9]{40}$/;

/**
 * The tag an install updates from.
 *
 * Both channels use a tag CI moves after a green push, not the branch tip.
 * `develop` fetches `anton-ahpd-develop`. `main` and every other answer,
 * including a detached release checkout, a missing source and an unknown
 * branch, fetch `anton-ahpd`, which moves only after a successful push to
 * `main`. An install that never checked out `develop` therefore keeps seeing
 * a commit only once it has been promoted.
 */
export function tracked(branch) {
  const tag = branch === 'develop' ? developReleaseTag : releaseTag;
  return {
    channel: branch === 'develop' ? 'develop' : 'main',
    spec: `refs/tags/${tag}:refs/tags/${tag}`,
    rev: `refs/tags/${tag}^{commit}`,
  };
}

/** The branch checked out at `source`, or `''` when git cannot say. A detached checkout is `''`. */
export async function branchOf(source, run = command, signal) {
  try {
    return String(await run('git', ['branch', '--show-current'], source, signal) ?? '').trim();
  } catch {
    return '';
  }
}

export async function json(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}

export async function save(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
}

export async function command(file, args, cwd, signal, timeout = 120_000) {
  const result = await execute(file, args, { cwd, signal, timeout, maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', CI: '1' } });
  return result.stdout.trim();
}

export async function prepare(home, current, signal, source = current, run = command) {
  const releases = join(home, 'managed-releases');
  const mirror = join(home, 'managed-source.git');
  await mkdir(releases, { recursive: true });
  if (!await stat(mirror).catch(() => undefined)) await run('git', ['init', '--bare', mirror], home, signal);
  const channel = tracked(await branchOf(source, run, signal));
  await run('git', ['fetch', '--force', '--depth=1', repository, channel.spec], mirror, signal);
  const revision = await run('git', ['rev-parse', channel.rev], mirror, signal);
  if (!sha.test(revision)) throw new Error('Invalid managed release revision');
  const running = await run('git', ['rev-parse', 'HEAD'], current, signal);
  if (running === revision) return undefined;
  const failed = await json(join(home, 'managed-update-state.json'), {});
  if (failed.failed === revision) return undefined;
  process.stderr.write(`${new Date().toISOString()} managed update: ${channel.channel} is ${revision}, this release is ${running}\n`);
  const destination = join(releases, revision);
  const marker = await json(join(destination, '.managed-build.json'), undefined);
  if (marker?.revision === revision) return destination;
  const staging = join(releases, `.build-${revision}-${randomUUID()}`);
  try {
    await run('git', ['clone', '--no-checkout', mirror, staging], home, signal);
    await run('git', ['checkout', '--detach', revision], staging, signal);
    const manifest = await json(join(staging, 'package.json'));
    if (!/^pnpm@\d+\.\d+\.\d+$/.test(manifest.packageManager ?? '')) throw new Error('An exact pnpm version is required');
    const pnpm = (args) => run('npm', ['exec', '--yes', '--package', manifest.packageManager, '--', 'pnpm', ...args], staging, signal, 900_000);
    await pnpm(['install', '--frozen-lockfile']);
    await pnpm(['run', 'boundary']);
    await pnpm(['run', 'build']);
    await run(process.execPath, ['packages/server/dist/main.js', '--version'], staging, signal);
    await save(join(staging, '.managed-build.json'), { revision });
    await rename(staging, destination);
    return destination;
  } finally { await rm(staging, { recursive: true, force: true }); }
}

export async function prune(home, keep) {
  const root = join(home, 'managed-releases');
  for (const name of await readdir(root).catch(() => [])) {
    const path = join(root, name);
    if (!sha.test(name) || keep.includes(path)) continue;
    const marker = await json(join(path, '.managed-build.json'), undefined);
    if (marker?.revision === name) await rm(path, { recursive: true, force: true });
  }
}
