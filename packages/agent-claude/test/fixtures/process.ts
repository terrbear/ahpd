import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

export class ProcessFixture extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  killed = false;
  exitCode: number | null = null;
  signals: NodeJS.Signals[] = [];
  kill(signal: NodeJS.Signals): boolean { this.killed = true; this.signals.push(signal); return true; }
  exit(): void { this.exitCode = 0; this.emit('exit', 0, null); }
}
