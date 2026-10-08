/**
 * The ACP bridge as an AHP backend.
 *
 * The Agent Client Protocol owns the conversation, the tools and the model
 * choice; the server behind it owns the runtime. What this package adds is the
 * AHP half, so a program that speaks ACP is a configuration line rather than a
 * package of its own.
 *
 * This file holds the backend's identity: the provider, the schema a client
 * fills in and the defaults. The session that runs a turn is `session.ts`, the
 * connection is `connection.ts`, the update mapping is `mapping.ts`, and the
 * catalogue is `catalog.ts`.
 */

import type { Agent, Bag, Listed, Offered } from '@ahpd/sdk';
import { isAbsolute } from 'node:path';
import { catalogueOf, stateFile, watchedSession } from './catalog.js';
import { acpSession } from './session.js';
import { connectAcp } from './connection.js';
import { turnsOf } from './transcript.js';
import type { AcpOptions } from './types.js';

/**
 * One AHP backend over one ACP server command.
 *
 * The provider is per registration rather than per package, so two of these
 * with two commands are two backends, which is how one package serves Copilot
 * and Codex at once.
 */
export function acpAgent(options: AcpOptions): Agent {
  const provider = options.provider ?? 'acp';
  const displayName = options.displayName ?? 'ACP';

  /**
   * What a session may be told.
   *
   * One property, and no `model`: a model belongs to the turn, and ACP carries
   * the choice as a session config option the server names on `session/new`.
   * The choices reach a client through `probe` and `Session.models`, and the
   * choice itself arrives on `begin`, so advertising a model here would be a
   * second answer to a question the server already owns.
   *
   * The approvals control carries no `enum` yet, because no server has been
   * asked what modes it has. A session that has asked reports the server's own
   * ids and names in its `sessionState`, which is where a client draws them.
   */
  const schema = (): Bag => ({
    type: 'object',
    properties: {
      permissionMode: {
        scope: 'session',
        type: 'string',
        title: 'Approvals',
        description: 'How the agent handles tool approvals.',
        sessionMutable: true,
      },
    },
  });

  /**
   * What a session starts at.
   *
   * Only what was configured: a default invented for a model is a session that
   * picks a model nobody named. The model is not a schema property, but it is
   * still what a session that names none should run on, so it is defaulted
   * here and reaches the turn through `begin`.
   */
  const defaults = (): Record<string, unknown> => ({
    ...(options.model !== undefined ? { model: options.model } : {}),
  });

  return {
    provider,
    displayName,
    ...(options.description !== undefined ? { description: options.description } : {}),
    schema,
    defaults,
    accountIdentity: async (directory) => {
      if (provider !== 'codex' || options.command.split('/').at(-1) !== 'codex-acp' || directory === undefined || !isAbsolute(directory)) return { status: 'unavailable' };
      if (options.env !== undefined && ['OPENAI_API_KEY', 'CODEX_HOME', 'OPENAI_BASE_URL'].some((name) => options.env?.[name] !== undefined)) return { status: 'unavailable' };
      let received: (status: unknown) => void = () => {};
      const status = new Promise<unknown>((resolve) => { received = resolve; });
      const connection = connectAcp({
        command: options.command,
        ...(options.args === undefined ? {} : { args: options.args }),
        ...(options.env === undefined ? {} : { env: options.env }),
        cwd: directory,
        handlers: { update: () => {} },
        authStatus: received,
      });
      try {
        const result = await Promise.race([
          connection.initialize().then(() => status),
          connection.ended.then(() => undefined),
          new Promise<undefined>((resolve) => { setTimeout(() => resolve(undefined), 5000).unref(); }),
        ]);
        if (typeof result !== 'object' || result === null) return { status: 'unavailable' };
        const state = result as Record<string, unknown>;
        const account = state.account;
        const email = typeof account === 'object' && account !== null ? (account as Record<string, unknown>).email : undefined;
        if (state.kind !== 'account' || typeof email !== 'string' || !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email) || email.length > 254) return { status: 'unavailable' };
        return { status: 'verified', name: email };
      } catch {
        return { status: 'unavailable' };
      } finally {
        await connection.close(250);
      }
    },

    /**
     * What the server offers before a session exists.
     *
     * Nothing, and that is the honest answer: ACP advertises models and
     * commands on `session/new` and in `session/update`, never on
     * `initialize`, so there is no pre-session catalogue to report. A server's
     * models are the session's to report, which is what `Session.models()` is
     * for. The method states that emptiness rather than being omitted, and no
     * server is spawned to answer it.
     */
    probe: async (): Promise<Offered> => ({ models: [], customizations: [], commands: [] }),

    /*
     * The server's own session list where it has one, and this process's record
     * where it does not. Both are read in `catalog.ts`, because the registry is
     * process-wide and outlives any one session.
     */
    list: (): Promise<Listed[]> => catalogueOf(options, provider),

    /*
     * What this process watched of a session. `undefined` for one it never
     * opened, which is the contract's way of saying the host has no such row:
     * the ACP server owns the conversation and this bridge does not read it
     * back off disk.
     */
    transcript: async (id) => {
      const watched = watchedSession(provider, id);
      return watched === undefined ? undefined : turnsOf(watched);
    },

    // The bridge writes no per-session file, so undefined is the real answer
    // rather than a path to something that does not exist.
    stateFile,
    create: (start) => acpSession(options, start),
  };
}
