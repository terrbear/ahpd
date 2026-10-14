import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { SessionUpdate } from '@agentclientprotocol/sdk';

export const OUTPUT_PREVIEW_BYTES = 32 * 1024;
const EDGE_BYTES = 12 * 1024;
const hash = (value: string): string => createHash('sha256').update(value).digest('hex');

/** Cut UTF-8 only between code points. */
function edge(text: string, bytes: number, end = false): string {
  const buffer = Buffer.from(text);
  if (buffer.length <= bytes) return text;
  let at = end ? buffer.length - bytes : bytes;
  if (end) while ((buffer[at]! & 0xc0) === 0x80) at++;
  else while ((buffer[at]! & 0xc0) === 0x80) at--;
  return (end ? buffer.subarray(at) : buffer.subarray(0, at)).toString('utf8');
}

/** Labels never repeat a multiline script or heredoc. Arguments remain intact. */
export function toolLabel(value: string): string {
  const first = value.split('\n', 1)[0]!;
  const short = edge(first, 240);
  return short === value ? value : `${short} …`;
}

/** The default for a library embedder without a persistent ACP registry. */
export const outputDirectory = (directory?: string): string =>
  directory === undefined ? join(tmpdir(), `ahpd-acp-${process.pid}`, 'outputs') : join(directory, 'outputs');

/** One tool's text. After spilling, only its head and tail remain in memory. */
class Output {
  private inline = '';
  private head = '';
  private tail = '';
  private spilled = false;
  private bytes = 0;
  private readonly path: string;
  private readonly folder: string;
  constructor(path: string, folder: string) {
    this.path = path;
    this.folder = folder;
  }

  replace(text: string): void {
    this.inline = '';
    this.head = '';
    this.tail = '';
    this.bytes = 0;
    this.spilled = false;
    this.append(text);
  }

  append(text: string): void {
    const bytes = Buffer.byteLength(text);
    if (!this.spilled && this.bytes + bytes <= OUTPUT_PREVIEW_BYTES) {
      this.inline += text;
      this.bytes += bytes;
      return;
    }
    if (!this.spilled) {
      mkdirSync(this.folder, { recursive: true, mode: 0o700 });
      // Finish the file write before replacing full text with a reference.
      writeFileSync(this.path, this.inline, { mode: 0o600 });
      appendFileSync(this.path, text);
      this.head = edge(this.inline + edge(text, EDGE_BYTES), EDGE_BYTES);
      this.tail = edge(this.inline + edge(text, EDGE_BYTES, true), EDGE_BYTES, true);
      this.inline = '';
      this.spilled = true;
    } else {
      appendFileSync(this.path, text);
      this.tail = edge(this.tail + edge(text, EDGE_BYTES, true), EDGE_BYTES, true);
    }
    this.bytes += bytes;
  }

  content(): NonNullable<Extract<SessionUpdate, { sessionUpdate: 'tool_call_update' }>['content']> {
    if (!this.spilled) return [{ type: 'content', content: { type: 'text', text: this.inline } }];
    const uri = pathToFileURL(this.path).href;
    const marker = `\n\n[Output truncated: ${this.bytes} UTF-8 bytes. Full output: ${uri}. Read the file by line range.]\n\n`;
    return [
      { type: 'content', content: { type: 'text', text: this.head + marker + this.tail } },
      { type: 'content', content: { type: 'resource_link', uri, name: 'Full tool output', mimeType: 'text/plain', size: this.bytes } },
    ];
  }
}

/** Per-turn output storage, shared by live mapping and legacy transcript reads. */
export class ToolOutputs {
  private readonly held = new Map<string, Output>();
  private readonly folder: string;
  constructor(directory: string, session: string, turn: string) {
    this.folder = join(directory, hash(session), hash(turn));
  }

  update(given: SessionUpdate): SessionUpdate {
    if (given.sessionUpdate !== 'tool_call' && given.sessionUpdate !== 'tool_call_update') return given;
    const update = { ...given };
    if (typeof update.title === 'string') update.title = toolLabel(update.title);
    const meta = update._meta ?? {};
    const terminal = (meta.terminal_output_delta ?? meta.terminal_output) as { data?: unknown } | undefined;
    const texts = update.content?.flatMap((entry) =>
      entry.type === 'content' && entry.content.type === 'text' ? [entry.content.text] : []);
    if (texts === undefined && typeof terminal?.data !== 'string') return update;
    let output = this.held.get(update.toolCallId);
    if (output === undefined) {
      output = new Output(join(this.folder, `${hash(update.toolCallId)}.txt`), this.folder);
      this.held.set(update.toolCallId, output);
    }
    if (texts !== undefined) output.replace(texts.join('\n'));
    if (typeof terminal?.data === 'string') output.append(terminal.data);
    // Consume terminal deltas here; the mapper must not append them again.
    const remaining = { ...meta };
    delete remaining.terminal_output_delta;
    delete remaining.terminal_output;
    update._meta = remaining;
    update.content = [...(update.content?.filter((entry) => !(entry.type === 'content' && entry.content.type === 'text')) ?? []), ...output.content()];
    return update;
  }
}
