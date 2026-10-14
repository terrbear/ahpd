/**
 * The updates this bridge watched, rebuilt as the turns a client reads.
 *
 * ACP has no stored transcript to read: `loadSession` replays notifications
 * rather than returning turns, so the only record of a session this process
 * saw is the one it kept as it went. New records hold the mapped response
 * parts, with bounded tool previews and references to separately stored output.
 * Legacy update streams are materialized once through the live mapper.
 *
 * A session this process never watched has no record, and `Agent.transcript`
 * answers `undefined` for it rather than inventing a conversation.
 */

import type { Agent, Bag } from '@ahpd/sdk';
import { mapUpdate } from './mapping.js';
import { outputDirectory, ToolOutputs } from './output.js';
import type { AcpTurn, WatchedSession } from './types.js';

/**
 * The turns `Agent.transcript` answers with.
 *
 * Named by query rather than imported from the protocol package: an agent
 * backend states its protocol shapes through `@ahpd/sdk`, and taking a second
 * dependency to repeat the same type would be a boundary this package does not
 * declare.
 */
type Transcript = NonNullable<Awaited<ReturnType<NonNullable<Agent['transcript']>>>>;
export type TranscriptTurn = Transcript[number];

/**
 * One watched session's turns, in the order they ran.
 *
 * Materialized parts are shared with the live session. Legacy turns start
 * empty and replay their updates through the same bounded mapper.
 */
export function turnsOf(session: WatchedSession, directory?: string): TranscriptTurn[] {
  return session.turns.map((watched) => {
    const replay: AcpTurn = {
      turnId: watched.turnId,
      parts: watched.responseParts ?? [],
      calls: new Map(),
      outputs: new ToolOutputs(outputDirectory(directory), `${session.provider}:${session.id}`, watched.turnId),
    };
    if (watched.responseParts === undefined) {
      // Convert legacy records through the same bounded mapping as live
      // updates. Drop the raw stream only after every artifact write succeeds.
      for (const update of watched.updates) mapUpdate(replay, update);
      watched.responseParts = replay.parts;
      watched.updates = [];
      session.formatVersion = 2;
    }
    for (const part of replay.parts) {
      const request = part.request as Bag | undefined;
      const settled = request === undefined ? undefined : watched.inputs?.[String(request.id)];
      if (settled !== undefined && request !== undefined) {
        part.response = settled.response;
        request.answers = structuredClone(settled.answers);
      }
    }
    return {
      id: watched.turnId,
      startedAt: watched.startedAt,
      /*
       * A turn this bridge began is the person's unless somebody said
       * otherwise, and the transcript states that rather than leaving the
       * origin off: the protocol requires one, and the live snapshot's
       * omission is a `Bag` that a typed read cannot carry.
       */
      message: {
        text: watched.message.text,
        ...(watched.message.attachments !== undefined ? { attachments: watched.message.attachments } : {}),
        origin: watched.message.origin ?? { kind: 'user' },
      },
      responseParts: replay.parts,
      usage: undefined,
      state: watched.state,
      ...(watched.duration === undefined ? {} : { duration: watched.duration }),
    };
  });
}
