import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  BUMP_COOLDOWN_MS,
  DISBOARD_BOT_ID,
  EARLY_BUMP_COOLDOWN_MS,
  EARLY_BUMP_RECHARGE_MS,
  isBumpDone,
  parseEarlyBump,
  planNextBump,
  reconcileUses,
  setupBumpReminders,
} from '../src/bump.js';
import { StatsStore } from '../src/db.js';

const disboard = (extra) => ({ author: { id: DISBOARD_BOT_ID }, embeds: [], ...extra });

test('isBumpDone accepts a successful bump embed', () => {
  assert.equal(
    isBumpDone(disboard({ embeds: [{ description: 'Bump done! :thumbsup:' }], interaction: { commandName: 'bump' } })),
    true,
  );
});

test('isBumpDone rejects failed bumps and other bots', () => {
  assert.equal(
    isBumpDone(disboard({ embeds: [{ description: 'Please wait another 42 minutes until the server can be bumped' }], interaction: { commandName: 'bump' } })),
    false,
  );
  assert.equal(isBumpDone({ author: { id: '1' }, embeds: [{ description: 'Bump done!' }] }), false);
  assert.equal(isBumpDone(disboard({ interaction: { commandName: 'help' } })), false);
});

test('isBumpDone falls back to the command name when embeds are hidden', () => {
  assert.equal(isBumpDone(disboard({ interaction: { commandName: 'bump' } })), true);
  assert.equal(isBumpDone(disboard({})), false);
});

test('store persists bump role and reminders', () => {
  const store = new StatsStore(':memory:');
  assert.equal(store.getBumpRole('g1'), null);
  store.setBumpRole('g1', 'r1');
  assert.equal(store.getBumpRole('g1'), 'r1');

  store.setBumpReminder('g1', 'c1', 1000);
  assert.deepEqual(store.getBumpReminder('g1'), { guildId: 'g1', channelId: 'c1', dueAt: 1000 });
  store.setBumpReminder('g1', 'c2', 2000); // a new bump replaces the pending reminder
  assert.deepEqual(store.getAllBumpReminders(), [{ guildId: 'g1', channelId: 'c2', dueAt: 2000 }]);

  store.clearBumpReminder('g1');
  store.clearBumpRole('g1');
  assert.equal(store.getBumpReminder('g1'), null);
  assert.equal(store.getBumpRole('g1'), null);
  store.close();
});

const MIN = 60 * 1000;

test('parseEarlyBump reads the DISBOARD Pro line', () => {
  const text = 'Bump done! :thumbsup:\nCheck it out on DISBOARD.\n\n⚡ Bumped early with **DISBOARD Pro**! Used 1 accelerated bump (11 of 12 left).';
  assert.deepEqual(parseEarlyBump(text), { used: 1, left: 11, pool: 12 });
  assert.equal(parseEarlyBump('Bump done! :thumbsup:'), null);
});

test('planNextBump uses early bumps first, then 2 hours, then early again as they recharge', () => {
  const pool = 12;
  let uses = [];
  let t = 0;
  // 12 early bumps, each 30 minutes after the last.
  for (let i = 0; i < 12; i += 1) {
    const plan = planNextBump(t, uses, pool);
    assert.deepEqual(plan, { dueAt: t + EARLY_BUMP_COOLDOWN_MS, early: true }, `bump ${i}`);
    t = plan.dueAt;
    uses = reconcileUses([...uses, t], t, pool, pool - 1 - i);
  }
  // All 12 used: back to the normal 2-hour bump.
  const normal = planNextBump(t, uses, pool);
  assert.equal(normal.early, false);
  assert.equal(normal.dueAt, t + BUMP_COOLDOWN_MS);
  assert.equal(normal.rechargeAt, uses[0] + EARLY_BUMP_RECHARGE_MS);

  // Just before the first early bump recharges, the reminder comes at the recharge.
  const late = uses[0] + EARLY_BUMP_RECHARGE_MS - 60 * MIN;
  assert.deepEqual(planNextBump(late, uses, pool), { dueAt: uses[0] + EARLY_BUMP_RECHARGE_MS, early: true });
  // A day later everything has recharged.
  assert.deepEqual(planNextBump(t + EARLY_BUMP_RECHARGE_MS, uses, pool), {
    dueAt: t + EARLY_BUMP_RECHARGE_MS + EARLY_BUMP_COOLDOWN_MS,
    early: true,
  });
  // Without Pro it is always 2 hours.
  assert.deepEqual(planNextBump(0, [], 0), { dueAt: BUMP_COOLDOWN_MS, early: false });
});

test('reconcileUses trusts the count Disboard reports', () => {
  // We missed two uses while offline: Disboard says 9 left, we only know of 1.
  assert.equal(reconcileUses([100], 200, 12, 9).length, 3);
  // Disboard says more are left than we think: drop the oldest.
  assert.deepEqual(reconcileUses([100, 150, 180], 200, 12, 10), [150, 180]);
});

test('Disboard early-bump replies schedule 30-minute reminders', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const store = new StatsStore(':memory:');
  const sent = [];
  const channel = { isTextBased: () => true, send: async (m) => sent.push(m.content) };
  const bumps = setupBumpReminders({ channels: { fetch: async () => channel } }, store);
  store.setBumpRole('g', 'r');
  const now = Date.now();
  bumps.onMessage(
    disboard({
      inGuild: () => true,
      guildId: 'g',
      channelId: 'c',
      createdTimestamp: now,
      interaction: { commandName: 'bump' },
      embeds: [{ description: 'Bump done!\n⚡ Bumped early with DISBOARD Pro! Used 1 accelerated bump (11 of 12 left).' }],
    }),
  );
  assert.equal(store.getBumpReminder('g').dueAt, now + EARLY_BUMP_COOLDOWN_MS);
  t.mock.timers.tick(EARLY_BUMP_COOLDOWN_MS);
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(sent[0], /<@&r> ⚡ An early bump is ready with DISBOARD Pro \(11 of 12 left\)/);
  store.close();
});
