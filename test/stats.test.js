import assert from 'node:assert/strict';
import { test } from 'node:test';

import { StatsStore } from '../src/db.js';
import { computeStats, percentChange } from '../src/stats.js';
import { formatGrowth } from '../src/report.js';
import { dayKey, shiftDay } from '../src/time.js';

test('dayKey uses the configured timezone for day boundaries', () => {
  // 03:30 UTC on Sep 13 is still Sep 12 in New York (UTC-4 during DST).
  const date = new Date('2026-09-13T03:30:00Z');
  assert.equal(dayKey(date, 'America/New_York'), '2026-09-12');
  assert.equal(dayKey(date, 'UTC'), '2026-09-13');
});

test('shiftDay handles month and year boundaries', () => {
  assert.equal(shiftDay('2026-03-01', -1), '2026-02-28');
  assert.equal(shiftDay('2026-01-01', -1), '2025-12-31');
  assert.equal(shiftDay('2026-12-31', 1), '2027-01-01');
});

test('store counts messages and unique senders per day', () => {
  const store = new StatsStore(':memory:');
  store.recordMessage('2026-09-12', 'a');
  store.recordMessage('2026-09-12', 'a');
  store.recordMessage('2026-09-12', 'b');
  store.recordMessage('2026-09-13', 'c');

  assert.deepEqual(store.getDay('2026-09-12'), { messages: 3, uniqueSenders: 2 });
  assert.deepEqual(store.getDay('2026-09-13'), { messages: 1, uniqueSenders: 1 });
  assert.deepEqual(store.getDay('2026-09-14'), { messages: 0, uniqueSenders: 0 });
  store.close();
});

test('computeStats produces window averages and growth', () => {
  const store = new StatsStore(':memory:');
  const day = '2026-09-12';
  // Previous window: 10 messages/day from 2 users. Current window: 20/day from 4 users.
  for (let i = 0; i < 60; i += 1) {
    const d = shiftDay(day, -i);
    const inCurrent = i < 30;
    const users = inCurrent ? ['a', 'b', 'c', 'd'] : ['a', 'b'];
    const perUser = inCurrent ? 5 : 5;
    for (const u of users) store.recordMessage(d, u, perUser);
  }
  store.setTrackingSinceIfUnset(shiftDay(day, -59));

  const stats = computeStats(store, day, 30);
  assert.equal(stats.today.messages, 20);
  assert.equal(stats.today.uniqueSenders, 4);
  assert.equal(stats.window.days, 30);
  assert.equal(stats.window.avgMessages, 20);
  assert.equal(stats.window.avgUniqueSenders, 4);
  assert.equal(stats.previous.avgMessages, 10);
  assert.equal(stats.previous.avgUniqueSenders, 2);
  assert.equal(stats.growth.messages, 100);
  assert.equal(stats.growth.uniqueSenders, 100);
  store.close();
});

test('computeStats only averages over tracked days', () => {
  const store = new StatsStore(':memory:');
  const day = '2026-09-12';
  store.setTrackingSinceIfUnset(shiftDay(day, -4)); // 5 tracked days
  store.recordMessage(day, 'a', 10);
  store.recordMessage(shiftDay(day, -1), 'b', 10);

  const stats = computeStats(store, day, 30);
  assert.equal(stats.window.days, 5);
  assert.equal(stats.window.avgMessages, 4);
  assert.equal(stats.previous.days, 0);
  assert.equal(stats.growth.messages, null);
  store.close();
});

test('percentChange and formatGrowth', () => {
  assert.equal(percentChange(120, 100), 20);
  assert.equal(percentChange(80, 100), -20);
  assert.equal(percentChange(5, 0), null);
  assert.equal(formatGrowth(20), '+20%');
  assert.equal(formatGrowth(-12.345), '−12.3%');
  assert.equal(formatGrowth(0), '±0%');
  assert.equal(formatGrowth(null), 'n/a (no prior data)');
});

test('member joins, leaves and first-time senders are reported per day', () => {
  const store = new StatsStore(':memory:');
  const day = '2026-09-25';
  store.recordMemberEvent(day, 'g', 'u1', 'join', 1);
  store.recordMemberEvent(day, 'g', 'u2', 'join', 2);
  store.recordMemberEvent(day, 'g', 'u3', 'leave', 3);
  store.recordMemberEvent(shiftDay(day, -1), 'g', 'u4', 'join', 4);
  // u1 first message today, u5 messaged yesterday and today (not first-time today)
  store.recordMessage(day, 'u1');
  store.recordMessage(day, 'u5');
  store.recordMessage(shiftDay(day, -1), 'u5');

  const stats = computeStats(store, day, 30);
  assert.deepEqual(stats.members, { joins: 2, leaves: 1, firstTimeSenders: 1 });

  // Backfill replaces joins for a day without touching leaves.
  store.replaceJoins(day, [{ guildId: 'g', userId: 'u9', ts: 9 }]);
  assert.deepEqual(store.getMemberEvents(day), { joins: 1, leaves: 1 });
  store.close();
});
