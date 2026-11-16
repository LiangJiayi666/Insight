import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { computeWindow, acquireLock, chinaDate } from '../src/runtime.mjs';

test('daily window uses the last cutoff and caps long gaps', () => {
  const now = new Date('2026-11-11T12:00:00Z');
  const settings = { initialLookbackHours: 24, maxCatchupHours: 72 };
  assert.equal(computeWindow(now, null, settings).start, '2026-11-10T12:00:00.000Z');
  const window = computeWindow(now, '2026-10-01T00:00:00Z', settings);
  assert.equal(window.gap, true);
  assert.equal(Date.parse(window.end) - Date.parse(window.start), 72 * 3600000);
  assert.equal(chinaDate(new Date('2026-11-11T16:00:00Z')), '2026-11-12');
});

test('concurrent daily runs cannot share a lock', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'insight-lock-'));
  try {
    const file = path.join(root, 'daily.lock');
    const release = await acquireLock(file);
    await assert.rejects(acquireLock(file), /存在运行锁/);
    await release();
    await (await acquireLock(file))();
  } finally { await rm(root, { recursive: true, force: true }); }
});
