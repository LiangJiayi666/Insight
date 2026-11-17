import path from 'node:path';
import { readFile, readdir } from 'node:fs/promises';
import { readJson, saveJson } from './runtime.mjs';

export function searchKind(tool) {
  return /(?:^search$|web_search_exa$)/.test(tool) ? 'search' : 'fetch';
}

// Migrate old guard state from actual calls, excluding cache/cooldown/budget blocks.
// The guard's total remains authoritative, including interrupted requests.
export async function initializeSearchBudget(folder) {
  const file = path.join(folder, 'guard-state.json');
  const state = await readJson(file, { count: 0, nextAt: 0, blockedUntil: 0 });
  if (Number.isInteger(state.searchCount) && Number.isInteger(state.fetchCount)) return state;
  const calls = new Map();
  const runFolder = path.dirname(folder);
  for (const name of await readdir(runFolder).catch(error => { if (error.code === 'ENOENT') return []; throw error; })) {
    if (!/^attempt-\d+\.private\.log$/.test(name)) continue;
    for (const line of (await readFile(path.join(runFolder, name), 'utf8')).split(/\r?\n/)) {
      let event; try { event = JSON.parse(line); } catch { continue; }
      if (!/^mcp__exa__web_(search|fetch)_exa$/.test(event.toolName || '')) continue;
      const key = `${name}:${event.toolCallId}`;
      if (event.type === 'tool_execution_start') calls.set(key, searchKind(event.toolName));
      if (event.type === 'tool_execution_end' && (event.isError || event.result?.isError) && /相同请求已有成功结果|搜索服务限流冷却至|本刊搜索\/读取硬预算已用完|本刊分项预算已用完/.test(JSON.stringify(event.result))) calls.delete(key);
    }
  }
  state.searchCount = [...calls.values()].filter(kind => kind === 'search').length;
  state.fetchCount = [...calls.values()].filter(kind => kind === 'fetch').length;
  state.count = Math.max(state.count || 0, state.searchCount + state.fetchCount);
  await saveJson(file, state);
  return state;
}

export function budgetSummary(state, { maxCalls = 60, maxSearch = 24, maxFetch = 36 } = {}) {
  const total = Math.max(state.count || 0, (state.searchCount || 0) + (state.fetchCount || 0));
  return `本刊真实联网调用累计：搜索${state.searchCount || 0}/${maxSearch}次、读取${state.fetchCount || 0}/${maxFetch}次、合计${total}/${maxCalls}次。剩余搜索${Math.max(0, Math.min(maxSearch - (state.searchCount || 0), maxCalls - total))}次、读取${Math.max(0, Math.min(maxFetch - (state.fetchCount || 0), maxCalls - total))}次（共享合计剩余${Math.max(0, maxCalls - total)}次）。缓存命中不消耗预算；不得凭估计宣称额度用完。`;
}
