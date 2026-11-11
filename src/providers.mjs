import { createHash } from 'node:crypto';

export function checkCredentials(env = process.env) {
  const missing = ['EXA_API_KEY', 'OPENAI_API_KEY', 'OPENAI_MODEL'].filter(key => !env[key]?.trim());
  if (missing.length) throw new Error(`缺少配置：${missing.join(', ')}。请填写本地 .env 后重试。`);
  const base = new URL(env.OPENAI_BASE_URL || 'https://api.openai.com/v1');
  if (base.protocol !== 'https:' || base.username || base.password) throw new Error('OPENAI_BASE_URL 必须是无凭证 HTTPS 地址');
}
export function canonicalUrl(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Unsafe source URL');
  url.hash = '';
  for (const key of [...url.searchParams.keys()]) if (/^(utm_|fbclid|gclid)/i.test(key)) url.searchParams.delete(key);
  return url.href;
}
export function normalizeResults(results, category, window, maxChars) {
  const items = [];
  const seen = new Set();
  for (const result of results || []) {
    let url; try { url = canonicalUrl(result.url); } catch { continue; }
    const stamp = Date.parse(result.publishedDate);
    if (!Number.isFinite(stamp) || stamp < Date.parse(window.start) || stamp > Date.parse(window.end)) continue;
    if (seen.has(url) || !result.title || typeof result.text !== 'string' || result.text.trim().length < 300) continue;
    seen.add(url);
    items.push({ id: `s-${createHash('sha256').update(url).digest('hex').slice(0, 16)}`, url, title: result.title,
      published: result.publishedDate, category, publisher: new URL(url).hostname,
      text: result.text.slice(0, maxChars), retrievedAt: new Date().toISOString() });
  }
  return items;
}
export class Providers {
  constructor(settings, checkpoint, persist, env = process.env) {
    this.settings = settings; this.state = checkpoint; this.persist = persist; this.env = env;
    this.state.requests ||= { search: 0, model: 0 };
  }
  async post(kind, url, headers, body) {
    const cap = kind === 'search' ? this.settings.maxSearchRequests : this.settings.maxModelRequests;
    for (let attempt = 0; attempt < this.settings.maxAttempts; attempt++) {
      if (this.state.requests[kind] >= cap) throw new Error(`${kind} 每日请求预算已用尽`);
      this.state.requests[kind]++;
      await this.persist();
      let response;
      try { response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(this.settings.requestTimeoutMs) }); }
      catch { if (attempt + 1 === this.settings.maxAttempts) throw new Error(`${kind} 网络失败或超时`); }
      if (response?.ok) return response.json();
      if (response && response.status !== 429 && response.status < 500) throw new Error(`${kind} HTTP ${response.status}（响应内容不写入日志）`);
      if (attempt + 1 === this.settings.maxAttempts) throw new Error(`${kind} 请求失败，重试已耗尽`);
      await new Promise(resolve => setTimeout(resolve, 1500 * 2 ** attempt));
    }
  }
  async search(query, window, domains, count) {
    const result = await this.post('search', 'https://api.exa.ai/search', { 'x-api-key': this.env.EXA_API_KEY }, {
      query, type: 'auto', numResults: count, startPublishedDate: window.start, endPublishedDate: window.end,
      ...(domains?.length ? { includeDomains: domains } : {}), contents: { text: { maxCharacters: this.settings.maxSourceCharacters } },
    });
    return result.results || [];
  }
  async json(system, input) {
    const content = JSON.stringify(input);
    if (content.length > this.settings.maxInputCharacters) throw new Error('模型输入超过字符预算');
    const result = await this.post('model', `${(this.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '')}/chat/completions`, { Authorization: `Bearer ${this.env.OPENAI_API_KEY}` }, {
      model: this.env.OPENAI_MODEL, response_format: { type: 'json_object' }, max_tokens: this.settings.maxOutputTokens,
      messages: [{ role: 'system', content: system }, { role: 'user', content }],
    });
    if (result.choices?.[0]?.finish_reason === 'length') throw new Error('模型输出被截断');
    try { return JSON.parse(result.choices[0].message.content); } catch { throw new Error('模型未返回有效 JSON'); }
  }
}
