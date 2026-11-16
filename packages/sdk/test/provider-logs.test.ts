import { mkdtemp, writeFile, rm, symlink, truncate } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createHost } from '../src/host.js';
import { debugLogs } from '../src/debuglogs.js';
import { collectProviderLog, PROVIDER_LOG_LIMIT } from '../src/providerlogs.js';
import { echo } from '../../../examples/echo/agent.js';
import type { Peer } from '../src/types/rpc.js';

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const dispose of cleanup.splice(0)) await dispose(); });
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'provider-log-test-'));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const logs = debugLogs({ tmp: dir });
  cleanup.unshift(() => logs.close());
  return { dir, logs };
}
const peer = (): Peer => ({ send() {}, notify() {}, request: async () => ({}), answered() {}, close() {} });

it.each(['claude', 'codex'])('collects only the exact %s session through the host', async provider => {
  const { dir } = await fixture();
  const row = provider === 'claude' ? { sessionId: 'one', text: 'selected' } : { type: 'session_meta', payload: { id: 'one' } };
  await writeFile(join(dir, 'one.jsonl'), JSON.stringify(row) + '\n');
  await writeFile(join(dir, 'daemon.log'), 'unrelated');
  const host = createHost({ agents: [{ ...echo({ path: dir, pace: 0 }), provider, stateFile: id => join(dir, `${id}.jsonl`), harnessLogFile: async id => join(dir, `${id}.jsonl`) }], path: dir, diagnostics: { logs: () => [join(dir, 'daemon.log')] } });
  cleanup.unshift(() => host.close());
  const client = host.accept(peer());
  const init = await client.handle({ method: 'initialize', params: { clientId: 'fixture', protocolVersions: ['0.9.0'] } }) as { _meta: Record<string, unknown> };
  expect(init._meta['ahpd.providerDebugLogs']).toEqual({ version: 1, maxBytes: PROVIDER_LOG_LIMIT });
  await client.handle({ method: 'createSession', params: { channel: `${provider}:/one`, provider } });
  const state = (await client.handle({ method: 'subscribe', params: { channel: `${provider}:/one` } }) as { snapshot: { state: { defaultChat: string } } }).snapshot.state;
  const params = { session: `${provider}:/one`, chat: state.defaultChat, kind: 'archive', providerOnly: true, version: 1 };
  const got = await client.handle({ method: 'vscode/collectAgentHostDebugLogs', params }) as Record<string, unknown>;
  expect(got).toMatchObject({ version: 1, status: 'included', provider, session: params.session, chat: params.chat, entries: [{ path: 'events.jsonl' }] });
  const other = host.accept(peer());
  await other.handle({ method: 'initialize', params: { clientId: 'other', protocolVersions: ['0.9.0'] } });
  await expect(other.handle({ method: 'vscode/readAgentHostDebugLogsChunk', params: { resource: got.resource, position: 0 } })).rejects.toThrow();
  expect(await client.handle({ method: 'vscode/readAgentHostDebugLogsChunk', params: { resource: got.resource, position: 0 } })).toMatchObject({ eof: true });
  await expect(client.handle({ method: 'vscode/collectAgentHostDebugLogs', params: { ...params, chat: 'ahp-chat:/other' } })).rejects.toThrow();
  await expect(client.handle({ method: 'vscode/collectAgentHostDebugLogs', params: { ...params, path: '/private' } })).rejects.toThrow();
});

it('omits missing, oversized, unreadable and wrong-session data without returning raw errors', async () => {
  const { dir, logs } = await fixture();
  const owner = {};
  const file = join(dir, 'log.jsonl');
  expect(await collectProviderLog(logs, file, 'claude', 'one', owner)).toEqual({ status: 'unavailable', reason: 'missing' });
  await writeFile(file, '');
  await truncate(file, PROVIDER_LOG_LIMIT + 1);
  expect(await collectProviderLog(logs, file, 'claude', 'one', owner)).toEqual({ status: 'unavailable', reason: 'oversized' });
  const link = join(dir, 'link');
  await symlink(file, link);
  expect(await collectProviderLog(logs, link, 'claude', 'one', owner)).toEqual({ status: 'unavailable', reason: 'unreadable' });
  await writeFile(file, '{"sessionId":"other","text":"private credential"}\n');
  expect(await collectProviderLog(logs, file, 'claude', 'one', owner)).toEqual({ status: 'unavailable', reason: 'invalid-log' });
  await writeFile(file, '{"sessionId":"one"}\n{"sessionId":"other"}\n');
  expect(await collectProviderLog(logs, file, 'claude', 'one', owner)).toEqual({ status: 'unavailable', reason: 'invalid-log' });
});

it('limits concurrent leased captures and keeps archives private', async () => {
  const { dir, logs } = await fixture();
  const source = join(dir, 'source.jsonl');
  await writeFile(source, '{"sessionId":"one"}\n');
  const owner = {};
  const results = await Promise.allSettled(Array.from({ length: 8 }, () => logs.collect([{ path: 'events.jsonl', from: source, provider: true }], 'archive', owner)));
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(4);
  expect(results.filter(result => result.status === 'rejected')).toHaveLength(4);
  const { stat } = await import('node:fs/promises');
  for (const result of results) {
    if (result.status !== 'fulfilled') continue;
    expect((await stat(result.value.resource.slice('file://'.length))).mode & 0o777).toBe(0o600);
  }
});
