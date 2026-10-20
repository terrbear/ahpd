import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { loadConfig } from '../packages/server/src/config.js';

let root: string;
let home: string;
let source: string;
let adapter: string;
let config: string;
let service: string;
const script = new URL('./configure-codex-acp.mjs', import.meta.url);
const revision = '0bf05f7c8d2e02a700f57f023dce2c074d079f8e';

beforeEach(() => {
  root = mkdtempSync(join(process.cwd(), '.ahpd-config-test-'));
  home = join(root, 'AHPD $HOME 50% \\ backslash');
  source = join(root, 'ahpd source "$SOURCE" ${literal} & tools \\\\%');
  adapter = join(home, 'codex-acp', revision, 'dist', 'index.js');
  config = join(home, 'config.json');
  service = join(home, '.config', 'systemd', 'user', 'anton-ahpd.service');
  mkdirSync(dirname(adapter), { recursive: true });
  mkdirSync(join(home, 'work'), { recursive: true });
  mkdirSync(join(source, 'packages/server/dist'), { recursive: true });
  writeFileSync(join(source, 'packages/server/dist/main.js'), 'process.exit(0);');
  writeFileSync(adapter, 'pinned adapter');
  chmodSync(adapter, 0o755);
});

afterEach(() => { rmSync(root, { recursive: true, force: true }); });

function run(options: { kind?: string; serviceFile?: string; port?: string; claude?: string; codex?: string; path?: string; node?: string; adapter?: string } = {}) {
  const node = options.node ?? process.execPath;
  const args = [
    script.pathname,
    home,
    source,
    options.adapter ?? adapter,
    node,
    options.kind ?? 'linux',
    options.serviceFile ?? service,
    options.port ?? '9187',
    options.claude ?? join(dirname(node), 'claude'),
    options.codex ?? '',
  ];
  return spawnSync(node, args, { encoding: 'utf8', env: { ...process.env, PATH: options.path ?? process.env.PATH } });
}

function readConfig() {
  return JSON.parse(readFileSync(config, 'utf8'));
}

it('generates a fresh Codex configuration and a systemd-parsed service with literal paths and arguments', () => {
  const providerDirectory = join(home, 'provider "$PROVIDER" 50% \\ path');
  mkdirSync(providerDirectory);
  const providerCommand = join(providerDirectory, 'claude');
  const result = run({ path: '/tmp/session-shell-only', claude: providerCommand });
  expect(result.status).toBe(0);
  expect(readConfig()).toEqual({
    port: 9187,
    host: '127.0.0.1',
    paths: [join(home, 'work')],
    connectionTokenFile: join(home, 'token'),
    updateCheck: false,
    plugins: [
      join(source, 'packages/agent-claude'),
      { name: join(source, 'packages/agent-acp'), options: { provider: 'codex', displayName: 'Codex', command: adapter } },
    ],
  });
  expect(loadConfig(config).values.paths).toEqual([join(home, 'work')]);
  const unit = readFileSync(service, 'utf8');
  expect(unit).not.toContain('\\s');
  expect(unit).toContain('StandardOutput=append:');
  expect(unit).toContain('StandardError=append:');
  expect(unit).toContain('$$SOURCE');
  expect(unit).toContain('$${literal}');
  expect(unit).not.toContain('$$$$');
  expect(unit).not.toContain('/tmp/session-shell-only');
  expect(statSync(config).mode & 0o777).toBe(0o600);
  const verified = spawnSync('systemd-analyze', ['verify', service], {
    encoding: 'utf8',
    env: { ...process.env, SYSTEMD_LOG_LEVEL: 'debug' },
  });
  const diagnostics = `${verified.stdout}\n${verified.stderr}`.split('\n').filter((line) =>
    line.includes(basename(service)) || /WorkingDirectory:|Environment:|StandardOutput:|StandardError:|StandardOutputFileToAppend|Command Line:|PATH=/.test(line),
  ).join('\n');
  expect(verified.error, diagnostics).toBeUndefined();
  expect(verified.status, `${diagnostics}\n${unit}`).toBe(0);
  expect(diagnostics).not.toContain('Failed to parse output specifier, ignoring:');
  expect(diagnostics).not.toContain(`${basename(service)}: Failed to load configuration`);
  expect(diagnostics).toContain(`WorkingDirectory: ${join(home, 'work').replace(/\\/g, '\\\\')}`);
  expect(diagnostics).toContain(`StandardOutputFileToAppend: ${join(home, 'ahpd.log').replace(/\\/g, '\\\\')}`);
  expect(diagnostics).toContain(`Environment: PATH=${dirname(process.execPath)}:${providerDirectory}:`);
  const parsedCommand = diagnostics.split('\n').find((line) => line.includes('Command Line:'));
  expect(parsedCommand).toBeDefined();
  expect(parsedCommand).toContain(`Command Line: ${process.execPath.replace(/\\/g, '\\\\')}`);
  expect(parsedCommand).toContain('\\$\\$SOURCE');
  expect(parsedCommand).toContain('\\$\\${literal}');
  expect(parsedCommand).not.toContain('\\$\\$\\$\\$SOURCE');
});

it('migrates only the managed npm adapter and preserves customized configuration on rerun', () => {
  const oldCommand = join(home, 'node_modules/.bin/codex-acp');
  const managedName = join(source, 'packages/agent-acp');
  const custom = { name: '/opt/custom-acp', options: { provider: 'codex', displayName: 'Custom Codex', command: '/opt/custom-acp/codex-acp', env: { KEEP: 'yes' } } };
  const managed = { name: managedName, enabled: false, options: { provider: 'codex', displayName: 'Codex', command: oldCommand, args: ['--custom'], extra: true } };
  writeFileSync(config, JSON.stringify({
    port: 9199,
    paths: ['/srv/one', '/srv/two'],
    connectionTokenFile: '/secure/existing-token',
    updateCheck: true,
    customKey: { preserve: true },
    plugins: [custom, managed, { name: 'other', options: { key: 'keep' } }],
  }, null, 2));

  const first = run();
  expect(first.status).toBe(0);
  const after = readConfig();
  expect(after.port).toBe(9199);
  expect(after.paths).toEqual(['/srv/one', '/srv/two']);
  expect(loadConfig(config).values.paths).toEqual(['/srv/one', '/srv/two']);
  expect(after.connectionTokenFile).toBe('/secure/existing-token');
  expect(after.updateCheck).toBe(true);
  expect(after.customKey).toEqual({ preserve: true });
  expect(after.plugins).toEqual([
    custom,
    { ...managed, options: { ...managed.options, command: adapter } },
    { name: 'other', options: { key: 'keep' } },
    join(source, 'packages/agent-claude'),
  ]);
  const configBytes = readFileSync(config);
  const serviceBytes = readFileSync(service);
  const again = run();
  expect(again.status).toBe(0);
  expect(readFileSync(config).equals(configBytes)).toBe(true);
  expect(readFileSync(service).equals(serviceBytes)).toBe(true);
});

it('migrates a supported markerless legacy pinned install and leaves its files intact', () => {
  const previousRevision = '1111111111111111111111111111111111111111';
  const legacyInstall = join(home, 'codex-acp', previousRevision);
  const oldAdapter = join(legacyInstall, 'dist', 'index.js');
  mkdirSync(dirname(oldAdapter), { recursive: true });
  writeFileSync(oldAdapter, 'legacy pinned adapter');
  chmodSync(oldAdapter, 0o755);
  writeFileSync(join(legacyInstall, 'package.json'), JSON.stringify({
    name: '@agentclientprotocol/codex-acp',
    bin: { 'codex-acp': 'dist/index.js' },
  }));
  const managed = { name: join(source, 'packages/agent-acp'), options: { provider: 'codex', displayName: 'Codex', command: oldAdapter } };
  writeFileSync(config, JSON.stringify({ plugins: [managed] }));

  const result = run();
  expect(result.status).toBe(0);
  expect(readConfig().plugins[0].options.command).toBe(adapter);
  expect(readFileSync(oldAdapter, 'utf8')).toBe('legacy pinned adapter');
});

it('does not migrate an unrelated markerless directory in the adapter tree', () => {
  const revision = '2222222222222222222222222222222222222222';
  const customInstall = join(home, 'codex-acp', revision);
  const customAdapter = join(customInstall, 'dist', 'index.js');
  mkdirSync(dirname(customAdapter), { recursive: true });
  writeFileSync(customAdapter, 'custom adapter');
  chmodSync(customAdapter, 0o755);
  writeFileSync(join(customInstall, 'package.json'), JSON.stringify({ name: 'unrelated-package', bin: { 'codex-acp': 'dist/index.js' } }));
  const custom = { name: join(source, 'packages/agent-acp'), options: { provider: 'codex', displayName: 'Codex', command: customAdapter } };
  writeFileSync(config, JSON.stringify({ plugins: [custom] }));

  const result = run();
  expect(result.status).toBe(0);
  expect(readConfig().plugins).toEqual([custom, join(source, 'packages/agent-claude')]);
  expect(readFileSync(customAdapter, 'utf8')).toBe('custom adapter');
});

it('migrates a marked previous pinned install to the current pinned adapter', () => {
  const previousRevision = '1111111111111111111111111111111111111111';
  const oldAdapter = join(home, 'codex-acp', previousRevision, 'dist', 'index.js');
  mkdirSync(dirname(oldAdapter), { recursive: true });
  writeFileSync(oldAdapter, 'old pinned adapter');
  writeFileSync(join(home, 'codex-acp', previousRevision, '.codex-acp-install.json'), JSON.stringify({
    repository: 'https://github.com/terrbear/codex-acp.git',
    revision: previousRevision,
  }));
  const managed = { name: join(source, 'packages/agent-acp'), options: { provider: 'codex', displayName: 'Codex', command: oldAdapter } };
  writeFileSync(config, JSON.stringify({ paths: ['/kept'], plugins: [managed] }));

  const result = run();
  expect(result.status).toBe(0);
  expect(readConfig().paths).toEqual(['/kept']);
  expect(readConfig().plugins[0].options.command).toBe(adapter);
});

it('accepts symlinked package-manager Node and adapter executables', () => {
  const nodeLink = join(root, 'package-manager-node');
  const adapterLink = join(root, 'package-manager-codex-acp');
  symlinkSync(process.execPath, nodeLink);
  symlinkSync(adapter, adapterLink);
  const result = run({ node: nodeLink, adapter: adapterLink });
  expect(result.status).toBe(0);
  expect(readFileSync(service, 'utf8')).toContain(nodeLink);
  expect(readConfig().plugins[1].options.command).toBe(adapterLink);
});

it('preserves a custom Codex adapter rather than adding or replacing a managed provider', () => {
  const custom = { name: '/opt/codex-acp', options: { provider: 'codex', displayName: 'Codex', command: '/opt/codex-acp/bin/codex-acp', args: ['--custom'] } };
  writeFileSync(config, JSON.stringify({ plugins: [custom] }));
  const result = run();
  expect(result.status).toBe(0);
  expect(readConfig().plugins).toEqual([custom, join(source, 'packages/agent-claude')]);
  expect(result.stdout).toContain('Existing custom Codex ACP configuration was preserved');
});

it('does not change config or service when the adapter is incomplete or a service destination cannot be staged', () => {
  writeFileSync(config, JSON.stringify({ port: 9199, plugins: ['kept'] }));
  const before = readFileSync(config);
  const blocked = join(root, 'not-a-directory');
  writeFileSync(blocked, 'preserve');
  const result = run({ serviceFile: join(blocked, 'anton-ahpd.service') });
  expect(result.status).not.toBe(0);
  expect(readFileSync(config).equals(before)).toBe(true);

  const missing = join(root, 'missing', 'adapter.js');
  const failed = spawnSync(process.execPath, [script.pathname, home, source, missing, process.execPath, 'linux', service, '9187', '', ''], { encoding: 'utf8' });
  expect(failed.status).not.toBe(0);
  expect(readFileSync(config).equals(before)).toBe(true);
  expect(() => readFileSync(service)).toThrow();
});

it('writes a valid escaped launchd plist and rejects transient provider locations', () => {
  const plist = join(home, 'Library', 'LaunchAgents', 'io.trustgrid.anton.ahpd.plist');
  const result = run({ kind: 'mac', serviceFile: plist, claude: '' });
  expect(result.status).toBe(0);
  const text = readFileSync(plist, 'utf8');
  expect(text).toContain('&amp;');
  expect(text).toContain('&quot;');
  expect(text).toContain('%');
  const parsedPlist = spawnSync('python3', ['-c', 'import plistlib,sys; plistlib.load(open(sys.argv[1], "rb"))', plist], { encoding: 'utf8' });
  expect(parsedPlist.error, parsedPlist.stderr).toBeUndefined();
  expect(parsedPlist.status, parsedPlist.stderr).toBe(0);
  const before = readFileSync(config);
  const rejected = run({ claude: '/tmp/one-shot/claude' });
  expect(rejected.status).not.toBe(0);
  expect(rejected.stderr).toContain('transient directory');
  expect(readFileSync(config).equals(before)).toBe(true);
});
