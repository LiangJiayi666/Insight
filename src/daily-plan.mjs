import { chinaDate, computeWindow } from './runtime.mjs';

const DAY = 86400000;
export function shiftDate(date, days) {
  const time = Date.parse(`${date}T12:00:00+08:00`);
  if (!Number.isFinite(time) || chinaDate(new Date(time)) !== date) throw new Error('刊期日期无效');
  return chinaDate(new Date(time + days * DAY));
}

// The first published issue or existing checkpoint defines when this installation
// started. Do not invent missing editions before that date.
export function pendingIssueDates(state, checkpointDates, today) {
  shiftDate(today, 0);
  const known = [...Object.keys(state.published || {}), ...checkpointDates];
  for (const date of known) shiftDate(date, 0);
  const first = known.filter(date => date <= today).sort()[0] || today;
  const pending = [];
  for (let date = first; date <= today; date = shiftDate(date, 1)) {
    if (!state.published?.[date]) pending.push(date);
  }
  return pending;
}

export function issueWindow(date, state, settings, now = new Date(), previousCheckpoint = null) {
  shiftDate(date, 0);
  const today = chinaDate(now);
  if (date > today) throw new Error('不能制作未来刊期');
  const end = date < today ? new Date(`${date}T23:59:59.999+08:00`) : now;
  const previous = state.published?.[shiftDate(date, -1)];
  if (previousCheckpoint && previousCheckpoint.date !== shiftDate(date, -1)) throw new Error('前一期检查点日期不匹配');
  // A missing previous edition is handled separately. Its failure must not cause
  // today's issue to silently absorb the entire unpublished interval again.
  // A failed predecessor still owns a fixed coverage window. Continue from its
  // cutoff so that evening-to-midnight news is not lost during catch-up.
  const start = previous?.cutoff || previousCheckpoint?.window?.end || (Object.keys(state.published || {}).length || date < today
    ? `${date}T00:00:00+08:00` : null);
  return computeWindow(end, start, settings);
}

export function publicationPosition(state, date, cutoff) {
  const latestDate = Object.keys(state.published || {}).sort().at(-1);
  return {
    latest: !latestDate || date >= latestDate,
    lastCutoff: !state.lastCutoff || Date.parse(cutoff) > Date.parse(state.lastCutoff) ? cutoff : state.lastCutoff,
  };
}
