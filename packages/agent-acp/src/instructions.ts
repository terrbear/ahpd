import type { InitializeResponse } from '@agentclientprotocol/sdk';

export function customInstructionsMeta(instructions: string | undefined, handshake: InitializeResponse) {
  if (instructions === undefined) return {};
  const support = handshake._meta?.['ahpd.clientSystemInstructions'];
  if (typeof support !== 'object' || support === null || (support as { version?: unknown }).version !== 1) {
    throw new Error('Codex ACP server does not advertise client system instructions; update the pinned adapter before sending a turn');
  }
  return { _meta: { 'ahpd.clientSystemInstructions': instructions } };
}
