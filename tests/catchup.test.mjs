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
  return { root, run, sentinel };
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

test('a failed edition publishes existing supported stories with a documented failed candidate search', async t => {
  const { root, run } = await project(t);
  await ready(root, missing);
  const folder = path.join(root, 'data/pi-runs', datePath(missing));
  const checkpoint = await readJson(path.join(folder, 'checkpoint.json'));
  checkpoint.status = 'failed'; checkpoint.attempts = 3;
  checkpoint.validationError = '重大候选未追查独立来源';
  await saveJson(path.join(folder, 'checkpoint.json'), checkpoint);
  const bundle = await readJson(path.join(folder, 'bundle.json'));
  bundle.issue.notice = '重大候选查询失败，未收入正文。';
  bundle.selectionAudit.push({ event: 'failed major lead', importance: 'high', leadUrls: ['https://example.com/lead'], followUpUrls: [], decision: 'unverified', reason: 'network failure', followUpAttempts: [{ query: 'actual failed query', result: 'unavailable', detail: 'fetch failed' }] });
  await saveJson(path.join(folder, 'bundle.json'), bundle);
  const { stdout } = await run(`--resume-date=${missing}`);
  assert.match(stdout, /已发布 1\/12/);
  const published = await readJson(path.join(root, 'data/issues', datePath(missing), 'issue.json'));
  assert.equal(published.stories.length, 1);
  assert.equal(published.stories[0].id, 'one');
  assert.match(published.notice, /重大候选查询失败/);
  const audit = await readJson(path.join(root, 'data/evidence', datePath(missing), 'selection-audit.json'));
  assert.equal(audit[1].decision, 'unverified');
  assert.deepEqual(audit[1].followUpAttempts, bundle.selectionAudit[1].followUpAttempts);
  assert.equal((await readJson(path.join(folder, 'checkpoint.json'))).attempts, 3);
});

async function failingProvider(root, sentinel) {
  await cp(new URL('../scripts/pi-exa-observer.mjs', import.meta.url), path.join(root, 'scripts/pi-exa-observer.mjs'));
  await writeFile(sentinel, `
    if (process.argv.includes('mcp')) console.log(JSON.stringify({ servers: [{ name: 'exa', enabled: true, state: 'connected', tools: ['web_search_exa', 'web_fetch_exa'] }] }));
    else console.log(JSON.stringify({ type: 'message_end', message: { role: 'assistant', stopReason: 'error', errorMessage: '502 status code (no body)' } }));
  `);
  await saveJson(path.join(root, 'config/pi.json'), { cliPath: sentinel, maxAttemptsPerDay: 3, timeoutMinutes: 1, tools: ['read'] });
}

test('terminal provider failure stops remaining network attempts but still publishes ready artifacts', async t => {
  const { root, run, sentinel } = await project(t);
  await failingProvider(root, sentinel);
  await saveJson(path.join(root, 'data/pi-runs', datePath(first), 'checkpoint.json'), { date: first, window: { start: `${first}T00:00:00+08:00`, end: `${first}T23:59:59.999+08:00` }, attempts: 0 });
  await ready(root, today);
  await assert.rejects(run(), /502/);
  const failed = await readJson(path.join(root, 'data/pi-runs', datePath(first), 'checkpoint.json'));
  assert.equal(failed.attempts, 1);
  assert.match(failed.providerError, /502/);
  assert.equal(await readJson(path.join(root, 'data/pi-runs', datePath(missing), 'checkpoint.json'), null), null);
  assert.equal((await readJson(path.join(root, 'data/runtime/state.json'))).published[today].count, 1);
});

test('explicit retry grants exactly one attempt and preserves exhausted history', async t => {
  const { root, run, sentinel } = await project(t);
  await failingProvider(root, sentinel);
  await ready(root, missing, { noBundle: true });
  await assert.rejects(run(`--resume-date=${missing}`), /尝试次数已达上限/);
  await assert.rejects(run(`--resume-date=${missing}`, '--retry-failed'), /502/);
  const checkpoint = await readJson(path.join(root, 'data/pi-runs', datePath(missing), 'checkpoint.json'));
  assert.equal(checkpoint.attempts, 4);
  assert.equal(checkpoint.retryAuthorizations.length, 1);
  assert.equal(checkpoint.retryAuthorizations[0].attempt, 4);
  await assert.rejects(run(`--resume-date=${missing}`), /尝试次数已达上限/);
  assert.equal((await readJson(path.join(root, 'data/pi-runs', datePath(missing), 'checkpoint.json'))).attempts, 4);
});
