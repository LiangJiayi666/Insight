export function diagnoseRun(text) {
  return {
    searchRateLimited: /429|free MCP rate limit/.test(text),
    networkFailure: /fetch failed/.test(text),
    crawlTimeout: /CRAWL_TIMEOUT/.test(text)
  };
}
