import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';

let root: string;
let scripts: string;
let bin: string;
let install: string;
let events: string;
let pinFile: string;
const revision = '0bf05f7c8d2e02a700f57f023dce2c074d079f8e';
const nextRevision = '1111111111111111111111111111111111111111';
const markerName = '.codex-acp-install.json';
const installer = new URL('./install-codex-acp.mjs', import.meta.url);
const pinSource = new URL('./codex-acp.json', import.meta.url);

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ahpd install codex '));
  scripts = join(root, 'scripts');
  bin = join(root, 'bin');
  install = join(root, 'AHPD home', 'codex adapter');
  events = join(root, 'events');
  mkdirSync(scripts, { recursive: true });
  mkdirSync(bin, { recursive: true });
  copyFileSync(installer, join(scripts, 'install-codex-acp.mjs'));
  copyFileSync(pinSource, join(scripts, 'codex-acp.json'));
  pinFile = join(scripts, 'codex-acp.json');
  writeFileSync(join(bin, 'git'), `#!/usr/bin/env node
const fs = require('node:fs');
fs.appendFileSync(process.env.TEST_EVENTS, 'git ' + process.argv.slice(2).join(' ') + '\\n');
const op = process.argv[2];
if (op === 'init') fs.mkdirSync('.git', { recursive: true });
if (op === 'fetch') fs.writeFileSync('.git/FETCH_HEAD', process.argv.at(-1));
if (op === 'checkout') fs.writeFileSync('.git/HEAD', fs.readFileSync('.git/FETCH_HEAD', 'utf8'));
if (op === 'rev-parse') console.log(fs.readFileSync('.git/HEAD', 'utf8'));
`);
  writeFileSync(join(bin, 'npm'), `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
fs.appendFileSync(process.env.TEST_EVENTS, 'npm ' + process.argv.slice(2).join(' ') + '\\n');
if (process.env.TEST_BUILD_ERROR === '1' && process.argv[2] === 'run') { console.error('synthetic npm build failure'); process.exit(1); }
if (process.argv[2] === 'ci') {
  const dependency = '@openai/codex';
  const version = '0.160.1';
  fs.writeFileSync('package.json', JSON.stringify({ name: '@agentclientprotocol/codex-acp', dependencies: { [dependency]: '^' + version }, bin: { 'codex-acp': 'dist/index.js' } }));
  fs.writeFileSync('package-lock.json', JSON.stringify({
    name: '@agentclientprotocol/codex-acp',
    lockfileVersion: 3,
    packages: { '': { name: '@agentclientprotocol/codex-acp', dependencies: { [dependency]: '^' + version } }, 'node_modules/@openai/codex': { version } },
  }));
  fs.mkdirSync('node_modules/@openai/codex/bin', { recursive: true });
  fs.mkdirSync('node_modules/.bin', { recursive: true });
  fs.writeFileSync('node_modules/@openai/codex/package.json', JSON.stringify({ name: '@openai/codex', version, bin: { codex: 'bin/codex.js' } }));
  fs.writeFileSync('node_modules/@openai/codex/native-runtime', 'ready');
  fs.writeFileSync('node_modules/@openai/codex/bin/codex.js', '#!/usr/bin/env node\\nconst fs = require("node:fs");\\nconst path = require("node:path");\\nif (!fs.existsSync(path.join(__dirname, "..", "native-runtime"))) { console.error("missing native runtime"); process.exit(1); }\\nconsole.log("codex-cli 0.160.1");\\n');
  fs.chmodSync('node_modules/@openai/codex/bin/codex.js', 0o755);
  fs.symlinkSync('../@openai/codex/bin/codex.js', 'node_modules/.bin/codex');
  fs.writeFileSync('node_modules/.package-lock.json', JSON.stringify({ lockfileVersion: 3, packages: { '': {} } }));
}
if (process.argv[2] === 'run') {
  if (process.env.TEST_CREATE_DESTINATION === '1') {
    fs.mkdirSync(process.env.TEST_INSTALL_DEST);
    fs.writeFileSync(path.join(process.env.TEST_INSTALL_DEST, 'keep.txt'), 'concurrent data');
  }
  fs.mkdirSync('dist', { recursive: true });
  fs.writeFileSync(path.join('dist', 'index.js'), 'adapter ' + process.env.FAKE_BUILD_REVISION + '\\n');
}
`);
  chmodSync(join(bin, 'git'), 0o755);
  chmodSync(join(bin, 'npm'), 0o755);
  events = join(root, 'events');
});

afterEach(() => { rmSync(root, { recursive: true, force: true }); });

function run(extra: Record<string, string> = {}) {
  return spawnSync(process.execPath, [join(scripts, 'install-codex-acp.mjs'), install], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`,
      TEST_EVENTS: events,
      TEST_INSTALL_DEST: install,
      FAKE_BUILD_REVISION: JSON.parse(readFileSync(pinFile, 'utf8')).revision,
      ...extra,
    },
  });
}

function pinTo(value: string) {
  writeFileSync(pinFile, JSON.stringify({ repository: 'https://github.com/terrbear/codex-acp.git', revision: value }, null, 2));
}

function installedRevision() {
  return JSON.parse(readFileSync(join(install, markerName), 'utf8')).revision;
}

it('installs the pinned build, reuses a verified match, and replaces it on pin transition', () => {
  const first = run();
  expect(first.status).toBe(0);
  expect(first.stdout).toContain(`Installed terrbear/codex-acp@${revision}`);
  expect(readFileSync(join(install, 'dist/index.js'), 'utf8')).toContain(`adapter ${revision}`);
  expect(installedRevision()).toBe(revision);
  const beforeReuse = readFileSync(events, 'utf8');

  const reused = run();
  expect(reused.status).toBe(0);
  expect(reused.stdout).toContain(`Reusing terrbear/codex-acp@${revision}`);
  expect(readFileSync(events, 'utf8')).toBe(beforeReuse);

  pinTo(nextRevision);
  const upgraded = run();
  expect(upgraded.status).toBe(0);
  expect(upgraded.stdout).toContain(`Installed terrbear/codex-acp@${nextRevision}`);
  expect(installedRevision()).toBe(nextRevision);
  expect(readFileSync(join(install, 'dist/index.js'), 'utf8')).toContain(`adapter ${nextRevision}`);
  expect(readdirSync(join(root, 'AHPD home'))).toEqual(['codex adapter']);
});

it('rebuilds a marked install when its bundled Codex CLI entrypoint or native runtime is missing', () => {
  expect(run().status).toBe(0);
  const nativeRuntime = join(install, 'node_modules/@openai/codex/native-runtime');
  rmSync(nativeRuntime);

  const missingRuntime = run();
  expect(missingRuntime.status).toBe(0);
  expect(missingRuntime.stdout).toContain(`Installed terrbear/codex-acp@${revision}`);
  expect(readFileSync(nativeRuntime, 'utf8')).toBe('ready');

  const cliEntrypoint = join(install, 'node_modules/@openai/codex/bin/codex.js');
  rmSync(cliEntrypoint);
  const missingCli = run();
  expect(missingCli.status).toBe(0);
  expect(missingCli.stdout).toContain(`Installed terrbear/codex-acp@${revision}`);
  expect(readFileSync(cliEntrypoint, 'utf8')).toContain('codex-cli 0.160.1');
});

it('refuses a destination that appears while the pinned build is being staged', () => {
  const raced = run({ TEST_CREATE_DESTINATION: '1' });
  expect(raced.status).not.toBe(0);
  expect(raced.stderr).toContain('appeared during build and was left untouched');
  expect(readFileSync(join(install, 'keep.txt'), 'utf8')).toBe('concurrent data');
  expect(readdirSync(install)).toEqual(['keep.txt']);
});

it('repairs an incomplete managed install but refuses to overwrite an unmarked directory', () => {
  expect(run().status).toBe(0);
  writeFileSync(join(install, 'dist/index.js'), 'incomplete');
  const repaired = run();
  expect(repaired.status).toBe(0);
  expect(readFileSync(join(install, 'dist/index.js'), 'utf8')).toContain(`adapter ${revision}`);

  const unknown = join(root, 'unknown adapter');
  mkdirSync(unknown, { recursive: true });
  writeFileSync(join(unknown, 'keep.txt'), 'user data');
  const refused = spawnSync(process.execPath, [join(scripts, 'install-codex-acp.mjs'), unknown], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`, TEST_EVENTS: events },
  });
  expect(refused.status).not.toBe(0);
  expect(refused.stderr).toContain('not a verified terrbear/codex-acp installation');
  expect(readFileSync(join(unknown, 'keep.txt'), 'utf8')).toBe('user data');
});

it('preserves the previous pinned build and exposes the underlying build error when replacement fails', () => {
  expect(run().status).toBe(0);
  const oldMarker = readFileSync(join(install, markerName));
  const oldEntrypoint = readFileSync(join(install, 'dist/index.js'));
  pinTo(nextRevision);

  const failed = run({ TEST_BUILD_ERROR: '1' });
  expect(failed.status).not.toBe(0);
  expect(failed.stderr).toContain('synthetic npm build failure');
  expect(failed.stderr).toContain('npm failed (1)');
  expect(readFileSync(join(install, markerName)).equals(oldMarker)).toBe(true);
  expect(readFileSync(join(install, 'dist/index.js')).equals(oldEntrypoint)).toBe(true);
  expect(installedRevision()).toBe(revision);
});
