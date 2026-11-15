import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { inspectSearchLog, repairSearchCache, chargedAttempts } from '../src/search-recovery.mjs';
import { saveJson, readJson, atomicWrite } from '../src/runtime.mjs';

function log({ providerError = false } = {}) {
  const toolName = 'mcp__exa__web_search_exa', toolCallId = 'search';
  const result = { isError: false, content: [{ type: 'text', text: 'https://example.com/eec6799542931fb3.html' }] };
  const events = [
    { type: 'tool_execution_start', toolName, toolCallId, args: { query: 'news' } },
    { type: 'tool_execution_end', toolName, toolCallId, result, isError: false },
    { type: 'message_end', message: { ...result, role: 'toolResult', toolCallId, timestamp: 1794761869127 } },
    ...(providerError ? [{ type: 'tool_execution_end', toolName, isError: true, result: { content: [{ type: 'text', text: 'HTTP 429 free MCP rate limit' }] } }] : []),
    { type: 'tool_execution_end', toolName: 'mcp__exa__web_fetch_exa', isError: true, result: { content: [{ type: 'text', text: '搜索服务限流冷却至2026-11-15T17:12:49.127Z' }] } },
  ];
  return events.map(JSON.stringify).join('\n');
}

test('replay proves false cooldown from successful result and subsequent guard block', () => {
  assert.equal(inspectSearchLog(log()).falseCooldown, true);
  assert.equal(inspectSearchLog(log({ providerError: true })).falseCooldown, false);
  assert.equal(inspectSearchLog(log()).successes[0].fetchedAt, '2026-11-15T16:57:49.127Z');
});

test('repair recovers lost cache and refunds once without erasing attempt history', async () => {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'guard-repair-'));
  try {
    await saveJson(path.join(folder, 'checkpoint.json'), { attempts: 3, status: 'failed' });
    await saveJson(path.join(folder, 'search-cache/guard-state.json'), { count: 6, blockedUntil: 9999999999999 });
    await atomicWrite(path.join(folder, 'attempt-1.private.log'), log({ providerError: true }));
    await atomicWrite(path.join(folder, 'attempt-3.private.log'), log());
    assert.deepEqual(await repairSearchCache(folder), { restored: 1, refundedAttempts: [3] });
    assert.deepEqual(await repairSearchCache(folder), { restored: 0, refundedAttempts: [3] });
    const checkpoint = await readJson(path.join(folder, 'checkpoint.json'));
    assert.equal(checkpoint.attempts, 3);
    assert.equal(chargedAttempts(checkpoint), 2);
    assert.equal(chargedAttempts({ ...checkpoint, attempts: 4 }), 3);
    assert.equal((await readJson(path.join(folder, 'search-cache/guard-state.json'))).blockedUntil, 0);
    assert.equal(Object.keys(await readJson(path.join(folder, 'search-cache/index.json'))).length, 1);
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test('repair preserves a later real provider cooldown', async () => {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'guard-repair-'));
  try {
    await saveJson(path.join(folder, 'checkpoint.json'), { attempts: 2 });
    await saveJson(path.join(folder, 'search-cache/guard-state.json'), { count: 8, blockedUntil: 9999999999999 });
    await atomicWrite(path.join(folder, 'attempt-1.private.log'), log());
    await atomicWrite(path.join(folder, 'attempt-2.private.log'), log({ providerError: true }));
    await repairSearchCache(folder);
    assert.equal((await readJson(path.join(folder, 'search-cache/guard-state.json'))).blockedUntil, 9999999999999);
  } finally { await rm(folder, { recursive: true, force: true }); }
});
