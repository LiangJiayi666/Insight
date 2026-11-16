// Data, calculations and publication requirements for historical comparisons.
// This module never retrieves news; research still goes through Pi and Exa.
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const normalized = value => value.replace(/\s+/g, ' ').trim();

export function historyTopic(story) {
  const text = `${story.title} ${story.facts}`;
  if (/\bGDP\b|国内生产总值|经济增长|增长预测|增长预期|经济增速/i.test(text)) return 'growth';
  if (/\bCPI\b|\bPPI\b|价格指数|企业.*价格|物价|通胀/i.test(story.title)) return 'data';
  if (/利率|加息|降息|票息|储蓄国债|\bLPR\b|联邦基金/i.test(text)) return 'rates';
  if (/同比|环比|\bCPI\b|\bPPI\b|价格指数|通胀/i.test(text)) return 'data';
  return null;
}

function periodIndex(period, frequency) {
  let match;
  if (frequency === 'annual' && (match = /^(\d{4})$/.exec(period))) return Number(match[1]);
  if (frequency === 'quarterly' && (match = /^(\d{4})-Q([1-4])$/.exec(period))) return Number(match[1]) * 4 + Number(match[2]) - 1;
  if (frequency === 'monthly' && (match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(period))) return Number(match[1]) * 12 + Number(match[2]) - 1;
  if (frequency === 'decision' && /^\d{4}-\d{2}-\d{2}$/.test(period)) {
    const time = Date.parse(period + 'T00:00:00Z');
    if (Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === period) return time / 86400000;
  }
  throw new Error('实际序列期间须按频率使用YYYY、YYYY-Qn、YYYY-MM或YYYY-MM-DD');
}

function hasHistoricalCoverage(series, comparisons) {
  const periods = series.points.map(p => ({ period: p.period, index: periodIndex(p.period, series.frequency) })).sort((a, b) => a.index - b.index);
  const latest = periods.at(-1), previous = periods.at(-2);
  if (!previous) return false;
  const back = { annual: 1, quarterly: 4, monthly: 12, decision: 365 }[series.frequency];
  const yearEarlier = series.frequency === 'decision'
    ? periods.filter(p => p.index <= latest.index - back).at(-1)
    : periods.find(p => p.index === latest.index - back);
  if (!yearEarlier || (series.frequency !== 'decision' && previous.index !== latest.index - 1)) return false;
  const compared = from => comparisons.some(c => c.seriesId === series.id && c.from === from.period && c.to === latest.period);
  return compared(previous) && compared(yearEarlier);
}

export function historySourceIds(history) {
  return [...new Set((history?.series || []).flatMap(s => s.points.map(p => p.sourceId)))];
}

export function calculateComparison(series, comparison) {
  const from = series.points.find(p => p.period === comparison.from);
  const to = series.points.find(p => p.period === comparison.to);
  if (!from || !to || from === to) throw new Error('历史比较必须指定同一序列的两个不同期间');
  const delta = to.value - from.value;
  let value, unit;
  switch (comparison.method) {
    case 'percentage-points':
      if (series.unit !== '%' || series.measure === 'level') throw new Error('百分点比较必须使用同口径的百分率');
      value = delta; unit = '个百分点'; break;
    case 'basis-points':
      if (series.unit !== '%' || series.measure !== 'interest-rate') throw new Error('基点比较必须使用以百分数记录的利率');
      value = delta * 100; unit = '基点'; break;
    case 'percent-change':
      if (series.measure !== 'level' || from.value <= 0 || to.value < 0) throw new Error('增长率计算必须使用正基期的非负水平值，不能对增速或利率再算百分比');
      value = delta / from.value * 100; unit = '%'; break;
    case 'difference':
      if (series.measure !== 'level') throw new Error('百分率的差使用百分点或基点');
      value = delta; unit = series.unit; break;
    default: throw new Error('历史比较计算方法无效');
  }
  if (!Number.isFinite(value)) throw new Error('历史比较结果无效');
  return { value: Number(value.toFixed(6)), unit };
}

export function validateHistory(story, { required = false, evidence } = {}) {
  const history = story.history;
  const topic = historyTopic(story);
  if (!history) {
    if (required && topic) throw new Error(`${story.id}：数据/利率新闻缺少历史比较，不能用“未取得”代替检索`);
    return;
  }
  if (!['complete', 'limited'].includes(history.status) || !nonempty(history.interpretation)
    || !Array.isArray(history.series) || !Array.isArray(history.comparisons)) throw new Error('历史研究结构不完整');
  const ids = new Set();
  for (const series of history.series) {
    if (!nonempty(series.id) || ids.has(series.id) || !nonempty(series.metric) || !nonempty(series.basis) || !nonempty(series.unit)
      || !['level', 'growth-rate', 'interest-rate'].includes(series.measure)
      || !['observed', 'forecast'].includes(series.kind)
      || !['annual', 'quarterly', 'monthly', 'decision', 'vintage'].includes(series.frequency)
      || !Array.isArray(series.points) || !series.points.length) throw new Error('历史序列缺少指标、单位、实际/预测或统计口径');
    ids.add(series.id);
    if (series.measure !== 'level' && series.unit !== '%') throw new Error('增速和利率统一按百分数记录，单位为%');
    const periods = new Set();
    for (const point of series.points) {
      if (!nonempty(point.period) || periods.has(point.period) || !Number.isFinite(point.value)
        || !nonempty(point.sourceId) || !nonempty(point.quote) || point.quote.length < 8) throw new Error('历史数据点缺少期间、数值或原文依据，或期间重复');
      periods.add(point.period);
      if (series.kind === 'observed') periodIndex(point.period, series.frequency);
      if (evidence) {
        const item = evidence.get(point.sourceId);
        if (!item || !normalized(item.text).includes(normalized(point.quote))) throw new Error('历史数据引文无法匹配正文');
        const numbers = point.quote.replaceAll(',', '').replace(/[−－]/g, '-').match(/-?\d+(?:\.\d+)?/g) || [];
        if (!numbers.some(n => Number(n) === Math.abs(point.value) || Number(n) === point.value)) throw new Error('历史数据数值不在引文中');
      }
    }
  }
  for (const comparison of history.comparisons) {
    const series = history.series.find(s => s.id === comparison.seriesId);
    if (!series || !nonempty(comparison.label)) throw new Error('历史比较未关联指标或说明');
    calculateComparison(series, comparison);
  }
  if (history.status === 'complete') {
    const observed = history.series.filter(s => s.kind === 'observed' && s.points.length >= (s.frequency === 'quarterly' ? 4 : 3));
    const suitable = observed.filter(s => topic === 'growth' ? s.measure === 'growth-rate' : topic === 'rates' ? s.measure === 'interest-rate' : true);
    if (!suitable.some(s => hasHistoricalCoverage(s, history.comparisons)) || history.missing?.length) throw new Error('完整分析必须包含真实历史序列、前期及上年同期比较，预测修订不能替代实际走势');
  } else {
    if (!Array.isArray(history.missing) || !history.missing.length || history.missing.some(s => !nonempty(s))
      || !Array.isArray(history.attempts) || !history.attempts.length) throw new Error('资料受限必须列出缺口及实际检索记录');
    for (const attempt of history.attempts) {
      if (!nonempty(attempt.query) || !nonempty(attempt.detail)
        || !['unavailable', 'no-comparable-data', 'rate-limited', 'budget-exhausted'].includes(attempt.result)) throw new Error('历史检索记录不完整');
      if (attempt.url) {
        const url = new URL(attempt.url);
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('历史检索URL无效');
      }
    }
    const stopped = history.attempts.some(a => ['rate-limited', 'budget-exhausted'].includes(a.result));
    if (!stopped && new Set(history.attempts.map(a => a.query.trim())).size < 2) throw new Error('未取得历史数据时须记录官方与替代来源的两次实际追查');
    if (story.sections.some(s => ['analysis', 'example'].includes(s.kind))) throw new Error('资料受限只能发简讯，不用泛泛分析或假设算例充数');
  }
}
