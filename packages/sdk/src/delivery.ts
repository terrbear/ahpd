import { createHash } from 'node:crypto';
import type { Bag } from './types/common.js';
import type { MessageFrom, Session } from './types/session.js';

type Target = { resource: string; chat: string; session: Session };
type Source = { session: string; chat: string };
type Entry = Source & {
  deliveryId: string;
  generation: string;
  resource: string;
  targetChat: string;
  targetSession: Session;
  queueId?: string;
  acceptedAt: string;
  state: 'accepted' | 'queued' | 'consumed' | 'superseded' | 'removed' | 'uncertain';
  turnId?: string;
  supersededBy?: string;
  reason?: string;
  fingerprint: string;
  origin: string;
  sourceTurnId?: string;
};
type Waiter = { owner: Session; resource: string; chat: string; turnId: string; finish: (confirmed: boolean) => void };

const object = (value: unknown): Bag => typeof value === 'object' && value !== null ? value as Bag : {};
const pending = (target: Target): Bag[] => {
  const held = target.session.chatState().queuedMessages;
  return Array.isArray(held) ? held as Bag[] : [];
};
const fingerprint = (text: string): string => createHash('sha256').update(text).digest('hex');
const matches = (held: Bag, entry: Entry): boolean => {
  const message = object(held.message);
  if (fingerprint(String(message.text ?? '')) !== entry.fingerprint) return false;
  if (message.origin !== undefined && object(message.origin).kind !== entry.origin) return false;
  const meta = object(message._meta);
  if (Object.hasOwn(meta, 'ahpd.delivery') && meta['ahpd.delivery'] !== entry.deliveryId) return false;
  const raw = meta['vscode.chat.delegation'];
  if (raw !== undefined) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return false;
    const delegation = object(raw);
    const expected: Bag = { sourceSession: entry.session, sourceChat: entry.chat, sourceTurnId: entry.sourceTurnId };
    for (const key of Object.keys(expected)) {
      if (Object.hasOwn(delegation, key) && delegation[key] !== expected[key]) return false;
    }
  }
  return true;
};
const terminal = (target: Target, turnId: string): boolean => target.session.allTurns().some((turn) =>
  turn.id === turnId && ['complete', 'cancelled', 'error'].includes(String(turn.state)));
const preview = (text: string): Bag => {
  let shown = '';
  let bytes = 0;
  for (const char of text.slice(0, 1024)) {
    const size = new TextEncoder().encode(char).length;
    if (bytes + size > 1024) break;
    shown += char;
    bytes += size;
  }
  return { text: shown, truncated: shown.length < text.length };
};

export class Deliveries {
  readonly generation = crypto.randomUUID();
  private entries = new Map<string, Entry>();
  private instances = new WeakMap<Session, string>();
  private queued = new Map<string, string>();
  private waiters = new Set<Waiter>();
  private trimmed = new Set<string>();
  private closed = false;

  private now: () => number;

  constructor(now: () => number = Date.now) { this.now = now; }

  private instance(session: Session): string {
    let id = this.instances.get(session);
    if (id === undefined) { id = crypto.randomUUID(); this.instances.set(session, id); }
    return `${this.generation}:${id}`;
  }

  private queueKey(chat: string, id: string): string { return JSON.stringify([chat, id]); }

  private settle(entry: Entry): void {
    const settled = [...this.entries.values()].filter((one) => one.targetChat === entry.targetChat
      && one.state !== 'accepted' && one.state !== 'queued');
    for (const old of settled.slice(0, Math.max(0, settled.length - 128))) {
      this.entries.delete(old.deliveryId);
      if (old.queueId !== undefined) {
        const key = this.queueKey(old.targetChat, old.queueId);
        if (this.queued.get(key) === old.deliveryId) this.queued.delete(key);
      }
      this.trimmed.add(entry.targetChat);
    }
  }

  receipt(entry: Entry, target?: Target): Bag {
    const queue = target === undefined ? [] : pending(target);
    const index = queue.findIndex((one) => one.id === entry.queueId);
    return {
      deliveryId: entry.deliveryId, generation: entry.generation,
      resource: entry.resource, chat: entry.targetChat, state: entry.state,
      acceptedAt: entry.acceptedAt, ageMs: Math.max(0, this.now() - Date.parse(entry.acceptedAt)),
      source: { session: entry.session, chat: entry.chat },
      ...(entry.queueId === undefined ? {} : { queueId: entry.queueId }),
      ...(entry.state === 'queued' && index >= 0 ? { position: index + 1 } : {}),
      ...(entry.turnId === undefined ? {} : { turnId: entry.turnId }),
      ...(entry.supersededBy === undefined ? {} : { supersededBy: entry.supersededBy }),
      ...(entry.reason === undefined ? {} : { reason: entry.reason }),
    };
  }

  send(target: Target, source: Source, text: string, from: MessageFrom, supersedes?: string): Bag {
    if (this.closed) throw new Error('This host is closed; delivery is unconfirmed');
    const queue = pending(target);
    const old = supersedes === undefined ? undefined : this.entries.get(supersedes);
    if (supersedes !== undefined && (old === undefined || old.state !== 'queued'
      || old.resource !== target.resource || old.targetChat !== target.chat || old.targetSession !== target.session
      || old.session !== source.session || old.chat !== source.chat
      || !queue.some((one) => one.id === old.queueId && matches(one, old)))) {
      throw new Error(`Delivery ${supersedes} is not your confirmed pending message in this chat; no replacement was sent`);
    }
    const active = [...this.entries.values()].filter((one) => one.targetChat === target.chat
      && (one.state === 'accepted' || one.state === 'queued'));
    if (active.length >= 256 && old === undefined) throw new Error('This chat already has 256 tracked pending deliveries; nothing was sent');
    const state = target.session.chatState();
    const busy = old !== undefined || state.activeTurn !== undefined || state.steeringMessage !== undefined || queue.length > 0;
    const id = crypto.randomUUID();
    const sourceTurnId = object(from._meta?.['vscode.chat.delegation']).sourceTurnId;
    const entry: Entry = { ...source, deliveryId: id, generation: this.instance(target.session), resource: target.resource,
      targetChat: target.chat, targetSession: target.session, fingerprint: fingerprint(text),
      origin: from.origin?.kind ?? 'user', ...(typeof sourceTurnId === 'string' ? { sourceTurnId } : {}), acceptedAt: new Date(this.now()).toISOString(), state: 'accepted',
      ...(busy ? { queueId: old?.queueId ?? id } : {}) };
    this.entries.set(id, entry);
    if (entry.queueId !== undefined) this.queued.set(this.queueKey(target.chat, entry.queueId), id);
    const attributed = { ...from, _meta: { ...from._meta, 'ahpd.delivery': id } };
    try {
      if (entry.queueId !== undefined) target.session.queue(entry.queueId, text, undefined, attributed);
      else target.session.begin(id, text, undefined, attributed);
      const held = pending(target).find((one) => one.id === entry.queueId);
      if (entry.state !== 'consumed' && held !== undefined && matches(held, entry)) entry.state = 'queued';
      if (entry.state !== 'queued' && entry.state !== 'consumed') {
        entry.state = 'uncertain';
        entry.reason = 'The host has no correlated pending or turn-start receipt; inspect before any new delivery';
      }
      if (old !== undefined) {
        if (entry.state === 'queued' || entry.state === 'consumed') {
          old.state = 'superseded';
          old.supersededBy = id;
        } else {
          old.state = 'uncertain';
          old.reason = 'Replacement could not be confirmed; inspect before any new delivery';
        }
        this.settle(old);
      }
    } catch {
      entry.state = 'uncertain';
      entry.reason = 'The backend did not confirm delivery; inspect before any new delivery';
      if (old !== undefined) { old.state = 'uncertain'; this.settle(old); }
    }
    if (entry.state !== 'queued') this.settle(entry);
    return this.receipt(entry, target);
  }

  observe(chat: string, action: Bag, owner?: Session): void {
    const kind = String(action.type);
    const queueId = kind === 'chat/turnStarted' ? action.queuedMessageId : action.id;
    const entryId = typeof queueId === 'string' ? this.queued.get(this.queueKey(chat, queueId)) : undefined;
    const entry = entryId === undefined && queueId === undefined && kind === 'chat/turnStarted'
      ? this.entries.get(String(action.turnId)) : this.entries.get(String(entryId));
    if (entry?.targetChat === chat && (owner === undefined || entry.targetSession === owner) && entry.state !== 'superseded') {
      if (kind === 'chat/turnStarted' && typeof action.turnId === 'string') {
        let handoff = action.message === undefined ? undefined : action;
        if (handoff === undefined && entry.queueId !== undefined) {
          handoff = [...entry.targetSession.allTurns(), object(entry.targetSession.chatState().activeTurn)]
            .find((turn) => turn.id === action.turnId && turn.queuedMessageId === entry.queueId);
        }
        if ((entry.queueId !== undefined && handoff === undefined) || (handoff !== undefined && !matches(handoff, entry))) {
          entry.state = 'uncertain'; entry.reason = 'Handoff text does not match this pending revision'; this.settle(entry); return;
        }
        if (entry.turnId !== undefined && entry.turnId !== action.turnId) {
          entry.state = 'uncertain';
          entry.reason = 'Conflicting handoff receipts; inspect before any new delivery';
          this.settle(entry);
          return;
        }
        entry.state = 'consumed';
        entry.turnId = action.turnId;
        delete entry.reason;
        this.settle(entry);
      } else if (kind === 'chat/pendingMessageSet' && action.kind === 'queued' && entry.state !== 'consumed') {
        if (matches(action, entry)) entry.state = 'queued';
        else { entry.state = 'uncertain'; entry.reason = 'Pending revision changed outside this delivery'; this.settle(entry); }
      }
      else if (kind === 'chat/pendingMessageRemoved' && action.kind === 'queued' && entry.state !== 'consumed') {
        entry.state = 'removed';
        this.settle(entry);
      }
    }
    if (['chat/turnComplete', 'chat/turnCancelled', 'chat/error'].includes(kind)) {
      for (const waiter of this.waiters) if (waiter.chat === chat && waiter.turnId === action.turnId
        && (owner === undefined || waiter.owner === owner)) waiter.finish(true);
    }
  }

  context(target: Target, offset = 0): Bag {
    const queue = pending(target);
    for (const entry of this.entries.values()) {
      if (entry.targetChat !== target.chat || entry.targetSession !== target.session || entry.state !== 'queued') continue;
      const held = queue.find((one) => one.id === entry.queueId);
      if (held !== undefined && matches(held, entry)) continue;
      const turn = [...target.session.allTurns(), object(target.session.chatState().activeTurn)]
        .find((one) => one.queuedMessageId === entry.queueId);
      if (held === undefined && typeof turn?.id === 'string' && matches(turn, entry)) { entry.state = 'consumed'; entry.turnId = turn.id; }
      else { entry.state = 'uncertain'; entry.reason = 'Pending message disappeared without a correlated turn-start receipt'; }
      this.settle(entry);
    }
    const entries = [...this.entries.values()].filter((one) => one.targetChat === target.chat && one.targetSession === target.session);
    const page = queue.slice(offset, offset + 50).map((one, index) => {
      const id = this.queued.get(this.queueKey(target.chat, String(one.id)));
      const candidate = id === undefined ? undefined : this.entries.get(id);
      const entry = candidate?.targetSession === target.session && candidate.state === 'queued' && matches(one, candidate)
        ? candidate : undefined;
      return { queueId: one.id, position: offset + index + 1,
        acceptedAt: entry?.acceptedAt ?? null,
        ageMs: entry === undefined ? null : Math.max(0, this.now() - Date.parse(entry.acceptedAt)),
        ...(entry === undefined ? {} : { deliveryId: entry.deliveryId, source: { session: entry.session, chat: entry.chat } }),
        ...preview(String(object(one.message).text ?? '')) };
    });
    return { resource: target.resource, chat: target.chat, generation: this.instance(target.session),
      activeTurnId: object(target.session.chatState().activeTurn).id ?? null,
      pendingMessages: page, pendingCount: queue.length,
      ...(offset + page.length < queue.length ? { nextPendingOffset: offset + page.length } : {}),
      deliveries: entries.map((entry) => this.receipt(entry, target)),
      deliveryHistoryTruncated: this.trimmed.has(target.chat),
      unlistedDeliveryState: 'unknown; absence never authorizes retry',
      capabilities: { supersedeOwnPending: true, delegatedMidTurnSteering: false,
        steeringUnsupportedReason: 'This backend has no delegated steering consumption receipt; use explicit bounded interruption',
        interruptRequiresExpectedTurnId: true },
    };
  }

  interrupt(target: Target, turnId: string, timeoutMs = 5000): Promise<Bag> {
    if (this.closed) throw new Error('This host is closed; stop is unconfirmed');
    if (object(target.session.chatState().activeTurn).id !== turnId) throw new Error(`${turnId} is not the active turn in this chat; nothing was cancelled`);
    if ([...this.waiters].some((one) => one.owner === target.session && one.chat === target.chat && one.turnId === turnId)) {
      throw new Error(`Stop for ${turnId} is already pending; inspect before another cancellation`);
    }
    if (this.waiters.size >= 256) throw new Error('This host already has 256 pending stops; nothing was cancelled');
    return new Promise((resolve) => {
      const queuedIds = pending(target).map((one) => one.id);
      let finished = false;
      const finish = (confirmed: boolean) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        this.waiters.delete(waiter);
        resolve({ resource: target.resource, chat: target.chat, turnId, generation: this.instance(target.session),
          state: confirmed ? 'confirmed' : 'unconfirmed',
          queueRetained: queuedIds.every((id) => pending(target).some((one) => one.id === id)),
          ...(confirmed ? {} : { reason: 'The host has not confirmed this exact stop; inspect before any new delivery' }) });
      };
      const waiter: Waiter = { owner: target.session, resource: target.resource, chat: target.chat, turnId, finish };
      const timer = setTimeout(() => finish(false), timeoutMs);
      this.waiters.add(waiter);
      try { target.session.cancel(turnId); if (terminal(target, turnId)) finish(true); }
      catch { finish(false); }
    });
  }

  forgetChat(chat: string, owner: Session): void {
    for (const waiter of this.waiters) if (waiter.chat === chat && waiter.owner === owner) waiter.finish(false);
    for (const entry of this.entries.values()) {
      if (entry.targetChat !== chat || entry.targetSession !== owner) continue;
      this.entries.delete(entry.deliveryId);
      if (entry.queueId !== undefined) {
        const key = this.queueKey(chat, entry.queueId);
        if (this.queued.get(key) === entry.deliveryId) this.queued.delete(key);
      }
    }
    this.trimmed.delete(chat);
  }

  forget(resource: string): void {
    for (const waiter of this.waiters) if (waiter.resource === resource) waiter.finish(false);
    for (const entry of this.entries.values()) {
      if (entry.resource !== resource) continue;
      this.entries.delete(entry.deliveryId);
      if (entry.queueId !== undefined) this.queued.delete(this.queueKey(entry.targetChat, entry.queueId));
      this.trimmed.delete(entry.targetChat);
    }
  }

  close(): void {
    this.closed = true;
    for (const waiter of this.waiters) waiter.finish(false);
    this.entries.clear();
    this.queued.clear();
    this.trimmed.clear();
  }
}
