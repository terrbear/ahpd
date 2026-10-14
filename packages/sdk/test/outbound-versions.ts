import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript';
import { createPeer } from '../src/rpc.js';

export const BASE = '31bf80ab062e88439784475d5eff590b88b52f43';
export const REJECTED = 'abdd4504bce4aed563205920641a4f3fa3c2ec29';

/** Shallow CI checkouts may not carry the two historical git objects. */
export function historicalSourcesAvailable(): boolean {
  try {
    for (const revision of [BASE, REJECTED]) execFileSync('git', ['cat-file', '-e', `${revision}:packages/sdk/src/rpc.ts`], {
      cwd: fileURLToPath(new URL('../../../', import.meta.url)), stdio: 'ignore',
    });
    return true;
  } catch { return false; }
}

/** Read only these exact public-source git objects; no checkout or worker. */
export async function versions(): Promise<Record<string, typeof createPeer>> {
  const peers: Record<string, typeof createPeer> = { final: createPeer };
  for (const revision of [BASE, REJECTED]) {
    const source = execFileSync('git', ['show', `${revision}:packages/sdk/src/rpc.ts`], {
      cwd: fileURLToPath(new URL('../../../', import.meta.url)), encoding: 'utf8',
    });
    const { outputText } = transpileModule(source, { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2023 } });
    // Synchronous CommonJS evaluation works inside Vitest's VM without a
    // dynamic-import callback. These exact source files import only node:buffer
    // at runtime; their local type imports are erased by the transpiler.
    const historical = { exports: {} as { createPeer: typeof createPeer } };
    new Function('exports', 'require', 'module', outputText)(historical.exports, createRequire(import.meta.url), historical);
    peers[revision] = historical.exports.createPeer;
  }
  return peers;
}
