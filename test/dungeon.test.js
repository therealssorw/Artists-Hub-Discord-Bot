import assert from 'node:assert/strict';
import { test } from 'node:test';

import { escapeName, formatArrival, setupDungeonArrivals } from '../src/dungeon.js';

test('names are escaped for Discord markdown', () => {
  assert.equal(escapeName('oto_toxic'), 'oto\\_toxic');
  assert.equal(escapeName('plain name'), 'plain name');
});

test('an arrival line names the character and the crowd', () => {
  assert.equal(formatArrival({ name: 'Ototoxic', here: 1 }), '**Ototoxic** set out into the dungeon');
  assert.equal(formatArrival({ name: 'Ototoxic', here: 3 }), '**Ototoxic** set out into the dungeon · 3 adventuring now');
});

test('a line written by the server is posted as it is', () => {
  assert.equal(formatArrival({ name: 'x', here: 1, text: '**Ototoxic** set out into the dungeon · 2 adventuring now' }), '**Ototoxic** set out into the dungeon · 2 adventuring now');
});

test('polling announces each arrival since the last check', async () => {
  const sent = [];
  const channel = { isTextBased: () => true, type: 0, send: async (m) => sent.push(m.content) };
  const client = { channels: { fetch: async () => channel } };
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    const body = calls.length === 1
      ? { now: 1000, arrivals: [{ name: 'Ototoxic', here: 2, at: 900 }] }
      : { now: 2000, arrivals: [] };
    return { ok: true, json: async () => body };
  };
  const watcher = setupDungeonArrivals(client, { fetchImpl });
  await watcher.poll();
  await watcher.poll();
  assert.deepEqual(sent, ['**Ototoxic** set out into the dungeon · 2 adventuring now']);
  assert.match(calls[1], /since=1000$/);
});
