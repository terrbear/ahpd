import type { SessionUpdate } from '@agentclientprotocol/sdk';
import type { Bag, Emit } from '@ahpd/sdk';
import type { AcpTurn } from './types.js';
import { contentOf } from './elicitation.js';

const KEY = 'codex/asyncUserInput';
const bag = (value: unknown): Bag => typeof value === 'object' && value !== null ? value as Bag : {};

export function mapAsyncInput(turn: AcpTurn, update: SessionUpdate): Bag[] | undefined {
  const input = bag(bag(update._meta)[KEY]);
  if (typeof input.id !== 'string' || input.id === '' || !Array.isArray(input.questions) || input.questions.length === 0) return undefined;
  const questions: Bag[] = [];
  for (const [index, raw] of input.questions.entries()) {
    const question = bag(raw);
    if (typeof question.title !== 'string' || question.title.trim() === '') return undefined;
    if (question.options != null && (!Array.isArray(question.options) || !question.options.every((option) => typeof option === 'string'))) return undefined;
    const options = (question.options ?? []) as string[];
    questions.push({ id: String(index), title: question.title, message: '', kind: options.length > 0 ? 'single-select' : 'text', required: true, allowFreeformInput: true, options: options.map((option) => ({ id: option, label: option })) });
  }
  const id = `codex-async-${input.id}`;
  if (turn.parts.some((part) => bag(part.request).id === id)) return [];
  const request = { id, message: 'Codex has a question', questions, _meta: { [KEY]: input.id } };
  turn.parts.push({ kind: 'inputRequest', request });
  return [{ type: 'chat/inputRequested', turnId: turn.turnId, request }];
}

export function asyncInputs(
  emit: Emit,
  chat: string,
  turns: Bag[],
  persist: (turn: string, id: string, response: string, answers: Bag) => void,
) {
  const pending = new Map<string, { turn: string; part: Bag }>();
  const track = (turn: string, part: Bag): void => {
    const request = bag(part.request);
    if (part.kind === 'inputRequest' && typeof bag(request._meta)[KEY] === 'string' && part.response === undefined) {
      pending.set(String(request.id), { turn, part });
    }
  };
  for (const turn of turns) {
    for (const part of (turn.responseParts ?? []) as Bag[]) track(String(turn.id), part);
  }
  const requestOf = (part: Bag): Bag => ({ id: bag(part.request).id, kind: 'chatInput', chat, request: structuredClone(part.request) });
  const settle = (id: string, response: string, answers: Bag): void => {
    const held = pending.get(id);
    if (held === undefined) throw new Error(`Async question ${id} is no longer pending`);
    persist(held.turn, id, response, answers);
    held.part.response = response;
    bag(held.part.request).answers = structuredClone(answers);
    pending.delete(id);
    emit('chat', { type: 'chat/inputCompleted', turnId: held.turn, requestId: id, response, answers });
    emit('session', { type: 'session/inputNeededRemoved', id });
  };
  return {
    has: (id: string): boolean => pending.has(id),
    requests: (): Bag[] => [...pending.values()].map(({ part }) => requestOf(part)),
    register: (turn: string, part: Bag): void => {
      const id = String(bag(part.request).id);
      if (pending.has(id)) return;
      track(turn, part);
      if (pending.has(id)) emit('session', { type: 'session/inputNeededSet', request: requestOf(part) });
    },
    answer: (id: string, accepted: boolean, answers: Bag): { text: string } => {
      const held = pending.get(id);
      if (held === undefined) throw new Error(`Async question ${id} is no longer pending`);
      const questions = bag(held.part.request).questions as Bag[];
      const content = accepted ? contentOf(questions, answers) : {};
      const text = questions.map((question) => {
        const value = content[String(question.id)];
        const reply = accepted ? String(value ?? '') : 'Declined to answer';
        return `${String(question.title)}\nAnswer: ${reply}`;
      }).join('\n\n');
      settle(id, accepted ? 'accept' : 'decline', answers);
      return { text: `The user answered the earlier questions:\n\n${text}` };
    },
    cancel: (): void => {
      for (const id of [...pending.keys()]) settle(id, 'cancel', {});
    },
  };
}
