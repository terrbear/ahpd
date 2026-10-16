import { hostname, userInfo } from 'node:os';
import type { Agent, ResourceProvider } from '@ahpd/sdk';

export function cliHistoryProvider(agents: Agent[], identity = { host: hostname(), user: String(userInfo().uid) }): ResourceProvider {
  return {
    read: async (uri, _wanted, reader) => {
      const observedAt = new Date().toISOString();
      let result: Record<string, unknown> = { version: 1, status: 'unavailable', writable: false };
      try {
        if (reader !== undefined) throw new Error();
        const url = new URL(uri);
        const id = url.pathname.slice(1);
        if (url.protocol !== 'ahpd-cli-history:' || url.username || url.password || url.port || url.hash || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id)) throw new Error();
        if (url.searchParams.getAll('host').length !== 1 || url.searchParams.getAll('user').length !== 1 || [...url.searchParams.keys()].some(k => k !== 'host' && k !== 'user')) throw new Error();
        if (url.searchParams.get('host') !== identity.host || url.searchParams.get('user') !== identity.user) throw new Error();
        const agent = agents.find(one => one.provider === url.hostname && ['claude', 'codex'].includes(one.provider));
        if (!agent) throw new Error();
        const external = await agent.externalHistory?.(id);
        if (!external) throw new Error();
        const { format, history } = external;
        const candidate = { version: 1, status: 'available', writable: false, host: identity.host, user: identity.user, provider: agent.provider, nativeId: id, format, history, observedAt };
        if (Buffer.byteLength(JSON.stringify(candidate)) > 8 * 1024 * 1024) throw new Error();
        result = candidate;
      } catch {
        result = { version: 1, status: 'unavailable', writable: false };
      }
      return { data: JSON.stringify(result), encoding: 'utf-8', contentType: 'application/json' };
    },
  };
}
