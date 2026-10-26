#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

if (process.argv.slice(2).join(' ') !== 'cli app-server') process.exit(42);
const mode = process.env.MODEL_TEST_MODE;
if (mode === 'tree') {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  appendFileSync(process.env.MODEL_TEST_LOG + '.pid', String(child.pid));
}
appendFileSync(process.env.MODEL_TEST_LOG + '.pid', '\n' + String(process.pid));
if (mode === 'hang') process.on('SIGTERM', () => {});
createInterface({ input: process.stdin }).on('line', (line) => {
  const request = JSON.parse(line);
  appendFileSync(process.env.MODEL_TEST_LOG, JSON.stringify(request) + '\n');
  if (request.id === undefined || mode === 'hang' || mode === 'tree') return;
  if (mode === 'exit') process.exit(1);
  const reply = (result) => process.stdout.write(JSON.stringify({ id: request.id, result }) + '\n');
  if (request.method === 'initialize') return reply({});
  if (request.method === 'account/read') return reply({ requiresOpenaiAuth: true, account: mode === 'signed-out' ? null : { type: 'chatgpt' } });
  if (request.method === 'model/list') {
    if (mode === 'error') return process.stdout.write(JSON.stringify({ id: request.id, error: { code: -1, message: 'private error details' } }) + '\n');
    if (mode === 'cold-model') return reply({ data: [{ id: 'cold', displayName: 'Cold' }], nextCursor: null });
    if (mode === 'empty') return reply({ data: [], nextCursor: null });
    if (mode === 'malformed') return reply({ data: [{ id: 1 }], nextCursor: null });
    if (request.params.cursor === null) return reply({ data: [{ id: 'fast', displayName: 'Fast' }], nextCursor: 'second' });
    return reply({ data: [{ id: 'thorough', displayName: 'Thorough' }], nextCursor: mode === 'loop' ? 'second' : null });
  }
  process.exit(43);
});
