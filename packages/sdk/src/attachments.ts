export interface EmbeddedAttachment {
  type: 'embeddedResource';
  label: string;
  data: string;
  contentType: string;
}

export function embeddedAttachments(value: unknown): EmbeddedAttachment[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error('Attachments must be an array');
  let total = 0;
  return value.map((entry: unknown) => {
    if (typeof entry !== 'object' || entry === null) throw new Error('Invalid attachment');
    const item = entry as Record<string, unknown>;
    if (item.type !== 'embeddedResource' || typeof item.label !== 'string' || typeof item.data !== 'string' || typeof item.contentType !== 'string') throw new Error('Only embedded file attachments are supported');
    if (!item.label.trim() || Buffer.byteLength(item.label, 'utf8') > 120 || item.label === '.' || item.label === '..' || /[\p{Cc}/\\]/u.test(item.label)) throw new Error('Attachment label must be a short filename without path separators or control characters');
    if (item.data.length > 4 * Math.ceil((25 << 20) / 3)) throw new Error('Attachments exceed the 25 MB total limit');
    const bytes = Buffer.from(item.data, 'base64');
    if (bytes.length === 0 || bytes.toString('base64') !== item.data) throw new Error('Attachment data must be nonempty canonical base64');
    total += bytes.length;
    if (total > 25 << 20) throw new Error('Attachments exceed the 25 MB total limit');
    const images = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
    if (!images.includes(item.contentType) && item.contentType !== 'text/plain' && item.contentType !== 'application/pdf') throw new Error('Unsupported attachment content type');
    if (images.includes(item.contentType) && bytes.length > 5 << 20) throw new Error('Image attachment exceeds the 5 MB image limit');
    const signature = bytes.subarray(0, 12);
    let matches = false;
    switch (item.contentType) {
      case 'image/png': matches = signature.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])); break;
      case 'image/jpeg': matches = signature.subarray(0, 3).equals(Buffer.from([255,216,255])); break;
      case 'image/gif': matches = ['GIF87a', 'GIF89a'].includes(signature.subarray(0, 6).toString('ascii')); break;
      case 'image/webp': matches = signature.subarray(0, 4).toString('ascii') === 'RIFF' && signature.subarray(8, 12).toString('ascii') === 'WEBP'; break;
      case 'application/pdf': matches = signature.subarray(0, 5).toString('ascii') === '%PDF-'; break;
      default: matches = !bytes.includes(0) && new TextDecoder('utf-8', { fatal: true }).decode(bytes).length > 0;
    }
    if (!matches) throw new Error('Attachment content does not match its MIME type');
    return { type: 'embeddedResource' , label: item.label, data: item.data, contentType: item.contentType };
  });
}
