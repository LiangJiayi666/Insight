import path from 'node:path';
import { readFile, readdir, stat } from 'node:fs/promises';
import { readJson, chinaDate, datePath } from './runtime.mjs';
import { pendingIssueDates, shiftDate } from './daily-plan.mjs';
import { diagnoseRun } from './run-diagnostics.mjs';
import { renderIssue } from './render.mjs';

export async function inspectHealth(root, now = new Date()) {
  const findings = [];
  const state = await readJson(path.join(root, 'data/runtime/state.json'), { published: {} });
  const published = Object.keys(state.published || {}).sort();
  const today = chinaDate(now);
  const config = await readJson(path.join(root, 'config/pi.json'), {});
  const settings = await readJson(path.join(root, 'config/settings.json'), { scheduleLocalTime: '19:50' });
  const deadline = Date.parse(`${today}T${settings.scheduleLocalTime}:00+08:00`) + (config.timeoutMinutes || 90) * 60000;
  const dueThrough = now.getTime() >= deadline ? today : shiftDate(today, -1);
  const runRoot = path.join(root, 'data/pi-runs');
  const checkpoints = [];
  for (const year of await readdir(runRoot).catch(e => { if (e.code === 'ENOENT') return []; throw e; })) {
    if (!/^\d{4}$/.test(year)) continue;
    for (const month of await readdir(path.join(runRoot, year))) {
      if (!/^\d{2}$/.test(month)) continue;
      for (const day of await readdir(path.join(runRoot, year, month))) {
        if (!/^\d{2}$/.test(day)) continue;
        const date = `${year}-${month}-${day}`;
        const checkpoint = await readJson(path.join(runRoot, year, month, day, 'checkpoint.json'), null);
        if (checkpoint) checkpoints.push({ ...checkpoint, date });
      }
    }
  }
  const missing = pendingIssueDates(state, checkpoints.map(c => c.date), dueThrough);
  if (missing.length) findings.push({ severity: 'error', code: 'missing-editions', dates: missing, message: `已到期缺刊：${missing.join('、')}` });
  const byDate = new Map(checkpoints.map(c => [c.date, c]));
  for (const c of checkpoints) {
    const previous = shiftDate(c.date, -1);
    const cutoff = state.published?.[previous]?.cutoff || byDate.get(previous)?.window?.end;
    if (cutoff && Date.parse(c.window?.start) - Date.parse(cutoff) > 1) findings.push({ severity: 'error', code: 'coverage-gap', date: c.date, start: cutoff, end: c.window.start, message: '相邻采集窗口存在未覆盖时间段' });
  }
  const failures = [];
  for (const c of checkpoints.filter(c => !state.published?.[c.date])) {
    const folder = path.join(runRoot, datePath(c.date));
    const logs = (await readdir(folder)).filter(f => /^attempt-\d+\.private\.log$/.test(f)).sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]));
    const lastLog = logs.at(-1);
    const diagnosis = lastLog ? diagnoseRun(await readFile(path.join(folder, lastLog), 'utf8')) : {};
    failures.push({ date: c.date, status: c.status, attempts: c.attempts, exhausted: c.attempts >= config.maxAttemptsPerDay, diagnosis, validationError: c.validationError });
  }
  for (const date of published) {
    try {
      const issue = await readJson(path.join(root, 'data/issues', datePath(date), 'issue.json'));
      const html = await readFile(path.join(root, 'public/issues', datePath(date), 'index.html'), 'utf8');
      if (issue.date !== date || issue.stories.length !== state.published[date].count) throw new Error('稿件与发布索引不一致');
      // Old editions intentionally retain their renderer/styles. Only compare
      // the current home page to the current renderer; require old assets exist.
      for (const asset of ['styles.css', 'app.js']) await stat(path.join(root, 'public/issues', datePath(date), asset));
      if (!html.includes(date)) throw new Error('归档页面缺少刊期日期');
      if (date === published.at(-1)) {
        const home = await readFile(path.join(root, 'public/index.html'), 'utf8');
        if (home !== renderIssue(issue)) throw new Error('首页与最新稿件重新渲染的结果不一致');
      }
    } catch (error) { findings.push({ severity: 'error', code: 'publication-integrity', date, message: error.message }); }
  }
  const locks = [];
  for (const name of ['daily', 'operations', 'report-delivery', 'git-sync']) {
    const record = await readJson(path.join(root, 'data/runtime', `${name}.lock`), null);
    if (!record) continue;
    let alive = true;
    try { process.kill(record.pid, 0); } catch (error) { alive = error.code !== 'ESRCH'; }
    locks.push({ name, ...record, alive });
    if (!alive) findings.push({ severity: 'error', code: 'stale-lock', message: `${name}锁的进程已退出，需核实后解锁` });
  }
  const deliveries = [];
  for (let n = 0; n < 7; n++) {
    const date = shiftDate(today, -n);
    const record = await readJson(path.join(root, 'data/delivery-ledger', `${date}-daily.json`), null);
    if (record) deliveries.push({ date, status: record.status, kind: record.kind, editionDate: record.editionDate || null, sentAt: record.sentAt });
  }
  return { checkedAt: now.toISOString(), status: findings.some(f => f.severity === 'error') ? 'unhealthy' : 'healthy', model: config.model, thinkingLevel: config.thinkingLevel || null, latestEdition: published.at(-1) || null, dueThrough, publishedCount: published.length, missing, failures, findings, locks, deliveries, git: await readJson(path.join(root, 'data/runtime/git-sync.json'), null), scope: '本地状态与产物检查；不代表外部模型、Exa、飞书实时可用。联网验证使用pi:probe和pi:smoke。' };
}
