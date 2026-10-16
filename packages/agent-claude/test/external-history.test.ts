import { expect, it, vi } from 'vitest';
const calls = vi.hoisted(() => ({ list: vi.fn(), messages: vi.fn() }));
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ listSessions: calls.list, getSessionMessages: calls.messages }));
const { readExternalHistory } = await import('../src/external-history.js');
const id = '11111111-2222-4333-8444-555555555555';

it('preserves system compaction, attachments and unresolved tool records without marking them complete', async () => {
 calls.list.mockResolvedValue([{sessionId:id,lastModified:1}]);
 const messages = [
  {type:'user',session_id:id,message:{content:'earlier question'}},
  {type:'assistant',session_id:id,message:{content:[{type:'tool_use',id:'tool',input:{synthetic:true}}]}},
  {type:'user',session_id:id,message:{content:[{type:'tool_result',tool_use_id:'tool',content:'earlier result'},{type:'image',source:{type:'url',url:'https://fixture.invalid/image'}}]}},
  {type:'system',session_id:id,message:{subtype:'compact_boundary',compact_metadata:{trigger:'auto'}}},
  {type:'assistant',session_id:id,message:{content:[{type:'tool_use',id:'pending'}]}},
 ];
 calls.messages.mockResolvedValue(messages);
 const result = await readExternalHistory(id, ['/fixture']);
 expect(result).toEqual({format:'claude-messages',history:{id,turns:messages}});
 expect(calls.messages).toHaveBeenCalledWith(id,{dir:'/fixture',includeSystemMessages:true});
 expect(JSON.stringify(result)).not.toContain('"state":"complete"');
});

it('refuses missing catalog identity and mismatched message ownership', async () => {
 calls.messages.mockClear(); calls.list.mockResolvedValue([]);
 expect(await readExternalHistory(id,['/fixture'])).toBeUndefined();
 expect(calls.messages).not.toHaveBeenCalled();
 calls.list.mockResolvedValue([{sessionId:id,lastModified:1}]);
 calls.messages.mockResolvedValue([{session_id:'other'}]);
 expect(await readExternalHistory(id,['/fixture'])).toBeUndefined();
});
