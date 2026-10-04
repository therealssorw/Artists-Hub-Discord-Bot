/**
 * Dungeon Delve arrivals.
 *
 * The game's room server (theroom/worker) keeps a short log of characters
 * who set out into the dungeon. The bot polls it and announces each one in
 * the dungeon channel, so the server never needs a way in to the bot.
 */
import { ChannelType } from 'discord.js';

import { config } from './config.js';

/** Escape the bits of a name Discord would read as markdown. */
export function escapeName(name) {
  return String(name).replace(/[_*~`|\\]/g, '\\$&');
}

/** The line posted for one arrival. */
export function formatArrival({ name, here }) {
  const who = `**${escapeName(name)}** set out into the dungeon`;
  return here > 1 ? `${who} · ${here} adventuring now` : who;
}

export function setupDungeonArrivals(client, { fetchImpl = fetch } = {}) {
  let since = Date.now();
  let timer = null;
  let busy = false;

  async function fetchArrivals() {
    const url = `${config.dungeonApi}/api/arrivals?since=${since}`;
    const headers = config.dungeonSecret ? { authorization: `Bearer ${config.dungeonSecret}` } : {};
    const res = await fetchImpl(url, { headers });
    if (!res.ok) throw new Error(`${url} answered ${res.status}`);
    const data = await res.json();
    if (Number.isFinite(data.now)) since = data.now;
    return Array.isArray(data.arrivals) ? data.arrivals : [];
  }

  async function announce(arrivals) {
    if (!arrivals.length) return;
    const channel = await client.channels.fetch(config.dungeonChannelId);
    if (!channel || !channel.isTextBased() || channel.type === ChannelType.DM) {
      throw new Error(`Dungeon channel ${config.dungeonChannelId} is not a text channel I can see.`);
    }
    for (const arrival of arrivals) {
      await channel.send({ content: formatArrival(arrival), allowedMentions: { parse: [] } });
      console.log(`Announced ${arrival.name} setting out into the dungeon.`);
    }
  }

  async function poll() {
    if (busy) return;
    busy = true;
    try {
      await announce(await fetchArrivals());
    } catch (error) {
      console.error('Failed to check dungeon arrivals:', error.message ?? error);
    } finally {
      busy = false;
    }
  }

  return {
    start() {
      if (timer) return;
      timer = setInterval(poll, config.dungeonPollMs);
      console.log(
        `Watching ${config.dungeonApi} for dungeon arrivals every ${config.dungeonPollMs / 1000}s, announcing in channel ${config.dungeonChannelId}.`,
      );
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
    poll,
  };
}
