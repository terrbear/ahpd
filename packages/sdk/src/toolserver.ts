/**
 * The host's tools for one session, served as an HTTP MCP server.
 *
 * A backend that cannot call a `BoundTool` in-process, such as an ACP agent,
 * is given this as one of its MCP servers instead. One loopback listener
 * serves every session, each under a path and a bearer token of its own, so a
 * token for one session does not open another's, and the listener is bound
 * only while some session has an endpoint open.
 *
 * Streamable HTTP, JSON-RPC by hand: `initialize`, `tools/list` and
 * `tools/call` answered as JSON, and an optional GET stream that carries
 * `notifications/tools/list_changed` when the tools change.
 */

import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Bag } from './types/common.js';
import type { BoundTool, ClientToolCall, ClientToolResult, ToolsEndpoint } from './types/agent.js';

/** The revisions of MCP this server speaks, newest first. */
const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

/** The largest request body read. A tool call carries arguments, not files. */
const MAX_BODY = 8 * 1024 * 1024;

/** What `open` is given, per session. */
export interface ToolsServerOptions {
  /** The tools served until `setTools` replaces them. */
  tools: BoundTool[];
  /** Runs a call to a tool a client provides. */
  client: (call: ClientToolCall) => Promise<ClientToolResult>;
}

/** The listener behind every session's endpoint. */
export interface ToolsServers {
  /** Serve one session's tools, starting the listener if no session has. */
  open(options: ToolsServerOptions): Promise<ToolsEndpoint>;
  /** Close every endpoint and the listener. */
  close(): Promise<void>;
}

interface Served {
  token: string;
  tools: BoundTool[];
  client: ToolsServerOptions['client'];
  streams: Set<ServerResponse>;
}

const bag = (value: unknown): Bag => (typeof value === 'object' && value !== null ? value as Bag : {});

const sameToken = (given: string, expected: string): boolean => {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
};

const readBody = (request: IncomingMessage): Promise<string> => new Promise((resolve, reject) => {
  const chunks: Buffer[] = [];
  let size = 0;
  request.on('data', (chunk: Buffer) => {
    size += chunk.length;
    if (size > MAX_BODY) {
      reject(new Error('The request is too large'));
      request.destroy();
      return;
    }
    chunks.push(chunk);
  });
  request.on('end', () => { resolve(Buffer.concat(chunks).toString('utf8')); });
  request.on('error', reject);
});

const send = (response: ServerResponse, status: number, body?: unknown): void => {
  if (body === undefined) {
    response.writeHead(status).end();
    return;
  }
  response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
};

/** A tool as `tools/list` states it. */
const listed = (tool: BoundTool): Bag => ({
  name: tool.definition.name,
  ...(tool.definition.title === undefined ? {} : { title: tool.definition.title }),
  description: tool.definition.description ?? tool.definition.title ?? tool.definition.name,
  inputSchema: tool.definition.inputSchema ?? { type: 'object' },
  ...(tool.definition.annotations === undefined ? {} : { annotations: tool.definition.annotations }),
});

const textResult = (text: string, ok: boolean): Bag => ({
  content: [{ type: 'text', text }],
  ...(ok ? {} : { isError: true }),
});

/** One `tools/call`: the host's own tool is run, a client's is handed to the client. */
async function called(served: Served, params: Bag): Promise<Bag> {
  const tool = served.tools.find((one) => one.definition.name === params.name);
  if (tool === undefined) return textResult(`There is no tool called ${String(params.name)}`, false);
  const input = bag(params.arguments);
  try {
    if (tool.owner !== undefined) {
      const callId = bag(params._meta).callId;
      const answer = await served.client({
        tool,
        input,
        ...(typeof callId === 'string' ? { callId } : {}),
      });
      return textResult(answer.text, answer.ok);
    }
    if (tool.run === undefined) return textResult(`${tool.definition.name} has nothing to run`, false);
    return textResult(await tool.run(input), true);
  }
  catch (error: unknown) {
    return textResult(error instanceof Error ? error.message : String(error), false);
  }
}

/** One JSON-RPC message, answered, or undefined for a notification. */
async function answered(served: Served, message: Bag): Promise<Bag | undefined> {
  const method = typeof message.method === 'string' ? message.method : '';
  if (message.id === undefined) return undefined;
  const reply = (result: unknown): Bag => ({ jsonrpc: '2.0', id: message.id, result });
  const params = bag(message.params);
  switch (method) {
    case 'initialize': {
      const asked = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      return reply({
        protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: true } },
        serverInfo: { name: 'ahpd', version: '1.0.0' },
      });
    }
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({ tools: served.tools.map(listed) });
    case 'tools/call':
      return reply(await called(served, params));
    default:
      return { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `Method not found: ${method}` } };
  }
}

/**
 * The listener, which binds on the first endpoint and lets go with the last.
 *
 * Nothing is started until a session asks, so a host that never offers an
 * agent its tools holds no port.
 */
export function toolsServers(): ToolsServers {
  const sessions = new Map<string, Served>();
  let server: Promise<Server> | undefined;
  let port = 0;

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const path = (request.url ?? '').split('?')[0] ?? '';
    const served = path.startsWith('/mcp/') ? sessions.get(path.slice('/mcp/'.length)) : undefined;
    if (served === undefined) return send(response, 404);
    const header = request.headers.authorization ?? '';
    if (!header.startsWith('Bearer ') || !sameToken(header.slice('Bearer '.length), served.token)) {
      return send(response, 401);
    }
    if (request.method === 'GET') {
      if (!(request.headers.accept ?? '').includes('text/event-stream')) return send(response, 405);
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      response.write(': ahpd\n\n');
      served.streams.add(response);
      response.on('close', () => { served.streams.delete(response); });
      return undefined;
    }
    if (request.method !== 'POST') return send(response, 405);
    let message: Bag;
    try { message = bag(JSON.parse(await readBody(request))); }
    catch { return send(response, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); }
    const reply = await answered(served, message);
    return reply === undefined ? send(response, 202) : send(response, 200, reply);
  };

  const listening = (): Promise<Server> => {
    server ??= (async () => {
      const { createServer } = await import('node:http');
      const made = createServer((request, response) => {
        handle(request, response).catch(() => {
          if (!response.headersSent) send(response, 500);
          else response.end();
        });
      });
      await new Promise<void>((resolve, reject) => {
        made.once('error', reject);
        made.listen(0, '127.0.0.1', () => { resolve(); });
      });
      port = (made.address() as AddressInfo).port;
      return made;
    })();
    return server;
  };

  const release = async (): Promise<void> => {
    if (sessions.size > 0 || server === undefined) return;
    const closing = server;
    server = undefined;
    const held = await closing;
    held.closeAllConnections();
    await new Promise<void>((resolve) => { held.close(() => { resolve(); }); });
  };

  return {
    open: async (options) => {
      const id = randomBytes(16).toString('hex');
      const served: Served = {
        token: randomBytes(32).toString('hex'),
        tools: [...options.tools],
        client: options.client,
        streams: new Set(),
      };
      sessions.set(id, served);
      try { await listening(); }
      catch (error: unknown) {
        sessions.delete(id);
        server = undefined;
        throw error;
      }
      return {
        url: `http://127.0.0.1:${port}/mcp/${id}`,
        headers: { Authorization: `Bearer ${served.token}` },
        setTools: (tools) => {
          served.tools = [...tools];
          const note = `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' })}\n\n`;
          for (const stream of served.streams) stream.write(note);
        },
        close: () => {
          for (const stream of served.streams) stream.end();
          sessions.delete(id);
          void release();
        },
      };
    },
    close: async () => {
      for (const served of sessions.values()) for (const stream of served.streams) stream.end();
      sessions.clear();
      await release();
    },
  };
}
