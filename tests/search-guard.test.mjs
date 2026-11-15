import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
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
