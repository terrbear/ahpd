import { inflateSync } from 'node:zlib';
import { expect, it } from 'vitest';
import { attachmentContent } from '../src/attachments.js';

const red = { type: 'embeddedResource', label: 'red.png', contentType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==' };

it('passes actual image pixels and files in Claude native content without base64 in text', () => {
  const pdf = Buffer.from('%PDF-1.7\nfixture').toString('base64');
  const blocks = attachmentContent('', [red,
    { type: 'embeddedResource', label: 'note.txt', contentType: 'text/plain', data: Buffer.from('actual file').toString('base64') },
    { type: 'embeddedResource', label: 'report.pdf', contentType: 'application/pdf', data: pdf },
  ]);
  expect(blocks).toEqual([
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: red.data } },
    { type: 'text', text: 'note.txt:\nactual file' },
    { type: 'document', title: 'report.pdf', source: { type: 'base64', media_type: 'application/pdf', data: pdf } },
  ]);
  const bytes = Buffer.from(red.data, 'base64');
  const length = bytes.readUInt32BE(33);
  expect(inflateSync(bytes.subarray(41, 41 + length))).toEqual(Buffer.from([0, 255, 0, 0, 255]));
  expect(attachmentContent('plain', undefined)).toBe('plain');
});
