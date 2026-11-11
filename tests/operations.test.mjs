import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { parseUsage, updateLedger, maintain, costText } from '../src/operations.mjs';
import { renderIssue } from '../scripts/render.mjs';
test('usage counts completed messages only, preserves unknown pricing and missing logs', () => {
  const m = { type: 'message_end', message: { role: 'assistant', id: 'a', usage: { input: 10, output: 2, cacheRead: 20, totalTokens: 32, cost: { total: 0 } } } };
  const { usage } = parseUsage([m, m, { type: 'message_update', usage: { totalTokens: 100 } }].map(JSON.stringify).join('\n'));
  assert.equal(usage.totalTokens, 32); assert.equal(usage.priceIncomplete, true);
  assert.equal(parseUsage('fetch failed').usage.missingUsage, true);
});
test('ledger is idempotent, backup restores renderable issue', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'insight-ops-'));
  try {
    const logs = path.join(root, 'data/pi-runs/2026/11/11'); await mkdir(logs, { recursive: true });
    await writeFile(path.join(logs, 'attempt-1.private.log'), 'fetch failed');
    const issue = JSON.parse(await readFile(new URL('../data/issues/2026-11-11.json', import.meta.url), 'utf8'));
    await mkdir(path.join(root, 'data/issues'), { recursive: true });
    await writeFile(path.join(root, 'data/issues/issue.json'), JSON.stringify(issue));
    await updateLedger(root, '2026-11-11'); const ledger = await updateLedger(root, '2026-11-11');
    assert.equal(Object.keys(ledger.runs).length, 1); assert.ok(costText(ledger, 12).includes('未知'));
    const result = await maintain(root, new Date('2026-11-11T12:00:00Z'));
    const restored = JSON.parse(await readFile(path.join(result.backup, 'data/issues/issue.json'), 'utf8'));
    assert.equal(renderIssue(restored), renderIssue(issue));
    assert.ok(result.verifiedFiles > 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});
