import type { Host, PluginSpec } from '@ahpd/sdk';

export interface ManagedChannel {
  on(event: 'message', listener: (message: unknown) => void): unknown;
  send(message: unknown): unknown;
}

export function managedLifecycle(channel: ManagedChannel, host: Pick<Host, 'turning' | 'close'>, shutdown: () => void, providers?: string[]): void {
  let draining = false;
  channel.on('message', (message) => {
    if (typeof message !== 'object' || message === null || !('type' in message) || message.type !== 'managed-drain') return;
    if (draining) return;
    if (host.turning().length > 0) {
      channel.send({ type: 'managed-busy' });
      return;
    }
    draining = true;
    void host.close().catch(() => {});
    channel.send({ type: 'managed-draining' });
    shutdown();
  });
  channel.send({ type: 'managed-ready', ...(providers ? { providers } : {}) });
}

export function managedPlugins(plugins: PluginSpec[], source: string, current: string, adapters: Record<string, string> = {}): PluginSpec[] {
  const move = (path: string): string => path.startsWith(`${source}/packages/`) ? current + path.slice(source.length) : path;
  return plugins.map((plugin) => {
    if (typeof plugin === 'string') return move(plugin);
    const options = plugin.options;
    const command = options?.command;
    const replacement = typeof command === 'string' && Object.hasOwn(adapters, command) ? adapters[command] : undefined;
    if (plugin.enabled !== false && options?.provider === 'codex' && typeof replacement === 'string') {
      return { ...plugin, name: move(plugin.name), options: { ...options, command: replacement } };
    }
    return { ...plugin, name: move(plugin.name) };
  });
}
