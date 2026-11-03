import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';

const skill = readFileSync(new URL('../anton-bundle/skills/ahpd-setup/SKILL.md', import.meta.url), 'utf8');
const setupScript = skill.match(/```bash\r?\n([\s\S]*?)\r?\n```/)?.[1];
if (!setupScript) throw new Error('ahpd setup skill has no bash installer block');

const revision = '0bf05f7c8d2e02a700f57f023dce2c074d079f8e';
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

async function listen(host: string) {
  const child = spawn(process.execPath, ['-e', 'const net=require("node:net");const s=net.createServer();s.listen(0,process.argv[1],()=>console.log(s.address().port));', host], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  const port = await new Promise<number>((resolvePort, reject) => {
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      output += chunk;
      const value = Number(output.trim().split('\n')[0]);
      if (Number.isInteger(value) && value > 0) resolvePort(value);
    });
    child.once('error', reject);
    child.once('exit', (code) => reject(new Error(`test listener exited (${code}): ${output}`)));
  });
  return { child, port };
}

function executable(path: string, contents: string) {
  writeFileSync(path, contents);
  chmodSync(path, 0o755);
}

it.each([
  { bindHost: '127.0.0.2', connectHost: '127.0.0.2', addressHost: '127.0.0.2' },
  { bindHost: '::1', connectHost: '::1', addressHost: '[::1]' },
  { bindHost: '127.0.0.1', connectHost: '127.0.0.1', addressHost: '127.0.0.1', configuredHost: '0.0.0.0' },
])('runs the extracted setup shell with preserved host $configuredHost and relative token path', async ({ bindHost, connectHost, addressHost, configuredHost }) => {
  const root = mkdtempSync(join(process.cwd(), '.ahpd-shell-test-'));
  roots.push(root);
  const home = join(root, 'home with spaces');
  const source = join(home, '.a3', 'ahpd-src');
  const bin = join(root, 'bin');
  const ahpdHome = join(home, '.a3', 'ahpd');
  const configPath = join(ahpdHome, 'config.json');
  const relativeToken = 'auth/session token';
  const tokenPath = resolve(ahpdHome, relativeToken);
  mkdirSync(join(source, '.git'), { recursive: true });
  mkdirSync(join(source, 'scripts'), { recursive: true });
  mkdirSync(join(source, 'packages/server/dist'), { recursive: true });
  mkdirSync(join(source, 'packages/agent-claude'), { recursive: true });
  mkdirSync(join(source, 'packages/agent-acp'), { recursive: true });
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(source, 'scripts/codex-acp.json'), JSON.stringify({ repository: 'https://github.com/terrbear/codex-acp.git', revision }));
  copyFileSync(new URL('./configure-codex-acp.mjs', import.meta.url), join(source, 'scripts/configure-codex-acp.mjs'));
  writeFileSync(join(source, 'packages/server/dist/main.js'), 'process.exit(0);');

  executable(join(bin, 'git'), '#!/bin/sh\ncase "$3:$4" in\n  remote:get-url) echo https://github.com/terrbear/ahpd.git ;;\n  branch:--show-current) echo main ;;\n  status:--porcelain) ;;\nesac\nexit 0\n');
  executable(join(bin, 'pnpm'), '#!/bin/sh\nexit 0\n');
  executable(join(bin, 'claude'), '#!/bin/sh\nexit 0\n');
  executable(join(bin, 'systemctl'), '#!/bin/sh\nexit 0\n');
  executable(join(bin, 'systemd-analyze'), '#!/bin/sh\nexit 0\n');
  executable(join(bin, 'seq'), '#!/bin/sh\necho 1\n');
  executable(join(bin, 'sleep'), '#!/bin/sh\nexit 0\n');
  executable(join(bin, 'node'), `#!/bin/sh\ncase "$1" in\n  */scripts/install-codex-acp.mjs)\n    destination="$2"\n    mkdir -p "$destination/dist" "$destination/node_modules/.bin"\n    printf '#!/bin/sh\\nexit 0\\n' > "$destination/dist/index.js"\n    chmod 755 "$destination/dist/index.js"\n    ln -s ../../dist/index.js "$destination/node_modules/.bin/codex"\n    ;;\n  *) exec "${process.execPath}" "$@" ;;\nesac\n`);

  const listener = await listen(bindHost);
  try {
    mkdirSync(dirname(tokenPath), { recursive: true });
    writeFileSync(tokenPath, 'synthetic-token-not-a-credential');
    writeFileSync(configPath, JSON.stringify({
      port: listener.port,
      host: configuredHost ?? bindHost,
      paths: ['/srv/only-this-workspace'],
      connectionTokenFile: relativeToken,
      plugins: [{ name: '/custom/adapter', options: { provider: 'codex', command: '/custom/adapter' } }],
    }));
    const env = { ...process.env, HOME: home, REAL_NODE: process.execPath, PATH: `${bin}:${process.env.PATH}` };
    delete env.AHPD_CHANNEL;
    const result = spawnSync('bash', ['-c', setupScript], {
      cwd: process.cwd(),
      encoding: 'utf8',
      timeout: 30_000,
      env,
    });
    expect(result.error, result.stderr).toBeUndefined();
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain(`ADDRESS=ws://${addressHost}:${listener.port}`);
    expect(result.stdout).toContain(`AHPD_HOME=${ahpdHome}`);
    expect(result.stdout).toContain(`TOKEN_FILE=${tokenPath}`);
    expect(result.stdout).not.toContain('synthetic-token-not-a-credential');
    expect(JSON.parse(readFileSync(configPath, 'utf8'))).toMatchObject({
      host: configuredHost ?? bindHost,
      connectionTokenFile: relativeToken,
      paths: ['/srv/only-this-workspace'],
    });
  } finally {
    listener.child.kill('SIGTERM');
  }
});

/** The files the installer needs after a clone, or in a checkout that already exists. */
function seedCheckout(dir: string) {
  mkdirSync(join(dir, 'scripts'), { recursive: true });
  mkdirSync(join(dir, 'packages/server/dist'), { recursive: true });
  mkdirSync(join(dir, 'packages/agent-claude'), { recursive: true });
  mkdirSync(join(dir, 'packages/agent-acp'), { recursive: true });
  mkdirSync(join(dir, '.git'), { recursive: true });
  writeFileSync(join(dir, 'scripts/codex-acp.json'), JSON.stringify({ repository: 'https://github.com/terrbear/codex-acp.git', revision }));
  copyFileSync(new URL('./configure-codex-acp.mjs', import.meta.url), join(dir, 'scripts/configure-codex-acp.mjs'));
  writeFileSync(join(dir, 'packages/server/dist/main.js'), 'process.exit(0);');
}

async function runInstaller(options: { branch?: string; channel?: string; existing?: boolean; healthy?: boolean }) {
  const root = mkdtempSync(join(process.cwd(), '.ahpd-shell-test-'));
  roots.push(root);
  const home = join(root, 'home');
  const bin = join(root, 'bin');
  const gitLog = join(root, 'git.log');
  const template = join(root, 'template');
  mkdirSync(bin, { recursive: true });
  seedCheckout(template);
  if (options.existing) seedCheckout(join(home, '.a3', 'ahpd-src'));
  executable(join(bin, 'git'), `#!/bin/sh
printf '%s\\n' "$*" >> "$GIT_LOG"
if [ "$1" = clone ]; then
  mkdir -p "$5"
  cp -a "$GIT_TEMPLATE/." "$5/"
  exit 0
fi
case "$3:$4" in
  remote:get-url) echo https://github.com/terrbear/ahpd.git ;;
  branch:--show-current) printf '%s\\n' "$GIT_BRANCH" ;;
  status:--porcelain) ;;
esac
exit 0
`);
  executable(join(bin, 'pnpm'), '#!/bin/sh\nexit 0\n');
  executable(join(bin, 'claude'), '#!/bin/sh\nexit 0\n');
  executable(join(bin, 'systemctl'), '#!/bin/sh\nexit 0\n');
  executable(join(bin, 'systemd-analyze'), '#!/bin/sh\nexit 0\n');
  executable(join(bin, 'seq'), '#!/bin/sh\necho 1\n');
  executable(join(bin, 'sleep'), '#!/bin/sh\nexit 0\n');
  executable(join(bin, 'node'), `#!/bin/sh
case "$1" in
  */scripts/install-codex-acp.mjs)
    destination="$2"
    mkdir -p "$destination/dist" "$destination/node_modules/.bin"
    printf '#!/bin/sh\\nexit 0\\n' > "$destination/dist/index.js"
    chmod 755 "$destination/dist/index.js"
    ln -s ../../dist/index.js "$destination/node_modules/.bin/codex"
    ;;
  *) exec "${process.execPath}" "$@" ;;
esac
`);
  const listener = options.healthy === false ? undefined : await listen('127.0.0.1');
  if (listener) {
    const ahpdHome = join(home, '.a3', 'ahpd');
    mkdirSync(ahpdHome, { recursive: true });
    writeFileSync(join(ahpdHome, 'token'), 'synthetic-token-not-a-credential');
    writeFileSync(join(ahpdHome, 'config.json'), JSON.stringify({
      port: listener.port, host: '127.0.0.1', paths: ['/srv/only-this-workspace'], connectionTokenFile: 'token',
    }));
  }
  const env = {
    ...process.env,
    HOME: home,
    PATH: `${bin}:${process.env.PATH}`,
    GIT_LOG: gitLog,
    GIT_BRANCH: options.branch ?? 'main',
    GIT_TEMPLATE: template,
  };
  if (options.channel === undefined) delete env.AHPD_CHANNEL;
  else env.AHPD_CHANNEL = options.channel;
  try {
    const result = spawnSync('bash', ['-c', setupScript!], {
      cwd: process.cwd(), encoding: 'utf8', timeout: 30_000, env,
    });
    return { result, log: existsSync(gitLog) ? readFileSync(gitLog, 'utf8') : '' };
  } finally {
    listener?.child.kill('SIGTERM');
  }
}

it('rejects an unknown channel before touching the checkout', async () => {
  const { result, log } = await runInstaller({ channel: 'beta', healthy: false });
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(1);
  expect(result.stdout).toContain('AHPD_CHANNEL must be main or develop');
  expect(log).toBe('');
});

it('refuses to switch an existing checkout via AHPD_CHANNEL', async () => {
  const { result } = await runInstaller({ existing: true, branch: 'main', channel: 'develop', healthy: false });
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(1);
  expect(result.stdout).toContain('is on main');
  expect(result.stdout).toContain('does not switch an existing checkout');
  expect(result.stdout).toContain('check out develop');
});

it('refuses a checkout that is neither main nor develop', async () => {
  const { result } = await runInstaller({ existing: true, branch: 'feature', healthy: false });
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(1);
  expect(result.stdout).toContain('is not on main or develop');
});

it('fast-forwards an existing develop checkout and leaves main alone', async () => {
  const { result, log } = await runInstaller({ existing: true, branch: 'develop' });
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  expect(log).toContain('fetch origin develop');
  expect(log).toContain('merge --ff-only origin/develop');
  expect(log).not.toContain('origin/main');
  expect(log).not.toContain('origin main');
});

it('clones develop only when asked, and otherwise clones main explicitly', async () => {
  const develop = await runInstaller({ channel: 'develop' });
  expect(develop.result.status, `${develop.result.stdout}\n${develop.result.stderr}`).toBe(0);
  expect(develop.log).toContain('clone --branch develop https://github.com/terrbear/ahpd.git');
  const main = await runInstaller({});
  expect(main.result.status, `${main.result.stdout}\n${main.result.stderr}`).toBe(0);
  expect(main.log).toContain('clone --branch main https://github.com/terrbear/ahpd.git');
});
