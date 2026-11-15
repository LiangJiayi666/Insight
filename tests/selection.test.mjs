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
  assert.deepEqual(diagnoseRun('429 free MCP rate limit; fetch failed; CRAWL_TIMEOUT'), { searchRateLimited: true, networkFailure: true, crawlTimeout: true });
});
