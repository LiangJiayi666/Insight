import test from 'node:test';
import assert from 'node:assert/strict';
import { pendingIssueDates, issueWindow, publicationPosition, shiftDate } from '../src/daily-plan.mjs';

const settings = { initialLookbackHours: 24, maxCatchupHours: 72 };
test('missing historical editions precede today, even when today is already published', () => {
  const state = { published: { '2026-11-11': {}, '2026-11-12': {}, '2026-11-13': {}, '2026-11-15': {} } };
  assert.deepEqual(pendingIssueDates(state, [], '2026-11-16'), ['2026-11-14', '2026-11-16']);
  state.published['2026-11-16'] = {};
  assert.deepEqual(pendingIssueDates(state, [], '2026-11-16'), ['2026-11-14']);
  assert.deepEqual(pendingIssueDates({ published: {} }, [], '2026-11-16'), ['2026-11-16']);
  assert.deepEqual(pendingIssueDates({ published: {} }, ['2026-11-14'], '2026-11-16'), ['2026-11-14', '2026-11-15', '2026-11-16']);
});

test('missing edition detection crosses months and rejects impossible dates', () => {
  assert.deepEqual(pendingIssueDates({ published: { '2026-12-30': {} } }, [], '2027-01-02'), ['2026-12-31', '2027-01-01', '2027-01-02']);
  assert.equal(shiftDate('2028-03-01', -1), '2028-02-29');
  assert.throws(() => shiftDate('2026-02-30', 0), /日期无效/);
});

test('backfill windows end on the historical day and never use a later issue cutoff', () => {
  const state = { lastCutoff: '2026-11-15T11:56:55.536Z', published: {
    '2026-11-13': { cutoff: '2026-11-13T11:50:01.995Z' },
    '2026-11-15': { cutoff: '2026-11-15T11:56:55.536Z' },
  } };
  const now = new Date('2026-11-16T05:00:00Z');
  assert.deepEqual(issueWindow('2026-11-14', state, settings, now), {
    start: '2026-11-13T11:50:01.995Z', end: '2026-11-14T15:59:59.999Z', gap: false,
  });
  assert.equal(issueWindow('2026-11-16', state, settings, now).start, state.lastCutoff);
  delete state.published['2026-11-15'];
  assert.equal(issueWindow('2026-11-16', state, settings, now).start, '2026-11-15T16:00:00.000Z');
  assert.throws(() => issueWindow('2026-11-17', state, settings, now), /未来/);
});

test('publishing an older issue preserves the current home page and collection cutoff', () => {
  const state = { lastCutoff: '2026-11-15T11:56:55.536Z', published: { '2026-11-15': {} } };
  assert.deepEqual(publicationPosition(state, '2026-11-14', '2026-11-14T15:59:59.999Z'), { latest: false, lastCutoff: state.lastCutoff });
  assert.deepEqual(publicationPosition(state, '2026-11-16', '2026-11-16T11:50:00Z'), { latest: true, lastCutoff: '2026-11-16T11:50:00Z' });
});

test('a failed predecessor checkpoint prevents an uncovered evening gap', () => {
  const state = { published: { '2026-11-19': { cutoff: '2026-11-19T11:50:00Z' } } };
  const previous = { date: '2026-11-20', status: 'failed', window: { end: '2026-11-20T11:50:00Z' } };
  const window = issueWindow('2026-11-21', state, settings, new Date('2026-11-21T11:50:00Z'), previous);
  assert.equal(window.start, '2026-11-20T11:50:00.000Z');
  assert.equal(window.end, '2026-11-21T11:50:00.000Z');
  assert.throws(() => issueWindow('2026-11-22', state, settings, new Date('2026-11-22T11:50:00Z'), previous), /日期不匹配/);
});
