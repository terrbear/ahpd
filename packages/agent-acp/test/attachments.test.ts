import { expect, it } from 'vitest';
import { attachmentBlocks } from '../src/attachments.js';

it('rejects PDFs rather than allowing provider conversion into model-visible base64', () => {
  expect(() => attachmentBlocks([{ type: 'embeddedResource', label: 'report.pdf', contentType: 'application/pdf', data: Buffer.from('%PDF-1.7\nfixture').toString('base64') }])).toThrow('native PDF support');
});
