// Only inspect failed tool envelopes. URLs, article text, call IDs and cache
// filenames can legitimately contain "429" or discuss network errors.
export function classifyToolFailure(result) {
  const envelopes = [result, result?.structuredContent, result?.details];
  const failed = envelopes.some(value => value && (
    value.isError === true || value.error != null ||
    [value.status, value.statusCode, value.httpStatus].some(code => Number(code) >= 400 && Number(code) <= 599)
  ));
  const text = failed ? JSON.stringify(result) : '';
  const guardBlocked = /搜索服务限流冷却至/.test(text);
  const localBlock = guardBlocked || /相同请求已有成功结果|本刊搜索\/读取硬预算已用完/.test(text);
  const status429 = envelopes.some(value => value && [value.status, value.statusCode, value.httpStatus, value.error?.code].some(code => Number(code) === 429));
  return {
    failed,
    rateLimited: failed && !localBlock && (status429 || /\b(?:HTTP|status(?: code)?|error)\s*[:=]?\s*429\b|\b(?:free MCP rate limit|too many requests|rate[ _-]?limit(?:ed|ing|s)?|quota exceeded)\b/i.test(text)),
    networkFailure: failed && /fetch failed|ECONNRESET|ECONNREFUSED|ENOTFOUND|ETIMEDOUT/i.test(text),
    crawlTimeout: failed && /CRAWL_TIMEOUT/i.test(text),
    guardBlocked,
  };
}
