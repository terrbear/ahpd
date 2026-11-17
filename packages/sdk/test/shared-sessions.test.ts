import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { directorySessions } from '../src/directory-sessions.js';
import { acquireFileLock, fileSessionLocks, sessionKey, SessionBusyError } from '../src/session-locks.js';

let root: string;
const children: ChildProcess[] = [];
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ahpd-shared-'));
  // Execute the current source in independent Node processes, not stale dist.
  for (const name of ['session-locks', 'directory-sessions']) {
    const source = readFileSync(new URL(`../src/${name}.ts`, import.meta.url), 'utf8');
    writeFileSync(join(root, `${name}.js`), ts.transpileModule(source, {
      compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ES2022 },
    }).outputText);
  }
  writeFileSync(join(root, 'package.json'), '{"type":"module"}');
});
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      const done = once(child, 'exit'); child.kill('SIGKILL'); await done;
    }
  }
  rmSync(root, { recursive: true, force: true });
});
const worker = (code: string): ChildProcess => {
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import {directorySessions} from ${JSON.stringify(pathToFileURL(join(root, 'directory-sessions.js')).href)};
    import {fileSessionLocks} from ${JSON.stringify(pathToFileURL(join(root, 'session-locks.js')).href)};
    const directory = ${JSON.stringify(join(root, 'data'))};
    ${code}
  `], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  children.push(child);
  return child;
};
const finished = async (child: ChildProcess): Promise<void> => {
  let errors = ''; child.stderr?.on('data', (chunk) => { errors += String(chunk); });
  const [code] = await once(child, 'exit');
  expect(errors).toBe(''); expect(code).toBe(0);
};

it('keeps independently opened stores fresh and preserves unrelated fields', () => {
  const a = directorySessions({ directory: join(root, 'data') });
  const b = directorySessions({ directory: join(root, 'data') });
  a.setConfig('a', { model: 'one' }); b.setFlags('a', 32);
  a.setOwner('b', 'user:two');
  expect(b.config('a')).toEqual({ model: 'one' });
  expect(a.flags('a')).toBe(32); expect(b.owner('b')).toBe('user:two');
});

it('preserves same-session updates from four competing processes', async () => {
  await Promise.all(Array.from({ length: 4 }, (_, n) => finished(worker(`
    const store = directorySessions({directory});
    for (let i=0;i<12;i++) store.setSender('same', ${JSON.stringify(String(n))} + '-' + i, 'user:${n}');
  `))));
  const store = directorySessions({ directory: join(root, 'data') });
  for (let n=0;n<4;n++) for (let i=0;i<12;i++) expect(store.sender('same', `${n}-${i}`)).toBe(`user:${n}`);
}, 20000);

it('holds distinct session ownership concurrently and rejects the same session', async () => {
  const child = worker(`const locks=fileSessionLocks({directory}); locks.acquire('one'); process.send('ready'); setInterval(()=>{},1000);`);
  await once(child, 'message');
  const locks = fileSessionLocks({ directory: join(root, 'data') });
  expect(() => locks.acquire('one')).toThrow(SessionBusyError);
  const release = locks.acquire('two');
  const store = directorySessions({ directory: join(root, 'data') });
  store.setConfig('two', { concurrent: true });
  release(); release();
  const again = locks.acquire('two'); again();
});

it('releases on SIGKILL and reopens acknowledged durable data', async () => {
  const child = worker(`
    fileSessionLocks({directory}).acquire('one');
    directorySessions({directory}).setConfig('one',{model:'durable'});
    process.send('ready'); setInterval(()=>{},1000);
  `);
  await once(child, 'message');
  const dead = once(child, 'exit'); child.kill('SIGKILL'); await dead;
  await finished(worker(`
    const release = fileSessionLocks({directory}).acquire('one');
    const store=directorySessions({directory});
    if (store.config('one').model !== 'durable') throw new Error('lost data');
    store.setFlags('one',64); release();
  `));
  expect(directorySessions({ directory: join(root, 'data') }).flags('one')).toBe(64);
});

it('releases on failure exit without an explicit unlock', async () => {
  const child = worker(`fileSessionLocks({directory}).acquire('one'); process.send('ready'); setTimeout(()=>process.exit(7),50);`);
  await once(child, 'message');
  const [code] = await once(child, 'exit'); expect(code).toBe(7);
  const release = fileSessionLocks({ directory: join(root, 'data') }).acquire('one'); release();
});

it('migrates lazily without resurrecting forgotten legacy metadata', () => {
  const legacyFile = join(root, 'legacy.json');
  writeFileSync(legacyFile, JSON.stringify({ version: 1, sessions: [{ id: 'one', flags: 32, config: { x: 1 } }] }));
  const options = { directory: join(root, 'data'), legacyFile };
  const store = directorySessions(options);
  expect(store.flags('one')).toBe(32);
  store.setOwner('one', 'user:ana');
  expect(directorySessions(options).config('one')).toEqual({ x: 1 });
  store.forget('one');
  expect(directorySessions(options).flags('one')).toBe(0);
  expect(directorySessions(options).config('one')).toBeUndefined();
});

it('fails closed on corrupt records and still releases the metadata lock', () => {
  const directory = join(root, 'data'); const store = directorySessions({ directory });
  store.setFlags('one', 32);
  const file = join(directory, readdirSync(directory).find((name) => name.endsWith('.json'))!);
  writeFileSync(file, '{broken');
  expect(() => store.setFlags('one',64)).toThrow();
  writeFileSync(file, JSON.stringify({version:1,id:'one',values:{flags:32}}));
  store.setFlags('one',64); expect(store.flags('one')).toBe(64);
});

it('contains hostile identifiers and retains the full SessionStore shape', () => {
  const directory = join(root, 'data'); const store = directorySessions({ directory }); const id='../outside';
  store.setScope(id,null); store.setProvider(id,'claude'); store.setArtifacts(id,[{id:'a'}]);
  store.setPullRequests(id,{initialPullRequestUrls:[],associatedPullRequestUrls:['url']});
  store.setChatTitle(id,'__proto__','title'); store.setSender(id,'turn','user:ana');
  expect(store.scope(id)).toBeNull(); expect(store.provider(id)).toBe('claude');
  expect(store.artifacts(id)).toEqual([{id:'a'}]); expect(store.chatTitle(id,'__proto__')).toBe('title');
  expect(store.pullRequests(id)?.associatedPullRequestUrls).toEqual(['url']);
  store.setChatTitle(id,'__proto__',''); store.setSender(id,'turn',undefined); store.setArtifacts(id,[]);
  expect(store.chatTitle(id,'__proto__')).toBeUndefined();
  expect(store.sender(id,'turn')).toBeUndefined(); expect(store.artifacts(id)).toBeUndefined();
  expect(readdirSync(directory).every((file)=>/^[a-f0-9]{64}\.(json|metadata.lock)$/.test(file))).toBe(true);
  store.close?.(); expect(()=>store.setFlags(id,32)).toThrow('closed');
});

it('writes another session while the first metadata transaction is locked', async () => {
  const directory = join(root, 'data'); directorySessions({ directory });
  const release = acquireFileLock(join(directory, `${sessionKey('one')}.metadata.lock`));
  try {
    await finished(worker(`directorySessions({directory}).setFlags('two',32);`));
    expect(directorySessions({directory}).flags('two')).toBe(32);
  } finally { release(); }
});
