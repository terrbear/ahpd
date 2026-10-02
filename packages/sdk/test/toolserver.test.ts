import { afterEach, describe, expect, it } from 'vitest';
import { toolsServers } from '../src/toolserver.js';
import type { BoundTool, ClientToolCall, ToolsEndpoint } from '../src/types/agent.js';

/*
 * The host's tools as one session's MCP server.
 *
 * Driven over real HTTP on loopback, because the listener, the path and the
 * token are the whole of what a backend relies on.
 */

const own = (name: string, run: BoundTool['run']): BoundTool => ({
  definition: { name, description: `${name} tool`, inputSchema: { type: 'object', properties: { text: { type: 'string' } } } },
  ...(run === undefined ? {} : { run }),
});

const clients = (name: string): BoundTool => ({
  definition: { name: `c1__${name}`, inputSchema: { type: 'object' } },
  owner: 'c1',
});

const rpc = async (endpoint: ToolsEndpoint, body: unknown, headers: Record<string, string> = endpoint.headers): Promise<Response> =>
  fetch(endpoint.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
    body: JSON.stringify(body),
  });

const result = async (endpoint: ToolsEndpoint, method: string, params: unknown = {}): Promise<Record<string, unknown>> => {
  const response = await rpc(endpoint, { jsonrpc: '2.0', id: 1, method, params });
  return ((await response.json()) as { result: Record<string, unknown> }).result;
};

describe('the tools server', () => {
  const servers = toolsServers();
  afterEach(async () => { await servers.close(); });

  const noClient = (): Promise<{ text: string; ok: boolean }> => Promise.reject(new Error('no client'));

  it('answers initialize with the protocol it speaks and tools that can change', async () => {
    const endpoint = await servers.open({ tools: [], client: noClient });
    const answer = await result(endpoint, 'initialize', { protocolVersion: '2025-06-18' });
    expect(answer).toMatchObject({ protocolVersion: '2025-06-18', capabilities: { tools: { listChanged: true } } });
    const newer = await result(endpoint, 'initialize', { protocolVersion: '2099-01-01' });
    expect(newer.protocolVersion).toBe('2025-06-18');
  });

  it('lists the session\'s tools with a schema for each', async () => {
    const endpoint = await servers.open({ tools: [own('echo', () => ''), clients('open')], client: noClient });
    const { tools } = await result(endpoint, 'tools/list') as { tools: { name: string; inputSchema: unknown }[] };
    expect(tools.map((one) => one.name)).toEqual(['echo', 'c1__open']);
    expect(tools[1]?.inputSchema).toEqual({ type: 'object' });
  });

  it('runs a host tool and answers its text, and its failure as an error result', async () => {
    const endpoint = await servers.open({
      tools: [
        own('echo', (input) => `said ${String(input.text)}`),
        own('boom', () => { throw new Error('it broke'); }),
      ],
      client: noClient,
    });
    expect(await result(endpoint, 'tools/call', { name: 'echo', arguments: { text: 'hi' } }))
      .toEqual({ content: [{ type: 'text', text: 'said hi' }] });
    expect(await result(endpoint, 'tools/call', { name: 'boom', arguments: {} }))
      .toEqual({ content: [{ type: 'text', text: 'it broke' }], isError: true });
    expect(await result(endpoint, 'tools/call', { name: 'nope' })).toMatchObject({ isError: true });
  });

  it('hands a call to a client\'s tool to the client and waits for what it says', async () => {
    const seen: ClientToolCall[] = [];
    let answer: (value: { text: string; ok: boolean }) => void = () => {};
    const endpoint = await servers.open({
      tools: [clients('open')],
      client: (call) => {
        seen.push(call);
        return new Promise((resolve) => { answer = resolve; });
      },
    });
    let settled = false;
    const pending = result(endpoint, 'tools/call', { name: 'c1__open', arguments: { path: '/x' }, _meta: { callId: 'call_9' } })
      .then((value) => { settled = true; return value; });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(settled).toBe(false);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ input: { path: '/x' }, callId: 'call_9', tool: { owner: 'c1' } });
    answer({ text: 'opened', ok: true });
    expect(await pending).toEqual({ content: [{ type: 'text', text: 'opened' }] });
  });

  it('answers a client that failed as an error result', async () => {
    const endpoint = await servers.open({
      tools: [clients('open')],
      client: () => Promise.resolve({ text: 'The client is gone', ok: false }),
    });
    expect(await result(endpoint, 'tools/call', { name: 'c1__open' }))
      .toEqual({ content: [{ type: 'text', text: 'The client is gone' }], isError: true });
  });

  it('refuses a wrong or missing token with 401', async () => {
    const endpoint = await servers.open({ tools: [], client: noClient });
    const call = { jsonrpc: '2.0', id: 1, method: 'tools/list' };
    expect((await rpc(endpoint, call, { Authorization: 'Bearer nope' })).status).toBe(401);
    expect((await rpc(endpoint, call, {})).status).toBe(401);
  });

  it('does not let one session\'s token into another\'s path', async () => {
    const first = await servers.open({ tools: [own('a', () => '')], client: noClient });
    const second = await servers.open({ tools: [own('b', () => '')], client: noClient });
    const crossed = { ...second, url: first.url };
    expect((await rpc(crossed, { jsonrpc: '2.0', id: 1, method: 'tools/list' })).status).toBe(401);
  });

  it('answers 404 for a path nobody serves, and for one whose session has ended', async () => {
    const kept = await servers.open({ tools: [], client: noClient });
    const ended = await servers.open({ tools: [], client: noClient });
    ended.close();
    expect((await rpc(ended, { jsonrpc: '2.0', id: 1, method: 'ping' })).status).toBe(404);
    const elsewhere = kept.url.replace('/mcp/', '/other/');
    expect((await rpc({ ...kept, url: elsewhere }, { jsonrpc: '2.0', id: 1, method: 'ping' })).status).toBe(404);
  });

  it('listens on loopback and stops listening when the last session ends', async () => {
    const endpoint = await servers.open({ tools: [], client: noClient });
    expect(new URL(endpoint.url).hostname).toBe('127.0.0.1');
    endpoint.close();
    await new Promise((resolve) => setTimeout(resolve, 50));
    await expect(rpc(endpoint, { jsonrpc: '2.0', id: 1, method: 'ping' })).rejects.toThrow();
  });

  it('replaces the tools on setTools and says so on an open stream', async () => {
    const endpoint = await servers.open({ tools: [own('a', () => '')], client: noClient });
    const stream = await fetch(endpoint.url, { headers: { ...endpoint.headers, accept: 'text/event-stream' } });
    expect(stream.status).toBe(200);
    const reader = (stream.body as ReadableStream<Uint8Array>).getReader();
    await reader.read();
    endpoint.setTools([own('b', () => '')]);
    const note = new TextDecoder().decode((await reader.read()).value);
    expect(note).toContain('notifications/tools/list_changed');
    const { tools } = await result(endpoint, 'tools/list') as { tools: { name: string }[] };
    expect(tools.map((one) => one.name)).toEqual(['b']);
    await reader.cancel();
  });

  it('takes a notification without answering it', async () => {
    const endpoint = await servers.open({ tools: [], client: noClient });
    expect((await rpc(endpoint, { jsonrpc: '2.0', method: 'notifications/initialized' })).status).toBe(202);
  });
});
