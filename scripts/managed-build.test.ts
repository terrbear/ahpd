import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { branchOf, developReleaseTag, prepare, releaseTag, repository, tracked } from './managed-build.mjs';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const temp = (): string => {
  const root = mkdtempSync(join(tmpdir(), 'managed-build-'));
  roots.push(root);
  return root;
};

const mainRef = {
  channel: 'main',
  spec: `refs/tags/${releaseTag}:refs/tags/${releaseTag}`,
  rev: `refs/tags/${releaseTag}^{commit}`,
};
const developRef = {
  channel: 'develop',
  spec: `refs/tags/${developReleaseTag}:refs/tags/${developReleaseTag}`,
  rev: `refs/tags/${developReleaseTag}^{commit}`,
};

it('keeps main on the anton-ahpd tag and sends only develop to its own tag', () => {
  expect(tracked('main')).toEqual(mainRef);
  expect(tracked('develop')).toEqual(developRef);
  for (const branch of ['', 'HEAD', 'feature', 'origin/develop']) expect(tracked(branch)).toEqual(mainRef);
  expect(developRef.spec).not.toContain(mainRef.spec);
});

it('publishes each tag from CI on that branch, and only after a green push', () => {
  const workflow = readFileSync(new URL('../.github/workflows/managed-release.yml', import.meta.url), 'utf8');
  const ci = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
  const tags = [...workflow.matchAll(/git tag -f (\S+) /g)].map((found) => found[1]);
  expect(tags).toEqual([releaseTag, developReleaseTag]);
  expect(workflow).toContain("head_branch == 'main'");
  expect(workflow).toContain("head_branch == 'develop'");
  expect(workflow).toContain("ref: main");
  expect(workflow).toContain("ref: develop");
  expect(workflow).toContain("github.event.workflow_run.event == 'push'");
  expect(ci).toContain('branches: [main, develop]');
});

it('reads the source branch, and a detached checkout is not develop', async () => {
  const root = temp();
  const git = (...args: string[]) => execFileSync('git', args, {
    cwd: root,
    stdio: 'pipe',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'ahpd', GIT_AUTHOR_EMAIL: 'ahpd@example.com',
      GIT_COMMITTER_NAME: 'ahpd', GIT_COMMITTER_EMAIL: 'ahpd@example.com',
    },
  });
  git('init', '-b', 'main');
  writeFileSync(join(root, 'readme'), 'a');
  git('add', 'readme');
  git('commit', '-m', 'start');
  expect(await branchOf(root)).toBe('main');
  git('checkout', '-b', 'develop');
  expect(await branchOf(root)).toBe('develop');
  git('checkout', '--detach');
  expect(await branchOf(root)).toBe('');
  expect(await branchOf(join(root, 'missing'))).toBe('');
});

/** Record the fetch, and answer one sha for both the tag and the running checkout. */
function recordingRun(branch: string | undefined, sha: string) {
  const fetches: { args: string[]; cwd?: string }[] = [];
  const parses: string[] = [];
  const run = async (_file: string, args: readonly string[], cwd?: string) => {
    if (args[0] === 'branch') {
      if (branch === undefined) throw new Error('not a git checkout');
      return branch;
    }
    if (args[0] === 'fetch') fetches.push({ args: [...args], cwd });
    if (args[0] === 'rev-parse') {
      parses.push(args[1] ?? '');
      return sha;
    }
    return '';
  };
  return { fetches, parses, run };
}

it('fetches the develop tag from the source checkout, not the detached release', async () => {
  const home = temp();
  const current = join(home, 'release');
  const source = join(home, 'source');
  mkdirSync(current);
  const seen: string[] = [];
  const run = async (_file: string, args: readonly string[], cwd?: string) => {
    if (args[0] === 'branch') {
      seen.push(cwd ?? '');
      return 'develop';
    }
    if (args[0] === 'fetch') seen.push(args.join(' '));
    if (args[0] === 'rev-parse') return 'a'.repeat(40);
    return '';
  };
  expect(await prepare(home, current, undefined, source, run)).toBeUndefined();
  expect(seen).toContain(source);
  expect(seen).toContain(`fetch --force --depth=1 ${repository} ${developRef.spec}`);
});

it.each([
  ['main', 'main'],
  ['feature', 'feature'],
  ['unreadable', undefined],
])('fetches the main tag when the source branch is %s', async (_label, branch) => {
  const home = temp();
  const current = join(home, 'release');
  mkdirSync(current);
  const { fetches, parses, run } = recordingRun(branch, 'b'.repeat(40));
  expect(await prepare(home, current, undefined, current, run)).toBeUndefined();
  expect(fetches.map((call) => call.args)).toEqual([['fetch', '--force', '--depth=1', repository, mainRef.spec]]);
  expect(parses).toEqual([mainRef.rev, 'HEAD']);
});
