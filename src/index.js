import {
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
  SlashCommandBuilder,
} from 'discord.js';
import cron from 'node-cron';

import { config } from './config.js';
import { StatsStore } from './db.js';
import { buildReportEmbed } from './report.js';
import { computeStats } from './stats.js';
import { dayKey, shiftDay, todayKey } from './time.js';

const store = new StatsStore(config.databasePath);

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
});

const statsCommand = new SlashCommandBuilder()
  .setName('stats')
  .setDescription('Show message activity stats for the server.')
  .addStringOption((option) =>
    option
      .setName('day')
      .setDescription('Which day to report on (default: today so far)')
      .addChoices(
        { name: 'Today (so far)', value: 'today' },
        { name: 'Yesterday', value: 'yesterday' },
      ),
  );

/** Should this message be counted? */
function shouldCount(message) {
  if (!message.inGuild()) return false;
  if (message.author?.bot) return false;
  if (message.system) return false;
  if (config.guildId && message.guildId !== config.guildId) return false;
  return true;
}

async function registerCommands() {
  const commands = [statsCommand.toJSON()];
  if (config.guildId) {
    const guild = await client.guilds.fetch(config.guildId);
    await guild.commands.set(commands);
    console.log(`Registered /stats in guild ${guild.name} (${guild.id}).`);
  } else {
    await client.application.commands.set(commands);
    console.log('Registered /stats globally (may take up to an hour to appear).');
  }
}

/** Post the report for `day` to the configured stats channel. */
async function postDailyReport(day) {
  const channel = await client.channels.fetch(config.statsChannelId);
  if (!channel || !channel.isTextBased() || channel.type === ChannelType.DM) {
    throw new Error(`Stats channel ${config.statsChannelId} is not a text channel I can see.`);
  }

  const stats = computeStats(store, day, config.windowDays);
  await channel.send({ embeds: [buildReportEmbed(stats)] });
  store.markReported(day);
  console.log(`Posted daily report for ${day} to #${channel.name ?? channel.id}.`);
}

/**
 * If the bot was offline at midnight, post yesterday's report on startup so a
 * day is never silently skipped.
 */
async function catchUpMissedReport() {
  const yesterday = shiftDay(todayKey(config.timezone), -1);
  const trackingSince = store.getTrackingSince();
  if (!trackingSince || trackingSince > yesterday) return;
  if (store.wasReported(yesterday)) return;

  console.log(`Report for ${yesterday} was never posted; posting it now.`);
  try {
    await postDailyReport(yesterday);
  } catch (error) {
    console.error('Failed to post catch-up report:', error);
  }
}

client.once(Events.ClientReady, async (readyClient) => {
  console.log(`Logged in as ${readyClient.user.tag}.`);
  store.setTrackingSinceIfUnset(todayKey(config.timezone));

  try {
    await registerCommands();
  } catch (error) {
    console.error('Failed to register slash commands:', error);
  }

  // 12:00 AM every day in the configured timezone (America/New_York by default).
  cron.schedule(
    '0 0 * * *',
    async () => {
      // Report on the day that just ended, not the new day that just began.
      const day = shiftDay(todayKey(config.timezone), -1);
      try {
        await postDailyReport(day);
      } catch (error) {
        console.error(`Failed to post daily report for ${day}:`, error);
      }
    },
    { timezone: config.timezone },
  );
  console.log(`Daily report scheduled for 00:00 ${config.timezone} in channel ${config.statsChannelId}.`);

  await catchUpMissedReport();
});

client.on(Events.MessageCreate, (message) => {
  if (!shouldCount(message)) return;
  try {
    store.recordMessage(dayKey(message.createdAt, config.timezone), message.author.id);
  } catch (error) {
    console.error('Failed to record message:', error);
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand() || interaction.commandName !== 'stats') return;

  const choice = interaction.options.getString('day') ?? 'today';
  const today = todayKey(config.timezone);
  const day = choice === 'yesterday' ? shiftDay(today, -1) : today;

  try {
    const stats = computeStats(store, day, config.windowDays);
    const embed = buildReportEmbed(stats, {
      partial: choice === 'today',
      title: choice === 'today' ? '📊 Stats — Today so far' : undefined,
    });
    await interaction.reply({ embeds: [embed] });
  } catch (error) {
    console.error('Failed to handle /stats:', error);
    const payload = {
      content: 'Sorry, I could not compute the stats right now.',
      flags: MessageFlags.Ephemeral,
    };
    if (interaction.deferred || interaction.replied) await interaction.followUp(payload);
    else await interaction.reply(payload);
  }
});

client.on(Events.Error, (error) => console.error('Discord client error:', error));

function shutdown(signal) {
  console.log(`Received ${signal}, shutting down.`);
  client.destroy();
  store.close();
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

client.login(config.token).catch((error) => {
  console.error('Failed to log in:', error);
  process.exit(1);
});
