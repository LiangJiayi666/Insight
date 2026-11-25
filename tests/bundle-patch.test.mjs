import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { saveJson, readJson } from '../src/runtime.mjs';
import { patchBundle, bundleRevision } from '../src/bundle-patch.mjs';
import { bundleWriteRestriction } from '../src/pi-feedback.mjs';

async function setup(t) {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'bundle-patch-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const date = '2026-11-24', window = { start: '2026-11-23T15:17:40Z', end: '2026-11-24T11:50:02Z' };
  const text = '单元测试虚构正文，不可作为真实新闻依据。'.repeat(20);
  const sources = Array.from({ length: 4 }, (_, i) => ({ id: `s-${i}`, title: 'fixture', publisher: 'fixture', url: `https://example.com/${i}`, published: i < 3 ? '2026-11-23T08:00:00Z' : '2026-11-24T08:00:00Z', accessed: date, method: 'fixture', limits: 'fixture', excerpt: text.slice(0, 30) }));
  const stories = sources.map(s => ({ id: `story-${s.id}`, title: 'fixture', published: s.published.slice(0, 10), eventDate: date, status: 'fixture', facts: text, affected: 'fixture', takeaway: 'fixture', sourceIds: [s.id], claims: [{ sourceId: s.id, text: 'fixture', quote: s.excerpt }], sections: [{ title: 'fixture', paragraphs: ['fixture'] }] }));
  const bundle = { issue: { date, cutoff: window.end, sources, stories }, evidence: sources.map(s => ({ id: s.id, url: s.url, published: s.published, text })), selectionAudit: stories.map(s => ({ event: s.id, importance: 'high', leadUrls: ['https://example.com/lead'], followUpUrls: ['https://example.com/independent'], decision: 'included', reason: 'fixture', storyId: s.id })) };
  await saveJson(path.join(folder, 'bundle.json'), bundle);
  await saveJson(path.join(folder, 'validation.json'), { date, window, target: 12, requireSelection: true });
  return folder;
}

test('structural removal fixes three out-of-window stories together and preserves excluded candidate records', async t => {
  const folder = await setup(t);
  const operations = [];
  for (const index of [2, 1, 0]) {
    operations.push({ op: 'remove', path: ['issue', 'stories', String(index)] });
    operations.push({ op: 'set', path: ['selectionAudit', String(index), 'decision'], valueJson: '"excluded"' });
    operations.push({ op: 'set', path: ['selectionAudit', String(index), 'reason'], valueJson: '"主来源早于精确窗口，作为候选保留，未收入正文。"' });
    operations.push({ op: 'remove', path: ['selectionAudit', String(index), 'storyId'] });
  }
  operations.push({ op: 'set', path: ['issue', 'notice'], valueJson: '"3条旧闻不在窗口内，已排除；本刊覆盖有限。"' });
  const result = await patchBundle(folder, { revision: await bundleRevision(folder), operations });
  assert.equal(result.validationPassed, true);
  assert.equal(result.count, 1);
  const saved = await readJson(path.join(folder, 'bundle.json'));
  assert.equal(saved.selectionAudit.length, 4);
  assert.equal(saved.selectionAudit[0].decision, 'excluded');
  assert.equal(saved.evidence.length, 4);
  assert.equal(result.revision, await bundleRevision(folder));
});

test('invalid later operation, stale revision, unsafe paths and changed edition never overwrite saved content', async t => {
  const folder = await setup(t);
  const file = path.join(folder, 'bundle.json');
  const original = await readFile(file, 'utf8'), revision = await bundleRevision(folder);
  const first = { op: 'remove', path: ['issue', 'stories', '2'] };
  for (const operation of [
    { op: 'set', path: ['issue', 'notice'], valueJson: '{bad JSON' },
    { op: 'remove', path: ['issue', 'stories', '999'] },
    { op: 'set', path: ['issue', '__proto__', 'x'], valueJson: 'true' },
    { op: 'set', path: ['issue', 'cutoff'], valueJson: '"2026-11-25T00:00:00Z"' },
    { op: 'set', path: ['outside'], valueJson: 'true' },
  ]) {
    await assert.rejects(patchBundle(folder, { revision, operations: [first, operation] }));
    assert.equal(await readFile(file, 'utf8'), original);
  }
  await assert.rejects(patchBundle(folder, { revision: 'stale', operations: [first] }), /稿件已变化/);
  assert.equal(await readFile(file, 'utf8'), original);
});

test('concurrent edits cannot silently overwrite each other and intermediate JSON remains usable', async t => {
  const folder = await setup(t), revision = await bundleRevision(folder);
  const results = await Promise.allSettled(['one', 'two'].map(value => patchBundle(folder, { revision, operations: [{ op: 'set', path: ['issue', 'notice'], valueJson: JSON.stringify(value) }] })));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  const result = results.find(r => r.status === 'fulfilled').value;
  assert.equal(result.validationPassed, false);
  assert.match(result.validationError, /主新闻不在/);
  assert.equal((await readJson(path.join(folder, 'bundle.json'))).issue.stories.length, 4);
});

test('raw text edits and malformed JSON writes are blocked before touching the bundle', async t => {
  const folder = await setup(t), file = path.join(folder, 'bundle.json');
  for (const event of [{ toolName: 'edit', input: { path: file } }, { toolName: 'write', input: { path: file, content: '/*COMMENT*/{}' } }]) assert.equal(bundleWriteRestriction(event, folder).block, true);
  assert.equal(bundleWriteRestriction({ toolName: 'write', input: { path: file, content: '{}' } }, folder), undefined);
});
