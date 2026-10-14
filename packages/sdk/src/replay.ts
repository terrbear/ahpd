/** A retention budget, independent of the size of a live frame or snapshot. */
export const REPLAY_BYTES = 32 * 1024 * 1024;
export const REPLAY_ACTIONS = 1000;

/**
 * Estimate the storage a clone of protocol data needs without making the clone
 * or serializing it. Charge strings as UTF-16 and allow for object/property
 * overhead. This is a retention accounting policy, not an exact V8 heap size.
 * Unsupported or excessively deep values can still go out live; they just
 * require snapshot recovery instead of a retained replay copy.
 */
function retainedSize(value: unknown, budget: number): number {
  let bytes = 0;
  const seen = new WeakSet<object>();
  const visit = (one: unknown, depth: number): void => {
    if (bytes > budget) return;
    if (typeof one === 'string') { bytes += 32 + one.length * 2; return; }
    if (one === null || one === undefined || typeof one === 'boolean' || typeof one === 'number') {
      bytes += 16;
      return;
    }
    if (typeof one !== 'object' || depth > 64) { bytes = Infinity; return; }
    if (seen.has(one)) return;
    seen.add(one);
    const prototype = Object.getPrototypeOf(one);
    if (!Array.isArray(one) && prototype !== Object.prototype && prototype !== null) {
      bytes = Infinity;
      return;
    }
    bytes += 64 + (Array.isArray(one) ? one.length * 8 : 0);
    if (bytes > budget) return;
    for (const key in one) {
      if (!Object.hasOwn(one, key)) continue;
      bytes += 32 + key.length * 2;
      if (bytes > budget) return;
      const property = Object.getOwnPropertyDescriptor(one, key)!;
      // Do not invoke a getter twice, or budget a different value from the
      // one structuredClone would subsequently read.
      if (!('value' in property)) { bytes = Infinity; return; }
      visit(property.value, depth + 1);
      if (bytes > budget) return;
    }
  };
  visit(value, 0);
  return bytes;
}

/** A contiguous suffix of actions, frozen for reconnect and subscribe races. */
export class Replay<T extends { serverSeq: number }> {
  readonly entries: T[] = [];
  private sizes: number[] = [];
  private bytes = 0;
  private evictedThrough = 0;

  get retainedBytes(): number { return this.bytes; }
  covers(since: number): boolean { return since >= this.evictedThrough; }

  push(entry: T): void {
    const size = retainedSize(entry, REPLAY_BYTES);
    // Release old copies before allocating the new one. Oversized entries
    // clear the suffix too: replay must never silently jump over an action.
    while (this.entries.length > 0
      && (this.entries.length >= REPLAY_ACTIONS || this.bytes + size > REPLAY_BYTES)) {
      this.evictedThrough = this.entries.shift()!.serverSeq;
      this.bytes -= this.sizes.shift()!;
    }
    if (size > REPLAY_BYTES) {
      this.evictedThrough = entry.serverSeq;
      return;
    }
    this.entries.push(structuredClone(entry));
    this.sizes.push(size);
    this.bytes += size;
  }
}
