import { fileURLToPath } from 'node:url';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { acpAgent } from '../src/agent.js';
const fixture = fileURLToPath(new URL('./fixtures/read-history.mjs', import.meta.url));
const id = '11111111-2222-4333-8444-555555555555';

it('reads external unwatched prior turns without session/new, load or prompt', async () => {
 const directory = await mkdtemp(join(tmpdir(), 'cli-history-'));
 try {
  const receipt = join(directory, 'methods');
  const agent = acpAgent({ command:process.execPath, args:[fixture], provider:'codex', env:{CLI_HISTORY_TEST_RECEIPT:receipt} });
  expect(await agent.transcript?.(id)).toBeUndefined();
  const read = await agent.externalHistory?.(id);
  expect(read?.history.id).toBe(id);
  expect(read?.history.sessionId).toBe('different-root');
  expect(JSON.stringify(read)).toContain('earlier result');
  expect(JSON.stringify(read)).toContain('inProgress');
  expect(await readFile(receipt, 'utf8')).toBe('initialize\n_session/read_history\n');
 } finally { await rm(directory, {recursive:true, force:true}); }
});

it('refuses an old ACP capability without attempting load as fallback', async () => {
 const directory = await mkdtemp(join(tmpdir(), 'cli-history-'));
 try {
  const receipt = join(directory, 'methods');
  const agent = acpAgent({ command:process.execPath, args:[fixture,'--old'], provider:'codex', env:{CLI_HISTORY_TEST_RECEIPT:receipt} });
  expect(await agent.externalHistory?.(id)).toBeUndefined();
  expect(await readFile(receipt, 'utf8')).toBe('initialize\n');
 } finally { await rm(directory, {recursive:true, force:true}); }
});
