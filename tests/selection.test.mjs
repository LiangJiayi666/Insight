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
