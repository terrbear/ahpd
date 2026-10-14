import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { mapUpdate } from '../src/mapping.js';
import { outputDirectory, OUTPUT_PREVIEW_BYTES, ToolOutputs } from '../src/output.js';
import { persistentCatalog } from '../src/persistence.js';
import { turnsOf } from '../src/transcript.js';
import type { AcpTurn, WatchedSession } from '../src/types.js';
import type { Bag } from '@ahpd/sdk';

const paths: string[] = [];
afterEach(() => { for (const path of paths.splice(0)) rmSync(path, { recursive: true, force: true }); });
const directory = () => { const path = mkdtempSync(join(tmpdir(), 'ahpd-output-')); paths.push(path); return path; };
const turnAt = (path: string, session = 'provider:session'): AcpTurn => ({
  turnId: 'turn', parts: [], calls: new Map(), outputs: new ToolOutputs(outputDirectory(path), session, 'turn'),
});
const start = (turn: AcpTurn, title = 'command'): void => {
  mapUpdate(turn, { sessionUpdate: 'tool_call', toolCallId: '../tool', title, kind: 'execute', status: 'in_progress', rawInput: { command: title } });
};
const delta = (turn: AcpTurn, text: string) => mapUpdate(turn, {
  sessionUpdate: 'tool_call_update', toolCallId: '../tool', _meta: { terminal_output_delta: { data: text } },
});
const content = (turn: AcpTurn): Bag[] => (turn.parts[0]!.toolCall as Bag).content as Bag[];

it('keeps small output exact and spills streaming output without retaining its full text', () => {
  const path = directory();
  const turn = turnAt(path);
  start(turn);
  delta(turn, 'small\n');
  expect(content(turn)).toEqual([{ type: 'text', text: 'small\n' }]);
  const chunk = '界😀\n'.repeat(8192);
  for (let i = 0; i < 20; i++) {
    const actions = delta(turn, chunk);
    expect(Buffer.byteLength(JSON.stringify(actions))).toBeLessThan(OUTPUT_PREVIEW_BYTES);
    expect(Buffer.byteLength(JSON.stringify(turn.parts))).toBeLessThan(OUTPUT_PREVIEW_BYTES);
  }
  const blocks = content(turn);
  const preview = String(blocks[0]!.text);
  expect(preview).toContain('Output truncated:');
  expect(preview).not.toContain('\ufffd');
  expect(preview.startsWith('small\n')).toBe(true);
  expect(preview.endsWith(chunk.slice(-50))).toBe(true);
  const uri = String(blocks[1]!.uri);
  const saved = readFileSync(fileURLToPath(uri), 'utf8');
  expect(saved).toBe('small\n' + chunk.repeat(20));
  expect(blocks[1]!.sizeHint).toBe(Buffer.byteLength(saved));
  expect(statSync(fileURLToPath(uri)).mode & 0o777).toBe(0o600);
  const done = mapUpdate(turn, { sessionUpdate: 'tool_call_update', toolCallId: '../tool', status: 'completed' });
  expect((done[0]!.result as Bag).content).toEqual(blocks);
});

it('replaces content, then appends deltas, and isolates identical tool IDs across sessions', () => {
  const path = directory();
  const turn = turnAt(path);
  const other = turnAt(path, 'provider:other');
  start(turn); start(other);
  delta(turn, 'old'.repeat(20000));
  mapUpdate(turn, { sessionUpdate: 'tool_call_update', toolCallId: '../tool', content: [{ type: 'content', content: { type: 'text', text: 'replacement' } }] });
  delta(turn, 'tail');
  expect(content(turn)).toEqual([{ type: 'text', text: 'replacementtail' }]);
  delta(turn, 'new'.repeat(20000));
  delta(other, 'other'.repeat(20000));
  const first = String(content(turn)[1]!.uri);
  const second = String(content(other)[1]!.uri);
  expect(first).not.toBe(second);
  expect(readFileSync(fileURLToPath(first), 'utf8')).toBe('replacementtail' + 'new'.repeat(20000));
  expect(readFileSync(fileURLToPath(second), 'utf8')).toBe('other'.repeat(20000));
});

it('bounds all repeated labels while preserving complete arguments', () => {
  const turn = turnAt(directory());
  const command = "cat >> data.json <<'END'\n" + 'data'.repeat(20000) + '\nEND';
  const started = mapUpdate(turn, { sessionUpdate: 'tool_call', toolCallId: 'tool', title: command, rawInput: { command }, kind: 'execute' });
  mapUpdate(turn, { sessionUpdate: 'tool_call_update', toolCallId: 'tool', status: 'completed' });
  const call = turn.parts[0]!.toolCall as Bag;
  for (const key of ['displayName', 'invocationMessage', 'pastTenseMessage']) {
    expect(Buffer.byteLength(String(call[key]))).toBeLessThan(256);
    expect(String(call[key])).not.toContain('datadata');
  }
  expect(JSON.parse(String(call.toolInput))).toEqual({ command });
  expect(started[0]!.displayName).toBe(call.displayName);
});

it('normalizes legacy history, preserves a backup, and restores resource references after restart', () => {
  const path = directory();
  const text = 'start\n' + 'body\n'.repeat(50000) + 'end\n';
  const record: WatchedSession = {
    provider: 'provider', id: 'native', cwd: path, additional: [], title: 'saved', createdAt: '2026-10-14', modifiedAt: '2026-10-14',
    turns: [{ turnId: 'turn', startedAt: '2026-10-14', message: { text: 'hello' }, state: 'complete', duration: 1,
      updates: [
        { sessionUpdate: 'tool_call', toolCallId: 'tool', title: 'command', kind: 'execute' },
        { sessionUpdate: 'tool_call_update', toolCallId: 'tool', _meta: { terminal_output_delta: { data: text } } },
        { sessionUpdate: 'tool_call_update', toolCallId: 'tool', status: 'completed' },
      ] }],
  };
  persistentCatalog(path, 'provider').save(record, 'host');
  const fresh = persistentCatalog(path, 'provider');
  const loaded = fresh.get('host')!;
  const built = turnsOf(loaded, path);
  expect(loaded.turns[0]!.updates).toEqual([]);
  expect(JSON.stringify(loaded).length).toBeLessThan(OUTPUT_PREVIEW_BYTES);
  const blocks = (built[0]!.responseParts[0] as unknown as Bag).toolCall as Bag;
  const uri = String((blocks.content as Bag[])[1]!.uri);
  expect(readFileSync(fileURLToPath(uri), 'utf8')).toBe(text);
  fresh.save(loaded, 'host');
  const folder = readdirSync(path).find((name) => name !== 'outputs')!;
  const backup = readdirSync(join(path, folder)).find((name) => name.endsWith('.v1.bak'))!;
  expect(JSON.parse(readFileSync(join(path, folder, backup), 'utf8'))).toEqual(record);
  const restored = persistentCatalog(path, 'provider').get('host')!;
  expect(turnsOf(restored, path)).toEqual(built);
  // Saving a materialized record again must not re-read all its output.
  fresh.save(loaded, 'host');
  expect(restored.formatVersion).toBe(2);
});

it('does not replace output with a nonexistent artifact when storage fails', () => {
  const path = directory();
  writeFileSync(join(path, 'outputs'), 'not a directory');
  const turn = turnAt(path);
  start(turn);
  delta(turn, 'small');
  expect(() => delta(turn, 'x'.repeat(OUTPUT_PREVIEW_BYTES))).toThrow();
  expect(content(turn)).toEqual([{ type: 'text', text: 'small' }]);
});
