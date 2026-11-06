import { createInterface } from 'node:readline';
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
const update = (update) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'fixture', update } }) + '\n');
let prompt;
createInterface({ input: process.stdin }).on('line', (line) => {
  const r = JSON.parse(line);
  if (r.method === 'initialize') reply(r.id, { protocolVersion: 1, agentCapabilities: { loadSession: true }, _meta: { steering: { supported: true, activeOnly: true } } });
  else if (r.method === 'session/new') reply(r.id, { sessionId: 'fixture' });
  else if (r.method === 'session/prompt') {
    prompt = r.id;
    update({ sessionUpdate: 'tool_call', toolCallId: 'first', title: 'First command', kind: 'execute', status: 'in_progress' });
  } else if (r.method === '_session/steering') {
    if (r.params.activeOnly !== true || prompt === undefined) process.exit(2);
    reply(r.id, { outcome: 'injected' });
    update({ sessionUpdate: 'tool_call_update', toolCallId: 'first', status: 'completed' });
    update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Applied correction before the next command: ' + r.params.prompt[0].text } });
    reply(prompt, { stopReason: 'end_turn' });
    prompt = undefined;
  } else if (r.method === 'session/cancel' && prompt !== undefined) {
    reply(prompt, { stopReason: 'cancelled' }); prompt = undefined;
  } else if (r.id !== undefined) reply(r.id, {});
});
