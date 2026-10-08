import { createInterface } from 'node:readline';
import { basename } from 'node:path';

if (process.argv.includes('--ignore-term')) {
  process.on('SIGTERM', () => {});
  setInterval(() => {}, 1000);
}

const write = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);

createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method !== 'initialize') return;
  const status = process.argv.includes('--key')
    ? { kind: 'api_key', label: 'API key' }
    : { kind: 'account', account: { email: `${basename(process.cwd())}@example.com` }, label: 'ChatGPT' };
  write({ jsonrpc: '2.0', method: '_auth/status_update', params: { authStatus: status } });
  write({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: 1, agentCapabilities: {}, agentInfo: { name: 'account-fixture', version: '1' } } });
});
