const MAX_REQUESTS = 1024;

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function tokenCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export function codexRequestUsage(value: unknown) {
  const evidence = object(value);
  if (!Array.isArray(evidence.requests) || !tokenCount(evidence.count) ||
      evidence.count < evidence.requests.length || evidence.requests.length > MAX_REQUESTS) return undefined;
  const requests = [];
  for (const entry of evidence.requests) {
    const { inputTokens, cachedInputTokens, cacheWriteInputTokens, outputTokens, reasoningOutputTokens, recordedAt } = object(entry);
    if (!tokenCount(inputTokens) || !tokenCount(cachedInputTokens) ||
        !tokenCount(cacheWriteInputTokens) || !tokenCount(outputTokens) ||
        !tokenCount(reasoningOutputTokens) || typeof recordedAt !== 'string' ||
        recordedAt.length !== 24 || !Number.isFinite(Date.parse(recordedAt))) return undefined;
    requests.push({ inputTokens, cachedInputTokens, cacheWriteInputTokens, outputTokens, reasoningOutputTokens, recordedAt });
  }
  return requests.length ? { count: evidence.count, requests } : undefined;
}
