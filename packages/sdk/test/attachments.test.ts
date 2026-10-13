import { expect, it } from 'vitest';
import { embeddedAttachments } from '../src/attachments.js';

const red = { type: 'embeddedResource', label: 'red.png', contentType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==' };

it('validates file labels, canonical data, supported MIME types, and byte signatures', () => {
  expect(embeddedAttachments([red])).toEqual([red]);
  for (const label of ['', ' ', '.', '..', '../red.png', 'a\\b', 'a\nb', 'x'.repeat(121)]) {
    expect(() => embeddedAttachments([{ ...red, label }])).toThrow('label');
  }
  expect(() => embeddedAttachments([{ ...red, contentType: 'image/jpeg' }])).toThrow('MIME');
  expect(() => embeddedAttachments([{ ...red, contentType: 'application/octet-stream' }])).toThrow('Unsupported');
  expect(() => embeddedAttachments([{ ...red, data: 'invalid base64' }])).toThrow('canonical');
  expect(() => embeddedAttachments([{ ...red, data: Buffer.alloc((5 << 20) + 1).toString('base64') }])).toThrow('5 MB');
  expect(() => embeddedAttachments([{ ...red, data: 'a'.repeat(4 * Math.ceil((25 << 20) / 3) + 1) }])).toThrow('25 MB');
});
