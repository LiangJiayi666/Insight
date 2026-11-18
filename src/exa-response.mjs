// Observe the existing Pi -> Exa transport. Never log request URLs, bodies or credentials.
const key = Symbol.for('insight.exa.http-responses');
const allowed = ['retry-after', 'x-ratelimit-reset', 'x-ratelimit-limit', 'x-ratelimit-remaining', 'date'];

export function observeExaFetch(fetchImpl, record, now = Date.now) {
  return async function(input, init) {
    let tool;
    try {
      const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
      if (url.protocol === 'https:' && url.hostname === 'mcp.exa.ai' && body?.method === 'tools/call'
        && /^web_(search|fetch)_exa$/.test(body.params?.name || '')) tool = body.params.name;
    } catch { /* Not a tracked Exa tool request. */ }
    const response = await fetchImpl(input, init);
    if (tool) {
      const headers = Object.fromEntries(allowed.map(name => [name, response.headers.get(name)]).filter(([, value]) => value != null));
      record({ tool, status: response.status, observedAt: now(), headers });
    }
    return response; // Body and request behavior are unchanged.
  };
}

export function installExaObserver() {
  if (globalThis[key]) return;
  const events = globalThis[key] = [];
  globalThis.fetch = observeExaFetch(globalThis.fetch, event => {
    events.push(event);
    if (events.length > 100) events.shift();
  });
}

export function takeExaResponse(tool, startedAt) {
  const events = globalThis[key];
  if (!events) return;
  const name = tool.replace(/^mcp__exa__/, '');
  const result = events.filter(event => event.tool === name && event.observedAt >= startedAt).at(-1);
  // Exa tool calls are serialized by SearchGuard.
  events.splice(0);
  return result;
}

export function providerRetry(result, now = Date.now()) {
  const envelopes = [result?.details?.exaHttp, result, result?.details, result?.structuredContent];
  for (const envelope of envelopes) {
    if (!envelope?.headers) continue;
    let headers;
    try { headers = new Headers(envelope.headers); } catch { continue; }
    const retry = headers.get('retry-after');
    if (retry != null) {
      const seconds = /^\d+(?:\.\d+)?$/.test(retry.trim()) ? Number(retry) : null;
      const date = /[A-Za-z]{3}.*GMT$/.test(retry.trim()) ? Date.parse(retry) : NaN;
      const serverDate = Date.parse(headers.get('date'));
      const delay = seconds != null ? seconds * 1000 : Number.isFinite(date) ? Math.max(0, date - (Number.isFinite(serverDate) ? serverDate : now)) : NaN;
      if (Number.isFinite(delay) && delay >= 0 && now + delay <= 8640000000000000) return { until: now + delay, source: 'retry-after' };
    }
    const reset = headers.get('x-ratelimit-reset');
    if (reset != null && /^\d+(?:\.\d+)?$/.test(reset.trim())) {
      const value = Number(reset), timestamp = value >= 1e12 ? value : value * 1000;
      const serverDate = Date.parse(headers.get('date'));
      const until = Number.isFinite(serverDate) ? now + timestamp - serverDate : timestamp;
      if (Number.isFinite(until) && until >= now && until <= 8640000000000000) return { until, source: 'rate-limit-reset' };
    }
  }
  return null;
}
