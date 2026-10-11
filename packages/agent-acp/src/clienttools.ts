import type { ToolCall } from '@agentclientprotocol/sdk';
import type { BoundTool, ClientToolCall, ClientToolResult } from '@ahpd/sdk';

type Answer = (answer: ClientToolResult) => void;
type ReportWaiter = {
  owner: string;
  accept: (id: string) => void;
  cancel: (why: string) => void;
};

/** The longest a bridge call waits to hear the agent report it, so a call the agent never reports cannot hang. */
const REPORT_WAIT_MS = 30_000;

/** The arguments a call was given, whether the agent reports them bare or wrapped as `{ server, tool, arguments }`. */
const argumentsOf = (raw: unknown): unknown => {
  if (typeof raw === 'object' && raw !== null && 'tool' in raw && 'arguments' in raw) return (raw as { arguments: unknown }).arguments;
  return raw ?? null;
};

/**
 * The calls a session's clients run, joined between what the agent reports and what the tools server is asked.
 *
 * An ACP agent reports a tool call under its own id, and the MCP request that
 * runs it carries no such id. The two are matched by the tool's name, then by
 * its input, and whichever arrives first waits for the other.
 */
export function clientTools() {
  let offering: BoundTool[] = [];
  const unclaimed = new Map<string, { id: string; input: string; owner: string }[]>();
  const early = new Map<string, ClientToolResult>();
  const expecting = new Map<string, ReportWaiter[]>();
  const generations = new Map<string, number>();
  const byClient = new Map<string, { owner: string; settle: Answer }>();

  const providing = (call: ToolCall): BoundTool | undefined => {
    const said = [call.title, 'name' in call ? call.name : undefined]
      .filter((one): one is string => typeof one === 'string');
    return offering.find((one) => one.owner !== undefined && said.some((text) => text.includes(one.definition.name)));
  };

  const claim = (name: string, input: string, owner: string, callId?: string): Promise<string> => {
    const open = unclaimed.get(name) ?? [];
    const exact = open.findIndex((one) => one.owner === owner && one.input === input);
    const at = exact >= 0 ? exact : open.findIndex((one) => one.owner === owner);
    const took = at >= 0 ? open.splice(at, 1)[0] : undefined;
    unclaimed.set(name, open);
    if (took !== undefined) return Promise.resolve(took.id);
    return new Promise((resolve, reject) => {
      const remove = (): void => {
        const remaining = (expecting.get(name) ?? []).filter((one) => one !== waiter);
        if (remaining.length === 0) expecting.delete(name);
        else expecting.set(name, remaining);
        clearTimeout(timer);
      };
      const waiter: ReportWaiter = {
        owner,
        accept: (id) => { remove(); resolve(id); },
        cancel: (why) => {
          remove();
          reject(new Error(`${why}; tool=${name}, client=${owner}, state=awaiting-agent-report, toolCallId=${callId ?? 'unavailable'}; reconnect Anton and retry the read-only check`));
        },
      };
      const timer = setTimeout(() => {
        waiter.cancel('AHP timed out after 30000ms waiting for the agent to report the tool call');
      }, REPORT_WAIT_MS);
      expecting.set(name, [...(expecting.get(name) ?? []), waiter]);
    });
  };

  const release = (why: string, whose?: string): void => {
    for (const [id, held] of [...byClient.entries()]) {
      if (whose !== undefined && held.owner !== whose) continue;
      byClient.delete(id);
      held.settle({ text: `${why}; toolCallId=${id}, client=${held.owner}, state=awaiting-client-result; reconnect Anton and check the outcome before retrying`, ok: false });
    }
  };

  return {
    set: (tools: BoundTool[]): void => { offering = [...tools]; },
    tools: (): BoundTool[] => offering,

    /** The client a reported call belongs to, remembering the call for the request that runs it. */
    clientOf: (call: ToolCall): string | undefined => {
      const tool = providing(call);
      if (tool === undefined) return undefined;
      const name = tool.definition.name;
      const input = JSON.stringify(argumentsOf(call.rawInput));
      const first = (expecting.get(name) ?? []).find((one) => one.owner === tool.owner);
      if (first !== undefined) first.accept(call.toolCallId);
      else unclaimed.set(name, [...(unclaimed.get(name) ?? []), { id: call.toolCallId, input, owner: tool.owner ?? '' }]);
      return tool.owner;
    },

    /** Runs a call the tools server was asked for, resolving with what its client says. */
    run: async (call: ClientToolCall, started: (id: string) => void): Promise<ClientToolResult> => {
      const owner = call.tool.owner ?? '';
      const generation = generations.get(owner) ?? 0;
      generations.set(owner, generation);
      const id = await claim(call.tool.definition.name, JSON.stringify(call.input), owner, call.callId);
      if ((generations.get(owner) ?? 0) !== generation) {
        return { text: `The client disconnected before execution was dispatched; toolCallId=${id}, client=${owner}, state=cancelled-before-dispatch; reconnect Anton and retry the read-only check`, ok: false };
      }
      const answered = early.get(id);
      if (answered !== undefined) {
        early.delete(id);
        return answered;
      }
      return await new Promise((settle, reject) => {
        byClient.set(id, { owner, settle });
        try { started(id); }
        catch (error) {
          byClient.delete(id);
          const reason = error instanceof Error ? error.message : String(error);
          reject(new Error(`Unable to publish client tool execution; toolCallId=${id}, client=${owner}, state=dispatch-failed: ${reason}; reconnect Anton and check the outcome before retrying`));
        }
      });
    },

    owner: (id: string): string | undefined => byClient.get(id)?.owner,

    complete: (id: string, clientId: string, result: ClientToolResult): boolean => {
      const reported = [...unclaimed.values()].flat().find((one) => one.id === id);
      if (reported !== undefined && reported.owner === clientId) {
        early.set(id, result);
        return true;
      }
      const held = byClient.get(id);
      if (held === undefined || held.owner !== clientId) return false;
      byClient.delete(id);
      held.settle(result);
      return true;
    },

    release: (why: string, whose?: string): void => {
      const owners = new Set<string>();
      for (const waiting of [...expecting.values()]) {
        for (const held of [...waiting]) {
          if (whose !== undefined && held.owner !== whose) continue;
          owners.add(held.owner);
          held.cancel(why);
        }
      }
      for (const [name, reports] of unclaimed) {
        const remaining = reports.filter((one) => {
          if (whose !== undefined && one.owner !== whose) return true;
          owners.add(one.owner);
          early.delete(one.id);
          return false;
        });
        if (remaining.length === 0) unclaimed.delete(name);
        else unclaimed.set(name, remaining);
      }
      for (const held of byClient.values()) {
        if (whose === undefined || held.owner === whose) owners.add(held.owner);
      }
      if (whose !== undefined) owners.add(whose);
      else for (const owner of generations.keys()) owners.add(owner);
      for (const owner of owners) generations.set(owner, (generations.get(owner) ?? 0) + 1);
      release(why, whose);
    },
  };
}
