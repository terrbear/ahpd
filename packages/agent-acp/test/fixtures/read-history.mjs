import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
const send = (id, result) => process.stdout.write(JSON.stringify({jsonrpc:'2.0', id, result}) + '\n');
createInterface({input:process.stdin}).on('line', line => {
 const request = JSON.parse(line);
 appendFileSync(process.env.CLI_HISTORY_TEST_RECEIPT, request.method + '\n');
 if (request.method === 'initialize') send(request.id, {protocolVersion:1, agentCapabilities:process.argv.includes('--old') ? {} : {_meta:{readOnlyHistory:{version:1}}}});
 else if (request.method === '_session/read_history') send(request.id, {version:1, format:'codex-thread', writable:false, thread:{id:request.params.sessionId, sessionId:'different-root', turns:[{id:'prior',items:[{type:'userMessage',content:'earlier question'},{type:'commandExecution',status:'completed',output:'earlier result'}]},{id:'pending',status:'inProgress'}]}});
 else process.exit(2);
});
