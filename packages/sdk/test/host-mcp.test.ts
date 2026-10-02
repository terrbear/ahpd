import { afterEach, expect, it } from 'vitest';
import { createHost, ROOT } from '../src/host.js';
import { echo } from '../../../examples/echo/agent.js';
import type { Agent, Start, ToolsEndpoint } from '../src/types/agent.js';
import type { HostOptions } from '../src/types/host.js';
import type { Peer } from '../src/types/rpc.js';

/*
 * What a backend is handed to reach MCP: the host's configured servers, and
 * the session's tools as a server the host serves.
 */

const DIR = '/tmp/ahpd-host-mcp';

const peer = (): Peer => ({
  send: () => {}, notify: () => {}, request: async () => ({}), answered: () => {}, close: () => {},
});

const settle = async (): Promise<void> => {
  for (let i = 0; i < 40; i++) await new Promise((r) => { setTimeout(r, 0); });
};

const started: Start[] = [];
const hosts: ReturnType<typeof createHost>[] = [];

const backend = (): Agent => {
  const base = echo({ path: DIR, pace: 0 });
  return { ...base, create: (start) => { started.push(start); return base.create(start); } };
};

async function session(options: Partial<HostOptions> = {}): Promise<Start> {
  started.length = 0;
  const host = createHost({ path: DIR, agents: [backend()], ...options });
  hosts.push(host);
  const client = host.accept(peer());
  await client.handle({ method: 'initialize', params: { clientId: 'probe', protocolVersions: ['0.9.0'], initialSubscriptions: [ROOT] } });
  await client.handle({ method: 'createSession', params: { channel: 'ahp-session:/made', provider: 'echo' } });
  await settle();
  return started[0] as Start;
}

afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.close()));
});

it('hands the host\'s MCP servers to the backend, and none when there are none', async () => {
  const servers = {
    files: { type: 'stdio' as const, command: 'files-mcp', args: ['--ro'] },
    docs: { type: 'http' as const, url: 'https://docs.example/mcp', headers: { 'X-Key': 'k' } },
  };
  expect((await session({ mcpServers: servers })).mcpServers).toEqual(servers);
  expect((await session()).mcpServers).toBeUndefined();
});

it('serves the session\'s host tools over MCP to a backend that asks, and stops with the host', async () => {
  const start = await session({
    tools: [{
      definition: { name: 'whoami', description: 'Who', inputSchema: { type: 'object' } },
      run: () => 'terry',
    }],
  });
  const endpoint: ToolsEndpoint = await (start.toolsServer as NonNullable<Start['toolsServer']>)(
    () => Promise.resolve({ text: 'unused', ok: true }),
  );
  const call = async (method: string, params: unknown): Promise<{ result: Record<string, unknown> }> =>
    (await fetch(endpoint.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...endpoint.headers },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    })).json() as Promise<{ result: Record<string, unknown> }>;
  expect((await call('tools/list', {})).result.tools).toMatchObject([{ name: 'whoami' }]);
  expect((await call('tools/call', { name: 'whoami', arguments: {} })).result)
    .toEqual({ content: [{ type: 'text', text: 'terry' }] });

  await hosts[0]?.close();
  await expect(fetch(endpoint.url, { method: 'POST', body: '{}' })).rejects.toThrow();
});
