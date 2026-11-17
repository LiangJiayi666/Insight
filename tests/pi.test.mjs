import test from 'node:test';
import assert from 'node:assert/strict';
import { validatePiBundle, makePiPrompt } from '../src/pi-contract.mjs';
import { piArgs } from '../src/pi-runner.mjs';
import { mkdtemp, mkdir, cp, writeFile, readFile, rm, access } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { saveJson } from '../src/runtime.mjs';
import { bundleWriteFeedback, bundleWriteRestriction } from '../src/pi-feedback.mjs';
const date = '2026-11-11';
const window = { start: '2026-11-10T08:00:00Z', end: '2026-11-11T08:00:00Z' };
function fixture() {
  const text = '测试用虚构正文，仅供单元测试，不能作为真实新闻。'.repeat(20);
  const source = { id: 's-1', url: 'https://example.com/news', publisher: '测试', title: '测试', published: '2026-11-11T01:00:00Z', accessed: window.end, method: 'fixture', excerpt: '测试用虚构正文，仅供单元测试', limits: '测试' };
  return { issue: { date, cutoff: window.end, sources: [source], stories: [{ id: 'one', title: '测试', published: date, eventDate: date, status: '测试', facts: '测试', affected: '测试', takeaway: '测试', sourceIds: ['s-1'], claims: [{ text: '测试', sourceId: 's-1', quote: source.excerpt }], sections: Array.from({ length: 4 }, () => ({ title: '测试', paragraphs: ['测试'] })) }] }, evidence: [{ id: 's-1', url: source.url, published: source.published, text }] };
}
test('Pi bundle requires real-shaped evidence and matching date/window', () => {
  assert.doesNotThrow(() => validatePiBundle(fixture(), { date, window, target: 12 }));
  const bad = fixture(); bad.issue.stories[0].claims[0].quote = '没有出现在正文中的虚构引用';
  assert.throws(() => validatePiBundle(bad, { date, window, target: 12 }), /引文/);
  const old = fixture(); old.evidence[0].published = '2020-01-01T00:00:00Z';
  assert.throws(() => validatePiBundle(old, { date, window, target: 12 }), /窗口/);
});
test('Pi bundle rejects reused primary sources', () => {
  const data = fixture(); data.issue.stories.push({ ...data.issue.stories[0], id: 'two' });
  assert.throws(() => validatePiBundle(data, { date, window, target: 12 }), /重复/);
});

test('source tracking parameters do not bypass evidence matching or duplicate detection', () => {
  const bundle = fixture();
  bundle.issue.sources[0].url += '?utm_source=newsletter#story';
  assert.doesNotThrow(() => validatePiBundle(bundle, { date, window, target: 12 }));
  bundle.issue.sources[0].url = 'file:///private.txt';
  assert.throws(() => validatePiBundle(bundle, { date, window, target: 12 }));
});
test('Pi CLI uses isolated session and no command shell or credential flags', () => {
  const args = piArgs('cli.js', { tools: ['read', 'write'], projectTrust: 'ignore', model: '' }, 'C:/a b/prompt.txt');
  assert.ok(args.includes('--no-session')); assert.ok(args.includes('--no-approve'));
  assert.ok(args.includes('@C:/a b/prompt.txt')); assert.ok(!args.includes('--api-key'));
  assert.ok(!args.includes('--continue'));
});
test('prompt carries the exact window, target and output', () => {
  const prompt = makePiPrompt({ date, window, target: 12, output: 'output.json' });
  for (const value of [window.start, window.end, '目标12条', 'output.json', '不得读取或输出认证文件']) assert.ok(prompt.includes(value));
  assert.ok(prompt.includes('标题必须写明当事人'));
  assert.ok(makePiPrompt({ date, window, target: 12, output: 'output.json', backfill: true }).includes('这是历史补刊'));
});

test('write feedback lets Pi repair a saved invalid bundle before ending its run', async t => {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'pi-feedback-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  await saveJson(path.join(folder, 'validation.json'), { date, window, target: 12, requireSelection: true });
  const file = path.join(folder, 'bundle.json');
  const bundle = fixture();
  bundle.selectionAudit = [{ event: 'major event', importance: 'high', leadUrls: [bundle.evidence[0].url], followUpUrls: [], decision: 'included', reason: 'fixture', storyId: 'one' }];
  await saveJson(file, bundle);
  const event = { toolName: 'write', input: { path: file }, content: [{ type: 'text', text: 'saved' }], isError: false };
  assert.equal(bundleWriteRestriction(event, folder), undefined);
  assert.equal(bundleWriteRestriction({ ...event, toolName: 'edit', input: { path: path.join(folder, '../code.mjs') } }, folder).block, true);
  const failed = await bundleWriteFeedback(event, folder);
  assert.equal(failed.isError, true); assert.match(failed.content[0].text, /major event.*未追查/);
  assert.match(failed.content[0].text, /本次运行内修复/);
  bundle.selectionAudit[0].followUpUrls = [bundle.evidence[0].url];
  await saveJson(file, bundle);
  const passed = await bundleWriteFeedback({ ...event, toolName: 'edit' }, folder);
  assert.equal(passed.isError, false); assert.match(passed.content.at(-1).text, /本地发布校验通过/);
  assert.equal(await bundleWriteFeedback({ ...event, input: { path: path.join(folder, 'other.json') } }, folder), undefined);
  assert.equal(await bundleWriteFeedback({ ...event, isError: true }, folder), undefined);
});

test('ready Pi artifact publishes during cooldown without another attempt or Git sync', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pi-ready-'));
  try {
    await cp(new URL('../src/', import.meta.url), path.join(root, 'src'), { recursive: true });
    await mkdir(path.join(root, 'scripts'));
    for (const file of ['pi-daily.mjs']) await cp(new URL(`../scripts/${file}`, import.meta.url), path.join(root, 'scripts', file));
    for (const file of ['styles.css', 'app.js']) await cp(new URL(`../${file}`, import.meta.url), path.join(root, file));
    const sentinel = path.join(root, 'must-not-invoke.mjs');
    await writeFile(sentinel, 'process.exit(99);');
    await saveJson(path.join(root, 'config/pi.json'), { cliPath: sentinel, maxAttemptsPerDay: 3 });
    await saveJson(path.join(root, 'config/settings.json'), { targetStories: 12, initialLookbackHours: 24, maxCatchupHours: 72 });
    const folder = path.join(root, 'data/pi-runs/2026/11/11');
    await saveJson(path.join(folder, 'checkpoint.json'), { date, window, attempts: 3, status: 'failed', providerError: 'old failure', validationError: 'old validation failure' });
    await saveJson(path.join(folder, 'search-cache/guard-state.json'), { blockedUntil: Date.now() + 900000 });
    const bundle = fixture();
    bundle.selectionAudit = [{ event: 'fixture', importance: 'normal', leadUrls: [bundle.evidence[0].url], decision: 'included', reason: 'fixture', storyId: 'one' }];
    await saveJson(path.join(folder, 'bundle.json'), bundle);
    const { stdout } = await promisify(execFile)(process.execPath, [path.join(root, 'scripts/pi-daily.mjs'), `--resume-date=${date}`, '--no-sync'], {
      cwd: root, env: { ...process.env, INSIGHT_PI_CLI: sentinel }, timeout: 15000, windowsHide: true,
    });
    assert.match(stdout, /已发布 1\/12/);
    const checkpoint = JSON.parse(await readFile(path.join(folder, 'checkpoint.json'), 'utf8'));
    assert.equal(checkpoint.status, 'published');
    assert.equal(checkpoint.attempts, 3);
    assert.equal(checkpoint.providerError, undefined);
    assert.equal(checkpoint.validationError, undefined);
    await access(path.join(root, 'public/index.html'));
    await assert.rejects(access(path.join(root, 'data/runtime/daily.lock')), { code: 'ENOENT' });
    await assert.rejects(access(path.join(root, 'data/runtime/git-sync.json')), { code: 'ENOENT' });
  } finally { await rm(root, { recursive: true, force: true }); }
});
