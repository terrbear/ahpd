import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { cycle } from './managed-cycle.mjs';


const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const until = async (check: () => boolean) => {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('condition not reached');
};

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'managed-update-'));
  roots.push(root);
  const config = join(root, 'config.json');
  writeFileSync(config, JSON.stringify({ plugins: ['/source/packages/agent-claude'], connectionTokenFile: 'token' }));
  const child = Object.assign(new EventEmitter(), { connected: true, send: vi.fn(), kill: vi.fn() });
  const start = vi.fn(() => child);
  const prepare = vi.fn(async () => '/new');
  const options = { source: '/source', current: '/source', config };
  const dependencies = { start, prepare, log: vi.fn(), pollMs: 10, readyTimeoutMs: 1000 };
  return { root, child, options, dependencies };
}

it('stages an update while busy and activates only after an idle handoff', async () => {
  const f = fixture();
  const result = cycle(f.options, f.dependencies);
  await until(() => f.dependencies.start.mock.calls.length > 0);
  f.child.emit('message', { type: 'managed-ready' });
  await until(() => f.child.send.mock.calls.length > 0);
  expect(f.child.send).toHaveBeenLastCalledWith({ type: 'managed-drain' });
  f.child.emit('message', { type: 'managed-busy' });
  expect(f.child.kill).not.toHaveBeenCalled();
  await until(() => f.child.send.mock.calls.length > 1);
  f.child.emit('message', { type: 'managed-draining' });
  f.child.emit('exit', 0);
  expect(await result).toMatchObject({ current: '/new', previous: '/source', probation: true });
  expect(f.dependencies.prepare).toHaveBeenCalledTimes(1);
});

it('rolls a candidate back when it exits before readiness and remembers the bad revision', async () => {
  const f = fixture();
  const result = cycle({ ...f.options, current: '/bad', previous: '/source', probation: true }, f.dependencies);
  await until(() => f.dependencies.start.mock.calls.length > 0);
  f.child.emit('exit', 1);
  expect(await result).toMatchObject({ current: '/source' });
  expect(JSON.parse(readFileSync(join(f.root, 'managed-update-state.json'), 'utf8'))).toEqual({ current: '/source', failed: 'bad' });
});

it('disables automatic builds without stopping the host', async () => {
  const f = fixture();
  writeFileSync(join(f.root, 'self-update.json'), '{"enabled":false}');
  const result = cycle(f.options, f.dependencies);
  await until(() => f.dependencies.start.mock.calls.length > 0);
  f.child.emit('message', { type: 'managed-ready' });
  await new Promise((resolve) => setTimeout(resolve, 40));
  expect(f.dependencies.prepare).not.toHaveBeenCalled();
  expect(f.child.send).not.toHaveBeenCalled();
  f.child.emit('exit', 1);
  await expect(result).rejects.toThrow('exited unexpectedly');
});

it('keeps serving when a build fails and does not retry on each idle poll', async () => {
  const f = fixture();
  f.dependencies.prepare.mockRejectedValue(new Error('offline'));
  const result = cycle(f.options, f.dependencies);
  await until(() => f.dependencies.start.mock.calls.length > 0);
  f.child.emit('message', { type: 'managed-ready' });
  await until(() => f.dependencies.prepare.mock.calls.length > 0);
  await new Promise((resolve) => setTimeout(resolve, 40));
  expect(f.dependencies.prepare).toHaveBeenCalledTimes(1);
  expect(f.child.send).not.toHaveBeenCalled();
  expect(f.child.kill).not.toHaveBeenCalled();
  f.child.emit('exit', 1);
  await expect(result).rejects.toThrow('exited unexpectedly');
});

it('times out a candidate that never becomes ready and falls back', async () => {
  const f = fixture();
  const result = cycle({ ...f.options, current: '/bad', previous: '/source', probation: true }, { ...f.dependencies, readyTimeoutMs: 20 });
  await until(() => f.child.kill.mock.calls.length > 0);
  expect(f.child.kill).toHaveBeenCalledWith('SIGKILL');
  f.child.emit('exit', null);
  expect(await result).toMatchObject({ current: '/source' });
});

it('reads the release channel from the source checkout, not the detached release', async () => {
  const f = fixture();
  const result = cycle({ ...f.options, current: '/release' }, f.dependencies);
  await until(() => f.dependencies.start.mock.calls.length > 0);
  f.child.emit('message', { type: 'managed-ready' });
  await until(() => f.dependencies.prepare.mock.calls.length > 0);
  expect(f.dependencies.prepare).toHaveBeenCalledWith(f.root, '/release', expect.any(AbortSignal), '/source');
  f.child.emit('exit', 1);
  await expect(result).rejects.toThrow('exited unexpectedly');
});

it('rejects a ready candidate that silently lost a provider', async () => {
  const f = fixture();
  writeFileSync(join(f.root, 'managed-update-state.json'), JSON.stringify({ current: '/source', providers: ['claude', 'codex'] }));
  const result = cycle({ ...f.options, current: '/bad', previous: '/source', probation: true }, f.dependencies);
  await until(() => f.dependencies.start.mock.calls.length > 0);
  f.child.emit('message', { type: 'managed-ready', providers: ['codex'] });
  expect(f.child.kill).toHaveBeenCalledWith('SIGKILL');
  f.child.emit('exit', null);
  expect(await result).toMatchObject({ current: '/source' });
});
