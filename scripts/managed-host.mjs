import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { json } from './managed-build.mjs';

const [sourceArg, configArg] = process.argv.slice(2);
if (!sourceArg || !configArg) throw new Error('Usage: managed-host.mjs <source> <config-file>');
const source = resolve(sourceArg), config = resolve(configArg);
const home = dirname(config);
await mkdir(home, { recursive: true });
const state = await json(`${home}/managed-update-state.json`, {});
let next = { source, config, current: state.current ?? source, previous: state.previous };
while (next) {
  const { cycle } = await import(pathToFileURL(`${next.current}/scripts/managed-cycle.mjs`).href);
  next = await cycle(next);
}
