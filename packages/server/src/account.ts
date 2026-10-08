import type { Agent, ResourceProvider } from '@ahpd/sdk';

export function accountProvider(agents: Agent[]): ResourceProvider {
  const unavailable = { status: 'unavailable' } as const;
  const named = (uri: string): { agent: Agent; directory?: string } | undefined => {
    let url: URL;
    try { url = new URL(uri); } catch { return undefined; }
    if (url.protocol !== 'ahpd-account:' || url.pathname !== '' || url.hash !== '' || !/^[a-z][a-z0-9-]*$/.test(url.hostname)) return undefined;
    if ([...url.searchParams.keys()].some((key) => key !== 'cwd') || url.searchParams.getAll('cwd').length > 1) return undefined;
    const agent = agents.find((one) => one.provider === url.hostname);
    if (agent === undefined) return undefined;
    const directory = url.searchParams.get('cwd');
    return { agent, ...(directory === null ? {} : { directory }) };
  };
  return {
    authorize: async (uri) => named(uri) !== undefined,
    read: async (uri) => {
      const target = named(uri);
      let identity: { status: 'verified'; name: string } | { status: 'unavailable' } = unavailable;
      try {
        if (target?.agent.accountIdentity !== undefined) {
          const claimed = await target.agent.accountIdentity(target.directory);
          if (claimed.status === 'verified' && typeof claimed.name === 'string' && claimed.name.length <= 254 && /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(claimed.name)) identity = { status: 'verified', name: claimed.name };
        }
      } catch {
        identity = unavailable;
      }
      return { data: JSON.stringify(identity), encoding: 'utf-8', contentType: 'application/json' };
    },
  };
}
