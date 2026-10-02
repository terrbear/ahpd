import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { createHost } from '../../sdk/src/host.js';
import { acpAgent } from '../src/index.js';
import type { Peer } from '../../sdk/src/types/rpc.js';

/*
 * The MCP servers an ACP session opens with: the host's configured ones, less
 * what the server cannot take, and the host's tools and its clients' tools as
 * one HTTP server of the host's own.
 */

const FIXTURE = fileURLToPath(new URL('./fixtures/acp-server.mjs', import.meta.url));

type Note = { channel: string; action: Record<string, unknown> };

function peer() {
  const notes: { method: string; params: unknown }[] = [];
  const quiet: Peer = {
    send: () => {},
    notify: (method, params) => notes.push({ method, params }),
    request: async () => ({}),
    answered: () => {},
    close: async () => {},
  };
  return { notes, peer: quiet };
}

const until = async (check: () => boolean, times = 2500): Promise<void> => {
  for (let i = 0; i < times; i++) {
    if (check()) return;
    await new Promise((r) => { setTimeout(r, 2); });
  }
};

const made: string[] = [];
const running: { client: ReturnType<ReturnType<typeof createHost>['accept']>; uri: string; host: ReturnType<typeof createHost> }[] = [];

afterEach(async () => {
  for (const one of running.splice(0)) {
    await one.client.handle({ method: 'disposeSession', params: { channel: one.uri } });
    await one.host.close?.();
  }
  for (const path of made.splice(0)) rmSync(path, { recursive: true, force: true });
});

async function talking(http: boolean, options: { hostTools?: boolean } = {}) {
  const path = mkdtempSync(join(tmpdir(), 'ahpd-acp-mcp-'));
  made.push(path);
  const log = join(path, 'requests.jsonl');
  const host = createHost({
    path,
    mcpServers: {
      files: { type: 'stdio', command: 'files-mcp', args: ['--ro'], env: { A: 'b' } },
      docs: { type: 'http', url: 'https://docs.example/mcp', headers: { 'X-Key': 'k' } },
    },
    agents: [acpAgent({
      command: process.execPath,
      args: [FIXTURE],
      env: { ACP_LOG: log, ...(http ? { ACP_MCP_HTTP: '1' } : {}) },
      provider: 'acp',
      ...options,
    })],
  });
  const held = peer();
  const client = host.accept(held.peer);
  await client.handle({
    method: 'initialize',
    params: { clientId: 'probe', protocolVersions: ['0.8.0'], initialSubscriptions: ['ahp-root://'] },
  });
  const uri = 'ahp-session:/mcp';
  const chatUri = 'ahp-chat:/mcp';
  await client.handle({ method: 'createSession', params: { channel: uri, provider: 'acp', workingDirectories: [`file://${path}`] } });
  await client.handle({ method: 'subscribe', params: { channel: uri } });
  await client.handle({ method: 'subscribe', params: { channel: chatUri } });
  running.push({ client, uri, host });
  return { client, notes: held.notes, uri, chatUri, log };
}

const actions = (notes: { method: string; params: unknown }[], channel: string): Record<string, unknown>[] => notes
  .filter((n) => n.method === 'action')
  .map((n) => n.params as Note)
  .filter((e) => e.channel === channel)
  .map((e) => e.action);

const sentToServer = (log: string): { mcpServers: Record<string, unknown>[] } => {
  const lines = readFileSync(log, 'utf8').trim().split('\n').map((one) => JSON.parse(one) as { method?: string; params?: unknown });
  return lines.find((one) => one.method === 'session/new')?.params as { mcpServers: Record<string, unknown>[] };
};

const turn = async (t: Awaited<ReturnType<typeof talking>>, text: string): Promise<void> => {
  void t.client.handle({
    method: 'dispatchAction',
    params: { channel: t.chatUri, action: { type: 'chat/turnStarted', turnId: 't1', message: { text } } },
  });
  await until(() => actions(t.notes, t.chatUri).some((a) => a.type === 'chat/turnComplete'));
};

it('hands a server that takes http the configured servers and the host tools server', async () => {
  const t = await talking(true);
  await turn(t, 'hello');
  const servers = sentToServer(t.log).mcpServers;
  expect(servers.map((one) => one.name)).toEqual(['files', 'docs', 'ahp']);
  expect(servers[0]).toEqual({ name: 'files', command: 'files-mcp', args: ['--ro'], env: [{ name: 'A', value: 'b' }] });
  expect(servers[1]).toMatchObject({ type: 'http', url: 'https://docs.example/mcp', headers: [{ name: 'X-Key', value: 'k' }] });
  expect(servers[2]).toMatchObject({ type: 'http', url: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/mcp\//) });
});

it('leaves out http servers and the host tools for a server that takes none', async () => {
  const t = await talking(false);
  await turn(t, 'hello');
  expect(sentToServer(t.log).mcpServers.map((one) => one.name)).toEqual(['files']);
});

it('leaves out the host tools server when hostTools is off', async () => {
  const t = await talking(true, { hostTools: false });
  await turn(t, 'hello');
  expect(sentToServer(t.log).mcpServers.map((one) => one.name)).toEqual(['files', 'docs']);
});

it('raises a client tool call for the client and returns what the client says', async () => {
  const t = await talking(true);
  await t.client.handle({
    method: 'dispatchAction',
    params: {
      channel: t.uri,
      action: {
        type: 'session/activeClientSet',
        activeClient: { tools: [{ name: 'dummy', description: 'A dummy', inputSchema: { type: 'object' } }] },
      },
    },
  });
  void t.client.handle({
    method: 'dispatchAction',
    params: { channel: t.chatUri, action: { type: 'chat/turnStarted', turnId: 't1', message: { text: 'mcpcall' } } },
  });
  await until(() => actions(t.notes, t.chatUri).some((a) => a.type === 'chat/toolCallStart'));
  const start = actions(t.notes, t.chatUri).find((a) => a.type === 'chat/toolCallStart');
  expect(start).toMatchObject({ toolCallId: 'call-mcp', contributor: { kind: 'client', clientId: 'probe' } });
  await t.client.handle({
    method: 'dispatchAction',
    params: {
      channel: t.chatUri,
      action: {
        type: 'chat/toolCallComplete',
        turnId: 't1',
        toolCallId: 'call-mcp',
        result: { success: true, content: [{ type: 'text', text: 'dummy says hi' }] },
      },
    },
  });
  await until(() => actions(t.notes, t.chatUri).some((a) => a.type === 'chat/turnComplete'));
  const prose = actions(t.notes, t.chatUri).filter((a) => a.type === 'chat/delta').map((a) => String(a.content)).join('');
  expect(prose).toContain('mcp=dummy says hi');
});

it('tells the host the models the server named once the session has opened', async () => {
  const t = await talking(true);
  await turn(t, 'hello');
  const root = await t.client.handle({ method: 'subscribe', params: { channel: 'ahp-root://' } }) as {
    snapshot: { state: { agents: { provider: string; models: { id: string }[] }[] } };
  };
  const agent = root.snapshot.state.agents.find((one) => one.provider === 'acp');
  expect(agent?.models.map((one) => one.id)).toEqual(['fast', 'thorough']);
});
