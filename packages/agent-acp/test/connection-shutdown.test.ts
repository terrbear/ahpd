import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { connectAcp } from '../src/connection.js';

const isAlive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
};

it('lets an adapter finish child cleanup on stdin EOF before sending a signal', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'acp-shutdown-'));
  const ready = join(dir, 'ready');
  const cleaned = join(dir, 'cleaned');
  const connection = connectAcp({
    command: process.execPath,
    args: ['-e', `
      const fs = require('node:fs');
      process.stdin.resume();
      process.stdin.on('end', () => {
        setTimeout(() => { fs.writeFileSync(${JSON.stringify(cleaned)}, 'done'); process.exit(0); }, 50);
      });
      fs.writeFileSync(${JSON.stringify(ready)}, String(process.pid));
      setTimeout(() => process.exit(2), 2000).unref();
    `],
    handlers: { update: () => {} },
  });
  try {
    await expect.poll(async () => readFile(ready, 'utf8').catch(() => '')).toMatch(/^\d+$/);
    const pid = Number(await readFile(ready, 'utf8'));
    await connection.close(250);
    expect(await readFile(cleaned, 'utf8').catch(() => '')).toBe('done');
    expect(isAlive(pid)).toBe(false);
    await connection.close(250);
  } finally {
    await connection.close(250);
    await rm(dir, { recursive: true, force: true });
  }
});

it('waits for an owned child to exit during EOF cleanup', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'acp-owned-child-'));
  const ready = join(dir, 'ready');
  const cleaned = join(dir, 'cleaned');
  const connection = connectAcp({
    command: process.execPath,
    args: ['-e', `
      const fs = require('node:fs');
      const child = require('node:child_process').spawn(process.execPath, ['-e',
        "process.stdin.resume(); process.stdin.on('data', () => process.exit(0)); setTimeout(() => process.exit(2), 1500);"
      ], {stdio: ['pipe', 'ignore', 'ignore']});
      process.stdin.resume();
      process.stdin.on('end', () => setTimeout(() => child.stdin.end('stop'), 300));
      child.on('exit', (code) => { fs.writeFileSync(${JSON.stringify(cleaned)}, String(code)); process.exit(0); });
      fs.writeFileSync(${JSON.stringify(ready)}, JSON.stringify([process.pid, child.pid]));
    `],
    handlers: { update: () => {} },
  });
  try {
    await expect.poll(async () => readFile(ready, 'utf8').catch(() => '')).toMatch(/^\[/);
    const pids = JSON.parse(await readFile(ready, 'utf8')) as number[];
    await connection.close();
    expect(await readFile(cleaned, 'utf8')).toBe('0');
    expect(pids.map(isAlive)).toEqual([false, false]);
  } finally {
    await connection.close();
    await rm(dir, { recursive: true, force: true });
  }
});

it('escalates a stubborn adapter and settles concurrent closes after exit', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'acp-stubborn-'));
  const ready = join(dir, 'ready');
  const connection = connectAcp({
    command: process.execPath,
    args: ['-e', `
      process.stdin.resume();
      process.on('SIGTERM', () => {});
      setInterval(() => {}, 1000);
      require('node:fs').writeFileSync(${JSON.stringify(ready)}, String(process.pid));
    `],
    handlers: { update: () => {} },
  });
  try {
    await expect.poll(async () => readFile(ready, 'utf8').catch(() => '')).toMatch(/^\d+$/);
    const pid = Number(await readFile(ready, 'utf8'));
    await Promise.all([connection.close(50), connection.close(50)]);
    expect((await connection.ended).message).toContain('SIGKILL');
    expect(isAlive(pid)).toBe(false);
  } finally {
    await connection.close(50);
    await rm(dir, { recursive: true, force: true });
  }
});
