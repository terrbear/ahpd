import { embeddedAttachments } from '@ahpd/sdk';
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

type UserContent = SDKUserMessage['message']['content'];
export function attachmentContent(text: string, attachments: unknown): UserContent {
  const files = embeddedAttachments(attachments);
  if (files.length === 0) return text;
  const content: Exclude<UserContent, string> = text ? [{ type: 'text', text }] : [];
  for (const file of files) {
    if (file.contentType.startsWith('image/')) content.push({ type: 'image', source: { type: 'base64', media_type: file.contentType as 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp', data: file.data } });
    else if (file.contentType === 'application/pdf') content.push({ type: 'document', title: file.label, source: { type: 'base64', media_type: 'application/pdf', data: file.data } });
    else content.push({ type: 'text', text: `${file.label}:\n${Buffer.from(file.data, 'base64').toString('utf8')}` });
  }
  return content;
}
