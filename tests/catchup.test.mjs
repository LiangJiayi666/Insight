import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, cp, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chinaDate, datePath, saveJson, readJson } from '../src/runtime.mjs';
import { shiftDate } from '../src/daily-plan.mjs';

const today = chinaDate(), missing = shiftDate(today, -1), first = shiftDate(today, -2);
async function project(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pi-catchup-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await cp(new URL('../src/', import.meta.url), path.join(root, 'src'), { recursive: true });
  await mkdir(path.join(root, 'scripts'));
  await cp(new URL('../scripts/pi-daily.mjs', import.meta.url), path.join(root, 'scripts/pi-daily.mjs'));
  for (const file of ['styles.css', 'app.js']) await cp(new URL(`../${file}`, import.meta.url), path.join(root, file));
  const sentinel = path.join(root, 'must-not-invoke.mjs');
  await writeFile(sentinel, 'process.exit(99);');
  await saveJson(path.join(root, 'config/pi.json'), { cliPath: sentinel, maxAttemptsPerDay: 3 });
  await saveJson(path.join(root, 'config/settings.json'), { targetStories: 12, initialLookbackHours: 24, maxCatchupHours: 72 });
  const run = (...args) => promisify(execFile)(process.execPath, [path.join(root, 'scripts/pi-daily.mjs'), '--no-sync', ...args], { cwd: root, env: { ...process.env, INSIGHT_PI_CLI: sentinel }, timeout: 15000, windowsHide: true });
  return { root, run };
}

async function ready(root, date, { noBundle = false } = {}) {
  const window = { start: `${date}T00:00:00+08:00`, end: `${date}T23:59:59.999+08:00` };
  const folder = path.join(root, 'data/pi-runs', datePath(date));
  await saveJson(path.join(folder, 'checkpoint.json'), { date, window, attempts: noBundle ? 3 : 0 });
  if (noBundle) return;
  const excerpt = '测试用虚构正文，仅供单元测试。';
  const url = `https://example.com/${date}`;
  const source = { id: 's-1', url, publisher: '测试', title: '测试', published: `${date}T12:00:00+08:00`, accessed: today, method: 'fixture', excerpt, limits: 'fixture' };
  await saveJson(path.join(folder, 'bundle.json'), {
    issue: { date, cutoff: window.end, sources: [source], stories: [{ id: 'one', title: date, published: date, eventDate: date, status: 'fixture', facts: excerpt, affected: 'fixture', takeaway: 'fixture', sourceIds: ['s-1'], claims: [{ text: excerpt, sourceId: 's-1', quote: excerpt }], sections: Array.from({ length: 4 }, () => ({ title: 'fixture', paragraphs: ['fixture'] })) }] },
    evidence: [{ id: 's-1', url, published: source.published, text: excerpt.repeat(20) }],
    selectionAudit: [{ event: 'fixture', importance: 'normal', leadUrls: [url], decision: 'included', reason: 'fixture', storyId: 'one' }],
  });
}

test('normal daily invocation publishes missing editions first, then today, and is idempotent', async t => {
  const { root, run } = await project(t);
  await saveJson(path.join(root, 'data/runtime/state.json'), { lastCutoff: `${first}T23:59:59.999+08:00`, published: { [first]: { cutoff: `${first}T23:59:59.999+08:00` } } });
  await ready(root, missing); await ready(root, today);
  const { stdout } = await run();
  const order = [...stdout.matchAll(/已发布 1\/12 条：(\d{4}-\d{2}-\d{2})/g)].map(m => m[1]);
  assert.deepEqual(order, [missing, today]);
  const state = await readJson(path.join(root, 'data/runtime/state.json'));
  assert.equal(state.published[missing].count, 1);
  assert.equal(state.published[today].count, 1);
  assert.ok(state.published[missing].backfilledAt);
  assert.match(await readFile(path.join(root, 'public/index.html'), 'utf8'), new RegExp(today));
  assert.match((await run()).stdout, /均已发布/);
});

test('a hole is repaired even after today is published, without moving the home page backward', async t => {
  const { root, run } = await project(t);
  const lastCutoff = `${today}T23:59:59.999+08:00`;
  await saveJson(path.join(root, 'data/runtime/state.json'), { lastCutoff, published: { [first]: { cutoff: `${first}T23:59:59.999+08:00` }, [today]: { cutoff: lastCutoff } } });
  await mkdir(path.join(root, 'public'));
  await writeFile(path.join(root, 'public/index.html'), 'latest remains unchanged');
  await ready(root, missing);
  await run();
  assert.equal(await readFile(path.join(root, 'public/index.html'), 'utf8'), 'latest remains unchanged');
  assert.equal((await readJson(path.join(root, 'data/runtime/state.json'))).lastCutoff, lastCutoff);
});

test('an exhausted old issue remains failed but does not prevent publishing today', async t => {
  const { root, run } = await project(t);
  await saveJson(path.join(root, 'data/runtime/state.json'), { published: { [first]: { cutoff: `${first}T23:59:59.999+08:00` } } });
  await ready(root, missing, { noBundle: true }); await ready(root, today);
  await assert.rejects(run(), /尝试次数已达上限/);
  const state = await readJson(path.join(root, 'data/runtime/state.json'));
  assert.equal(state.published[missing], undefined);
  assert.equal(state.published[today].count, 1);
});
