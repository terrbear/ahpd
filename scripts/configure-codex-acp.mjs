import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';

if (process.argv.length !== 11) {
  throw new Error('Usage: node scripts/configure-codex-acp.mjs <home> <source> <adapter-command> <node> <linux|mac> <service-file> <port> <claude-command> <codex-command>');
}

const [homeArg, sourceArg, adapterArg, nodeArg, serviceKind, serviceFileArg, portArg, claudeArg, codexArg] = process.argv.slice(2);
const home = resolve(homeArg);
const source = resolve(sourceArg);
const adapter = resolve(adapterArg);
const node = resolve(nodeArg);
const serviceFile = resolve(serviceFileArg);
const configFile = join(home, 'config.json');
const work = join(home, 'work');
const server = join(source, 'packages/server/dist/main.js');
const token = join(home, 'token');
const port = Number(portArg);
const markerName = '.codex-acp-install.json';

function requirePath(value, name) {
  if (!value.startsWith('/') || /[\0\r\n]/.test(value)) throw new Error(`${name} must be an absolute path without control characters`);
}

for (const [value, name] of [[home, 'home'], [source, 'source'], [adapter, 'adapter command'], [node, 'Node'], [serviceFile, 'service file']]) {
  requirePath(value, name);
}
if (!['linux', 'mac'].includes(serviceKind)) throw new Error('Service kind must be linux or mac');
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Default port must be an integer between 1 and 65535');
if (!await regularFile(adapter)) throw new Error(`Pinned Codex ACP command is missing: ${adapter}`);
if (!await regularFile(node)) throw new Error(`Node executable is missing: ${node}`);

async function regularFile(path) {
  try {
    const info = await stat(path);
    return info.isFile() && (info.mode & 0o111) !== 0 ? info : undefined;
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isTransient(path) {
  const normalized = resolve(path);
  const roots = ['/tmp', '/var/tmp', '/private/tmp', '/private/var/folders', '/run/user', '/dev/shm'];
  return roots.some((root) => normalized === root || normalized.startsWith(`${root}/`));
}

async function stablePath() {
  const candidates = [node, claudeArg, codexArg].filter(Boolean);
  const dirs = [];
  for (const command of candidates) {
    requirePath(command, 'Provider command');
    const directory = dirname(command);
    if (isTransient(directory)) throw new Error(`A provider executable is in a transient directory: ${directory}`);
    dirs.push(directory);
  }
  dirs.push(...(serviceKind === 'mac'
    ? ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin']
    : ['/usr/local/bin', '/usr/bin', '/bin']));
  const result = [];
  for (const directory of dirs) {
    if (isTransient(directory)) continue;
    if (directory.includes(':')) throw new Error(`PATH directory cannot contain a colon: ${directory}`);
    const info = await stat(directory).catch((error) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
    if (info?.isDirectory() && !result.includes(directory)) result.push(directory);
  }
  return result.join(':');
}

function provider(options) {
  return isRecord(options) && options.provider === 'codex';
}

function hasPlugin(plugins, path, displayName) {
  return plugins.some((plugin) => {
    if (plugin === path) return true;
    return isRecord(plugin) && (plugin.name === path || plugin.options?.displayName === displayName && plugin.options?.provider === displayName.toLowerCase());
  });
}

function systemdPath(value) {
  if (/[\0\r\n]/.test(value)) throw new Error('Service paths must not contain control characters');
  return value.replace(/%/g, '%%');
}

function systemdEnvironment(value) {
  if (/[\0\r\n]/.test(value)) throw new Error('Service values must not contain control characters');
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%')}"`;
}

function systemdExecExecutable(value) {
  if (/[\0\r\n]/.test(value)) throw new Error('Service executable must not contain control characters');
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%')}"`;
}

function systemdExecArgument(value) {
  if (/[\0\r\n]/.test(value)) throw new Error('Service arguments must not contain control characters');
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\$/g, () => '$$').replace(/%/g, '%%')}"`;
}

function xmlEscape(value) {
  if (/[\0-\x08\x0b\x0c\x0e-\x1f]/.test(value)) throw new Error('Service paths must not contain XML control characters');
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function renderSystemd(pathValue) {
  const logFile = systemdPath(join(home, 'ahpd.log'));
  const command = [systemdExecExecutable(node), ...[server, '--config-file', configFile].map(systemdExecArgument)].join(' ');
  return `[Unit]\nDescription=ahpd agent host for Anton\n\n[Service]\nWorkingDirectory=${systemdPath(work)}\nEnvironment=${systemdEnvironment(`PATH=${pathValue}`)}\nExecStart=${command}\nRestart=on-failure\nRestartSec=5\nStandardOutput=append:${logFile}\nStandardError=append:${logFile}\n\n[Install]\nWantedBy=default.target\n`;
}

function renderLaunchd(pathValue) {
  const esc = xmlEscape;
  const args = [node, server, '--config-file', configFile];
  const argList = args.map((value) => `    <string>${esc(value)}</string>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n<dict>\n  <key>Label</key><string>io.trustgrid.anton.ahpd</string>\n  <key>ProgramArguments</key>\n  <array>\n${argList}\n  </array>\n  <key>WorkingDirectory</key><string>${esc(work)}</string>\n  <key>EnvironmentVariables</key>\n  <dict><key>PATH</key><string>${esc(pathValue)}</string></dict>\n  <key>RunAtLoad</key><true/>\n  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>\n  <key>StandardOutPath</key><string>${esc(join(home, 'ahpd.log'))}</string>\n  <key>StandardErrorPath</key><string>${esc(join(home, 'ahpd.log'))}</string>\n</dict>\n</plist>\n`;
}

async function readConfig() {
  let raw;
  try {
    const info = await lstat(configFile);
    if (!info.isFile()) throw new Error(`Configuration is not a regular file: ${configFile}`);
    raw = await readFile(configFile, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw error;
  }
  let config;
  try {
    config = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Existing configuration is not valid JSON; it was not changed: ${error.message}`);
  }
  if (!isRecord(config)) throw new Error('Existing configuration must be a JSON object; it was not changed');
  return config;
}

async function legacyAdapterInstall(install, revision) {
  if (dirname(install) !== join(home, 'codex-acp') || !/^[a-f0-9]{40}$/.test(revision)) return false;
  const packageFile = join(install, 'package.json');
  const entrypoint = join(install, 'dist/index.js');
  try {
    const packageJson = JSON.parse(await readFile(packageFile, 'utf8'));
    const executable = await regularFile(entrypoint);
    return isRecord(packageJson)
      && packageJson.name === '@agentclientprotocol/codex-acp'
      && packageJson.bin?.['codex-acp'] === 'dist/index.js'
      && executable !== undefined
      && (executable.mode & 0o111) !== 0;
  } catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) return false;
    throw error;
  }
}

async function managedAdapterCommand(command) {
  const oldCommand = join(home, 'node_modules/.bin/codex-acp');
  if (command === oldCommand || command === adapter) return true;
  if (typeof command !== 'string' || basename(dirname(command)) !== 'dist' || basename(command) !== 'index.js') return false;
  const install = dirname(dirname(command));
  if (dirname(install) !== join(home, 'codex-acp')) return false;
  let marker;
  try {
    marker = JSON.parse(await readFile(join(install, markerName), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return legacyAdapterInstall(install, basename(install));
    if (error instanceof SyntaxError) return false;
    throw error;
  }
  return isRecord(marker)
    && marker.repository === 'https://github.com/terrbear/codex-acp.git'
    && /^[a-f0-9]{40}$/.test(marker.revision ?? '');
}

async function updateConfig(config) {
  if (config.port === undefined) config.port = port;
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) throw new Error('Existing configuration port must be an integer between 1 and 65535');
  if (config.host === undefined) config.host = '127.0.0.1';
  if (config.paths === undefined) config.paths = [work];
  if (!Array.isArray(config.paths)) throw new Error('Existing configuration paths must be an array');
  if (config.connectionTokenFile === undefined) config.connectionTokenFile = token;
  if (typeof config.connectionTokenFile !== 'string' || config.connectionTokenFile.length === 0) throw new Error('Existing connectionTokenFile must be a nonempty path');
  if (config.updateCheck === undefined) config.updateCheck = false;
  if (config.plugins === undefined) config.plugins = [];
  if (!Array.isArray(config.plugins)) throw new Error('Existing configuration plugins must be an array');

  const claudePlugin = join(source, 'packages/agent-claude');
  if (!hasPlugin(config.plugins, claudePlugin, 'Claude')) config.plugins.push(claudePlugin);
  const managedName = join(source, 'packages/agent-acp');
  const managed = [];
  for (const [index, plugin] of config.plugins.entries()) {
    if (!isRecord(plugin) || plugin.name !== managedName || !provider(plugin.options) || plugin.options.displayName !== 'Codex') continue;
    if (await managedAdapterCommand(plugin.options.command)) managed.push({ plugin, index });
  }
  if (managed.length > 1) throw new Error('Multiple managed Codex ACP entries were found; configuration was not changed');
  const hasCustomCodex = config.plugins.some((plugin) => isRecord(plugin) && provider(plugin.options) && !managed.some((item) => item.plugin === plugin));
  if (managed.length === 1) {
    const { plugin, index } = managed[0];
    config.plugins[index] = { ...plugin, options: { ...plugin.options, command: adapter } };
  } else if (!hasCustomCodex) {
    config.plugins.push({ name: managedName, options: { provider: 'codex', displayName: 'Codex', command: adapter } });
  }
  return { config, hasCustomCodex: managed.length === 0 && hasCustomCodex };
}

async function currentFile(path) {
  try {
    const info = await lstat(path);
    if (!info.isFile()) throw new Error(`Destination is not a regular file: ${path}`);
    return { content: await readFile(path), mode: info.mode & 0o777 };
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
}

async function stageWrite(path, content, mode) {
  await mkdir(dirname(path), { recursive: true });
  const current = await currentFile(path);
  if (current?.content.equals(Buffer.from(content)) && current.mode === mode) return undefined;
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  await writeFile(temporary, content, { mode, flag: 'wx' });
  await chmod(temporary, mode);
  return { path, temporary, current };
}

async function writeTransaction(files) {
  const staged = [];
  try {
    for (const file of files) {
      const result = await stageWrite(file.path, file.content, file.mode);
      if (result) staged.push(result);
    }
    const committed = [];
    try {
      for (const file of staged) {
        await rename(file.temporary, file.path);
        committed.push(file);
      }
    } catch (error) {
      const failures = [error];
      for (const file of committed.reverse()) {
        try {
          if (file.current) {
            const backup = join(dirname(file.path), `.${basename(file.path)}.${randomUUID()}.rollback`);
            await writeFile(backup, file.current.content, { mode: file.current.mode, flag: 'wx' });
            await chmod(backup, file.current.mode);
            await rename(backup, file.path);
          } else {
            await rm(file.path, { force: true });
          }
        } catch (restoreError) {
          failures.push(restoreError);
        }
      }
      if (failures.length > 1) throw new AggregateError(failures, 'Configuration/service update failed and rollback was incomplete');
      throw error;
    }
  } finally {
    await Promise.all(staged.map((file) => rm(file.temporary, { force: true })));
  }
}

const config = await updateConfig(await readConfig());
const pathValue = await stablePath();
const serviceContent = serviceKind === 'linux' ? renderSystemd(pathValue) : renderLaunchd(pathValue);
const configContent = `${JSON.stringify(config.config, null, 2)}\n`;
await writeTransaction([
  { path: serviceFile, content: serviceContent, mode: 0o644 },
  { path: configFile, content: configContent, mode: 0o600 },
]);
if (config.hasCustomCodex) console.log('Existing custom Codex ACP configuration was preserved; no managed adapter was substituted.');
console.log(`Configured ahpd at ${configFile} with the pinned Codex adapter command ${adapter}`);
