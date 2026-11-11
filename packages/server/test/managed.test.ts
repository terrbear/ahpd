import { expect, it, vi } from 'vitest';
import { managedLifecycle, managedPlugins } from '../src/managed.js';

it('refuses updates while a turn runs, then closes admissions before shutdown', () => {
  let listener: (message: unknown) => void = () => {};
  let busy = true;
  const events: string[] = [];
  const send = vi.fn();
  managedLifecycle({ on: (_event, next) => { listener = next; }, send }, {
    turning: () => busy ? ['session'] : [],
    close: () => { events.push('closed'); return Promise.resolve(); },
  }, () => events.push('shutdown'));
  expect(send).toHaveBeenCalledWith({ type: 'managed-ready' });
  listener({ type: 'managed-drain' });
  expect(send).toHaveBeenLastCalledWith({ type: 'managed-busy' });
  expect(events).toEqual([]);
  busy = false;
  listener({ type: 'managed-drain' });
  expect(events).toEqual(['closed', 'shutdown']);
  expect(send).toHaveBeenLastCalledWith({ type: 'managed-draining' });
  listener({ type: 'managed-drain' });
  expect(events).toHaveLength(2);
});

it('ignores unrelated IPC messages', () => {
  let listener: (message: unknown) => void = () => {};
  const close = vi.fn();
  managedLifecycle({ on: (_event, next) => { listener = next; }, send: () => {} }, { turning: () => [], close }, vi.fn());
  for (const message of [null, 'managed-drain', {}, { type: 'other' }]) listener(message);
  expect(close).not.toHaveBeenCalled();
});

it('changes only managed plugin paths, preserving custom plugins, options and relative credentials', () => {
  const config = { connectionTokenFile: 'token', plugins: ['/source/packages/agent-claude',
    { name: '/source/packages/agent-acp', options: { command: '/custom/codex', env: { KEEP: 'yes' } } },
    '/custom/plugin'] };
  expect(managedPlugins(config.plugins, '/source', '/release')).toEqual([
    '/release/packages/agent-claude', { name: '/release/packages/agent-acp', options: { command: '/custom/codex', env: { KEEP: 'yes' } } }, '/custom/plugin',
  ]);
  expect(config.plugins[0]).toBe('/source/packages/agent-claude');
});

it('uses the release adapter only for validated enabled Codex commands and preserves rollback configuration', () => {
  const managed = { name: '/source/packages/agent-acp', options: { provider: 'codex', command: '/old/adapter', env: { KEEP: 'yes' } } };
  const custom = { name: '/custom/plugin', options: { provider: 'codex', command: '/custom/adapter' } };
  const disabled = { ...managed, enabled: false };
  const other = { ...managed, options: { provider: 'other', command: '/old/adapter' } };
  const plugins = [managed, custom, disabled, other];
  const result = managedPlugins(plugins, '/source', '/release', { '/old/adapter': '/new/adapter' });
  expect(result[0]).toEqual({ ...managed, name: '/release/packages/agent-acp', options: { ...managed.options, command: '/new/adapter' } });
  expect(result[1]).toEqual(custom);
  expect(result[2]).toEqual({ ...disabled, name: '/release/packages/agent-acp' });
  expect(result[3]).toEqual({ ...other, name: '/release/packages/agent-acp' });
  expect(managed.options.command).toBe('/old/adapter');
  expect(managedPlugins(plugins, '/source', '/old-release')[0]).toEqual({ ...managed, name: '/old-release/packages/agent-acp' });
});

