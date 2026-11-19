import { mkdirSync, rmdirSync, statSync } from 'node:fs';

export const lockDockerState = (state) => {
  const lock = `${state}.lock`;
  const STALE = 10_000;
  const pause = new Int32Array(new SharedArrayBuffer(4));
  for (;;) {
    try {
      mkdirSync(lock);
      break;
    }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
        if (Date.now() - statSync(lock).mtimeMs > STALE) rmdirSync(lock);
      }
      catch {}
      Atomics.wait(pause, 0, 0, 2);
    }
  }
  process.on('exit', () => {
    try { rmdirSync(lock); }
    catch {}
  });
};
