import { createHash } from 'node:crypto';
import path from 'node:path';
import { readJson, saveJson } from './runtime.mjs';
import { classifyToolFailure } from './tool-failure.mjs';
export class SearchGuard {
  constructor(folder, { intervalMs = 8000, cooldownMs = 15 * 60000, maxCalls = 60, now = Date.now, sleep = ms => new Promise(r => setTimeout(r, ms)) } = {}) {
    Object.assign(this, { folder, intervalMs, cooldownMs, maxCalls, now, sleep });
    this.queue = Promise.resolve(); this.calls = new Map();
  }
  key(tool, input) { return createHash('sha256').update(JSON.stringify({ tool, input })).digest('hex'); }
  async before(id, tool, input) {
    const previous = this.queue; let release;
    this.queue = new Promise(r => { release = r; });
    await previous;
    try {
      const key = this.key(tool, input); const file = path.join(this.folder, `${key}.json`);
      const cached = await readJson(file, null);
      if (cached) { release(); return { block: true, reason: `相同请求已有成功结果，不重复联网。请用read读取缓存：${file}。缓存取得时间：${cached.fetchedAt}` }; }
      const state = await readJson(path.join(this.folder, 'guard-state.json'), { count: 0, nextAt: 0, blockedUntil: 0 });
      if (state.count >= this.maxCalls) { release(); return { block: true, reason: '本刊搜索/读取硬预算已用完，请复用缓存并完成已有证据稿件。' }; }
      if (state.blockedUntil > this.now()) { release(); return { block: true, reason: `搜索服务限流冷却至${new Date(state.blockedUntil).toISOString()}。请使用缓存收尾，勿继续调用。` }; }
      await this.sleep(Math.max(0, state.nextAt - this.now()));
      state.count++; state.nextAt = this.now() + this.intervalMs;
      await saveJson(path.join(this.folder, 'guard-state.json'), state);
      this.calls.set(id, { release, file, tool, input });
    } catch (e) { release(); throw e; }
  }
  async after(id, result) {
    const call = this.calls.get(id); if (!call) return;
    try {
      const failure = classifyToolFailure(result);
      if (failure.rateLimited) {
        const state = await readJson(path.join(this.folder, 'guard-state.json'));
        state.blockedUntil = this.now() + this.cooldownMs;
        state.blockReason = 'provider-rate-limit';
        await saveJson(path.join(this.folder, 'guard-state.json'), state);
      } else if (!failure.failed) {
        await saveJson(call.file, { tool: call.tool, input: call.input, fetchedAt: new Date(this.now()).toISOString(), result });
        const indexFile = path.join(this.folder, 'index.json');
        const index = await readJson(indexFile, {});
        index[path.basename(call.file)] = { tool: call.tool, input: call.input, path: call.file };
        await saveJson(indexFile, index);
      }
    } finally { this.calls.delete(id); call.release(); }
  }
}
