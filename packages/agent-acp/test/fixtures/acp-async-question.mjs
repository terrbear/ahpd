import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
const write = (value) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...value })}\n`);
for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line);
  if (process.env.ACP_LOG) appendFileSync(process.env.ACP_LOG, `${line}\n`);
  const { id, method, params = {} } = message;
  if (id === undefined) continue;
  if (method === 'initialize') {
    write({ id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } });
  } else if (method === 'session/new') {
    write({ id, result: { sessionId: `native-async-${process.pid}` } });
  } else if (method === 'session/load') {
    write({ id, result: {} });
  } else if (method === 'session/prompt') {
    const text = params.prompt.map((part) => part.text ?? '').join('');
    const update = text === 'ask' ? {
      sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Proceed with the bounded test?\nApprove\nKeep paused' },
      _meta: { 'codex/asyncUserInput': { id: 'question-1', questions: [{ title: 'Proceed with the bounded test?', options: ['Approve', 'Keep paused'] }] } },
    } : { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Received your reply.' } };
    write({ method: 'session/update', params: { sessionId: params.sessionId, update } });
    write({ id, result: { stopReason: 'end_turn' } });
  } else {
    write({ id, result: {} });
  }
}
