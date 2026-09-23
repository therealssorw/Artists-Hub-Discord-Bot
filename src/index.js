import {
  ChannelType,
  Client,
  Events,
  GatewayCloseCodes,
  GatewayIntentBits,
  MessageFlags,
  SlashCommandBuilder,
} from 'discord.js';
import cron from 'node-cron';

import { bumpReminderCommand, setupBumpReminders } from './bump.js';
import { config } from './config.js';
import { StatsStore } from './db.js';
import { buildReportEmbed } from './report.js';
import { computeStats } from './stats.js';
import { dayKey, shiftDay, todayKey } from './time.js';

const store = new StatsStore(config.databasePath);

/**
 * Message Content is a privileged intent (toggle it on under Bot in the
 * Developer Portal). It lets us read Disboard's "Bump done!" embed so failed
 * bumps are ignored. If it is not enabled, Discord closes the connection with
 * code 4014 and we reconnect without it; bump detection then treats every
 * /bump reply as a success.
 */
const baseIntents = [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages];
let client;
let bumps;

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
  const commands = [statsCommand.toJSON(), bumpReminderCommand.toJSON()];
  if (config.guildId) {
    const guild = await client.guilds.fetch(config.guildId);
    await guild.commands.set(commands);
    console.log(`Registered /stats and /bumpreminder in guild ${guild.name} (${guild.id}).`);
  } else {
    await client.application.commands.set(commands);
    console.log('Registered /stats and /bumpreminder globally (may take up to an hour to appear).');
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

function createClient(intents) {
  const c = new Client({ intents });
  bumps = setupBumpReminders(c, store);
  registerHandlers(c);
  return c;
}

function registerHandlers(c) {
  c.once(Events.ClientReady, async (readyClient) => {
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

    bumps.restore();
    await catchUpMissedReport();
  });

  c.on(Events.MessageCreate, (message) => {
    try {
      bumps.onMessage(message);
    } catch (error) {
      console.error('Failed to handle bump message:', error);
    }
    if (!shouldCount(message)) return;
    try {
      store.recordMessage(dayKey(message.createdAt, config.timezone), message.author.id);
    } catch (error) {
      console.error('Failed to record message:', error);
    }
  });

  c.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    if (interaction.commandName === 'bumpreminder') {
      try {
        await bumps.onCommand(interaction);
      } catch (error) {
        console.error('Failed to handle /bumpreminder:', error);
      }
      return;
    }

    if (interaction.commandName !== 'stats') return;

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

  c.on(Events.ShardDisconnect, (event) => {
    if (event.code !== GatewayCloseCodes.DisallowedIntents) return;
    if (!c.options.intents.has(GatewayIntentBits.MessageContent)) {
      console.error('Discord rejected the gateway intents; cannot continue.');
      process.exit(1);
    }
    console.warn(
      'Message Content intent is not enabled for this bot in the Discord Developer Portal. ' +
        'Reconnecting without it; bump reminders will trigger on every /bump reply, including failed ones. ' +
        'Enable it under Bot -> Privileged Gateway Intents for exact detection.',
    );
    c.destroy();
    client = createClient(baseIntents);
    client.login(config.token).catch((error) => {
      console.error('Failed to log in without Message Content intent:', error);
      process.exit(1);
    });
  });

  c.on(Events.Error, (error) => console.error('Discord client error:', error));
}

function shutdown(signal) {
  console.log(`Received ${signal}, shutting down.`);
  client.destroy();
  store.close();
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

client = createClient([...baseIntents, GatewayIntentBits.MessageContent]);
client.login(config.token).catch((error) => {
  console.error('Failed to log in:', error);
  process.exit(1);
});
