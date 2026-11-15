import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SearchGuard } from '../src/search-guard.mjs';
test('serializes calls, reuses successful cache and persists rate-limit cooldown', async () => {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'guard-'));
  try {
    let clock = 0;
    const opts = { now: () => clock, sleep: async ms => { clock += ms; }, intervalMs: 8000 };
    const g = new SearchGuard(folder, opts);
    assert.equal(await g.before('1', 'search', { q: 'one' }), undefined);
    await g.after('1', { content: ['real result'], isError: false });
    assert.equal((await g.before('2', 'search', { q: 'one' })).block, true);
    assert.equal(await g.before('3', 'search', { q: 'two' }), undefined);
    assert.equal(clock, 8000);
    await g.after('3', { content: ['HTTP 429'], isError: true });
    const next = new SearchGuard(folder, opts);
    assert.match((await next.before('4', 'search', { q: 'three' })).reason, /冷却/);
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test('successful article URL containing 429 is cached and never blocks the next fetch', async () => {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'guard-'));
  try {
    const guard = new SearchGuard(folder, { intervalMs: 0 });
    const input = { query: 'capital markets' };
    const result = { content: [{ type: 'text', text: 'URL: https://www.21jingji.com/article/20261114/herald/eec6799542931fb369bfa8134ced246d.html\nAn article about HTTP 429, fetch failed and CRAWL_TIMEOUT.' }], isError: false };
    await guard.before('search', 'search', input);
    await guard.after('search', result);
    const cached = JSON.parse(await readFile(path.join(folder, `${guard.key('search', input)}.json`), 'utf8'));
    assert.deepEqual(cached.result, result);
    assert.equal(await guard.before('fetch', 'fetch', { urls: ['https://example.com/article'] }), undefined);
    await guard.after('fetch', { content: [], isError: false });
    assert.equal(JSON.parse(await readFile(path.join(folder, 'guard-state.json'), 'utf8')).blockedUntil, 0);
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test('structured MCP errors are not cached and real limits survive restart', async () => {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'guard-'));
  try {
    const options = { intervalMs: 0, now: () => 1000 };
    const guard = new SearchGuard(folder, options);
    await guard.before('network', 'search', {});
    await guard.after('network', { isError: true, content: [{ type: 'text', text: 'fetch failed; request abc429xyz' }] });
    assert.equal(await guard.before('retry', 'search', {}), undefined);
    await guard.after('retry', { isError: false, structuredContent: { isError: true, content: [{ type: 'text', text: 'MCP HTTP request failed with status 429: free MCP rate limit' }] } });
    await assert.rejects(readFile(path.join(folder, `${guard.key('search', {})}.json`)), { code: 'ENOENT' });
    assert.match((await new SearchGuard(folder, options).before('blocked', 'search', {})).reason, /冷却/);
  } finally { await rm(folder, { recursive: true, force: true }); }
});
