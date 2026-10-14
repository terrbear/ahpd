/** Abort before JSON.stringify encodes a value that exceeds the byte budget. */
export class JsonBudgetExceeded extends Error {
  constructor() { super('Deferred JSON byte budget exceeded'); }
}

/** UTF-8 length without allocating another copy of an admitted large frame. */
export function utf8Bytes(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x80) bytes++;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && text.charCodeAt(i + 1) >= 0xdc00 && text.charCodeAt(i + 1) <= 0xdfff) {
      bytes += 4;
      i++;
    } else bytes += 3;
  }
  return bytes;
}

/** Exact byte length of a JSON string literal, stopping at the given budget. */
function quotedBytes(text: string, budget: number): number {
  // Every input code unit needs at least one output byte, plus two quotes.
  if (text.length + 2 > budget) throw new JsonBudgetExceeded();
  let bytes = 2;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code === 0x22 || code === 0x5c || code === 8 || code === 9 || code === 10 || code === 12 || code === 13) bytes += 2;
    else if (code < 0x20) bytes += 6;
    else if (code < 0x80) bytes++;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && text.charCodeAt(i + 1) >= 0xdc00 && text.charCodeAt(i + 1) <= 0xdfff) {
      bytes += 4;
      i++;
    } else if (code >= 0xd800 && code <= 0xdfff) bytes += 6;
    else bytes += 3;
    if (bytes > budget) throw new JsonBudgetExceeded();
  }
  return bytes;
}

// Intrinsic probes also recognize boxed primitives from another realm. Native
// JSON unboxes these after toJSON/replacer, using ToNumber/ToString as below.
function unbox(value: object): unknown {
  let number = false;
  let string = false;
  try { Number.prototype.valueOf.call(value); number = true; } catch {}
  if (number) return +(value as unknown as number);
  try { String.prototype.valueOf.call(value); string = true; } catch {}
  if (string) return String(value);
  try { return Boolean.prototype.valueOf.call(value); } catch {}
  return value;
}

/** Raw JSON bypasses quoting and traversal in native JSON.stringify. */
function rawJsonBytes(value: object, budget: number): number | undefined {
  const json = JSON as typeof JSON & { isRawJSON?: (value: unknown) => boolean };
  if (!json.isRawJSON?.(value)) return undefined;
  // Native raw objects expose the exact emitted literal as a frozen own data
  // property. Inspect its descriptor without invoking getters; if a runtime
  // cannot expose it safely, reject rather than undercount a branded value.
  const literal = Object.getOwnPropertyDescriptor(value, 'rawJSON');
  if (literal === undefined || typeof literal.value !== 'string'
    || literal.writable !== false || literal.configurable !== false) {
    throw new JsonBudgetExceeded();
  }
  // Code units give a cheap lower bound; count UTF-8 without creating another
  // encoded copy. The caller charges punctuation separately, as for scalars.
  if (literal.value.length > budget) throw new JsonBudgetExceeded();
  return utf8Bytes(literal.value);
}

/**
 * Keep native JSON rules (toJSON, omissions, holes, cycles, ordering), but
 * account for each literal before the engine encodes it. No raw object is
 * retained after this synchronous call. This bounds retained encoded deferred
 * output, not total JS heap or traversal work. Native JSON.stringify can
 * allocate an enumerable-key list before invoking the replacer; caller
 * getters/toJSON and the one admitted oversized frame can also allocate
 * outside this budget. Keep native serialization rather than replacing it
 * with a custom traversal and claiming a hard heap ceiling.
 */
export function boundedJson(message: Record<string, unknown>, budget: number): { text: string; bytes: number } {
  let remaining = budget;
  let root = true;
  const entries = new WeakMap<object, number>();
  const spend = (bytes: number): void => {
    if (bytes > remaining) throw new JsonBudgetExceeded();
    remaining -= bytes;
  };
  const text = JSON.stringify(message, function (this: object, key: string, original: unknown): unknown {
    const value = original !== null && typeof original === 'object' ? unbox(original) : original;
    const absent = value === undefined || typeof value === 'function' || typeof value === 'symbol';
    if (!root && absent && !Array.isArray(this)) return value;
    if (!root) {
      const count = entries.get(this) ?? 0;
      if (count > 0) spend(1); // comma
      entries.set(this, count + 1);
      if (!Array.isArray(this)) { spend(quotedBytes(key, remaining)); spend(1); }
    }
    root = false;
    if (absent || value === null) spend(4); // array hole / null
    else if (typeof value === 'string') spend(quotedBytes(value, remaining));
    else if (typeof value === 'boolean') spend(value ? 4 : 5);
    else if (typeof value === 'number') spend(Number.isFinite(value) ? String(value).length : 4);
    else if (typeof value === 'object') {
      const rawBytes = rawJsonBytes(value, remaining);
      if (rawBytes !== undefined) spend(rawBytes);
      else { spend(2); entries.set(value, 0); }
    }
    // BigInt retains native JSON's TypeError; it is never retained or encoded.
    return value;
  });
  if (text === undefined) throw new TypeError('An outbound frame must have a JSON representation');
  return { text, bytes: budget - remaining };
}
