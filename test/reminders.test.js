import assert from 'node:assert/strict';
import { test } from 'node:test';

import { StatsStore } from '../src/db.js';
import { buildReminderMessage, mentionsIn } from '../src/reminders.js';
import { humanizeDuration, nextOccurrence, parseWhen, zonedTime } from '../src/when.js';

const tz = 'America/New_York';
// Friday, October 9, 2026, 2:00 PM EDT
const now = zonedTime(2026, 10, 9, 14, 0, 0, tz);
const at = (input) => parseWhen(input, { now, timezone: tz });
const local = (y, mo, d, h, mi = 0) => zonedTime(y, mo, d, h, mi, 0, tz);

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

test('zonedTime converts wall clock to UTC for EDT and EST', () => {
  assert.equal(new Date(local(2026, 10, 9, 14)).toISOString(), '2026-10-09T18:00:00.000Z');
  assert.equal(new Date(local(2026, 12, 1, 9)).toISOString(), '2026-12-01T14:00:00.000Z');
});

test('parses durations with abbreviations', () => {
  assert.deepEqual(at('10m'), { at: now + 10 * MIN });
  assert.deepEqual(at('10 mins'), { at: now + 10 * MIN });
  assert.deepEqual(at('1h30m'), { at: now + 90 * MIN });
  assert.deepEqual(at('1h 30m'), { at: now + 90 * MIN });
  assert.deepEqual(at('in 2 hours and 15 minutes'), { at: now + 135 * MIN });
  assert.deepEqual(at('1.5h'), { at: now + 90 * MIN });
  assert.deepEqual(at('an hour'), { at: now + HOUR });
  assert.deepEqual(at('3d'), { at: now + 3 * DAY });
  assert.deepEqual(at('2w'), { at: now + 14 * DAY });
  assert.deepEqual(at('1 wk 2 days'), { at: now + 9 * DAY });
  assert.deepEqual(at('2mo'), { at: now + 60 * DAY });
  assert.deepEqual(at('45s'), { at: now + 45 * 1000 });
  assert.deepEqual(at('30 SECONDS'), { at: now + 30 * 1000 });
});

test('parses clock times in the configured timezone', () => {
  assert.deepEqual(at('3pm'), { at: local(2026, 10, 9, 15) });
  assert.deepEqual(at('3:30 pm'), { at: local(2026, 10, 9, 15, 30) });
  assert.deepEqual(at('at 15:45'), { at: local(2026, 10, 9, 15, 45) });
  // Already past today -> tomorrow.
  assert.deepEqual(at('9am'), { at: local(2026, 10, 10, 9) });
  assert.deepEqual(at('noon'), { at: local(2026, 10, 10, 12) });
  assert.deepEqual(at('midnight'), { at: local(2026, 10, 10, 0) });
});

test('parses days with and without times', () => {
  assert.deepEqual(at('tomorrow'), { at: local(2026, 10, 10, 9) });
  assert.deepEqual(at('tmrw 8:30pm'), { at: local(2026, 10, 10, 20, 30) });
  assert.deepEqual(at('tomorrow at 7am'), { at: local(2026, 10, 10, 7) });
  assert.deepEqual(at('tonight'), { at: local(2026, 10, 9, 20) });
  assert.deepEqual(at('today 6pm'), { at: local(2026, 10, 9, 18) });
  assert.deepEqual(at('mon'), { at: local(2026, 10, 12, 9) });
  assert.deepEqual(at('wednesday 5pm'), { at: local(2026, 10, 14, 17) });
  // Today is Friday: later today, a week out once the time has passed, or with "next".
  assert.deepEqual(at('fri 5pm'), { at: local(2026, 10, 9, 17) });
  assert.deepEqual(at('fri 9am'), { at: local(2026, 10, 16, 9) });
  assert.deepEqual(at('next fri 5pm'), { at: local(2026, 10, 16, 17) });
  assert.deepEqual(at('oct 12 3pm'), { at: local(2026, 10, 12, 15) });
  assert.deepEqual(at('October 12th at 3pm'), { at: local(2026, 10, 12, 15) });
  assert.deepEqual(at('12 dec'), { at: local(2026, 12, 12, 9) });
  assert.deepEqual(at('12/25 8am'), { at: local(2026, 12, 25, 8) });
  assert.deepEqual(at('2026-11-01 08:00'), { at: local(2026, 11, 1, 8) });
  // A month/day that already passed this year means next year.
  assert.deepEqual(at('jan 5'), { at: local(2027, 1, 5, 9) });
});

test('accepts Discord timestamps', () => {
  const ts = Math.floor(now / 1000) + 3600;
  assert.deepEqual(at(`<t:${ts}:R>`), { at: ts * 1000 });
  assert.deepEqual(at(String(ts)), { at: ts * 1000 });
});

test('rejects nonsense, past and far-future times', () => {
  for (const input of ['', 'soon', 'banana', '5 bananas', '13pm', '25:00', 'feb 30', 'today 9am', '2020-01-01', '2y']) {
    assert.ok(at(input).error, `expected an error for "${input}"`);
  }
});

test('repeats keep the local time across DST changes', () => {
  // Nov 1, 2026 is the end of DST in New York.
  const sat = local(2026, 10, 31, 9);
  assert.equal(nextOccurrence(sat, 'daily', tz), local(2026, 11, 1, 9));
  assert.equal(nextOccurrence(sat, 'daily', tz) - sat, 25 * HOUR);
  assert.equal(nextOccurrence(sat, 'weekly', tz), local(2026, 11, 7, 9));
  assert.equal(nextOccurrence(sat, 'hourly', tz), sat + HOUR);
  // Weekdays skip Saturday and Sunday.
  assert.equal(nextOccurrence(local(2026, 10, 9, 9), 'weekdays', tz), local(2026, 10, 12, 9));
  assert.equal(nextOccurrence(sat, 'weekdays', tz), local(2026, 11, 2, 9));
  assert.equal(nextOccurrence(local(2026, 10, 12, 9), 'weekdays', tz), local(2026, 10, 13, 9));
});

test('humanizeDuration shows the two largest units', () => {
  assert.equal(humanizeDuration(90 * MIN), '1 hour 30 minutes');
  assert.equal(humanizeDuration(3 * DAY + 2 * HOUR + 5 * MIN), '3 days 2 hours');
  assert.equal(humanizeDuration(45 * 1000), '45 seconds');
});

test('mentionsIn finds user, role and everyone mentions', () => {
  assert.deepEqual(mentionsIn('hey <@1> and <@!2>, <@&3> @here'), { users: ['1', '2'], roles: ['3'], everyone: 'here' });
  assert.deepEqual(mentionsIn('nothing'), { users: [], roles: [], everyone: null });
});

test('buildReminderMessage pings only the chosen targets', () => {
  const reminder = {
    id: 7,
    creatorId: '100',
    message: 'Stream starts!\nBring snacks',
    pings: { users: ['1'], roles: ['2'], everyone: null },
    dueAt: now,
    repeat: null,
  };
  const msg = buildReminderMessage(reminder, { now });
  assert.equal(
    msg.content,
    '⏰ **Reminder** for <@&2> <@1>\n> Stream starts!\n> Bring snacks\n-# Set by <@100> · #7',
  );
  assert.deepEqual(msg.allowedMentions, { users: ['1'], roles: ['2'], parse: [] });

  const late = buildReminderMessage({ ...reminder, repeat: 'daily' }, { now: now + HOUR, nextAt: now + DAY });
  assert.match(late.content, /late: was due/);
  assert.match(late.content, /repeats every day, next <t:\d+:R>/);

  const all = buildReminderMessage({ ...reminder, pings: { users: [], roles: [], everyone: 'everyone' } }, { now });
  assert.match(all.content, /for @everyone\n/);
  assert.deepEqual(all.allowedMentions.parse, ['everyone']);
});

test('store saves, lists, reschedules and deletes reminders', () => {
  const store = new StatsStore(':memory:');
  const pings = { users: ['1'], roles: [], everyone: null };
  const a = store.addReminder({ guildId: 'g', channelId: 'c', creatorId: 'u1', message: 'a', pings, dueAt: 2000 });
  const b = store.addReminder({ guildId: 'g', channelId: 'c', creatorId: 'u2', message: 'b', pings, dueAt: 1000, repeat: 'daily' });
  store.addReminder({ guildId: 'other', channelId: 'c', creatorId: 'u1', message: 'c', pings, dueAt: 500 });

  assert.deepEqual(store.getReminder(a).pings, pings);
  assert.deepEqual(store.listReminders('g').map((r) => r.id), [b, a]);
  assert.deepEqual(store.listReminders('g', 'u1').map((r) => r.id), [a]);
  assert.equal(store.getReminder(b).repeat, 'daily');

  store.rescheduleReminder(b, 9000);
  assert.equal(store.getReminder(b).dueAt, 9000);
  assert.equal(store.deleteReminder(a), true);
  assert.equal(store.deleteReminder(a), false);
  assert.equal(store.getReminder(a), null);
  assert.equal(store.getAllReminders().length, 2);
  store.close();
});
