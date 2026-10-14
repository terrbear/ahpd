import type { Bag } from './types/common.js';
import type { Page } from './types/paging.js';
import { boundedJson, JsonBudgetExceeded } from './bounded-json.js';

/**
 * A long list of turns, served a page at a time.
 *
 * Nothing here knows what a turn is beyond it being one of many, which is why
 * it is not in `transcript.ts`: reading a transcript is the backend's, because
 * only the thing that ran the session knows the shape its frames are in.
 * Paging is the host's, and it is the same paging whichever backend produced
 * them.
 */

/**
 * How many turns a snapshot carries.
 *
 * A session in this directory has eight hundred and fifty turns. Sending them
 * all works and will not keep working: a snapshot is what a client waits for
 * before it can draw anything, and the oldest turns are the ones nobody is
 * looking at.
 */
export const PAGE = 50;
export const PAGE_BYTES = 1024 * 1024;

/** Whole turns, newest first when selecting, oldest first on the wire. */
function pageBefore(turns: Bag[], end: number, size: number): Page {
  let start = end;
  let remaining = PAGE_BYTES - 2; // array brackets
  while (start > Math.max(0, end - size)) {
    try {
      const item = boundedJson(turns[start - 1]!, remaining - (start === end ? 0 : 1));
      remaining -= item.bytes + (start === end ? 0 : 1);
      start--;
    } catch (error) {
      if (!(error instanceof JsonBudgetExceeded)) throw error;
      // The protocol pages turns, not parts of a turn. Always make progress
      // on one oversized turn instead of an empty page with a stuck cursor.
      if (start === end) start--;
      break;
    }
  }
  return { turns: turns.slice(start, end), ...(start > 0 ? { turnsNextCursor: String(start) } : {}) };
}

/**
 * The newest page, and where the rest begins.
 *
 * The cursor is the index of the oldest turn served - opaque to a client, and
 * deliberately so, but it has to mean something here or `fetchTurns` cannot
 * answer twice in a row.
 */
export function tail(turns: Bag[], size = PAGE): Page {
  return pageBefore(turns, turns.length, size);
}

/**
 * The page before a cursor, or nothing when the cursor is not one of ours.
 *
 * The protocol requires an unrecognised cursor to be rejected rather than
 * guessed at: a host that quietly returned its newest page for a cursor it
 * did not issue would answer a question about old turns with new ones, and
 * the client would page forever without noticing.
 */
export function older(turns: Bag[], cursor: string, size = PAGE): Page | undefined {
  if (!/^\d+$/.test(cursor)) return undefined;
  const at = Number(cursor);
  if (at <= 0 || at > turns.length) return undefined;
  return pageBefore(turns, at, size);
}
