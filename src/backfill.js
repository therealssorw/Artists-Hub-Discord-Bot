/**
 * One-off script that rebuilds message counts from channel history so the
 * 30-day averages and growth are meaningful immediately after deploying the
 * bot, instead of after two months of live tracking.
 *
 *   npm run backfill            # last 60 days (two 30-day windows)
 *   npm run backfill -- 90      # last 90 days
 *
 * Every day in the range is overwritten with what is found in history, so it
 * is safe to run more than once. Threads (active and archived public) are
 * included. Messages from bots are ignored, matching live tracking.
 */
import { ChannelType, Client, GatewayIntentBits } from 'discord.js';

import { config } from './config.js';
import { StatsStore } from './db.js';
import { dayKey, shiftDay, todayKey } from './time.js';

const days = Number(process.argv[2]) || config.windowDays * 2;
const today = todayKey(config.timezone);
const fromDay = shiftDay(today, -(days - 1));
const cutoffMs = Date.now() - days * 86_400_000 - 86_400_000; // one extra day of slack for tz offset

const store = new StatsStore(config.databasePath);
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers] });

/** counts[day][userId] = number of messages */
const counts = {};
/** joins[day] = [{ guildId, userId, ts }] from each current member's join date */
const joins = {};
for (let d = fromDay; d <= today; d = shiftDay(d, 1)) {
  counts[d] = {};
  joins[d] = [];
}

let scanned = 0;

async function scanChannel(channel) {
  let before;
  for (;;) {
    let batch;
    try {
      batch = await channel.messages.fetch({ limit: 100, before });
    } catch (error) {
      console.warn(`  Skipping #${channel.name}: ${error.message}`);
      return;
    }
    if (batch.size === 0) return;

    for (const message of batch.values()) {
      if (message.createdTimestamp < cutoffMs) return;
      scanned += 1;
      if (message.author.bot || message.system) continue;
      const day = dayKey(message.createdAt, config.timezone);
      if (!counts[day]) continue;
      counts[day][message.author.id] = (counts[day][message.author.id] ?? 0) + 1;
    }

    const oldest = batch.last();
    if (oldest.createdTimestamp < cutoffMs) return;
    before = oldest.id;
  }
}

async function scanMembers(guild) {
  let members;
  try {
    members = await guild.members.fetch();
  } catch (error) {
    console.warn(`  Could not list members (enable the Server Members intent to backfill joins): ${error.message}`);
    return;
  }
  let found = 0;
  for (const member of members.values()) {
    if (member.user.bot || !member.joinedAt) continue;
    const day = dayKey(member.joinedAt, config.timezone);
    if (!joins[day]) continue;
    joins[day].push({ guildId: guild.id, userId: member.id, ts: member.joinedTimestamp });
    found += 1;
  }
  console.log(`  ${found} member join(s) in range (members who have since left are not visible).`);
}

async function scanGuild(guild) {
  console.log(`Scanning ${guild.name} (${guild.id})...`);
  await scanMembers(guild);
  const channels = await guild.channels.fetch();
  const me = await guild.members.fetchMe();

  for (const channel of channels.values()) {
    if (!channel) continue;
    if (![ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildForum, ChannelType.GuildVoice].includes(channel.type)) continue;
    const perms = channel.permissionsFor(me);
    if (!perms?.has(['ViewChannel', 'ReadMessageHistory'])) continue;

    if (channel.type !== ChannelType.GuildForum) {
      console.log(`  #${channel.name}`);
      await scanChannel(channel);
    }

    if (channel.threads) {
      const threads = [];
      try {
        threads.push(...(await channel.threads.fetchActive()).threads.values());
        threads.push(...(await channel.threads.fetchArchived({ type: 'public' })).threads.values());
      } catch (error) {
        console.warn(`  Could not list threads in #${channel.name}: ${error.message}`);
      }
      for (const thread of threads) {
        // Skip threads whose last activity is older than the range.
        if (thread.archiveTimestamp && thread.archiveTimestamp < cutoffMs) continue;
        console.log(`    🧵 ${thread.name}`);
        await scanChannel(thread);
      }
    }
  }
}

client.once('clientReady', async () => {
  console.log(`Logged in as ${client.user.tag}. Backfilling ${days} days (${fromDay} → ${today}).`);
  try {
    const guilds = config.guildId
      ? [await client.guilds.fetch(config.guildId)]
      : [...(await client.guilds.fetch()).values()].map((g) => client.guilds.fetch(g.id));

    for (const guild of await Promise.all(guilds)) {
      await scanGuild(guild);
    }

    for (const [day, byUser] of Object.entries(counts)) {
      store.replaceDay(day, byUser);
    }
    for (const [day, list] of Object.entries(joins)) {
      if (list.length) store.replaceJoins(day, list);
    }
    const existing = store.getTrackingSince();
    if (!existing || existing > fromDay) {
      store.stmts.setMeta.run('tracking_since', fromDay);
    }

    const totalMessages = Object.values(counts).reduce(
      (sum, byUser) => sum + Object.values(byUser).reduce((s, c) => s + c, 0),
      0,
    );
    console.log(`Done. Scanned ${scanned} messages; stored ${totalMessages} user messages across ${days} days.`);
  } catch (error) {
    console.error('Backfill failed:', error);
    process.exitCode = 1;
  } finally {
    store.close();
    client.destroy();
  }
});

client.login(config.token);
