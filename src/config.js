import 'dotenv/config';

function required(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable ${name}. See .env.example.`);
  }
  return value;
}

export const config = {
  get token() {
    return required('DISCORD_TOKEN');
  },
  statsChannelId: process.env.STATS_CHANNEL_ID || '1548706786893238322',
  guildId: process.env.GUILD_ID || null,
  databasePath: process.env.DATABASE_PATH || './data/stats.db',
  timezone: process.env.TIMEZONE || 'America/New_York',
  /** Dungeon Delve's room server, polled for characters setting out. */
  dungeonApi: (process.env.DUNGEON_API || 'https://ssorw.com').replace(/\/$/, ''),
  dungeonSecret: process.env.DUNGEON_SECRET || null,
  dungeonChannelId: process.env.DUNGEON_CHANNEL_ID || '1555979173917499432',
  dungeonPollMs: Number(process.env.DUNGEON_POLL_MS) || 15000,
  /** Member counts that trigger a milestone snapshot, smallest first. */
  milestones: (process.env.MILESTONES || '100')
    .split(',')
    .map((n) => Number(n.trim()))
    .filter((n) => Number.isInteger(n) && n > 0)
    .sort((a, b) => a - b),
  /** Where milestone snapshots go (default: the stats channel). */
  get milestoneChannelId() {
    return process.env.MILESTONE_CHANNEL_ID || this.statsChannelId;
  },
  /** Who to ping at a milestone (default: the server owner). */
  milestoneUserId: process.env.MILESTONE_USER_ID || null,
  /** Number of days in the rolling window used for averages and growth. */
  windowDays: 30,
};
