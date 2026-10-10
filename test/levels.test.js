import assert from 'node:assert/strict';
import { test } from 'node:test';

import { StatsStore } from '../src/db.js';
import {
  XP_COOLDOWN_MS,
  levelFromXp,
  levelUpText,
  randomXp,
  renderRankCard,
  setupLevels,
  totalXpForLevel,
  xpToNext,
} from '../src/levels.js';

test('level curve matches Arcane/MEE6', () => {
  assert.deepEqual([0, 1, 2, 3, 4].map(xpToNext), [100, 155, 220, 295, 380]);
  assert.equal(totalXpForLevel(0), 0);
  assert.equal(totalXpForLevel(5), 1150);
  assert.deepEqual(levelFromXp(0), { level: 0, current: 0, needed: 100 });
  assert.deepEqual(levelFromXp(99), { level: 0, current: 99, needed: 100 });
  assert.deepEqual(levelFromXp(100), { level: 1, current: 0, needed: 155 });
  assert.deepEqual(levelFromXp(1150 + 10), { level: 5, current: 10, needed: 475 });
});

test('randomXp stays within 15–25', () => {
  assert.equal(randomXp(() => 0), 15);
  assert.equal(randomXp(() => 0.9999), 25);
});

test('levelUpText mentions the member and any new roles', () => {
  assert.equal(levelUpText('1', 3), '🎉 GG <@1>, you just reached **level 3**!');
  assert.match(levelUpText('1', 5, ['9']), /level 5\*\*!\n🏷️ You unlocked <@&9>!/);
});

test('renderRankCard produces a PNG', () => {
  const png = renderRankCard({ name: 'sam', xp: 500, rank: 2, nextReward: { name: '@Self Promo', level: 5 } });
  assert.deepEqual([...png.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
});

test('store tracks XP, ranks, leaderboard and rewards', () => {
  const store = new StatsStore(':memory:');
  assert.deepEqual(store.getLevel('g', 'a'), { xp: 0, messages: 0, lastXpAt: 0 });
  store.addXp('g', 'a', 300, { messages: 3, at: 10 });
  store.addXp('g', 'b', 100, { messages: 1, at: 20 });
  store.addXp('g', 'c', 500);
  store.addXp('other', 'z', 9999);
  assert.deepEqual(store.getLevel('g', 'a'), { xp: 300, messages: 3, lastXpAt: 10 });
  assert.equal(store.addXp('g', 'b', -1000), 0); // never below zero
  assert.equal(store.getRank('g', 300), 2);
  assert.deepEqual(store.getLeaderboard('g').map((r) => r.userId), ['c', 'a']);
  assert.equal(store.getRankedCount('g'), 2);
  assert.deepEqual(store.getUsersWithXp('g', 400).map((r) => r.userId), ['c']);

  store.setLevelReward('g', 'r5', 5);
  store.setLevelReward('g', 'r1', 1);
  store.setLevelReward('g', 'r5', 6); // moving a reward replaces it
  assert.deepEqual(store.getLevelRewards('g'), [{ roleId: 'r1', level: 1 }, { roleId: 'r5', level: 6 }]);
  assert.equal(store.deleteLevelReward('g', 'r1'), true);
  assert.equal(store.deleteLevelReward('g', 'r1'), false);
  store.close();
});

function harness() {
  const store = new StatsStore(':memory:');
  const sent = [];
  const roles = new Set();
  const guild = {
    id: 'g',
    roles: { cache: new Map([['promo', { id: 'promo', name: 'Self Promo', editable: true }]]) },
  };
  const member = {
    id: 'u',
    guild,
    roles: { cache: { has: (id) => roles.has(id) }, add: async (role) => roles.add(role.id) },
  };
  const channel = { isTextBased: () => true, send: async (m) => sent.push(m) };
  const levels = setupLevels({ channels: { fetch: async () => channel } }, store, { random: () => 0.9999 });
  const message = (at) => ({ guildId: 'g', guild, author: { id: 'u', tag: 'u#0' }, member, channel, createdTimestamp: at });
  return { store, sent, roles, levels, message };
}

test('messages earn XP once a minute and level up with role rewards', async () => {
  const { store, sent, roles, levels, message } = harness();
  store.setLevelReward('g', 'promo', 1);

  await levels.onMessage(message(1_000_000));
  await levels.onMessage(message(1_000_000 + XP_COOLDOWN_MS - 1)); // cooldown: no XP
  assert.equal(store.getLevel('g', 'u').xp, 25);

  for (let i = 1; i <= 3; i += 1) await levels.onMessage(message(1_000_000 + i * XP_COOLDOWN_MS));
  assert.equal(store.getLevel('g', 'u').xp, 100);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].content, '🎉 GG <@u>, you just reached **level 1**!\n🏷️ You unlocked <@&promo>!');
  assert.deepEqual(sent[0].allowedMentions, { users: ['u'] });
  assert.ok(roles.has('promo'));
  store.close();
});

test('level-up messages can be turned off', async () => {
  const { store, sent, levels, message } = harness();
  store.setMeta('levels:announce:g', 'off');
  for (let i = 0; i < 4; i += 1) await levels.onMessage(message(i * XP_COOLDOWN_MS + 1));
  assert.equal(levelFromXp(store.getLevel('g', 'u').xp).level, 1);
  assert.equal(sent.length, 0);
  store.close();
});
