import path from 'node:path';
import { readFile, readdir } from 'node:fs/promises';
import { SearchGuard } from './search-guard.mjs';
import { classifyToolFailure } from './tool-failure.mjs';
import { diagnoseRun } from './run-diagnostics.mjs';
import { readJson, saveJson } from './runtime.mjs';

export function inspectSearchLog(text) {
  const calls = new Map();
  const timestamps = new Map();
  const successes = [];
  let lastCooldown = null, falseCooldown = false;
  for (const line of text.split(/\r?\n/)) {
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (event.type === 'message_end' && event.message?.role === 'toolResult') {
      timestamps.set(event.message.toolCallId, event.message.timestamp);
    }
    if (!/^mcp__exa__web_(search|fetch)_exa$/.test(event.toolName || '')) continue;
    if (event.type === 'tool_execution_start') calls.set(event.toolCallId, event);
    if (event.type !== 'tool_execution_end') continue;
    const result = { ...event.result, isError: event.isError === true || event.result?.isError === true };
    const failure = classifyToolFailure(result);
    if (failure.rateLimited) lastCooldown = 'provider';
    if (failure.guardBlocked && lastCooldown === 'false-positive') falseCooldown = true;
    if (!failure.failed) {
      // This is the precise payload the previous guard scanned, not call IDs.
      const oldPayload = { content: result.content, details: result.details, isError: result.isError };
      if (/429|free MCP rate limit/i.test(JSON.stringify(oldPayload))) lastCooldown = 'false-positive';
      const call = calls.get(event.toolCallId);
      if (call) successes.push({ id: event.toolCallId, tool: call.toolName, input: call.args, result });
    }
  }
  return {
    successes: successes.map(item => ({ ...item, fetchedAt: Number.isFinite(timestamps.get(item.id)) ? new Date(timestamps.get(item.id)).toISOString() : null })),
    falseCooldown, lastCooldown, diagnostics: diagnoseRun(text),
  };
}

// Caller holds the daily lock. Keep original attempts/logs and grant each proven
// false failure one credit, once; genuine provider failures are never refunded.
export async function repairSearchCache(folder) {
  const checkpointFile = path.join(folder, 'checkpoint.json');
  const checkpoint = await readJson(checkpointFile);
  const cache = path.join(folder, 'search-cache');
  const guard = new SearchGuard(cache);
  const index = await readJson(path.join(cache, 'index.json'), {});
  const previous = checkpoint.searchGuardRecovery || {};
  const refunded = new Set(previous.refundedAttempts || []);
  let restored = 0, lastCooldown = null;
  const files = (await readdir(folder)).filter(file => /^attempt-\d+\.private\.log$/.test(file))
    .sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]));
  for (const log of files) {
    const attempt = Number(log.match(/\d+/)[0]);
    const inspection = inspectSearchLog(await readFile(path.join(folder, log), 'utf8'));
    if (inspection.lastCooldown) lastCooldown = inspection.lastCooldown;
    if (attempt === checkpoint.attempts) checkpoint.diagnostics = inspection.diagnostics;
    if (!inspection.falseCooldown || inspection.diagnostics.searchRateLimited || attempt > checkpoint.attempts) continue;
    refunded.add(attempt);
    for (const entry of inspection.successes) {
      const file = path.join(cache, `${guard.key(entry.tool, entry.input)}.json`);
      if (!await readJson(file, null)) {
        const { id, ...value } = entry;
        await saveJson(file, { ...value, recoveredFrom: { log, toolCallId: id } });
        restored++;
      }
      index[path.basename(file)] = { tool: entry.tool, input: entry.input, path: file };
    }
  }
  await saveJson(path.join(cache, 'index.json'), index);
  const state = await readJson(path.join(cache, 'guard-state.json'), null);
  if (state && lastCooldown === 'false-positive' && state.blockReason !== 'provider-rate-limit') {
    state.blockedUntil = 0;
    state.blockReason = 'repaired-false-positive';
    await saveJson(path.join(cache, 'guard-state.json'), state);
  }
  checkpoint.searchGuardRecovery = {
    ...previous, repairedAt: new Date().toISOString(), refundedAttempts: [...refunded].sort((a, b) => a - b),
    reason: '成功工具结果中的429被旧正则误判，日志确认后续被本地冷却拦截；保留原始尝试次数和日志。',
  };
  await saveJson(checkpointFile, checkpoint);
  return { restored, refundedAttempts: checkpoint.searchGuardRecovery.refundedAttempts };
}

export function chargedAttempts(checkpoint) {
  const credits = new Set((checkpoint.searchGuardRecovery?.refundedAttempts || [])
    .filter(attempt => Number.isInteger(attempt) && attempt > 0 && attempt <= checkpoint.attempts));
  return checkpoint.attempts - credits.size;
}
