import type { Bag } from './types/common.js';

const MAX_CALLS = 32;
const MAX_SCAN = 512;
const MAX_BYTES = 32768;
const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 && Buffer.byteLength(value, 'utf8') <= 512 ? value : undefined;
const object = (value: unknown): Bag => typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Bag : {};
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const statuses = new Set(['streaming', 'pending-confirmation', 'running', 'auth-required', 'pending-result-confirmation', 'completed', 'cancelled']);

const canonicalOwner = (value: unknown): string | undefined =>
  typeof value === 'string' && /^(user|team|project|root):[^\s\x00-\x1f\x7f]+$/u.test(value) ? value : undefined;

export const assertDiagnosticTarget = (
  caller: { session: string; owner?: string | undefined },
  target: { session: string; owner?: string | undefined; chat: string; actualChat: string },
): void => {
  const owner = canonicalOwner(caller.owner);
  if (target.chat !== target.actualChat || (owner === undefined
    ? caller.session !== target.session
    : owner !== canonicalOwner(target.owner))) throw new Error('Execution diagnostics require an exact live chat in the calling session owner scope');
};

export const sessionExecutionDiagnostics = (source: {
  session: string;
  chat: string;
  snapshot: Bag;
  inputNeeded?: unknown;
  activeClients: unknown[];
  connectedClients: ReadonlySet<string>;
  connectionsComplete?: boolean;
  probe?: (ids: readonly string[]) => Bag;
}): Bag => {
  const calls: Bag[] = [];
  const turns = array(source.snapshot.turns);
  const active = object(source.snapshot.activeTurn);
  let scanned = 0;
  let truncated = false;
  for (let turnIndex = turns.length; turnIndex >= 0; turnIndex--) {
    const turn = turnIndex === turns.length ? active : object(turns[turnIndex]);
    const parts = array(turn.responseParts);
    for (let partIndex = parts.length - 1; partIndex >= 0; partIndex--) {
      if (++scanned > MAX_SCAN || calls.length >= MAX_CALLS) { truncated = true; break; }
      const part = object(parts[partIndex]);
      if (part.kind !== 'toolCall') continue;
      const call = object(part.toolCall);
      const contributor = object(call.contributor);
      let contributorIdentity: Bag = { kind: contributor.kind === 'mcp' ? 'mcp' : 'unknown' };
      if (contributor.kind === 'client') contributorIdentity = { kind: 'client', clientId: text(contributor.clientId) ?? null };
      calls.push({
        turnId: text(turn.id) ?? null,
        toolCallId: text(call.toolCallId) ?? null,
        name: text(call.toolName) ?? null,
        status: typeof call.status === 'string' && statuses.has(call.status) ? call.status : 'unknown',
        contributor: contributorIdentity,
        completionReceipt: 'unknown', requestAge: 'unknown',
      });
    }
    if (truncated) break;
    if (++scanned > MAX_SCAN) { truncated = true; break; }
  }
  const ids = calls.flatMap((call) => typeof call.toolCallId === 'string' ? [call.toolCallId] : []);
  let observed: Bag | undefined;
  try {
    const candidate = source.probe?.(ids);
    if (typeof candidate === 'object' && candidate !== null && !Array.isArray(candidate)
      && Array.isArray(candidate.calls) && typeof candidate.scanComplete === 'boolean') observed = candidate;
  } catch { observed = undefined; }
  const backendRows = array(observed?.calls).slice(0, MAX_CALLS).map(object);
  const pending = array(source.inputNeeded);
  const pendingComplete = Array.isArray(source.inputNeeded) && pending.length <= MAX_SCAN;
  for (const call of calls) {
    const matches = pending.slice(0, MAX_SCAN).map(object).filter((request) => typeof call.toolCallId === 'string' && typeof call.turnId === 'string' && request.kind === 'toolClientExecution'
      && request.chat === source.chat && request.turnId === call.turnId && object(request.toolCall).toolCallId === call.toolCallId);
    const request = matches.length === 1 ? matches[0] : undefined;
    const clientId = text(object(call.contributor).clientId);
    const client = source.activeClients.slice(0, MAX_SCAN).map(object).find((one) => one.clientId === clientId);
    const requestCall = object(request?.toolCall);
    const requestOwner = text(request?.clientId);
    const requestContributor = text(object(requestCall.contributor).clientId);
    let registered: boolean | string = 'unknown';
    if (client !== undefined) registered = true;
    else if (source.activeClients.length <= MAX_SCAN) registered = false;
    let connected: boolean | string = 'unknown';
    if (clientId !== undefined && source.connectedClients.has(clientId)) connected = true;
    else if (source.connectionsComplete !== false) connected = false;
    call.client = clientId === undefined ? { state: 'unknown' } : {
      clientId, connected,
      registered,
    };
    let requestState = 'unknown';
    if (matches.length > 1) requestState = 'conflicting';
    else if (pendingComplete) requestState = 'not-observed';
    const requestName = text(requestCall.toolName);
    call.clientExecution = request === undefined ? { state: requestState } : {
      state: 'pending', requestId: text(request.id) ?? null, clientId: requestOwner ?? null,
      ownerMatches: requestOwner !== undefined && requestOwner === clientId && requestContributor === clientId
        && object(requestCall.contributor).kind === 'client',
      registrationMatches: requestName === undefined || client === undefined || !Array.isArray(client.tools) || client.tools.length > MAX_SCAN ? 'unknown'
        : client.tools.slice(0, MAX_SCAN).map(object).some((tool) => text(tool.name) === requestName),
    };
    const backend = typeof call.toolCallId === 'string' ? backendRows.find((one) => one.toolCallId === call.toolCallId) : undefined;
    call.broker = backend === undefined ? { state: 'unknown' } : {
      state: 'observed',
      announcementRegistered: typeof backend.announcementRegistered === 'boolean' ? backend.announcementRegistered : 'unknown',
      announcementAwaitingHandler: typeof backend.announcementAwaitingHandler === 'boolean' ? backend.announcementAwaitingHandler : 'unknown',
      handlerAwaitingAnnouncement: typeof backend.handlerAwaitingAnnouncement === 'boolean' ? backend.handlerAwaitingAnnouncement : 'unknown',
      awaitingApproval: typeof backend.awaitingApproval === 'boolean' ? backend.awaitingApproval : 'unknown',
      approvedClaim: typeof backend.approvedClaim === 'string' && ['reserved', 'taken', 'none'].includes(backend.approvedClaim) ? backend.approvedClaim : 'unknown',
      clientRequestPublished: typeof backend.clientRequestPublished === 'boolean' ? backend.clientRequestPublished : 'unknown',
    };
  }
  const result: Bag = {
    session: text(source.session) ?? null, chat: text(source.chat) ?? null, activeTurnId: text(active.id) ?? null,
    calls: calls.reverse(), truncated, backendState: observed === undefined ? 'unknown' : 'observed',
    backendScanComplete: typeof observed?.scanComplete === 'boolean' ? observed.scanComplete : 'unknown',
    unidentifiedWaitingHandlers: typeof observed?.unidentifiedWaitingHandlers === 'number'
      && Number.isSafeInteger(observed.unidentifiedWaitingHandlers) && observed.unidentifiedWaitingHandlers >= 0
      ? observed.unidentifiedWaitingHandlers : 'unknown',
    completionReceipt: 'unknown', requestAge: 'unknown',
  };
  while (Buffer.byteLength(JSON.stringify(result), 'utf8') > MAX_BYTES && calls.length > 0) {
    calls.shift(); result.truncated = true;
  }
  return result;
};
