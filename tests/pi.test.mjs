import test from 'node:test';
import assert from 'node:assert/strict';
import { validatePiBundle, makePiPrompt } from '../src/pi-contract.mjs';
import { piArgs } from '../src/pi-runner.mjs';
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
test('Pi CLI uses isolated session and no command shell or credential flags', () => {
  const args = piArgs('cli.js', { tools: ['read', 'write'], projectTrust: 'ignore', model: '' }, 'C:/a b/prompt.txt');
  assert.ok(args.includes('--no-session')); assert.ok(args.includes('--no-approve'));
  assert.ok(args.includes('@C:/a b/prompt.txt')); assert.ok(!args.includes('--api-key'));
  assert.ok(!args.includes('--continue'));
});
test('prompt carries the exact window, target and output', () => {
  const prompt = makePiPrompt({ date, window, target: 12, output: 'output.json' });
  for (const value of [window.start, window.end, '目标12条', 'output.json', '不得读取或输出认证文件']) assert.ok(prompt.includes(value));
});
