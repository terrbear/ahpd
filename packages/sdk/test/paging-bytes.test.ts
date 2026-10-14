import { expect, it } from 'vitest';
import { older, PAGE, PAGE_BYTES, tail } from '../src/paging.js';

it('pages by UTF-8 bytes and walks every turn exactly once', () => {
  const turns = Array.from({ length: 20 }, (_, id) => ({ id, text: '界'.repeat(100000) }));
  let page = tail(turns);
  const seen = [...page.turns];
  expect(page.turns).toHaveLength(3);
  while (page.turnsNextCursor !== undefined) {
    expect(Buffer.byteLength(JSON.stringify(page.turns))).toBeLessThanOrEqual(PAGE_BYTES);
    page = older(turns, page.turnsNextCursor)!;
    seen.unshift(...page.turns);
  }
  expect(seen).toEqual(turns);
});

it('still bounds small pages by count and rejects invalid cursors', () => {
  const turns = Array.from({ length: 120 }, (_, id) => ({ id }));
  expect(tail(turns).turns).toHaveLength(PAGE);
  expect(tail(turns).turnsNextCursor).toBe('70');
  for (const cursor of ['nope', '-1', '0', '121']) expect(older(turns, cursor)).toBeUndefined();
});

it('makes progress across a single oversized turn without dropping or splitting it', () => {
  const turns = [{ id: 1 }, { id: 2, text: 'x'.repeat(PAGE_BYTES + 1) }, { id: 3 }];
  const last = tail(turns);
  expect(last.turns).toEqual([turns[2]]);
  const big = older(turns, last.turnsNextCursor!)!;
  expect(big.turns).toEqual([turns[1]]);
  expect(older(turns, big.turnsNextCursor!)!.turns).toEqual([turns[0]]);
});
