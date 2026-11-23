// Only inspect failed tool envelopes. URLs, article text, call IDs and cache
// filenames can legitimately contain "429" or discuss network errors.
export function classifyToolFailure(result) {
  const envelopes = [result, result?.structuredContent, result?.details, result?.details?.exaHttp];
  const failed = envelopes.some(value => value && (
    value.isError === true || value.error != null ||
    [value.status, value.statusCode, value.httpStatus].some(code => Number(code) >= 400 && Number(code) <= 599)
  ));
  const text = failed ? JSON.stringify(result) : '';
  // A genuine 429 also receives an appended policy explanation. Only the leading
  // tool error can identify a locally blocked call; the explanation is not one.
  const first = failed ? (result?.content?.find(item => item?.type === 'text')?.text || '') : '';
  const guardBlocked = /搜索服务限流冷却至|Exa限流等待至|本次运行的429重试次数已达上限/.test(first);
  const localBlock = guardBlocked || /同批Exa调用须串行|相同请求已有成功结果|本刊搜索\/读取硬预算已用完|本刊分项预算已用完|本次运行因Exa认证或余额错误停止联网/.test(first);
  const status429 = envelopes.some(value => value && [value.status, value.statusCode, value.httpStatus, value.error?.code].some(code => Number(code) === 429));
  const status = envelopes.flatMap(value => value ? [value.status, value.statusCode, value.httpStatus, value.error?.code] : []).map(Number).find(code => code >= 400 && code <= 599)
    || Number(/\b(?:HTTP(?: request failed with status)?|status(?: code)?|error)\s*[:=]?\s*([45]\d\d)\b/i.exec(text)?.[1]) || null;
  return {
    failed,
    rateLimited: failed && !localBlock && (status429 || status === 429 || (!status && /\b(?:free MCP rate limit|too many requests|rate[ _-]?limit(?:ed|ing|s)?)\b/i.test(text))),
    paymentRequired: failed && !localBlock && status === 402,
    authFailure: failed && !localBlock && (status === 401 || status === 403),
    networkFailure: failed && /fetch failed|ECONNRESET|ECONNREFUSED|ENOTFOUND|ETIMEDOUT/i.test(text),
    crawlTimeout: failed && /CRAWL_TIMEOUT/i.test(text),
    guardBlocked,
  };
}
