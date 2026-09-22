import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DISBOARD_BOT_ID, isBumpDone } from '../src/bump.js';
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
