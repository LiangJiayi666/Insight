import { createHash } from 'node:crypto';
import path from 'node:path';
import { readJson, saveJson } from './runtime.mjs';
import { classifyToolFailure } from './tool-failure.mjs';
import { searchKind, initializeSearchBudget, budgetSummary } from './search-budget.mjs';
import { providerRetry, takeExaResponse } from './exa-response.mjs';
export class SearchGuard {
  constructor(folder, { intervalMs = 0, maxCalls = Infinity, maxSearch = Infinity, maxFetch = Infinity,
    fallbackBackoffMs = 30000, maxBackoffMs = 900000, maxWaitMs = 60000, maxRateLimitRetries = 2,
    rateLimitFile = path.join(folder, 'rate-limit.json'), rejectConcurrent = false, now = Date.now, sleep = ms => new Promise(r => setTimeout(r, ms)) } = {}) {
    for (const value of [intervalMs, fallbackBackoffMs, maxBackoffMs, maxWaitMs, maxRateLimitRetries]) if (!Number.isFinite(value) || value < 0) throw new Error('Exa退避配置须为非负有限数值');
    if (!Number.isInteger(maxRateLimitRetries) || fallbackBackoffMs < 1 || maxBackoffMs < fallbackBackoffMs || maxWaitMs > 60000) throw new Error('Exa退避配置无效：单次自动等待不超过60秒');
    Object.assign(this, { folder, intervalMs, maxCalls, maxSearch, maxFetch, fallbackBackoffMs, maxBackoffMs, maxWaitMs, maxRateLimitRetries, rateLimitFile, rejectConcurrent, now, sleep });
    this.rateLimitsThisRun = 0; this.stopReason = null;
    this.queue = Promise.resolve(); this.calls = new Map();
  }
  key(tool, input) { return createHash('sha256').update(JSON.stringify({ tool, input })).digest('hex'); }
  async budget() { return budgetSummary(await initializeSearchBudget(this.folder), this); }
  async rateState() {
    const current = await readJson(this.rateLimitFile, null);
    if (current) return current;
    const legacy = await readJson(path.join(this.folder, 'guard-state.json'), {});
    return { blockedUntil: legacy.blockedUntil || 0, consecutive429: 0, retrySource: legacy.blockedUntil ? 'legacy-local-policy' : null };
  }
  async policyStatus() {
    if (this.stopReason) return this.stopReason;
    const state = await this.rateState();
    if (!state.blockedUntil || state.blockedUntil <= this.now()) return '';
    const basis = state.retrySource === 'retry-after' ? '服务端Retry-After' : state.retrySource === 'rate-limit-reset' ? '服务端X-RateLimit-Reset' : '未取得服务端等待时间，采用本地指数退避（不是官方额度或重置时间）';
    const stop = this.rateLimitsThisRun > this.maxRateLimitRetries;
    return `${stop ? '本次运行的429重试次数已达上限。' : ''}Exa限流等待至${new Date(state.blockedUntil).toISOString()}，依据：${basis}。${stop || state.blockedUntil - this.now() > this.maxWaitMs ? '本次停止新的联网调用，使用已保存证据；保留检查点，届时可恢复。' : '下一次Exa调用将先等待再尝试，勿立即反复请求。'}`;
  }
  async before(id, tool, input) {
    // Pi prepares every call in a parallel batch BEFORE executing any call.
    // Waiting for another call's result here deadlocks the entire batch.
    // In the Pi hook, reject the extra call so it can be issued next turn.
    if (this.rejectConcurrent && this.busy) return { block: true, reason: '同批Exa调用须串行：本条尚未联网、不计额度。请等待本批第一条结果，在下一轮单独重新调用本条。' };
    this.busy = true;
    const previous = this.queue; let release;
    this.queue = new Promise(r => { release = () => { this.busy = false; r(); }; });
    await previous;
    try {
      const key = this.key(tool, input); const file = path.join(this.folder, `${key}.json`);
      const cached = await readJson(file, null);
      if (cached) { release(); return { block: true, reason: `相同请求已有成功结果，不重复联网。请用read读取缓存：${file}。缓存取得时间：${cached.fetchedAt}` }; }
      if (this.stopReason) { release(); return { block: true, reason: this.stopReason }; }
      if (this.rateLimitsThisRun > this.maxRateLimitRetries) { release(); return { block: true, reason: '本次运行的429重试次数已达上限，请使用缓存收尾，稍后恢复。' }; }
      const state = await initializeSearchBudget(this.folder);
      if (state.count >= this.maxCalls) { release(); return { block: true, reason: '本刊搜索/读取硬预算已用完，请复用缓存并完成已有证据稿件。' }; }
      const kind = searchKind(tool);
      if (state[`${kind}Count`] >= (kind === 'search' ? this.maxSearch : this.maxFetch)) { release(); return { block: true, reason: '本刊分项预算已用完。' + budgetSummary(state, this) }; }
      const rate = await this.rateState();
      const delay = Math.max(0, rate.blockedUntil - this.now());
      if (delay > this.maxWaitMs) { const reason = await this.policyStatus(); release(); return { block: true, reason }; }
      if (delay) await this.sleep(delay);
      if (this.intervalMs) await this.sleep(Math.max(0, state.nextAt - this.now()));
      state.count++; state[`${kind}Count`]++; state.nextAt = this.now() + this.intervalMs;
      await saveJson(path.join(this.folder, 'guard-state.json'), state);
      this.calls.set(id, { release, file, tool, input, startedAt: this.now() });
    } catch (e) { release(); throw e; }
  }
  async after(id, result) {
    const call = this.calls.get(id); if (!call) return;
    try {
      const observed = takeExaResponse(call.tool, call.startedAt);
      if (observed) result = { ...result, details: { ...result.details, exaHttp: observed } };
      const failure = classifyToolFailure(result);
      if (failure.rateLimited) {
        const state = await this.rateState();
        state.consecutive429 = (state.consecutive429 || 0) + 1;
        this.rateLimitsThisRun++;
        const retry = providerRetry(result, this.now()) || { until: this.now() + Math.min(this.maxBackoffMs, this.fallbackBackoffMs * 2 ** Math.min(state.consecutive429 - 1, 20)), source: 'local-exponential-backoff' };
        state.blockedUntil = retry.until;
        state.retrySource = retry.source;
        state.last429At = new Date(this.now()).toISOString();
        state.lastHttp = observed || result.details?.exaHttp || null;
        await saveJson(this.rateLimitFile, state);
      } else if (failure.paymentRequired || failure.authFailure) {
        this.stopReason = `本次运行因Exa认证或余额错误停止联网（${failure.paymentRequired ? '402：余额或密钥预算不足' : '401/403：认证或访问权限问题'}），不是429限流，不自动重试。请使用缓存收尾。`;
      } else if (!failure.failed) {
        this.rateLimitsThisRun = 0;
        const state = await this.rateState();
        if (state.blockedUntil || state.consecutive429) await saveJson(this.rateLimitFile, { ...state, blockedUntil: 0, consecutive429: 0, retrySource: null, recoveredAt: new Date(this.now()).toISOString() });
        await saveJson(call.file, { tool: call.tool, input: call.input, fetchedAt: new Date(this.now()).toISOString(), result });
        const indexFile = path.join(this.folder, 'index.json');
        const index = await readJson(indexFile, {});
        index[path.basename(call.file)] = { tool: call.tool, input: call.input, path: call.file };
        await saveJson(indexFile, index);
      }
      return result;
    } finally { this.calls.delete(id); call.release(); }
  }
}
