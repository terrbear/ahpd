import { expect, it, vi } from 'vitest';
import { pendingWork } from '../src/pending-work.js';

it('blocks answers until admission, deduplicates registration, and completes once admitted', async () => {
  let admit!: () => void;
  const gate = new Promise<void>((resolve) => { admit = resolve; });
  const finish = vi.fn(async () => {});
  const begin = vi.fn(async () => { await gate; return finish; });
  const work = pendingWork(begin);
  work.track('question');
  work.track('question');
  expect(begin).toHaveBeenCalledOnce();
  expect(() => work.check('question')).toThrow('admission');
  admit();
  await work.ready();
  work.check('question');
  expect(finish).not.toHaveBeenCalled();
  work.complete('question');
  await Promise.resolve();
  expect(finish).toHaveBeenCalledOnce();
});

it('fails readiness and refuses answers when admission is rejected', async () => {
  const work = pendingWork(async () => { throw new Error('sealed'); });
  work.track('question');
  await expect(work.ready()).rejects.toThrow('sealed');
  expect(() => work.check('question')).toThrow('admission');
});
