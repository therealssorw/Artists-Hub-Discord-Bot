import assert from 'node:assert/strict';
import { test } from 'node:test';

import { PermissionsBitField } from 'discord.js';

import { StatsStore } from '../src/db.js';
import { blockedLinks, findLinks, isGifLink, setupLinkGate, warningText } from '../src/links.js';

test('findLinks picks up URLs, www links and invites', () => {
  assert.deepEqual(findLinks('see https://example.com/a?b=1, and www.foo.org.'), [
    'https://example.com/a?b=1',
    'www.foo.org',
  ]);
  assert.deepEqual(findLinks('join discord.gg/abc123 now'), ['discord.gg/abc123']);
  assert.deepEqual(findLinks('[click](https://evil.example/x)'), ['https://evil.example/x']);
  assert.deepEqual(findLinks('no links here, just art.'), []);
});

test('GIF links are allowed', () => {
  for (const link of [
    'https://tenor.com/view/cat-dance-gif-123',
    'https://media.tenor.com/abc/cat.gif',
    'https://giphy.com/gifs/happy-xyz',
    'https://media1.giphy.com/media/xyz/giphy.gif',
    'https://klipy.com/gifs/wave',
    'https://cdn.discordapp.com/attachments/1/2/funny.gif?ex=1',
    'https://i.imgur.com/abc.gifv',
  ]) {
    assert.equal(isGifLink(link), true, link);
  }
  for (const link of ['https://example.com', 'https://notgiphy.com.evil.io/x', 'https://youtube.com/watch?v=gif']) {
    assert.equal(isGifLink(link), false, link);
  }
});

test('blockedLinks ignores GIFs but not other links in the same message', () => {
  assert.deepEqual(blockedLinks('lol https://tenor.com/view/x'), []);
  assert.deepEqual(blockedLinks('lol https://tenor.com/view/x https://shop.example'), ['https://shop.example']);
});

test('warningText says how many messages are left', () => {
  assert.match(warningText('42', 12, 50), /<@42>.*50 messages.*You're at 12, just 38 more/s);
});

function fakeMessage({ content, count, perms = 0n, store }) {
  const sent = [];
  const message = {
    content,
    author: { id: 'u1', tag: 'u1#0', bot: false },
    system: false,
    member: { permissions: new PermissionsBitField(perms), roles: { cache: new Map() } },
    inGuild: () => true,
    deleted: false,
    delete: async () => {
      message.deleted = true;
    },
    channel: { send: async (m) => (sent.push(m), { delete: async () => {} }) },
    sent,
  };
  store.recordMessage('2026-10-01', 'u1', count);
  return message;
}

test('the gate removes links from new members and warns them', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const store = new StatsStore(':memory:');
  const gate = setupLinkGate(store);

  const newbie = fakeMessage({ content: 'my shop https://shop.example', count: 10, store });
  assert.equal(await gate.check(newbie), true);
  assert.equal(newbie.deleted, true);
  assert.match(newbie.sent[0].content, /You're at 10, just 40 more/);
  assert.deepEqual(newbie.sent[0].allowedMentions, { users: ['u1'] });

  const gif = fakeMessage({ content: 'https://tenor.com/view/yay', count: 0, store });
  assert.equal(await gate.check(gif), false);
  assert.equal(gif.deleted, false);

  const mod = fakeMessage({ content: 'https://rules.example', count: 0, perms: PermissionsBitField.Flags.ManageMessages, store });
  assert.equal(await gate.check(mod), false);

  const regular = fakeMessage({ content: 'https://portfolio.example', count: 40, store }); // 10 + 0 + 0 + 40 = 50
  assert.equal(store.getUserMessageCount('u1'), 50);
  assert.equal(await gate.check(regular), false);
  store.close();
});
