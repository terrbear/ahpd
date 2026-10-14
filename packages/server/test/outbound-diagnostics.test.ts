import type { Socket } from 'node:net';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import type { HostOptions, Listener, ListenOptions, OnConnect, OutboundClose, Peer } from '@ahpd/sdk';
import { OUTBOUND_LIMIT, RpcClosed } from '../../sdk/src/rpc.js';
import { runForeground } from '../src/commands/run.js';
import type { Options } from '../src/commands/options.js';

// Exercise the real runForeground -> listen -> Node WebSocket -> overload ->
// stderr path. Stub unrelated host/services; no daemon process or stores.
const state = vi.hoisted(() => ({
  listener: undefined as Listener | undefined,
  options: undefined as ListenOptions | undefined,
  peer: undefined as Peer | undefined,
  connectedClose: vi.fn(),
  hostClose: vi.fn(async () => {}),
  shutdown: vi.fn(),
}));
vi.mock('@ahpd/sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@ahpd/sdk')>();
  const unused = () => undefined;
  return {
    ...actual,
    fileResources: unused, fileUsage: unused, gitBranches: unused, gitChanges: unused,
    gitWorktrees: unused, githubPullRequests: unused, hostTools: unused,
    memoryAutomations: unused, memorySessions: unused, shellTerminals: unused, usageProvider: unused,
    createHost: () => ({
      turning: () => [], close: state.hostClose,
      accept(peer: Peer) {
        state.peer = peer;
        return { handle: async () => ({}), close: state.connectedClose };
      },
    }),
    listen: async (options: ListenOptions, onConnect: OnConnect) => {
      state.options = options;
      state.listener = await actual.listen({
        ...options,
        onOutboundClose: (event: OutboundClose) => options.onOutboundClose?.(Object.assign({}, event, {
          // Deliberate schema contamination at the callback boundary proves
          // the final server sink projects fields rather than logging objects.
          payload: 'private payload', sessionId: 'private session', identity: 'private identity',
          method: 'private method', path: '/private/path', url: 'ws://private.invalid', error: 'private error',
        })),
      }, onConnect);
      return state.listener;
    },
  };
});
vi.mock('../src/plugins.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/plugins.js')>(),
  loadPlugins: async (_specs: unknown, { base }: { base: HostOptions }) => ({
    options: { ...base, agents: [{ provider: 'synthetic' }] }, problems: [], loaded: [],
  }),
}));
vi.mock('../src/pty.js', () => ({ pty: async () => undefined }));
vi.mock('../src/daemon.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/daemon.js')>(),
  DETACHED_ENV: '__AHPD_OUTBOUND_TEST_DETACHED', forget: vi.fn(), running: vi.fn(), start: vi.fn(),
}));
vi.mock('../src/commands/options.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/commands/options.js')>(),
  secret: () => ({ from: 'synthetic open fixture' }),
}));
vi.mock('../src/commands/restart.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/commands/restart.js')>(),
  FORCED_SIGNAL: 'SIGUSR2', RESTART_SIGNAL: 'SIGHUP', answerRestartSignal: vi.fn(),
  checkedRestart: () => async () => {}, lifecycle: () => ({ shutdown: state.shutdown }),
}));

let client: WebSocket | undefined;
beforeEach(() => { vi.clearAllMocks(); });
afterEach(async () => {
  try {
    state.peer?.close();
    client?.terminate();
    await state.listener?.close();
    await state.hostClose();
  } finally {
    process.removeListener('SIGINT', state.shutdown);
    process.removeListener('SIGTERM', state.shutdown);
    client = undefined;
    state.listener = undefined;
    state.options = undefined;
    state.peer = undefined;
    vi.restoreAllMocks();
  }
});

it.each([false, true])('logs one fixed-schema overload event through runForeground after cleanup (sink throws: %s)', async (sinkThrows) => {
  let serverSocket: WebSocket | undefined;
  const amount = Object.getOwnPropertyDescriptor(WebSocket.prototype, 'bufferedAmount')!.get!;
  vi.spyOn(WebSocket.prototype, 'bufferedAmount', 'get').mockImplementation(function (this: WebSocket) {
    serverSocket = this;
    return amount.call(this) as number;
  });
  const intervalClear = vi.spyOn(globalThis, 'clearInterval');
  const timeoutClear = vi.spyOn(globalThis, 'clearTimeout');
  const records: Array<Record<string, unknown>> = [];
  const cleanupAtSink: Array<{ interval: boolean; question: boolean; terminated: boolean }> = [];
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  vi.spyOn(process.stderr, 'write').mockImplementation((raw) => {
    const line = String(raw);
    if (line.includes(' {"event":"outbound_close"')) {
      records.push(JSON.parse(line.slice(line.indexOf(' ') + 1)) as Record<string, unknown>);
      cleanupAtSink.push({
        interval: intervalClear.mock.calls.length > 0,
        question: timeoutClear.mock.calls.length > 0,
        terminated: serverSocket!.readyState !== WebSocket.OPEN,
      });
      if (sinkThrows) throw new Error('private sink failure');
    }
    return true;
  });
  const options: Options = {
    port: 0, host: '127.0.0.1', stdio: false, paths: ['/synthetic/private/path'],
    open: true, trustToken: false, advancedTools: false, automations: 'memory', sessions: 'memory',
    usagePer: 'turn', proxy: {} as Options['proxy'], plugins: [], noPlugins: true,
    updateCheck: false, warnings: [], configFiles: [],
  };
  await runForeground(options);
  expect(state.options!.onOutboundClose).toBeTypeOf('function');
  expect(state.options!.tap).toBeUndefined();
  client = new WebSocket(`ws://127.0.0.1:${state.listener!.port}`);
  const received: string[] = [];
  client.on('error', () => {}); // Termination may report a reset on some OSes.
  client.on('message', (raw) => { received.push(JSON.parse(String(raw)).method as string); });
  await new Promise<void>((resolve, reject) => {
    client!.once('open', resolve);
    client!.once('error', reject);
  });
  state.peer!.notify('ready', {});
  await vi.waitFor(() => expect(received).toEqual(['ready']));
  intervalClear.mockClear();
  timeoutClear.mockClear();
  const dropped = new Promise<void>((resolve) => { client!.once('close', resolve); });
  const transport = (serverSocket! as unknown as { _socket: Socket })._socket;
  const large = { text: 'x'.repeat(OUTBOUND_LIMIT + 1) };
  let pending!: Promise<unknown>;
  transport.cork();
  try {
    state.peer!.send(large);
    pending = state.peer!.request('private method', { secret: 'private secret' }).catch((error: unknown) => error);
    state.peer!.send(large); // Intentional overflow while the first is held.
  } finally { transport.uncork(); }
  expect(await pending).toBeInstanceOf(RpcClosed);
  await dropped;
  await vi.waitFor(() => expect(state.connectedClose).toHaveBeenCalledTimes(1));
  state.peer!.send(large);
  expect(records).toHaveLength(1);
  expect(cleanupAtSink).toEqual([{ interval: true, question: true, terminated: true }]);
  const record = records[0]!;
  expect(Object.keys(record).sort()).toEqual([
    'bufferedBytes', 'deferredBytes', 'deferredFrames', 'drainElapsedMs', 'event',
    'outstandingWrites', 'oversizedFrameBytes', 'reason', 'runtime',
  ]);
  expect(record).toMatchObject({ event: 'outbound_close', runtime: 'node', reason: 'deferred_byte_limit' });
  for (const field of ['bufferedBytes', 'deferredBytes', 'deferredFrames', 'outstandingWrites', 'oversizedFrameBytes', 'drainElapsedMs']) {
    expect(typeof record[field]).toBe('number');
    expect(Number.isFinite(record[field] as number)).toBe(true);
  }
  expect(JSON.stringify(record)).not.toContain('private');
}, 15_000);
