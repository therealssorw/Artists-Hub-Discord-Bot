import assert from 'node:assert/strict';
import { test } from 'node:test';

import { StatsStore } from '../src/db.js';
import { ordinal, reachedMilestones, renderMilestoneCard } from '../src/milestone.js';

test('ordinal suffixes', () => {
  assert.deepEqual([1, 2, 3, 4, 11, 12, 13, 21, 100, 101, 111, 1000].map(ordinal), [
    '1st', '2nd', '3rd', '4th', '11th', '12th', '13th', '21st', '100th', '101st', '111th', '1000th',
  ]);
});

test('reachedMilestones skips unreached and already announced milestones', () => {
  const announced = new Set([100]);
  const isAnnounced = (m) => announced.has(m);
  assert.deepEqual(reachedMilestones([100, 250, 500], 99, () => false), []);
  assert.deepEqual(reachedMilestones([100, 250, 500], 100, () => false), [100]);
  assert.deepEqual(reachedMilestones([100, 250, 500], 300, isAnnounced), [250]);
  assert.deepEqual(reachedMilestones([100], 140, isAnnounced), []);
});

test('renderMilestoneCard produces a PNG', () => {
  const png = renderMilestoneCard({
    guildName: 'Artists Hub',
    milestone: 100,
    count: 101,
    reachedAt: new Date('2026-10-09T22:00:00Z'),
    timezone: 'America/New_York',
    featured: { name: 'sketchy_sam', avatar: null, label: 'Newest member' },
    recent: [{ name: 'ava', avatar: null }],
  });
  assert.deepEqual([...png.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
  assert.equal(png.readUInt32BE(16), 1200); // width from the IHDR chunk
  assert.equal(png.readUInt32BE(20), 675);
});

test('store meta get, set and delete', () => {
  const store = new StatsStore(':memory:');
  assert.equal(store.getMeta('milestone:g:100'), null);
  store.setMeta('milestone:g:100', 'yes');
  assert.equal(store.getMeta('milestone:g:100'), 'yes');
  store.deleteMeta('milestone:g:100');
  assert.equal(store.getMeta('milestone:g:100'), null);
  store.close();
});
