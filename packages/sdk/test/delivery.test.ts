import { afterEach, expect, it, vi } from 'vitest';
import { Deliveries } from '../src/delivery.js';
import type { Bag } from '../src/types/common.js';
import type { MessageFrom, Session } from '../src/types/session.js';

afterEach(() => vi.useRealTimers());

function fixture(ledger = new Deliveries(() => Date.parse('2026-10-11T12:00:00Z'))) {
  const queue: Bag[] = [];
  const turns: Bag[] = [];
  let active: Bag | undefined = { id: 'busy' };
  const source = { session: 'codex:/coordinator', chat: 'ahp-chat:/coordinator' };
  const from = { origin: { kind: 'agent' as const }, _meta: { 'vscode.chat.delegation': { sourceSession: source.session, sourceChat: source.chat } } };
  const session = {
    chatState: () => ({ queuedMessages: queue, activeTurn: active }),
    allTurns: () => turns,
    queue: vi.fn((id: string, text: string, _model: unknown, provenance: MessageFrom) => {
      const entry = { id, message: { text, ...provenance } };
      const index = queue.findIndex((one) => one.id === id);
      if (index < 0) queue.push(entry); else queue[index] = entry;
      ledger.observe(target.chat, { type: 'chat/pendingMessageSet', kind: 'queued', id, message: entry.message });
    }),
    begin: vi.fn((id: string, text: string, _model: unknown, provenance: MessageFrom) => {
      active = { id, message: { text, ...provenance } };
      ledger.observe(target.chat, { type: 'chat/turnStarted', turnId: id });
    }),
    cancel: vi.fn((turnId: string) => {
      turns.push({ id: turnId, state: 'cancelled' });
      active = undefined;
      ledger.observe(target.chat, { type: 'chat/turnCancelled', turnId });
    }),
  };
  const target = { resource: 'codex:/target', chat: 'ahp-chat:/target', session: session as unknown as Session };
  const send = (text = 'validate', supersedes?: string) => ledger.send(target, source, text, from, supersedes);
  const finish = (receipt: Bag, turnId = 'accepted-turn') => {
    const [entry] = queue.splice(queue.findIndex((one) => one.id === receipt.queueId), 1);
    active = { id: turnId, queuedMessageId: receipt.queueId, message: entry?.message };
    ledger.observe(target.chat, { type: 'chat/turnStarted', turnId, queuedMessageId: receipt.queueId });
  };
  return { ledger, target, source, from, session, queue, turns, send, finish, idle: () => { active = undefined; } };
}

it('tracks exact early handoff and keeps accepted distinct from understanding', () => {
  const f = fixture();
  f.idle();
  const receipt = f.send('current instruction');
  expect(receipt).toMatchObject({ state: 'consumed', turnId: receipt.deliveryId, resource: f.target.resource, chat: f.target.chat });
  expect(f.session.begin.mock.calls[0]?.[3].origin).toEqual({ kind: 'agent' });
  expect(f.ledger.context(f.target).capabilities).toMatchObject({ delegatedMidTurnSteering: false });
});

it('supersedes only the exact pending revision in place with new identity and agent attribution', () => {
  const f = fixture();
  const first = f.send('old validation');
  const other = f.send('other instruction');
  const replacement = f.send('validation already passed; report only', String(first.deliveryId));
  expect(replacement).toMatchObject({ state: 'queued', queueId: first.queueId, position: 1 });
  expect(replacement.deliveryId).not.toBe(first.deliveryId);
  expect(f.queue.map((one) => one.id)).toEqual([first.queueId, other.queueId]);
  expect(f.ledger.context(f.target).deliveries).toEqual(expect.arrayContaining([
    expect.objectContaining({ deliveryId: first.deliveryId, state: 'superseded', supersededBy: replacement.deliveryId }),
  ]));
  f.finish(replacement);
  expect(f.ledger.context(f.target).deliveries).toEqual(expect.arrayContaining([
    expect.objectContaining({ deliveryId: replacement.deliveryId, state: 'consumed', turnId: 'accepted-turn' }),
  ]));
  expect(f.session.queue.mock.calls[2]?.[3].origin).toEqual({ kind: 'agent' });
});

it('rejects foreign sender, target, generation, consumed and unknown supersedes before mutation', () => {
  const f = fixture();
  const first = f.send();
  const mutations = f.session.queue.mock.calls.length;
  const bad = [
    () => f.ledger.send(f.target, { ...f.source, chat: 'foreign' }, 'x', f.from, String(first.deliveryId)),
    () => f.ledger.send({ ...f.target, chat: 'foreign' }, f.source, 'x', f.from, String(first.deliveryId)),
    () => f.ledger.send({ ...f.target, session: { ...f.target.session } }, f.source, 'x', f.from, String(first.deliveryId)),
    () => new Deliveries().send(f.target, f.source, 'x', f.from, String(first.deliveryId)),
    () => f.send('x', 'missing'),
  ];
  for (const run of bad) expect(run).toThrow(/not your confirmed pending/);
  f.finish(first);
  expect(() => f.send('x', String(first.deliveryId))).toThrow(/not your confirmed pending/);
  expect(f.session.queue).toHaveBeenCalledTimes(mutations);
  expect(f.session.begin).not.toHaveBeenCalled();
  expect(f.session.cancel).not.toHaveBeenCalled();
});

it('refuses to overwrite a queue revision edited outside the sending coordinator', () => {
  const f = fixture();
  const receipt = f.send();
  f.queue[0] = { id: receipt.queueId, message: { text: 'human changed this', origin: { kind: 'user' } } };
  expect(() => f.send('x', String(receipt.deliveryId))).toThrow(/not your confirmed pending/);
  expect(f.session.queue).toHaveBeenCalledTimes(1);
  expect(f.ledger.context(f.target).deliveries).toEqual(expect.arrayContaining([
    expect.objectContaining({ deliveryId: receipt.deliveryId, state: 'uncertain' }),
  ]));
});

it('never treats removal or absence without exact correlation as consumption or safe retry', () => {
  const f = fixture();
  const first = f.send();
  f.queue.splice(0);
  expect(f.ledger.context(f.target).deliveries).toEqual(expect.arrayContaining([
    expect.objectContaining({ deliveryId: first.deliveryId, state: 'uncertain' }),
  ]));
  expect(() => f.send('retry', String(first.deliveryId))).toThrow();
  const second = f.send();
  f.ledger.observe('other-chat', { type: 'chat/turnStarted', turnId: 'foreign', queuedMessageId: second.queueId });
  f.ledger.observe(f.target.chat, { type: 'chat/pendingMessageRemoved', kind: 'queued', id: second.queueId });
  expect(f.ledger.context(f.target).deliveries).toEqual(expect.arrayContaining([
    expect.objectContaining({ deliveryId: second.deliveryId, state: 'removed' }),
  ]));
  expect(f.session.begin).not.toHaveBeenCalled();
});

it('accepts exact authoritative snapshot handoff but not a foreign turn', () => {
  const f = fixture();
  const receipt = f.send();
  f.queue.splice(0);
  f.turns.push({ id: 'real-turn', state: 'complete', queuedMessageId: receipt.queueId, message: { text: 'validate' } });
  expect(f.ledger.context(f.target).deliveries).toEqual(expect.arrayContaining([
    expect.objectContaining({ deliveryId: receipt.deliveryId, state: 'consumed', turnId: 'real-turn' }),
  ]));
});

it('keeps 128 settled receipts and reports older evicted identity as unknown', () => {
  const f = fixture();
  f.idle();
  const receipts = Array.from({ length: 130 }, () => {
    f.idle();
    return f.send();
  });
  const context = f.ledger.context(f.target);
  expect(context.deliveries).toHaveLength(128);
  expect((context.deliveries as Bag[]).some((one) => one.deliveryId === receipts[0]?.deliveryId)).toBe(false);
  expect(context.deliveryHistoryTruncated).toBe(true);
  expect(context.unlistedDeliveryState).toContain('unknown');
});

it('refuses delivery 257 before dispatch but permits an in-place pending supersede at capacity', () => {
  const f = fixture();
  const receipts = Array.from({ length: 256 }, () => f.send());
  expect(() => f.send()).toThrow(/256/);
  expect(f.session.queue).toHaveBeenCalledTimes(256);
  expect(f.send('current', String(receipts[0]?.deliveryId)).state).toBe('queued');
  expect(f.queue).toHaveLength(256);
});

it('pages external queue entries with unknown ages and bounded UTF-8 previews', () => {
  const f = fixture();
  for (let i = 0; i < 51; i++) f.queue.push({ id: `external-${i}`, message: { text: 'é🚀'.repeat(600) } });
  const context = f.ledger.context(f.target);
  const page = context.pendingMessages as Bag[];
  expect(page).toHaveLength(50);
  expect(context).toMatchObject({ pendingCount: 51, nextPendingOffset: 50 });
  expect(page[0]).toMatchObject({ acceptedAt: null, ageMs: null, truncated: true });
  expect(new TextEncoder().encode(String(page[0]?.text)).length).toBeLessThanOrEqual(1024);
  expect(String(page[0]?.text)).not.toMatch(/[\uD800-\uDFFF]$/u);
  expect((f.ledger.context(f.target, 50).pendingMessages as Bag[])[0]).toMatchObject({ queueId: 'external-50', position: 51 });
});

it('reports a bounded uncertain receipt on backend throw without exposing its private error', () => {
  const f = fixture();
  f.session.queue.mockImplementationOnce(() => { throw new Error('secret backend body'); });
  const receipt = f.send();
  expect(receipt.state).toBe('uncertain');
  expect(JSON.stringify(receipt)).not.toContain('secret backend body');
  expect(f.session.queue).toHaveBeenCalledTimes(1);
});

it('registers the stop observer before synchronous terminal delivery and retains the queue', async () => {
  const f = fixture();
  const receipt = f.send();
  expect(await f.ledger.interrupt(f.target, 'busy')).toMatchObject({ state: 'confirmed', turnId: 'busy', queueRetained: true });
  expect(f.queue[0]?.id).toBe(receipt.queueId);
  expect(f.session.cancel).toHaveBeenCalledExactlyOnceWith('busy');
});

it('rejects stale turn stop and bounds a lost terminal without retry or queue mutation', async () => {
  vi.useFakeTimers();
  const f = fixture();
  f.send();
  expect(() => f.ledger.interrupt(f.target, 'wrong')).toThrow(/not the active turn/);
  expect(f.session.cancel).not.toHaveBeenCalled();
  f.session.cancel.mockImplementationOnce(() => {});
  const outcome = f.ledger.interrupt(f.target, 'busy');
  f.ledger.observe('foreign', { type: 'chat/turnCancelled', turnId: 'busy' });
  f.ledger.observe(f.target.chat, { type: 'chat/turnCancelled', turnId: 'wrong' });
  await vi.advanceTimersByTimeAsync(5000);
  expect(await outcome).toMatchObject({ state: 'unconfirmed', queueRetained: true });
  expect(f.session.cancel).toHaveBeenCalledTimes(1);
  expect(f.session.queue).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});

it('settles bounded stop on host close and forgets disposed resources without replay', async () => {
  vi.useFakeTimers();
  const f = fixture();
  const receipt = f.send();
  f.session.cancel.mockImplementationOnce(() => {});
  const outcome = f.ledger.interrupt(f.target, 'busy');
  f.ledger.forget(f.target.resource);
  expect(await outcome).toMatchObject({ state: 'unconfirmed' });
  expect(f.ledger.context(f.target).deliveries).toEqual([]);
  expect(() => f.send('x', String(receipt.deliveryId))).toThrow();
  f.session.cancel.mockImplementationOnce(() => {});
  const closed = f.ledger.interrupt(f.target, 'busy');
  f.ledger.close();
  expect(await closed).toMatchObject({ state: 'unconfirmed' });
  expect(vi.getTimerCount()).toBe(0);
  expect(() => f.send()).toThrow(/closed/);
});

it('does not attribute an externally replaced same-ID pending message to the original sender', () => {
  const f = fixture();
  const receipt = f.send('owned instruction');
  f.queue[0] = { id: receipt.queueId, message: { text: 'external replacement' } };
  const page = f.ledger.context(f.target).pendingMessages as Bag[];
  expect(page[0]).toMatchObject({ text: 'external replacement', acceptedAt: null, ageMs: null });
  expect(page[0]).not.toHaveProperty('deliveryId');
  expect(page[0]).not.toHaveProperty('source');
});

it('forgets only the disposed chat and settles its stop without affecting sibling chats', async () => {
  vi.useFakeTimers();
  const first = fixture();
  const second = fixture(first.ledger);
  second.target.chat = 'ahp-chat:/sibling';
  const firstReceipt = first.send();
  const secondReceipt = second.send();
  first.session.cancel.mockImplementationOnce(() => {});
  const outcome = first.ledger.interrupt(first.target, 'busy');
  first.ledger.forgetChat(first.target.chat, first.target.session);
  expect(await outcome).toMatchObject({ state: 'unconfirmed' });
  expect(vi.getTimerCount()).toBe(0);
  expect(first.ledger.context(first.target).deliveries).toEqual([]);
  expect(second.ledger.context(second.target).deliveries).toEqual([
    expect.objectContaining({ deliveryId: secondReceipt.deliveryId, state: 'queued' }),
  ]);
  expect(() => first.send('retry', String(firstReceipt.deliveryId))).toThrow();
  expect(second.session.queue).toHaveBeenCalledTimes(1);
});

it('bounds outstanding stop observers and never repeats cancellation of the same held turn', async () => {
  vi.useFakeTimers();
  const f = fixture();
  f.session.cancel.mockImplementation(() => {});
  const outcome = f.ledger.interrupt(f.target, 'busy');
  for (let n = 0; n < 1000; n++) expect(() => f.ledger.interrupt(f.target, 'busy')).toThrow(/already pending/);
  expect(f.session.cancel).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(1);
  f.ledger.close();
  expect(await outcome).toMatchObject({ state: 'unconfirmed' });
  expect(vi.getTimerCount()).toBe(0);
});

it('caps stop observers across distinct held chats before another backend cancellation', async () => {
  vi.useFakeTimers();
  const ledger = new Deliveries();
  const outcomes: Array<Promise<Bag>> = [];
  for (let n = 0; n < 256; n++) {
    const f = fixture(ledger);
    f.target.chat = `ahp-chat:/held-${n}`;
    f.session.cancel.mockImplementation(() => {});
    outcomes.push(ledger.interrupt(f.target, 'busy'));
  }
  const extra = fixture(ledger);
  expect(() => ledger.interrupt(extra.target, 'busy')).toThrow(/256 pending stops/);
  expect(extra.session.cancel).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(256);
  ledger.close();
  expect((await Promise.all(outcomes)).every((one) => one.state === 'unconfirmed')).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});

it('does not consume a replacement from a late same-ID previous-revision handoff', () => {
  const f = fixture();
  const first = f.send('previous instruction');
  const replacement = f.send('current instruction', String(first.deliveryId));
  f.ledger.observe(f.target.chat, { type: 'chat/turnStarted', turnId: 'old-turn',
    queuedMessageId: first.queueId, message: { text: 'previous instruction' } }, f.target.session);
  expect(f.ledger.context(f.target).deliveries).toEqual(expect.arrayContaining([
    expect.objectContaining({ deliveryId: replacement.deliveryId, state: 'uncertain' }),
  ]));
  f.ledger.observe(f.target.chat, { type: 'chat/turnStarted', turnId: 'current-turn',
    queuedMessageId: replacement.queueId, message: { text: 'current instruction' } }, f.target.session);
  expect(f.ledger.context(f.target).deliveries).toEqual(expect.arrayContaining([
    expect.objectContaining({ deliveryId: replacement.deliveryId, state: 'consumed', turnId: 'current-turn' }),
  ]));
});

it('does not consume a superseding revision from an unverified same-token handoff', () => {
  const f = fixture();
  const old = f.send('old validation');
  const current = f.send('validation already passed', String(old.deliveryId));
  f.ledger.observe(f.target.chat, { type: 'chat/turnStarted', turnId: 'late-old-turn', queuedMessageId: old.queueId }, f.target.session);
  expect(f.ledger.context(f.target).deliveries).toEqual(expect.arrayContaining([
    expect.objectContaining({ deliveryId: current.deliveryId, state: 'uncertain' }),
  ]));
  expect(f.session.begin).not.toHaveBeenCalled();
});

it.each(['origin', 'delivery', 'delegation-session', 'delegation-chat', 'delegation-turn'])('rejects distinguishable same-text foreign %s on snapshot before another write', (kind) => {
  const f = fixture();
  const owned = f.send('same text');
  const message = { ...f.queue[0]!.message as Bag };
  if (kind === 'origin') message.origin = { kind: 'user' };
  else if (kind === 'delivery') message._meta = { 'ahpd.delivery': 'foreign-explicit-delivery' };
  else {
    const key = { 'delegation-session': 'sourceSession', 'delegation-chat': 'sourceChat', 'delegation-turn': 'sourceTurnId' }[kind]!;
    message._meta = { 'vscode.chat.delegation': { [key]: 'foreign-explicit-source' } };
  }
  f.queue[0] = { id: owned.queueId, message };
  expect(() => f.send('overwrite', String(owned.deliveryId))).toThrow(/not your confirmed pending/);
  expect(f.session.queue).toHaveBeenCalledTimes(1);
  const context = f.ledger.context(f.target);
  expect(context.deliveries).toEqual(expect.arrayContaining([
    expect.objectContaining({ deliveryId: owned.deliveryId, state: 'uncertain' }),
  ]));
  expect((context.pendingMessages as Bag[])[0]).not.toHaveProperty('source');
});

it('does not accept a same-text foreign-identity callback as own pending or consumption', () => {
  const f = fixture();
  const owned = f.send('same text');
  const message = { text: 'same text', origin: { kind: 'user' }, _meta: { 'ahpd.delivery': 'foreign-explicit-delivery' } };
  f.queue[0] = { id: owned.queueId, message };
  f.ledger.observe(f.target.chat, { type: 'chat/pendingMessageSet', kind: 'queued', id: owned.queueId, message }, f.target.session);
  expect(f.ledger.context(f.target).deliveries).toEqual(expect.arrayContaining([
    expect.objectContaining({ deliveryId: owned.deliveryId, state: 'uncertain' }),
  ]));
  f.ledger.observe(f.target.chat, { type: 'chat/turnStarted', queuedMessageId: owned.queueId, turnId: 'foreign-turn', message }, f.target.session);
  expect(f.ledger.context(f.target).deliveries).toEqual(expect.arrayContaining([
    expect.objectContaining({ deliveryId: owned.deliveryId, state: 'uncertain' }),
  ]));
  expect(() => f.send('overwrite', String(owned.deliveryId))).toThrow();
  expect(f.session.queue).toHaveBeenCalledTimes(1);
});

it('retains own identity positives and genuinely omitted pending provenance compatibility', () => {
  const f = fixture();
  Object.assign(f.from._meta['vscode.chat.delegation'], { sourceTurnId: 'own-source-turn' });
  const owned = f.send('same text');
  expect(f.queue[0]?.message).toMatchObject({ origin: { kind: 'agent' }, _meta: {
    'ahpd.delivery': owned.deliveryId, 'vscode.chat.delegation': { sourceSession: f.source.session, sourceChat: f.source.chat },
  } });
  expect(f.ledger.context(f.target).deliveries).toEqual([expect.objectContaining({ state: 'queued' })]);
  const current = f.send('own revision', String(owned.deliveryId));
  f.queue[0] = { id: current.queueId, message: { text: 'own revision' } };
  expect(f.ledger.context(f.target).deliveries).toEqual(expect.arrayContaining([
    expect.objectContaining({ deliveryId: current.deliveryId, state: 'queued' }),
  ]));
  const compatible = f.send('still own', String(current.deliveryId));
  f.finish(compatible);
  expect(f.ledger.context(f.target).deliveries).toEqual(expect.arrayContaining([
    expect.objectContaining({ deliveryId: compatible.deliveryId, state: 'consumed' }),
  ]));
  expect(f.session.queue).toHaveBeenCalledTimes(3);
});
