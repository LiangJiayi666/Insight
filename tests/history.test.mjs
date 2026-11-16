import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { calculateComparison, historyTopic, validateHistory } from '../src/history.mjs';
import { validatePiBundle } from '../src/pi-contract.mjs';
import { renderIssue } from '../src/render.mjs';

// All figures below are synthetic fixtures, not economic observations.
function fixture() {
  const points = [['2025-Q3', -0.2], ['2025-Q4', 0], ['2026-Q1', 0.1], ['2026-Q2', 0.3], ['2026-Q3', 0.5]]
    .map(([period, value]) => ({ period, value, sourceId: 'history', quote: `测试数据 ${period} 季调实际GDP环比为${value}%。` }));
  const text = points.map(p => p.quote).join('\n') + '这是虚构测试表格，不能作为真实新闻数据。'.repeat(15);
  const history = { status: 'complete', interpretation: '测试：环比增速较上季提高0.2个百分点；增速差不能当成GDP同比。',
    series: [{ id: 'gdp', metric: '测试GDP环比增速', unit: '%', measure: 'growth-rate', kind: 'observed', frequency: 'quarterly', basis: '测试；实际；季调；非年化；同一版本', points }],
    comparisons: [
      { seriesId: 'gdp', from: '2026-Q2', to: '2026-Q3', method: 'percentage-points', label: '增速较上季变化' },
      { seriesId: 'gdp', from: '2025-Q3', to: '2026-Q3', method: 'percentage-points', label: '增速较上年同季变化' },
    ] };
  const source = { id: 'history', publisher: '测试机构', title: '测试数据表', url: 'https://example.com/history', published: '2026-11-12', accessed: '2026-11-16', method: 'fixture', excerpt: points[0].quote, limits: '测试' };
  const issue = { date: '2026-11-16', cutoff: '2026-11-16T12:00:00Z', sources: [source], stories: [{ id: 'gdp-news', title: '测试GDP数据', category: '经济', facts: '测试GDP数据', published: '2026-11-16', eventDate: '2026-Q3', affected: '测试', status: '测试', takeaway: '测试', sourceIds: ['history'], sections: [{ title: '测试判断', tag: '分析', kind: 'analysis', paragraphs: ['测试判断'], sourceIds: ['history'] }], history }] };
  return { issue, story: issue.stories[0], evidence: new Map([['history', { text }]]) };
}

test('old German and bond stories fail the new history gate despite valid prose and quotes', async () => {
  for (const [day, id] of [['12', 'germany-fiscal-outlook'], ['11', 'savings-bonds-2026-11']]) {
    const issue = JSON.parse(await readFile(new URL(`../data/issues/2026/11/${day}/issue.json`, import.meta.url), 'utf8'));
    const story = issue.stories.find(s => s.id === id);
    assert.throws(() => validateHistory(story, { required: true }), /缺少历史比较/);
  }
  assert.equal(historyTopic({ title: '日本企业商品价格同比上升，不等于已经加息', facts: '同比7.1%' }), 'data');
  assert.equal(historyTopic({ title: '政策利率调整', facts: '同时公布通胀同比数据' }), 'rates');
  assert.doesNotThrow(() => validateHistory({ title: '人事任命', facts: '任命公告', sections: [] }, { required: true }));
});

test('publication validates history while allowing date-only background outside the news window', () => {
  const { issue, evidence } = fixture();
  issue.sources.push({ ...issue.sources[0], id: 'news', url: 'https://example.com/news', published: '2026-11-16T09:00:00+08:00' });
  issue.stories[0].sourceIds = ['news'];
  issue.stories[0].claims = [{ text: '测试', sourceId: 'news', quote: issue.sources[1].excerpt }];
  const bundle = { issue, evidence: issue.sources.map(source => ({ id: source.id, url: source.url, published: source.published, text: evidence.get('history').text })) };
  const options = { date: issue.date, window: { start: '2026-11-15T12:00:00Z', end: issue.cutoff }, target: 12, requireHistory: true };
  assert.doesNotThrow(() => validatePiBundle(bundle, options));
  delete bundle.issue.stories[0].history;
  assert.throws(() => validatePiBundle(bundle, options), /缺少历史比较/);
});

test('history requires actual comparable periods, earlier-year coverage and evidence for every figure', () => {
  const { story, evidence } = fixture();
  assert.doesNotThrow(() => validateHistory(story, { required: true, evidence }));
  for (const mutate of [
    s => { s.history.series[0].kind = 'forecast'; },
    s => { s.history.series[0].points.shift(); s.history.comparisons.pop(); },
    s => { s.history.comparisons.pop(); },
    s => { s.history.series[0].points[0].sourceId = 'missing'; },
    s => { s.history.series[0].points[0].quote = '没有出现在真实证据中的伪造数据'; },
    s => { s.history.series[0].points[0].value = 1234; },
    s => { s.history.series[0].points[0].period = '2025-Q9'; },
    s => { s.history.comparisons[0].seriesId = 'wrong-series'; },
  ]) {
    const bad = structuredClone(story); mutate(bad);
    assert.throws(() => validateHistory(bad, { required: true, evidence }));
  }
});

test('rate paths calculate basis points and reject percentage growth of rates', () => {
  const series = { id: 'rate', measure: 'interest-rate', unit: '%', points: [{ period: 'prior', value: 4.5 }, { period: 'current', value: 4.25 }] };
  const comparison = { from: 'prior', to: 'current', method: 'basis-points' };
  assert.deepEqual(calculateComparison(series, comparison), { value: -25, unit: '基点' });
  assert.deepEqual(calculateComparison(series, { ...comparison, method: 'percentage-points' }), { value: -0.25, unit: '个百分点' });
  assert.throws(() => calculateComparison(series, { ...comparison, method: 'percent-change' }), /不能对增速或利率/);
  assert.throws(() => calculateComparison(series, { ...comparison, from: 'current' }), /不同期间/);
  assert.deepEqual(calculateComparison({ ...series, measure: 'level', unit: '指数', points: [{ period: 'prior', value: 100 }, { period: 'current', value: 102 }] }, { ...comparison, method: 'percent-change' }), { value: 2, unit: '%' });
});

test('rate analysis needs previous decision and at least a year of history', () => {
  const { story } = fixture();
  story.title = '测试央行利率调整'; story.facts = '测试利率';
  const series = story.history.series[0];
  Object.assign(series, { measure: 'interest-rate', frequency: 'decision' });
  series.points = ['2025-11-15', '2026-10-20', '2026-11-16'].map((period, i) => ({ period, value: 4.5 - i * 0.25, sourceId: 'history', quote: '测试利率原文数据4.5、4.25、4.0。' }));
  story.history.comparisons = [series.points[0], series.points[1]].map(p => ({ seriesId: 'gdp', from: p.period, to: '2026-11-16', method: 'basis-points', label: '测试利率变化' }));
  assert.doesNotThrow(() => validateHistory(story, { required: true }));
  series.points[0].period = '2026-09-20'; story.history.comparisons[0].from = '2026-09-20';
  assert.throws(() => validateHistory(story), /上年同期/);
});

test('limited brief requires actual attempted queries and cannot masquerade as full analysis', () => {
  const { story } = fixture();
  story.history = { status: 'limited', interpretation: '无法核对历史序列。', series: [], comparisons: [], missing: ['历史GDP序列'], attempts: [] };
  story.sections[0].kind = 'facts';
  assert.throws(() => validateHistory(story), /实际检索/);
  story.history.attempts = [
    { query: '测试官方历史表', url: 'https://example.com/history', result: 'unavailable', detail: '测试：官方页面读取失败' },
    { query: '测试替代来源历史表', result: 'no-comparable-data', detail: '测试：仅有名义值，不能与实际增速比较' },
  ];
  assert.doesNotThrow(() => validateHistory(story));
  story.sections[0].kind = 'analysis';
  assert.throws(() => validateHistory(story), /只能发简讯/);
  story.sections[0].kind = 'facts';
  story.history.attempts = [{ query: '测试历史表', result: 'rate-limited', detail: '测试：真实429，需要停止请求' }];
  assert.doesNotThrow(() => validateHistory(story));
});

test('history tables render citations, calculated changes and escaped labels without altering legacy pages', () => {
  const { issue } = fixture();
  issue.stories[0].history.series[0].metric = '<script>测试</script>';
  const html = renderIssue(issue);
  assert.match(html, /<table class="history-table">/);
  assert.match(html, /\+0.2个百分点/);
  assert.match(html, /&lt;script&gt;测试/);
  assert.doesNotMatch(html, /<script>测试/);
  assert.match(html, /https:\/\/example.com\/history/);
  assert.equal((html.match(/<table\b/g) || []).length, (html.match(/<\/table>/g) || []).length);
  assert.throws(() => renderIssue({ ...issue, sources: [{ ...issue.sources[0], id: 'elsewhere' }] }), /不存在的来源/);
});
