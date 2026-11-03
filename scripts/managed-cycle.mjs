import { fork } from 'node:child_process';
import { dirname, join, basename } from 'node:path';
import { json, prepare, prune, save } from './managed-build.mjs';

export async function cycle({ source, current, config, previous, probation = false }, dependencies = {}) {
  const start = dependencies.start ?? ((entry, args, options) => fork(entry, args, options));
  const build = dependencies.prepare ?? prepare;
  const home = dirname(config);
  const log = dependencies.log ?? ((message) => process.stderr.write(`${new Date().toISOString()} managed update: ${message}\n`));
  const receipt = await json(join(home, 'managed-update-state.json'), {});
  const child = start(join(current, 'packages/server/dist/main.js'), ['--config-file', config], {
    execPath: process.execPath, execArgv: [], detached: true, stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
    env: { ...process.env, AHPD_MANAGED_CHILD: '1', AHPD_MANAGED_SOURCE: source, AHPD_MANAGED_RELEASE: current, AHPD_MANAGED_PROVIDERS: JSON.stringify(probation ? receipt.providers ?? [] : []) },
  });
  const terminate = () => {
    if (!child.pid) { child.kill('SIGKILL'); return; }
    try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  };
  const abort = new AbortController();
  let ready = false, stopping = false, checking = false, pending, draining = false;
  let lastCheck = 0;
  let launchTimer, timer;
  const stop = () => { stopping = true; abort.abort(); child.kill('SIGTERM'); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  const check = async () => {
    if (!ready || stopping || checking || draining) return;
    checking = true;
    try {
      const preferences = await json(join(home, 'self-update.json'), { enabled: true });
      if (preferences.enabled === false) { pending = undefined; return; }
      const minutes = Number(preferences.intervalMinutes ?? 360);
      if (!Number.isFinite(minutes) || minutes < 5) throw new Error('intervalMinutes must be at least 5');
      if (!pending && Date.now() - lastCheck >= minutes * 60_000) {
        lastCheck = Date.now();
        // The release checkout is detached. The channel is the branch of the
        // source setup cloned, which is the install the operator can switch.
        pending = await build(home, current, abort.signal, source);
        if (pending) log(`validated ${basename(pending)}; waiting for idle`);
      }
      if (pending && !stopping && child.connected) child.send({ type: 'managed-drain' });
    } catch (error) {
      if (!stopping) log(`check failed; keeping current release (${error.code ?? error.name ?? 'error'})`);
    } finally { checking = false; }
  };
  return await new Promise((resolve, reject) => {
    let finished = false;
    const finish = async (code, error) => {
      if (finished) return;
      finished = true;
      clearTimeout(launchTimer); clearInterval(timer);
      process.off('SIGTERM', stop); process.off('SIGINT', stop);
      abort.abort();
      try {
        if (stopping) { resolve(undefined); return; }
        if (probation && !ready && previous) {
          log('new release failed readiness; rolling back');
          await save(join(home, 'managed-update-state.json'), { current: previous, failed: basename(current) });
          resolve({ source, current: previous, config }); return;
        }
        if (draining && pending && code === 0) {
          resolve({ source, current: pending, previous: current, probation: true, config }); return;
        }
        reject(error ?? new Error(`Managed host exited unexpectedly (${code})`));
      } catch (failure) { reject(failure); }
    };
    child.once('error', (error) => { void finish(undefined, error); });
    child.once('exit', (code) => { void finish(code); });
    child.on('message', (message) => {
      if (message?.type === 'managed-ready' && !ready) {
        const providers = Array.isArray(message.providers) ? message.providers : [];
        if (probation && (receipt.providers ?? []).some((provider) => !providers.includes(provider))) {
          log('new release lost a provider; rolling back');
          terminate();
          return;
        }
        ready = true;
        clearTimeout(launchTimer);
        const state = { current, providers, ...(previous ? { previous } : {}) };
        void json(join(home, 'managed-update-state.json'), {}).then((stored) => save(join(home, 'managed-update-state.json'), { ...stored, ...state })).catch(() => log('could not save update receipt'));
        log(`running ${basename(current)}`);
        void prune(home, [current, previous]).catch(() => log('old release cleanup failed'));
        timer = setInterval(() => { void check(); }, dependencies.pollMs ?? 60_000);
      }
      if (message?.type === 'managed-draining' && pending) draining = true;
    });
    launchTimer = setTimeout(terminate, dependencies.readyTimeoutMs ?? 60_000);
  });
}
