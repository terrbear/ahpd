import { createInterface } from 'node:readline';
import { basename } from 'node:path';

if (process.argv.includes('--ignore-term')) {
  process.on('SIGTERM', () => {});
  setInterval(() => {}, 1000);
}

const write = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);

createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method === '_account/subscription_usage' && process.argv.includes('--quota')) {
    const now = Date.now();
    const result = { status: 'verified', name: `${basename(process.cwd())}@example.com`, reportedAt: new Date(now).toISOString(),
      windows: [{ used: 0.23, windowSeconds: 604800, resetsAt: new Date(now + 120_000).toISOString() }] };
    write({ jsonrpc: '2.0', id: message.id, result });
    return;
  }
  if (message.method !== 'initialize') return;
  const status = process.argv.includes('--key')
    ? { kind: 'api_key', label: 'API key' }
    : { kind: 'account', account: { email: `${basename(process.cwd())}@example.com` }, label: 'ChatGPT' };
  write({ jsonrpc: '2.0', method: '_auth/status_update', params: { authStatus: status } });
  write({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: 1, agentCapabilities: process.argv.includes('--quota') && message.params?.clientCapabilities?._meta?.['ahpd.subscriptionUsage'] === 1
    ? { _meta: { subscriptionUsage: { version: 1 } } } : {}, agentInfo: { name: 'account-fixture', version: '1' } } });
});
