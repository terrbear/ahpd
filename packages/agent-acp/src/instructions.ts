import type { InitializeResponse } from '@agentclientprotocol/sdk';

export function customInstructionsMeta(instructions: string | undefined, handshake: InitializeResponse) {
  if (instructions === undefined) return {};
  const air = (handshake._meta as { jetbrains?: { air?: { version?: unknown; capabilities?: unknown } } } | undefined)?.jetbrains?.air;
  if (typeof air?.version !== 'number' || air.version < 1 || !Array.isArray(air.capabilities) || !air.capabilities.includes('customInstructions')) {
    throw new Error('Codex ACP server does not advertise customInstructions; update the pinned adapter before sending a turn');
  }
  return { _meta: { jetbrains: { air: { customInstructions: instructions } } } };
}
