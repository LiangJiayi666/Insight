import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { parseUsage, updateLedger, maintain, costText, deliverDailyReport } from '../src/operations.mjs';
import { renderIssue } from '../src/render.mjs';
import { saveJson } from '../src/runtime.mjs';
test('usage counts completed messages only, preserves unknown pricing and missing logs', () => {
  const m = { type: 'message_end', message: { role: 'assistant', id: 'a', usage: { input: 10, output: 2, cacheRead: 20, totalTokens: 32, cost: { total: 0 } } } };
  const { usage } = parseUsage([m, m, { type: 'message_update', usage: { totalTokens: 100 } }].map(JSON.stringify).join('\n'));
  assert.equal(usage.totalTokens, 32); assert.equal(usage.priceIncomplete, true);
  assert.equal(parseUsage('fetch failed').usage.missingUsage, true);
});

test('report shares authentication, preserves yesterday fallback, and deduplicates deliveries', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'insight-delivery-'));
  try {
    const bridgeDirectory = path.join(root, 'fake-bridge');
    await saveJson(path.join(bridgeDirectory, 'config.json'), { appId: 'test-app', appSecret: 'test-secret' });
    await saveJson(path.join(bridgeDirectory, 'owner.json'), { chatId: 'test-chat', openId: 'test-user' });
    await saveJson(path.join(root, 'data/runtime/state.json'), { published: { '2026-11-11': { count: 12 } } });
    const archive = path.join(root, 'public/issues/2026/11/11');
    await mkdir(archive, { recursive: true });
    await writeFile(path.join(archive, 'index.html'), '<link rel="stylesheet" href="styles.css"><p>fixture</p><script src="app.js" defer></script>');
    await writeFile(path.join(archive, 'styles.css'), 'body{}');
    await writeFile(path.join(archive, 'app.js'), '');
    const calls = [];
    const request = async (url, options) => {
      calls.push({ url, options });
      const data = url.includes('/auth/') ? { tenant_access_token: 'test-token' }
        : url.endsWith('/files') ? { data: { file_key: 'test-file' } } : { data: { message_id: 'test-message' } };
      return { ok: true, json: async () => ({ code: 0, ...data }) };
    };
    const options = { now: new Date('2026-11-12T14:00:00Z'), request, bridgeDirectory };
    assert.deepEqual(await deliverDailyReport(root, options), { cost: 'sent', daily: 'file-sent' });
    assert.equal(calls.filter(call => call.url.includes('/auth/')).length, 1);
    assert.equal(calls.filter(call => call.url.endsWith('/files')).length, 1);
    const messages = calls.filter(call => call.url.includes('/messages')).map(call => JSON.parse(call.options.body));
    assert.equal(messages.length, 2);
    assert.match(JSON.parse(messages[0].content).text, /昨天（2026-11-11）/);
    assert.equal(messages[1].msg_type, 'file');
    const beforeRetry = calls.length;
    assert.deepEqual(await deliverDailyReport(root, options), { cost: 'already-sent', daily: 'already-sent' });
    assert.equal(calls.length, beforeRetry);
    await deliverDailyReport(root, { ...options, requestId: 'new-user-command' });
    assert.equal(calls.length, beforeRetry + 4);
    // An older archive is not silently substituted when yesterday is missing.
    await deliverDailyReport(root, { ...options, now: new Date('2026-11-14T14:00:00Z') });
    const unavailable = JSON.parse(calls.at(-1).options.body);
    assert.equal(unavailable.msg_type, 'text');
    assert.match(JSON.parse(unavailable.content).text, /昨天也没有/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('one failed delivery does not prevent the other and retries do not resend successes', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'insight-delivery-failure-'));
  try {
    const bridgeDirectory = path.join(root, 'fake-bridge');
    await saveJson(path.join(bridgeDirectory, 'config.json'), { appId: 'test', appSecret: 'test' });
    await saveJson(path.join(bridgeDirectory, 'owner.json'), { chatId: 'test', openId: 'test' });
    let messages = 0;
    const request = async url => {
      if (url.includes('/auth/')) return { ok: true, json: async () => ({ code: 0, tenant_access_token: 'test' }) };
      messages++;
      if (messages === 1) throw new Error('fixture network failure');
      return { ok: true, json: async () => ({ code: 0, data: { message_id: 'test' } }) };
    };
    const options = { now: new Date('2026-11-12T14:00:00Z'), request, bridgeDirectory };
    await assert.rejects(deliverDailyReport(root, options), /fixture network failure/);
    assert.equal(messages, 2);
    assert.deepEqual(await deliverDailyReport(root, options), { cost: 'sent', daily: 'already-sent' });
    assert.equal(messages, 3);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('ledger is idempotent, backup restores renderable issue', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'insight-ops-'));
  try {
    const logs = path.join(root, 'data/pi-runs/2026/11/11'); await mkdir(logs, { recursive: true });
    await writeFile(path.join(logs, 'attempt-1.private.log'), 'fetch failed');
    const issue = JSON.parse(await readFile(new URL('../data/issues/2026/11/11/issue.json', import.meta.url), 'utf8'));
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
