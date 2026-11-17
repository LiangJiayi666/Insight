import test from 'node:test';
import assert from 'node:assert/strict';
import { validateSelection } from '../src/pi-contract.mjs';
import { diagnoseRun } from '../src/run-diagnostics.mjs';
test('major leads require follow-up and selected stories require decision records', () => {
  const b = { issue: { stories: [{ id: 'one' }] }, selectionAudit: [{ event: 'event', importance: 'high', leadUrls: ['https://example.com/lead'], followUpUrls: [], decision: 'included', reason: 'market impact', storyId: 'one' }] };
  assert.throws(() => validateSelection(b), /未追查/);
  b.selectionAudit[0].followUpUrls = ['https://example.com/article'];
  assert.doesNotThrow(() => validateSelection(b));
  b.issue.stories.push({ id: 'two' });
  assert.throws(() => validateSelection(b), /没有选题/);
});

test('failed research can remain in the audit without blocking supported stories', () => {
  const b = { issue: { notice: '重大候选追查失败，未收入正文。', stories: [{ id: 'one' }] }, selectionAudit: [
    { event: 'published', importance: 'high', leadUrls: ['https://example.com/article'], followUpUrls: ['https://example.com/article'], decision: 'included', reason: 'verified', storyId: 'one' },
    { event: 'unverified', importance: 'high', leadUrls: ['https://example.com/lead'], followUpUrls: [], decision: 'unverified', reason: 'search failed', followUpAttempts: [{ query: 'actual query', result: 'unavailable', detail: 'fetch failed' }] },
  ] };
  assert.doesNotThrow(() => validateSelection(b));
  b.selectionAudit[1].decision = 'included'; b.selectionAudit[1].storyId = 'one';
  assert.throws(() => validateSelection(b), /未追查独立来源/);
  b.selectionAudit[1].decision = 'unverified'; delete b.selectionAudit[1].storyId;
  b.selectionAudit[1].followUpAttempts[0].result = 'budget-exhausted';
  assert.throws(() => validateSelection(b), /不能把未查询或预算估计/);
  b.selectionAudit[1].followUpAttempts[0].result = 'no-independent-source';
  b.issue.notice = '';
  assert.throws(() => validateSelection(b), /覆盖缺口/);
});

test('selection reports all broken candidates together with their names', () => {
  const b = { issue: { stories: [] }, selectionAudit: [
    { event: 'bad-state', leadUrls: ['https://example.com/a'], decision: 'merged', reason: 'merged into another event' },
    { event: 'missing-research', importance: 'high', leadUrls: ['https://example.com/b'], decision: 'unverified', reason: 'not checked' },
  ] };
  assert.throws(() => validateSelection(b), error => /bad-state.*候选状态不合法/.test(error.message) && /missing-research.*未追查/.test(error.message));
});
test('diagnostics distinguish search limits from network and crawl failures', () => {
  const event = { type: 'tool_execution_end', toolName: 'mcp__exa__web_search_exa', isError: true, result: { content: [{ type: 'text', text: 'HTTP 429 free MCP rate limit; fetch failed; CRAWL_TIMEOUT' }] } };
  assert.deepEqual(diagnoseRun(JSON.stringify(event)), { searchRateLimited: true, networkFailure: true, crawlTimeout: true, searchCooldownBlocked: false });
});

test('diagnostics ignore successful content, prompts, call IDs and local cache blocks', () => {
  const events = [
    { type: 'message_end', message: { role: 'user', content: 'stop on HTTP 429; fetch failed; CRAWL_TIMEOUT' } },
    { type: 'tool_execution_end', toolCallId: 'call-429', toolName: 'mcp__exa__web_search_exa', isError: false, result: { content: [{ type: 'text', text: 'https://example.com/429 HTTP 429; fetch failed; CRAWL_TIMEOUT' }] } },
    { type: 'tool_execution_end', toolName: 'read', isError: true, result: { content: [{ type: 'text', text: 'ENOENT 429.json' }] } },
    { type: 'tool_execution_end', toolName: 'mcp__exa__web_search_exa', isError: true, result: { content: [{ type: 'text', text: '相同请求已有成功结果，不重复联网。请用read读取缓存：C:/429.json' }] } },
    { type: 'tool_execution_end', toolName: 'mcp__exa__web_fetch_exa', isError: true, result: { content: [{ type: 'text', text: '搜索服务限流冷却至2026-11-15T17:12:49.127Z。请使用缓存收尾，勿继续调用。' }] } },
  ];
  assert.deepEqual(diagnoseRun(events.map(JSON.stringify).join('\n')), { searchRateLimited: false, networkFailure: false, crawlTimeout: false, searchCooldownBlocked: true });
});
