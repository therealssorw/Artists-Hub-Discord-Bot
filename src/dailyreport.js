/**
 * /stats and the daily stats report, per server.
 *
 *   /stats show [day]                         today so far, or yesterday
 *   /stats reminder set channel:#chat time:9pm
 *   /stats reminder status | disable
 *
 * Each server picks its own channel and time (in TIMEZONE). A report sent in
 * the morning (before noon) covers the previous full day; one sent from noon
 * on covers the current day so far. A report missed while the bot was offline
 * is posted when it comes back, as long as it is still the same day.
 */
import { ChannelType, MessageFlags, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';

import { config } from './config.js';
import { buildReportEmbed } from './report.js';
import { computeStats } from './stats.js';
import { formatDayKey, shiftDay, todayKey } from './time.js';
import { wallParts, zonedTime } from './when.js';

const TICK_MS = 30 * 1000;
/** After a failed post, wait this long before trying that report again. */
const RETRY_MS = 10 * 60 * 1000;

export const statsCommand = new SlashCommandBuilder()
  .setName('stats')
  .setDescription('Server activity stats and the daily stats report.')
  .setDMPermission(false)
  .addSubcommand((sub) =>
    sub
      .setName('show')
      .setDescription('Show message activity stats for this server.')
      .addStringOption((opt) =>
        opt
          .setName('day')
          .setDescription('Which day to report on (default: today so far)')
          .addChoices({ name: 'Today (so far)', value: 'today' }, { name: 'Yesterday', value: 'yesterday' }),
      ),
  )
  .addSubcommandGroup((group) =>
    group
      .setName('reminder')
      .setDescription('The daily stats report for this server (needs Manage Server).')
      .addSubcommand((sub) =>
        sub
          .setName('set')
          .setDescription('Post the daily stats report in a channel at a set time.')
          .addChannelOption((opt) =>
            opt
              .setName('channel')
              .setDescription('Channel for the report')
              .setRequired(true)
              .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
          )
          .addStringOption((opt) =>
            opt
              .setName('time')
              .setDescription('Time of day, Eastern time: midnight, 9am, 9pm, 21:30…')
              .setRequired(true)
              .setMaxLength(20),
          ),
      )
      .addSubcommand((sub) => sub.setName('status').setDescription('Show where and when the report is posted.'))
      .addSubcommand((sub) => sub.setName('disable').setDescription('Stop the daily report for this server.')),
  );

/** "9pm", "9:30 PM", "21:30", "noon", "midnight" -> "HH:MM", or null. */
export function parseReportTime(input) {
  const s = String(input ?? '').trim().toLowerCase().replace(/\s+/g, ' ').replace(/^at /, '');
  if (s === 'midnight') return '00:00';
  if (s === 'noon' || s === 'midday') return '12:00';
  const m = s.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.|a|p)?$/);
  if (!m) return null;
  let hour = Number(m[1]);
  const minute = m[2] ? Number(m[2]) : 0;
  if (minute > 59) return null;
  if (m[3]) {
    if (hour < 1 || hour > 12) return null;
    hour %= 12;
    if (m[3].startsWith('p')) hour += 12;
  } else if (hour > 23) {
    return null;
  }
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

/** "21:30" -> "9:30 PM" */
export function formatReportTime(time) {
  const [h, m] = time.split(':').map(Number);
  if (h === 0 && m === 0) return 'midnight';
  if (h === 12 && m === 0) return 'noon';
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}

/**
 * For a report set for `time`, at `now`: which day it covers, whether that
 * day is still in progress, whether it is due, and when it next goes out.
 */
export function reportPlan(time, now, timezone) {
  const [hour, minute] = time.split(':').map(Number);
  const p = wallParts(now, timezone);
  const today = todayKey(timezone, now);
  const morning = hour < 12;
  const due = p.hour * 60 + p.minute >= hour * 60 + minute;
  return {
    day: morning ? shiftDay(today, -1) : today,
    partial: !morning,
    due,
    nextAt: zonedTime(p.year, p.month, p.day + (due ? 1 : 0), hour, minute, 0, timezone),
  };
}

/**
 * Data from before servers were tracked separately belongs to the server the
 * bot was first set up for (the one with STATS_CHANNEL_ID). Assign it there,
 * and carry the old midnight report over as that server's setting, once.
 */
export async function claimLegacyStats(client, store) {
  const settingsDone = store.getMeta('stats:legacy_settings_done');
  if (!store.hasLegacyStats() && settingsDone) return;
  const channel = await client.channels.fetch(config.statsChannelId).catch(() => null);
  const guildId = channel?.guildId ?? config.guildId;
  if (!guildId) {
    console.warn(`Could not find stats channel ${config.statsChannelId}; old stats stay unassigned for now.`);
    return;
  }
  if (store.hasLegacyStats()) {
    store.claimLegacyStats(guildId);
    console.log(`Assigned stats recorded before multi-server support to guild ${guildId}.`);
  }
  if (!settingsDone) {
    if (channel && !store.getStatsSettings(guildId)) store.setStatsSettings(guildId, channel.id, '00:00');
    store.setMeta('stats:legacy_settings_done', new Date().toISOString());
  }
}

export function setupDailyReports(client, store) {
  let timer = null;
  let running = false;
  /** guildId -> time of the last failed post */
  const failedAt = new Map();

  function title(day, partial) {
    return partial ? `📊 Stats — Today so far (${formatDayKey(day)})` : undefined;
  }

  async function post(setting, plan) {
    const channel = await client.channels.fetch(setting.channelId);
    if (!channel?.isTextBased() || channel.guildId !== setting.guildId) {
      throw new Error(`Stats channel ${setting.channelId} is not a text channel in guild ${setting.guildId}.`);
    }
    const stats = computeStats(store, setting.guildId, plan.day, config.windowDays);
    await channel.send({ embeds: [buildReportEmbed(stats, { partial: plan.partial, title: title(plan.day, plan.partial) })] });
    store.markReported(setting.guildId, plan.day);
    console.log(`Posted the stats report for ${plan.day} in guild ${setting.guildId}.`);
  }

  async function tick() {
    if (running) return;
    running = true;
    try {
      const now = Date.now();
      for (const setting of store.getAllStatsSettings()) {
        if (config.guildId && setting.guildId !== config.guildId) continue;
        const plan = reportPlan(setting.time, now, config.timezone);
        if (!plan.due || store.wasReported(setting.guildId, plan.day)) continue;
        if (now - (failedAt.get(setting.guildId) ?? 0) < RETRY_MS) continue;
        const since = store.getTrackingSince(setting.guildId) ?? store.getFirstDay(setting.guildId);
        if (!since || since > plan.day) {
          store.markReported(setting.guildId, plan.day); // nothing tracked for that day yet
          continue;
        }
        try {
          await post(setting, plan);
          failedAt.delete(setting.guildId);
        } catch (error) {
          failedAt.set(setting.guildId, now);
          console.error(`Failed to post the stats report for guild ${setting.guildId}:`, error);
        }
      }
    } finally {
      running = false;
    }
  }

  function start() {
    stop();
    tick();
    timer = setInterval(tick, TICK_MS);
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  async function onShow(interaction) {
    const choice = interaction.options.getString('day') ?? 'today';
    const today = todayKey(config.timezone);
    const day = choice === 'yesterday' ? shiftDay(today, -1) : today;
    const stats = computeStats(store, interaction.guildId, day, config.windowDays);
    const embed = buildReportEmbed(stats, {
      partial: choice === 'today',
      title: choice === 'today' ? '📊 Stats — Today so far' : undefined,
    });
    return interaction.reply({ embeds: [embed] });
  }

  function describe(setting) {
    const plan = reportPlan(setting.time, Date.now(), config.timezone);
    const covers = plan.partial ? 'that day so far' : 'the previous full day';
    return (
      `Daily stats go to <#${setting.channelId}> at **${formatReportTime(setting.time)}** (${config.timezone}), ` +
      `covering ${covers}. Next report <t:${Math.floor(plan.nextAt / 1000)}:R>.`
    );
  }

  async function onReminder(interaction, sub) {
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      return interaction.reply({ content: '⚠️ You need **Manage Server** to change the daily report.', flags: MessageFlags.Ephemeral });
    }
    const guildId = interaction.guildId;

    if (sub === 'status') {
      const setting = store.getStatsSettings(guildId);
      const content = setting
        ? describe(setting)
        : 'No daily report is set for this server. Use `/stats reminder set channel:#chat time:9pm`.';
      return interaction.reply({ content, flags: MessageFlags.Ephemeral });
    }

    if (sub === 'disable') {
      store.clearStatsSettings(guildId);
      return interaction.reply({ content: '🛑 Daily stats report turned off for this server.', flags: MessageFlags.Ephemeral });
    }

    // set
    const time = parseReportTime(interaction.options.getString('time', true));
    if (!time) {
      return interaction.reply({
        content: '⚠️ I couldn’t read that time. Try `midnight`, `9am`, `9:30pm` or `21:30`.',
        flags: MessageFlags.Ephemeral,
      });
    }
    const picked = interaction.options.getChannel('channel', true);
    const channel = await client.channels.fetch(picked.id).catch(() => null);
    const perms = channel?.permissionsFor(interaction.guild.members.me);
    if (!channel?.isTextBased() || !perms?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks])) {
      return interaction.reply({
        content: `⚠️ I need **View Channel**, **Send Messages** and **Embed Links** in ${picked}.`,
        flags: MessageFlags.Ephemeral,
      });
    }

    store.setStatsSettings(guildId, channel.id, time);
    store.setTrackingSinceIfUnset(guildId, todayKey(config.timezone));
    // Start from the next scheduled time rather than posting straight away.
    const plan = reportPlan(time, Date.now(), config.timezone);
    if (plan.due) store.markReported(guildId, plan.day);
    return interaction.reply({ content: `✅ ${describe(store.getStatsSettings(guildId))}` });
  }

  async function onCommand(interaction) {
    if (interaction.options.getSubcommandGroup(false) === 'reminder') {
      return onReminder(interaction, interaction.options.getSubcommand());
    }
    return onShow(interaction);
  }

  return { start, stop, onCommand };
}
