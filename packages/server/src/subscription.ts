import type { Agent, ResourceProvider } from '@ahpd/sdk';

type UsageWindow = { used: number; windowSeconds: number; resetsAt: string };

const unavailable = { status: 'unavailable' } as const;

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined;

function usageWindow(value: unknown, now: number): UsageWindow | undefined {
  const { used, windowSeconds, resetsAt } = record(value) ?? {};
  if (typeof used !== 'number' || !Number.isFinite(used) || used < 0 || used > 1 ||
      typeof windowSeconds !== 'number' || !Number.isSafeInteger(windowSeconds) || windowSeconds < 3600 || windowSeconds > 3_024_000 ||
      typeof resetsAt !== 'string') return undefined;
  const reset = Date.parse(resetsAt);
  if (!Number.isFinite(reset) || reset <= now || reset > now + windowSeconds * 1000 + 300_000) return undefined;
  return { used, windowSeconds, resetsAt: new Date(reset).toISOString() };
}

function verifiedUsage(answer: unknown, now: number) {
  const { status, name, reportedAt, windows } = record(answer) ?? {};
  if (status !== 'verified' || typeof name !== 'string' || name.length > 254 ||
      !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(name) || typeof reportedAt !== 'string' ||
      !Array.isArray(windows) || windows.length > 2) return unavailable;
  const reported = Date.parse(reportedAt);
  if (!Number.isFinite(reported) || reported > now + 300_000 || reported < now - 1_800_000) return unavailable;
  const active = windows.map((window) => usageWindow(window, now)).filter((window) => window !== undefined);
  if (active.length === 0) return unavailable;
  return { status: 'verified', name, reportedAt: new Date(reported).toISOString(), windows: active };
}

export function subscriptionProvider(agents: Agent[]): ResourceProvider {
  const pending = new Map<Agent, Promise<unknown>>();
  return {
    read: async (requested, _wanted, reader) => {
      let usage: ReturnType<typeof verifiedUsage> = unavailable;
      const provider = ['codex', 'claude'].find((name) => requested === 'ahpd-subscription://' + name);
      const agent = reader === undefined && provider !== undefined ? agents.find((one) => one.provider === provider) : undefined;
      if (agent?.subscriptionUsage !== undefined) {
        try {
          let read = pending.get(agent);
          if (read === undefined) {
            read = agent.subscriptionUsage().finally(() => pending.delete(agent));
            pending.set(agent, read);
          }
          usage = verifiedUsage(await read, Date.now());
        } catch {
          usage = unavailable;
        }
      }
      return { data: JSON.stringify(usage), encoding: 'utf-8', contentType: 'application/json' };
    },
  };
}
