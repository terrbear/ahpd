import type { ContentBlock } from '@agentclientprotocol/sdk';
import type { EmbeddedAttachment } from '@ahpd/sdk';

export function attachmentBlocks(attachments: EmbeddedAttachment[]): ContentBlock[] {
  return attachments.map((attachment): ContentBlock => {
    if (attachment.contentType.startsWith('image/')) return { type: 'image', data: attachment.data, mimeType: attachment.contentType };
    if (attachment.contentType === 'text/plain') return { type: 'resource', resource: { uri: `attachment:${encodeURIComponent(attachment.label)}`, mimeType: attachment.contentType, text: Buffer.from(attachment.data, 'base64').toString('utf8') } };
    throw new Error('PDF attachments require native PDF support, such as Claude Code; use UTF-8 text with this ACP provider');
  });
}
