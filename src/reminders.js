/**
 * /remind: post a message that pings people or roles at a chosen time.
 *
 *   /remind time:2h30m message:Art stream starts! ping:@Stream Viewers
 *   /remind time:fri 5pm message:Submit your pieces ping:@alice ping2:@bob repeat:weekly
 *   /reminders list
 *   /reminders cancel id:12
 *
 * Reminders are stored in SQLite, so a restart does not lose them; any that
 * came due while the bot was offline are sent (marked late) on startup.
 */
import { ChannelType, MessageFlags, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';

import { config } from './config.js';
import { EXAMPLES, REPEATS, describeWhen, nextOccurrence, parseWhen, wallParts } from './when.js';

const PING_OPTIONS = ['ping', 'ping2', 'ping3', 'ping4', 'ping5'];
export const MAX_MESSAGE_LENGTH = 1200;
const MAX_PINGS = 20;
const MAX_PENDING_PER_USER = 25;
/** setTimeout fires immediately for delays above ~24.8 days, so long waits are chained. */
const MAX_TIMEOUT_MS = 2 ** 31 - 1;
/** A reminder delivered more than this after its time says it is late. */
const LATE_AFTER_MS = 60 * 1000;
const POSTABLE_CHANNELS = [
  ChannelType.GuildText,
  ChannelType.GuildAnnouncement,
  ChannelType.PublicThread,
  ChannelType.PrivateThread,
  ChannelType.AnnouncementThread,
  ChannelType.GuildVoice,
];
const SUGGESTIONS = ['10m', '30m', '1h', '2h30m', 'tonight', 'tomorrow 9am', 'fri 5pm', '1w'];

export const remindCommand = new SlashCommandBuilder()
  .setName('remind')
  .setDescription('Post a reminder that pings people or roles at a set time.')
  .setDMPermission(false)
  .addStringOption((opt) =>
    opt
      .setName('time')
      .setDescription('When: 10m, 2h30m, 3d, 1w, 3pm, tomorrow 9am, fri 5pm, oct 12 3pm…')
      .setRequired(true)
      .setMaxLength(100)
      .setAutocomplete(true),
  )
  .addStringOption((opt) =>
    opt
      .setName('message')
      .setDescription('What to remind about (you can @mention people and roles in it too)')
      .setRequired(true)
      .setMaxLength(MAX_MESSAGE_LENGTH),
  )
  .addMentionableOption((opt) => opt.setName('ping').setDescription('Person or role to ping (default: you)'))
  .addMentionableOption((opt) => opt.setName('ping2').setDescription('Another person or role to ping'))
  .addMentionableOption((opt) => opt.setName('ping3').setDescription('Another person or role to ping'))
  .addMentionableOption((opt) => opt.setName('ping4').setDescription('Another person or role to ping'))
  .addMentionableOption((opt) => opt.setName('ping5').setDescription('Another person or role to ping'))
  .addChannelOption((opt) =>
    opt
      .setName('channel')
      .setDescription('Where to post it (default: this channel)')
      .addChannelTypes(...POSTABLE_CHANNELS),
  )
  .addStringOption((opt) =>
    opt
      .setName('repeat')
      .setDescription('Send it again on a schedule (default: once)')
      .addChoices(
        { name: 'Every hour', value: 'hourly' },
        { name: 'Every day', value: 'daily' },
        { name: 'Every weekday (Mon–Fri)', value: 'weekdays' },
        { name: 'Every week', value: 'weekly' },
      ),
  );

export const remindersCommand = new SlashCommandBuilder()
  .setName('reminders')
  .setDescription('List or cancel reminders made with /remind.')
  .setDMPermission(false)
  .addSubcommand((sub) =>
    sub.setName('list').setDescription('Show pending reminders (moderators see everyone’s).'),
  )
  .addSubcommand((sub) =>
    sub
      .setName('cancel')
      .setDescription('Cancel a reminder.')
      .addIntegerOption((opt) =>
        opt.setName('id').setDescription('Reminder number, from /reminders list').setRequired(true).setAutocomplete(true),
      ),
  );

/** User, role and @everyone/@here mentions written into a message. */
export function mentionsIn(text) {
  return {
    users: [...text.matchAll(/<@!?(\d+)>/g)].map((m) => m[1]),
    roles: [...text.matchAll(/<@&(\d+)>/g)].map((m) => m[1]),
    everyone: /@everyone/.test(text) ? 'everyone' : /@here/.test(text) ? 'here' : null,
  };
}

/** The message posted when a reminder goes off. */
export function buildReminderMessage(reminder, { now = Date.now(), nextAt = null } = {}) {
  const { pings } = reminder;
  const targets = [
    ...(pings.everyone ? [`@${pings.everyone}`] : []),
    ...pings.roles.map((id) => `<@&${id}>`),
    ...pings.users.map((id) => `<@${id}>`),
  ];
  const quoted = reminder.message
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');

  const notes = [`Set by <@${reminder.creatorId}>`];
  if (now - reminder.dueAt > LATE_AFTER_MS) {
    notes.push(`late: was due <t:${Math.floor(reminder.dueAt / 1000)}:f>, I was offline`);
  }
  if (reminder.repeat && nextAt) {
    notes.push(`repeats ${REPEATS[reminder.repeat]}, next <t:${Math.floor(nextAt / 1000)}:R>`);
  }
  notes.push(`#${reminder.id}`);

  return {
    content: `⏰ **Reminder** for ${targets.join(' ')}\n${quoted}\n-# ${notes.join(' · ')}`,
    allowedMentions: {
      users: pings.users,
      roles: pings.roles,
      parse: pings.everyone ? ['everyone'] : [],
    },
  };
}

function ephemeral(content) {
  return { content, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } };
}

function truncate(text, max) {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export function setupReminders(client, store) {
  /** reminder id -> timeout handle */
  const timers = new Map();

  function cancelTimer(id) {
    clearTimeout(timers.get(id));
    timers.delete(id);
  }

  function arm(reminder) {
    cancelTimer(reminder.id);
    const delay = Math.max(0, reminder.dueAt - Date.now());
    const handle =
      delay > MAX_TIMEOUT_MS
        ? setTimeout(() => {
            const current = store.getReminder(reminder.id);
            if (current) arm(current);
          }, MAX_TIMEOUT_MS)
        : setTimeout(() => fire(reminder.id), delay);
    timers.set(reminder.id, handle);
  }

  async function fire(id) {
    timers.delete(id);
    const reminder = store.getReminder(id);
    if (!reminder) return;
    const now = Date.now();

    let nextAt = null;
    if (reminder.repeat) {
      nextAt = nextOccurrence(reminder.dueAt, reminder.repeat, config.timezone);
      // After downtime, skip the occurrences that were missed rather than replaying them all.
      while (nextAt <= now) nextAt = nextOccurrence(nextAt, reminder.repeat, config.timezone);
      store.rescheduleReminder(id, nextAt);
      arm({ ...reminder, dueAt: nextAt });
    } else {
      store.deleteReminder(id);
    }

    try {
      const channel = await client.channels.fetch(reminder.channelId);
      if (!channel?.isTextBased()) throw new Error('channel is not text based');
      await channel.send(buildReminderMessage(reminder, { now, nextAt }));
      console.log(`Sent reminder #${id} in guild ${reminder.guildId}.`);
    } catch (error) {
      console.error(`Failed to send reminder #${id}:`, error);
      // The channel is gone or unusable; stop a repeating reminder from failing forever.
      if (reminder.repeat && (error.code === 10003 || error.code === 50001)) {
        cancelTimer(id);
        store.deleteReminder(id);
      }
    }
  }

  /** Re-arm reminders that were pending when the bot last stopped. */
  function restore() {
    const all = store.getAllReminders();
    for (const r of all) arm(r);
    if (all.length) console.log(`Restored ${all.length} pending reminder(s).`);
  }

  function stop() {
    for (const handle of timers.values()) clearTimeout(handle);
    timers.clear();
  }

  function isModerator(interaction) {
    return interaction.memberPermissions?.has(PermissionFlagsBits.ManageMessages) ?? false;
  }

  /**
   * Work out who a new reminder pings and check the creator is allowed to ping
   * them. Returns { pings } or { error }.
   */
  function resolvePings(interaction, channel, message) {
    const users = new Set();
    const roles = new Set();
    let everyone = null;

    for (const name of PING_OPTIONS) {
      const opt = interaction.options.get(name);
      if (opt?.role) {
        if (opt.role.id === interaction.guildId) everyone = 'everyone';
        else roles.add(opt.role.id);
      } else if (opt?.user) {
        users.add(opt.user.id);
      }
    }
    const written = mentionsIn(message);
    written.users.forEach((id) => users.add(id));
    written.roles.forEach((id) => roles.add(id));
    everyone ??= written.everyone;

    if (!users.size && !roles.size && !everyone) users.add(interaction.user.id);
    if (users.size + roles.size > MAX_PINGS) {
      return { error: `That's too many pings; a reminder can ping at most ${MAX_PINGS} people and roles.` };
    }

    const memberPerms = channel.permissionsFor(interaction.member);
    const botPerms = channel.permissionsFor(interaction.guild.members.me);
    const canMentionAll = memberPerms?.has(PermissionFlagsBits.MentionEveryone);
    const needsMentionAll = [];

    if (everyone) {
      if (!canMentionAll) return { error: `You don't have permission to ping @${everyone} in ${channel}.` };
      needsMentionAll.push(`@${everyone}`);
    }
    for (const id of roles) {
      const role = interaction.guild.roles.cache.get(id);
      if (!role) return { error: `I couldn't find the role <@&${id}>.` };
      if (role.mentionable) continue;
      if (!canMentionAll) return { error: `${role} can't be pinged by everyone, and you don't have permission to ping it.` };
      needsMentionAll.push(`${role}`);
    }
    if (needsMentionAll.length && !botPerms?.has(PermissionFlagsBits.MentionEveryone)) {
      return {
        error: `I need the **Mention @everyone, @here, and All Roles** permission in ${channel} to ping ${needsMentionAll.join(', ')}.`,
      };
    }

    return { pings: { users: [...users], roles: [...roles], everyone } };
  }

  async function onRemind(interaction) {
    const timeInput = interaction.options.getString('time', true);
    const message = interaction.options.getString('message', true).trim();
    const repeat = interaction.options.getString('repeat');
    const channelId = interaction.options.getChannel('channel')?.id ?? interaction.channelId;
    const channel = await client.channels.fetch(channelId).catch(() => null);

    const parsed = parseWhen(timeInput, { timezone: config.timezone });
    if (parsed.error) return interaction.reply(ephemeral(`⚠️ ${parsed.error}`));
    let dueAt = parsed.at;
    if (repeat === 'weekdays') {
      const { weekday } = wallParts(dueAt, config.timezone);
      if (weekday === 0 || weekday === 6) dueAt = nextOccurrence(dueAt, 'weekdays', config.timezone);
    }

    if (!channel?.isTextBased()) return interaction.reply(ephemeral('⚠️ I can only post reminders in text channels.'));
    const sendPerm = channel.isThread() ? PermissionFlagsBits.SendMessagesInThreads : PermissionFlagsBits.SendMessages;
    const memberPerms = channel.permissionsFor(interaction.member);
    if (!memberPerms?.has([PermissionFlagsBits.ViewChannel, sendPerm])) {
      return interaction.reply(ephemeral(`⚠️ You can't send messages in ${channel}.`));
    }
    const botPerms = channel.permissionsFor(interaction.guild.members.me);
    if (!botPerms?.has([PermissionFlagsBits.ViewChannel, sendPerm])) {
      return interaction.reply(ephemeral(`⚠️ I can't send messages in ${channel}. Give me access or pick another channel.`));
    }

    if (!isModerator(interaction)) {
      const pending = store.listReminders(interaction.guildId, interaction.user.id).length;
      if (pending >= MAX_PENDING_PER_USER) {
        return interaction.reply(
          ephemeral(`⚠️ You already have ${pending} pending reminders. Cancel some with \`/reminders cancel\` first.`),
        );
      }
    }

    const resolved = resolvePings(interaction, channel, message);
    if (resolved.error) return interaction.reply(ephemeral(`⚠️ ${resolved.error}`));
    const { pings } = resolved;

    const id = store.addReminder({
      guildId: interaction.guildId,
      channelId: channel.id,
      creatorId: interaction.user.id,
      message,
      pings,
      dueAt,
      repeat,
    });
    arm(store.getReminder(id));

    const who = [
      ...(pings.everyone ? [`@${pings.everyone}`] : []),
      ...pings.roles.map((r) => `<@&${r}>`),
      ...pings.users.map((u) => `<@${u}>`),
    ].join(', ');
    const unix = Math.floor(dueAt / 1000);
    const lines = [
      `⏰ Reminder **#${id}** set for <t:${unix}:F> (<t:${unix}:R>)${repeat ? `, repeating ${REPEATS[repeat]}` : ''}.`,
      `Posting in ${channel} and pinging ${who}.`,
      `> ${truncate(message, 200)}`,
    ];
    console.log(`Reminder #${id} set by ${interaction.user.id} for ${new Date(dueAt).toISOString()}.`);
    return interaction.reply({ content: lines.join('\n'), allowedMentions: { parse: [] } });
  }

  function describeReminder(r) {
    const unix = Math.floor(r.dueAt / 1000);
    const repeat = r.repeat ? ` · 🔁 ${REPEATS[r.repeat]}` : '';
    return `**#${r.id}** <t:${unix}:R> in <#${r.channelId}>${repeat} · by <@${r.creatorId}>\n> ${truncate(r.message, 80)}`;
  }

  async function onReminders(interaction) {
    const sub = interaction.options.getSubcommand();
    const mod = isModerator(interaction);

    if (sub === 'list') {
      const list = store.listReminders(interaction.guildId, mod ? null : interaction.user.id);
      if (!list.length) {
        return interaction.reply(ephemeral(`No pending reminders. Make one with \`/remind\`, e.g. ${EXAMPLES}.`));
      }
      const shown = list.slice(0, 15).map((r) => describeReminder(r));
      if (list.length > shown.length) shown.push(`…and ${list.length - shown.length} more.`);
      const heading = mod ? 'Pending reminders in this server' : 'Your pending reminders';
      return interaction.reply(ephemeral(`**${heading}**\n${shown.join('\n')}`));
    }

    // cancel
    const id = interaction.options.getInteger('id', true);
    const reminder = store.getReminder(id);
    if (!reminder || reminder.guildId !== interaction.guildId) {
      return interaction.reply(ephemeral(`⚠️ There is no reminder #${id}. See \`/reminders list\`.`));
    }
    if (reminder.creatorId !== interaction.user.id && !mod) {
      return interaction.reply(ephemeral(`⚠️ Reminder #${id} isn't yours to cancel.`));
    }
    cancelTimer(id);
    store.deleteReminder(id);
    return interaction.reply(ephemeral(`🗑️ Cancelled reminder #${id}: ${truncate(reminder.message, 100)}`));
  }

  async function onCommand(interaction) {
    if (interaction.commandName === 'remind') return onRemind(interaction);
    return onReminders(interaction);
  }

  /** Preview parsed times while typing /remind, and offer ids for /reminders cancel. */
  async function onAutocomplete(interaction) {
    const focused = interaction.options.getFocused(true);
    const now = Date.now();

    if (interaction.commandName === 'remind' && focused.name === 'time') {
      const input = focused.value.trim();
      const candidates = input ? [input] : SUGGESTIONS;
      const choices = candidates.map((value) => {
        const parsed = parseWhen(value, { now, timezone: config.timezone });
        const preview = parsed.error ? `❓ ${parsed.error.replace(/`/g, '')}` : describeWhen(parsed.at, { now, timezone: config.timezone });
        return { name: truncate(`${value} → ${preview}`, 100), value: value.slice(0, 100) };
      });
      return interaction.respond(choices);
    }

    if (interaction.commandName === 'reminders' && focused.name === 'id') {
      const list = store.listReminders(interaction.guildId, isModerator(interaction) ? null : interaction.user.id);
      const query = String(focused.value ?? '').toLowerCase();
      const choices = list
        .filter((r) => !query || String(r.id).startsWith(query) || r.message.toLowerCase().includes(query))
        .slice(0, 25)
        .map((r) => ({
          name: truncate(`#${r.id} · ${describeWhen(r.dueAt, { now, timezone: config.timezone })} · ${r.message}`, 100),
          value: r.id,
        }));
      return interaction.respond(choices);
    }

    return interaction.respond([]);
  }

  return { restore, stop, onCommand, onAutocomplete };
}
