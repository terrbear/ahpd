/*
 * `mcpServers` in the configuration file.
 *
 * VS Code's two shapes are kept as written; an entry of neither is skipped
 * with a sentence naming the file and the entry, and the run goes on.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { optionsFrom } from '../src/commands/options.js';

let home: string;
let config: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'ahpd-config-mcp-'));
  config = join(home, 'config.json');
});
afterEach(() => { rmSync(home, { recursive: true, force: true }); });

const folded = (value: unknown) => {
  writeFileSync(config, JSON.stringify(value));
  return optionsFrom({ configFile: config });
};

describe('mcpServers', () => {
  it('keeps a stdio server and an http server as written', () => {
    const servers = {
      files: { type: 'stdio', command: 'files-mcp', args: ['--ro'], env: { A: '1' }, cwd: '/srv' },
      docs: { type: 'http', url: 'https://docs.example/mcp', headers: { 'X-Key': 'k' } },
    };
    const options = folded({ mcpServers: servers });
    expect(options.mcpServers).toEqual(servers);
    expect(options.warnings).toEqual([]);
  });

  it('leaves the key out when the file has none', () => {
    expect(folded({}).mcpServers).toBeUndefined();
  });

  it('skips an entry of neither shape with a warning and keeps the rest', () => {
    const options = folded({
      mcpServers: {
        good: { type: 'stdio', command: 'ok' },
        notype: { command: 'x' },
        sse: { type: 'sse', url: 'https://x' },
        nocommand: { type: 'stdio' },
        nourl: { type: 'http' },
        badenv: { type: 'stdio', command: 'x', env: { A: 1 } },
        badheaders: { type: 'http', url: 'https://x', headers: ['a'] },
        text: 'files-mcp',
      },
    });
    expect(Object.keys(options.mcpServers ?? {})).toEqual(['good']);
    expect(options.warnings).toHaveLength(7);
    expect(options.warnings[0]).toBe(`${config}: mcpServers.notype has a type that is neither stdio nor http; skipped`);
    expect(options.warnings).toContain(`${config}: mcpServers.nocommand is a stdio server with no command; skipped`);
    expect(options.warnings).toContain(`${config}: mcpServers.text is not an object; skipped`);
  });

  it('refuses a key that is not an object', () => {
    expect(() => folded({ mcpServers: ['files-mcp'] })).toThrow(`${config}: mcpServers must be an object`);
  });
});
