import assert from 'node:assert/strict';
import { test } from 'node:test';

import { formatReportTime, parseReportTime, reportPlan } from '../src/dailyreport.js';
import { zonedTime } from '../src/when.js';

const tz = 'America/New_York';
const at = (h, m = 0) => zonedTime(2026, 10, 20, h, m, 0, tz);

test('parseReportTime understands 12- and 24-hour times', () => {
  assert.equal(parseReportTime('midnight'), '00:00');
  assert.equal(parseReportTime('noon'), '12:00');
  assert.equal(parseReportTime('9pm'), '21:00');
  assert.equal(parseReportTime('9:30 PM'), '21:30');
  assert.equal(parseReportTime('12am'), '00:00');
  assert.equal(parseReportTime('12pm'), '12:00');
  assert.equal(parseReportTime('7a'), '07:00');
  assert.equal(parseReportTime('21:45'), '21:45');
  assert.equal(parseReportTime('at 8am'), '08:00');
  for (const bad of ['', '25:00', '13pm', '9:75', 'tomorrow', '0am']) assert.equal(parseReportTime(bad), null, bad);
});

test('formatReportTime', () => {
  assert.equal(formatReportTime('00:00'), 'midnight');
  assert.equal(formatReportTime('12:00'), 'noon');
  assert.equal(formatReportTime('21:30'), '9:30 PM');
  assert.equal(formatReportTime('08:05'), '8:05 AM');
});

test('morning reports cover the previous day, later ones the current day', () => {
  const morning = reportPlan('09:00', at(10), tz);
  assert.deepEqual(morning, { day: '2026-10-19', partial: false, due: true, nextAt: zonedTime(2026, 10, 21, 9, 0, 0, tz) });

  const beforeEvening = reportPlan('21:00', at(20, 59), tz);
  assert.deepEqual(beforeEvening, { day: '2026-10-20', partial: true, due: false, nextAt: at(21) });
  assert.equal(reportPlan('21:00', at(21), tz).due, true);

  const midnight = reportPlan('00:00', at(0, 1), tz);
  assert.equal(midnight.day, '2026-10-19');
  assert.equal(midnight.due, true);
});
