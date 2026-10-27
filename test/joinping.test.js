import assert from 'node:assert/strict';
import { test } from 'node:test';

import { StatsStore } from '../src/db.js';
import { joinPingCommand, joinPingText, setupJoinPings } from '../src/joinping.js';

const DAY = 24 * 60 * 60 * 1000;
const now = 1_800_000_000_000;
const member = (ageMs, bot = false) => ({
  user: { username: 'sketchy_sam', bot, createdTimestamp: now - ageMs },
  guild: { id: 'g', memberCount: 101 },
  toString: () => '<@42>',
});

test('joinPingText pings the role and flags new accounts', () => {
  joinPingCommand.toJSON();
  const old = joinPingText(member(400 * DAY), 'owner', now);
  assert.match(old, /^<@&owner> 👋 <@42> \(\*\*sketchy_sam\*\*\) just joined, our 101st member!/);
  assert.doesNotMatch(old, /New account/);
  assert.match(joinPingText(member(2 * DAY), 'owner', now), /⚠️ \*\*New account\*\* \(2 days old\)/);
});

test('joins ping the configured role, but not for bots or when off', async () => {
  const store = new StatsStore(':memory:');
  const sent = [];
  const channel = { isTextBased: () => true, send: async (m) => sent.push(m) };
  const pings = setupJoinPings({ channels: { fetch: async () => channel } }, store);

  await pings.onMemberAdd(member(DAY * 400));
  assert.equal(sent.length, 0); // not set up

  store.setMeta('joinping:g', JSON.stringify({ roleId: 'owner', channelId: 'c' }));
  await pings.onMemberAdd(member(DAY * 400, true));
  assert.equal(sent.length, 0); // bots are skipped
  await pings.onMemberAdd(member(DAY * 400));
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].allowedMentions, { roles: ['owner'] });
  store.close();
});
