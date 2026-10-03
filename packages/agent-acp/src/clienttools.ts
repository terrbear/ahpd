import type { ToolCall } from '@agentclientprotocol/sdk';
import type { BoundTool, ClientToolCall, ClientToolResult } from '@ahpd/sdk';

type Answer = (answer: ClientToolResult) => void;

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
  const expecting = new Map<string, ((id: string) => void)[]>();
  const byClient = new Map<string, { owner: string; settle: Answer }>();

  const providing = (call: ToolCall): BoundTool | undefined => {
    const said = [call.title, 'name' in call ? call.name : undefined]
      .filter((one): one is string => typeof one === 'string');
    return offering.find((one) => one.owner !== undefined && said.some((text) => text.includes(one.definition.name)));
  };

  const claim = (name: string, input: string): Promise<string> => {
    const open = unclaimed.get(name) ?? [];
    const at = open.findIndex((one) => one.input === input);
    const took = at >= 0 ? open.splice(at, 1)[0] : open.shift();
    unclaimed.set(name, open);
    if (took !== undefined) return Promise.resolve(took.id);
    return new Promise((resolve, reject) => {
      const waiting = expecting.get(name) ?? [];
      const timer = setTimeout(() => {
        expecting.set(name, (expecting.get(name) ?? []).filter((one) => one !== resolve));
        reject(new Error('The agent never reported this tool call'));
      }, REPORT_WAIT_MS);
      waiting.push((id) => { clearTimeout(timer); resolve(id); });
      expecting.set(name, waiting);
    });
  };

  const release = (why: string, whose?: string): void => {
    for (const [id, held] of [...byClient.entries()]) {
      if (whose !== undefined && held.owner !== whose) continue;
      byClient.delete(id);
      held.settle({ text: why, ok: false });
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
      const first = (expecting.get(name) ?? []).shift();
      if (first !== undefined) first(call.toolCallId);
      else unclaimed.set(name, [...(unclaimed.get(name) ?? []), { id: call.toolCallId, input, owner: tool.owner ?? '' }]);
      return tool.owner;
    },

    /** Runs a call the tools server was asked for, resolving with what its client says. */
    run: async (call: ClientToolCall, started: (id: string) => void): Promise<ClientToolResult> => {
      const id = await claim(call.tool.definition.name, JSON.stringify(call.input));
      started(id);
      const answered = early.get(id);
      if (answered !== undefined) {
        early.delete(id);
        return answered;
      }
      return await new Promise((settle) => { byClient.set(id, { owner: call.tool.owner ?? '', settle }); });
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
      if (whose === undefined) {
        early.clear();
        unclaimed.clear();
      }
      release(why, whose);
    },
  };
}
