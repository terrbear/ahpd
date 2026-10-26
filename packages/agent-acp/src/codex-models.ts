import { spawn } from 'node:child_process';
import { basename, dirname, resolve } from 'node:path';
import { readFileSync, realpathSync } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import type { Offered } from '@ahpd/sdk';
import type { AcpOptions } from './types.js';

const empty = (): Offered => ({ models: [], commands: [], customizations: [] });
const object = (value: unknown): Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Invalid Codex discovery response');
  return value as Record<string, unknown>;
};

function isCodexAdapter(command: string): boolean {
  if (basename(command) === 'codex-acp') return true;
  try {
    const entry = realpathSync(command);
    const root = dirname(dirname(entry));
    const manifest = object(JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')));
    const bin = object(manifest.bin)['codex-acp'];
    return manifest.name === '@agentclientprotocol/codex-acp' && typeof bin === 'string' && resolve(root, bin) === entry;
  } catch { return false; }
}

export async function codexModels(options: AcpOptions): Promise<Offered> {
  const args = options.args ?? [];
  const adapter = args.length === 0 ? options.command : args[0];
  if (options.provider !== 'codex' || adapter === undefined || !isCodexAdapter(adapter)) return empty();
  if (args.length > 1 || (args.length === 1 && !/^node(?:\.exe)?$/.test(basename(options.command)))) return empty();
  const env = { ...process.env, ...options.env };
  if (env.CODEX_CONFIG || env.MODEL_PROVIDER || env.DEFAULT_AUTH_REQUEST) return empty();
  const child = spawn(options.command, [...args, 'cli', 'app-server'], {
    env, cwd: options.cwd, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stderr.resume();
  const exited = new Promise<void>((resolve) => {
    child.once('exit', () => resolve());
    child.once('error', () => resolve());
  });
  const decoder = new StringDecoder('utf8');
  const failure = new Error('Codex model discovery failed');
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  let stopped = false;
  let sequence = 0;
  let buffer = '';
  let bytes = 0;
  const fail = () => {
    stopped = true;
    for (const call of pending.values()) call.reject(failure);
    pending.clear();
  };
  child.on('error', fail);
  child.on('exit', fail);
  child.stdin.on('error', fail);
  child.stdout.on('data', (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes > 4 * 1024 * 1024) { fail(); return; }
    buffer += decoder.write(chunk);
    let index: number;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      try {
        const frame = object(JSON.parse(line));
        if (typeof frame.method === 'string' && frame.id !== undefined) { fail(); return; }
        if (typeof frame.id !== 'number') continue;
        const call = pending.get(frame.id);
        if (call === undefined) continue;
        pending.delete(frame.id);
        if (frame.error !== undefined) call.reject(failure);
        else call.resolve(frame.result);
      } catch { fail(); return; }
    }
  });
  const request = (method: string, params: unknown): Promise<unknown> => new Promise((resolve, reject) => {
    if (stopped) { reject(failure); return; }
    const id = ++sequence;
    pending.set(id, { resolve, reject });
    child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
  });
  const timer = setTimeout(fail, 2000);
  try {
    await request('initialize', { clientInfo: { name: 'ahpd-model-discovery', version: '1' } });
    child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n');
    const account = object(await request('account/read', { refreshToken: false }));
    if (typeof account.requiresOpenaiAuth !== 'boolean' || (account.requiresOpenaiAuth && !account.account)) throw failure;
    const models: Offered['models'] = [];
    const cursors = new Set<string>();
    let cursor: string | null = null;
    do {
      const page = object(await request('model/list', { cursor, limit: 100 }));
      if (!Array.isArray(page.data)) throw failure;
      for (const value of page.data) {
        const model = object(value);
        if (typeof model.id !== 'string' || !model.id || typeof model.displayName !== 'string') throw failure;
        if (!models.some((one) => one.id === model.id)) models.push({ id: model.id, name: model.displayName || model.id });
      }
      if (page.nextCursor !== null && typeof page.nextCursor !== 'string') throw failure;
      cursor = page.nextCursor as string | null;
      if (cursor !== null) {
        if (!cursor || cursors.has(cursor) || cursors.size >= 20) throw failure;
        cursors.add(cursor);
      }
    } while (cursor !== null);
    return { ...empty(), models };
  } finally {
    clearTimeout(timer);
    fail();
    child.stdin.destroy();
    if (child.pid !== undefined) {
      if (process.platform === 'win32') {
        await new Promise<void>((resolve) => {
          const kill = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
          kill.on('error', () => { child.kill(); resolve(); });
          kill.on('exit', () => resolve());
        });
      } else {
        try { process.kill(-child.pid, 'SIGKILL'); } catch {}
      }
    }
    await exited;
  }
}
