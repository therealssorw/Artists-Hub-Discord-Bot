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
  /** Number of days in the rolling window used for averages and growth. */
  windowDays: 30,
};
