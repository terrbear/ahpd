import { getSessionMessages } from '@anthropic-ai/claude-agent-sdk';
import { catalogue } from './catalog.js';
import type { Bag } from '@ahpd/sdk';

export async function readExternalHistory(id: string, directories: string[]): Promise<{ format: 'claude-messages'; history: Bag } | undefined> {
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id)) return undefined;
  for (const dir of directories) {
    const rows = await catalogue(dir);
    if (!rows.some(row => row.id === id)) continue;
    const messages = await getSessionMessages(id, { dir, includeSystemMessages: true });
    if (!messages.length || messages.some(message => message.session_id !== id)) return undefined;
    return { format: 'claude-messages', history: { id, turns: messages } };
  }
  return undefined;
}
