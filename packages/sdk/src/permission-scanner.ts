import type { Connection } from './types/host.js';
import type { Bag } from './types/common.js';

export interface PermissionScanRequest {
  chat: string;
  turnId: string;
  toolCallId: string;
  toolName: string;
  cwd: string;
  input: Bag;
}

export const permissionScannerRequested = (metadata: unknown): boolean => {
  if (typeof metadata !== 'object' || metadata === null) return false;
  const value = (metadata as Bag)['ahpd.permissionScanner'];
  return typeof value === 'object' && value !== null && (value as Bag).version === 1;
};

export function permissionScanners(connected: (client: Connection) => boolean, owner: (client: Connection) => string | undefined) {
  const registrations = new Map<string, { client: Connection; clientId: string; owner: string | undefined }>();
  return {
    register: (session: string, client: Connection): void => {
      if (client.clientId === '' || client.clientId === 'anonymous') return;
      registrations.set(session, { client, clientId: client.clientId, owner: owner(client) });
    },
    rebind: (session: string, client: Connection): void => {
      const held = registrations.get(session);
      if (held === undefined || held.client === client) return;
      if (held.clientId !== client.clientId || held.owner !== owner(client)) return;
      if (client.principal === undefined && client.root !== true) return;
      registrations.set(session, { ...held, client });
    },
    scan: async (session: string, request: PermissionScanRequest, signal: AbortSignal): Promise<'allow' | 'abstain'> => {
      const held = registrations.get(session);
      if (!scannableBashInput(request.toolName, request.input)) return 'abstain';
      if (held === undefined || signal.aborted || !connected(held.client) || owner(held.client) !== held.owner) return 'abstain';
      let timer: ReturnType<typeof setTimeout> | undefined;
      let abort: (() => void) | undefined;
      const expired = new Promise<undefined>((resolve) => {
        timer = setTimeout(() => { resolve(undefined); }, 1500);
        abort = () => { resolve(undefined); };
        signal.addEventListener('abort', abort, { once: true });
      });
      try {
        const reply = await Promise.race([held.client.peer.request('anton/scanPermission', { ...request, session }, 1500), expired]);
        if (signal.aborted || registrations.get(session) !== held || !connected(held.client) || owner(held.client) !== held.owner) return 'abstain';
        return typeof reply === 'object' && reply !== null && (reply as Bag).decision === 'allow' ? 'allow' : 'abstain';
      }
      catch { return 'abstain'; }
      finally {
        clearTimeout(timer);
        if (abort !== undefined) signal.removeEventListener('abort', abort);
      }
    },
    forget: (session: string): void => { registrations.delete(session); },
  };
}

export function scannableBashInput(toolName: string, input: Bag): boolean {
  if (toolName !== 'Bash' || typeof input.command !== 'string' || input.command.trim() === '') return false;
  for (const [key, value] of Object.entries(input)) {
    switch (key) {
      case 'command': break;
      case 'description': if (typeof value !== 'string') return false; break;
      case 'timeout': if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return false; break;
      case 'run_in_background': if (typeof value !== 'boolean') return false; break;
      default: return false;
    }
  }
  return true;
}
