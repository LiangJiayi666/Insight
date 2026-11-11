import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, copyFile, readFile, rm, access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runDaily } from '../src/pipeline.mjs';
import { computeWindow, acquireLock, saveJson } from '../src/runtime.mjs';
import { normalizeResults, checkCredentials } from '../src/providers.mjs';

const settings = { targetStories: 12, initialLookbackHours: 24, maxCatchupHours: 72, searchResultsPerTopic: 15, maxCandidates: 40, maxSourceCharacters: 12000, maxBackgroundQueries: 0 };
const now = new Date('2026-11-11T12:00:00Z');
const text = '离线测试证据：某机构发布了一个用于自动化验证的虚构新闻事件，不是真实新闻。'.repeat(15);
const articles = Array.from({ length: 15 }, (_, i) => ({ title: `虚构测试事件${i}`, url: `https://example.com/story/${i}`, publishedDate: '2026-11-11T08:00:00Z', text }));
const sources = { topics: [{ query: 'fixture', category: '经济', domains: ['example.com'] }] };
function fakeProvider(options = {}) {
  const calls = { search: 0, model: 0 };
  return {
    calls,
    async search() { calls.search++; if (options.failSearch) throw new Error('offline'); return articles; },
    async json(prompt, input) {
      calls.model++;
      if (input.candidates) return { events: input.candidates.slice(0, 12).map((s, i) => ({ key: `event-${i}`, title: s.title, category: ['经济', '金融', '社会', '政治'][i % 4], sourceIds: [s.id] })) };
      if (input.story) return { approved: !options.reject, reasons: options.reject ? ['测试拒绝'] : [] };
      const event = input.event;
      return { story: { id: event.key, category: event.category, title: event.title, published: '2026-11-11', eventDate: '测试日期', status: '测试', takeaway: '测试概括', facts: '虚构测试事件。', affected: '测试人员', sourceIds: event.sourceIds,
        claims: [{ text: '测试事实', sourceId: event.sourceIds[0], quote: '离线测试证据：某机构发布了一个用于自动化验证的虚构新闻事件' }],
        sections: Array.from({ length: 4 }, (_, i) => ({ title: `测试层${i}`, tag: '测试', paragraphs: ['假设算例：这不是新闻。'], sourceIds: event.sourceIds })) } };
    },
  };
}
async function tempProject(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'insight-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const asset of ['styles.css', 'app.js']) await copyFile(new URL(`../${asset}`, import.meta.url), path.join(root, asset));
  return root;
}
test('full offline pipeline creates 12 collapsed stories and is idempotent', async t => {
  const root = await tempProject(t); const provider = fakeProvider();
  const opts = { root, settings, sources, now, providerFactory: () => provider };
  assert.equal((await runDaily(opts)).count, 12);
  const html = await readFile(path.join(root, 'public/index.html'), 'utf8');
  assert.equal((html.match(/class="story"/g) || []).length, 12);
  assert.doesNotMatch(html, /<details[^>]*\bopen\b/);
  assert.ok(html.includes('本期资料说明'));
  assert.ok(!html.includes('class="notice"'));
  assert.ok(!html.includes('非实际业绩或报价'));
  const requests = { ...provider.calls };
  assert.equal((await runDaily(opts)).status, 'already-published');
  assert.deepEqual(provider.calls, requests);
  assert.equal(await readFile(path.join(root, 'public/issues/2026/11/11/index.html'), 'utf8'), html);
});
test('source failure leaves public page untouched and releases lock', async t => {
  const root = await tempProject(t);
  await assert.rejects(runDaily({ root, settings, sources, now, providerFactory: () => fakeProvider({ failSearch: true }) }), /没有满足/);
  await assert.rejects(access(path.join(root, 'public/index.html')));
  await assert.rejects(access(path.join(root, 'data/runtime/daily.lock')));
});
test('failed collection resumes and publishes with the same checkpoint', async t => {
  const root = await tempProject(t);
  await assert.rejects(runDaily({ root, settings, sources, now, providerFactory: () => fakeProvider({ failSearch: true }) }));
  assert.equal((await runDaily({ root, settings, sources, now, providerFactory: () => fakeProvider() })).count, 12);
});
test('fewer qualified events are labelled, never padded to twelve', async t => {
  const root = await tempProject(t); const provider = fakeProvider();
  provider.search = async () => articles.slice(0, 3);
  assert.equal((await runDaily({ root, settings, sources, now, providerFactory: () => provider })).count, 3);
  const html = await readFile(path.join(root, 'public/index.html'), 'utf8');
  assert.ok(html.includes('3/12')); assert.ok(html.includes('覆盖缺口'));
});
test('review rejection cannot publish', async t => {
  const root = await tempProject(t);
  await assert.rejects(runDaily({ root, settings, sources, now, providerFactory: () => fakeProvider({ reject: true }) }), /没有通过/);
  await assert.rejects(access(path.join(root, 'public/index.html')));
});
test('ready checkpoint recovers publication without new paid calls', async t => {
  const root = await tempProject(t);
  await runDaily({ root, settings, sources, now, providerFactory: () => fakeProvider() });
  await saveJson(path.join(root, 'data/runtime/state.json'), { lastCutoff: null, published: {} });
  const provider = fakeProvider();
  assert.equal((await runDaily({ root, settings, sources, now, providerFactory: () => provider })).count, 12);
  assert.deepEqual(provider.calls, { search: 0, model: 0 });
});
test('invalid dates, summary-only items, future news and URL tracking are handled', () => {
  const window = { start: '2026-11-10T12:00:00Z', end: now.toISOString() };
  const input = [...articles.slice(0, 1), { ...articles[0], url: articles[0].url + '?utm_source=x' }, { ...articles[1], publishedDate: '2099-01-01' }, { ...articles[2], publishedDate: 'invalid' }, { ...articles[3], text: 'short' }];
  assert.equal(normalizeResults(input, '经济', window, 1000).length, 1);
});
test('catchup window is capped and reports missing coverage', () => {
  const window = computeWindow(now, '2026-10-01T00:00:00Z', settings);
  assert.equal(window.gap, true);
  assert.equal(Date.parse(window.end) - Date.parse(window.start), 72 * 3600000);
});
test('concurrent runs cannot share a lock', async t => {
  const root = await tempProject(t); const file = path.join(root, 'lock');
  const release = await acquireLock(file);
  await assert.rejects(acquireLock(file), /存在运行锁/); await release();
});
test('missing credentials fail before networking', () => {
  assert.throws(() => checkCredentials({}), /EXA_API_KEY/);
});
