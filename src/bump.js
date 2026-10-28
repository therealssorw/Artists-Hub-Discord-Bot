/**
 * Disboard bump reminders.
 *
 * When someone runs Disboard's /bump and Disboard replies "Bump done!", the bot
 * schedules a reminder that pings a role chosen with /bumpreminder for when the
 * server can be bumped again. Pending reminders are stored in SQLite so a
 * restart does not lose them.
 *
 * DISBOARD Pro: a normal bump is ready 2 hours after the last bump, but Pro
 * servers also get a pool of accelerated bumps (12) usable 30 minutes after the
 * last bump. Each one recharges 24 hours after it is used. Disboard's reply to
 * an early bump says "Used 1 accelerated bump (11 of 12 left)", which the bot
 * reads to track the pool. While early bumps are left it reminds after 30
 * minutes; once they are used up it reminds at the normal 2 hours, or sooner
 * if an early bump recharges first.
 *
 * If nobody bumps after a reminder, it pings again every 30 minutes, up to 4
 * pings in all, until someone bumps and the count starts over. On weekdays it stays quiet during quiet hours (7 AM–3 PM
 * Eastern by default, changeable with /bumpreminder quiethours); a reminder
 * due then waits until quiet hours end. Weekends have no quiet hours.
 */
import { EmbedBuilder, MessageFlags, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';

import { config } from './config.js';
import { formatReportTime, parseReportTime } from './dailyreport.js';
import { wallParts, zonedTime } from './when.js';

export const DISBOARD_BOT_ID = '302050872383242240';
/** Disboard's global /bump command id, used to render a clickable mention. */
const DISBOARD_BUMP_COMMAND = '</bump:947088344167366698>';
export const BUMP_COOLDOWN_MS = 2 * 60 * 60 * 1000;
export const EARLY_BUMP_COOLDOWN_MS = 30 * 60 * 1000;
export const EARLY_BUMP_RECHARGE_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_EARLY_BUMPS = 12;
/** How long after an unanswered reminder to ping again. */
export const BUMP_REPEAT_MS = 30 * 60 * 1000;
/** Most pings per bump: the first reminder plus repeats. */
export const MAX_BUMP_PINGS = 4;
/** Default weekday quiet hours (no pings), in TIMEZONE. */
export const DEFAULT_QUIET_HOURS = { start: '07:00', end: '15:00' };

export const bumpReminderCommand = new SlashCommandBuilder()
  .setName('bumpreminder')
  .setDescription('Ping a role when Disboard /bump is ready again.')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .setDMPermission(false)
  .addSubcommand((sub) =>
    sub
      .setName('set')
      .setDescription('Choose the role to ping when the server can be bumped again.')
      .addRoleOption((opt) =>
        opt.setName('role').setDescription('Role to ping').setRequired(true),
      )
      .addBooleanOption((opt) =>
        opt
          .setName('pro')
          .setDescription('Use DISBOARD Pro early bumps (30 min) while any are left (default: detect automatically)'),
      ),
  )
  .addSubcommand((sub) =>
    sub.setName('disable').setDescription('Stop sending bump reminders.'),
  )
  .addSubcommand((sub) =>
    sub
      .setName('quiethours')
      .setDescription('Weekday hours with no bump pings (Eastern time; default 7am–3pm).')
      .addStringOption((opt) => opt.setName('start').setDescription('Quiet from, e.g. 7am').setMaxLength(20))
      .addStringOption((opt) => opt.setName('end').setDescription('Quiet until, e.g. 3pm').setMaxLength(20))
      .addBooleanOption((opt) => opt.setName('off').setDescription('Turn quiet hours off (ping any time)')),
  )
  .addSubcommand((sub) =>
    sub.setName('status').setDescription('Show the reminder role and the next reminder time.'),
  );

/**
 * Does this message look like a successful Disboard bump?
 *
 * Disboard replies to /bump with an embed saying "Bump done!". If the bot has
 * the Message Content intent we can read the embed and ignore failures such as
 * "Please wait another 42 minutes". Without it the embed is hidden, so we fall
 * back to treating any reply to /bump from Disboard as a bump.
 */
export function isBumpDone(message) {
  if (message.author?.id !== DISBOARD_BOT_ID) return false;
  const embedText = (message.embeds ?? []).map((e) => e.description ?? '').join('\n');
  if (embedText) return /bump done/i.test(embedText);
  // Embeds are hidden without the Message Content intent; rely on the command name.
  return message.interaction?.commandName === 'bump';
}

/** Text of Disboard's embeds (descriptions and fields). */
export function embedText(message) {
  return (message.embeds ?? [])
    .map((e) => [e.description ?? '', ...(e.fields ?? []).map((f) => `${f.name}\n${f.value}`)].join('\n'))
    .join('\n');
}

/**
 * Read "Bumped early with DISBOARD Pro! Used 1 accelerated bump (11 of 12 left)."
 * Returns { used, left, pool } or null for a normal bump.
 */
export function parseEarlyBump(text) {
  if (!/accelerated bump|bumped early/i.test(text)) return null;
  const counts = text.match(/(\d+)\s+of\s+(\d+)\s+left/i);
  if (!counts) return null;
  const used = Number(text.match(/used\s+(\d+)\s+accelerated/i)?.[1] ?? 1);
  return { used, left: Number(counts[1]), pool: Number(counts[2]) };
}

/** Early-bump uses still counting against the pool at `at`, oldest first. */
export function activeUses(uses, at) {
  return uses.filter((t) => t > at - EARLY_BUMP_RECHARGE_MS && t <= at).sort((a, b) => a - b);
}

/** Early bumps available at `at`. */
export function earlyBumpsLeft(uses, pool, at) {
  return Math.max(0, pool - activeUses(uses, at).length);
}

/**
 * Line our record of early-bump uses up with what Disboard says is left. If we
 * missed uses (bot offline), assume they were just used; if Disboard reports
 * more left than we think, drop our oldest records.
 */
export function reconcileUses(uses, at, pool, left) {
  const active = activeUses(uses, at);
  const diff = pool - active.length - left;
  if (diff > 0) for (let i = 0; i < diff; i += 1) active.push(at);
  if (diff < 0) active.splice(0, -diff);
  return active;
}

/**
 * When to remind after a bump at `bumpAt`: 30 minutes later if an early bump
 * will be available then, else when one recharges if that beats the normal
 * 2-hour cooldown, else at 2 hours. `pool` is 0 without DISBOARD Pro.
 */
export function planNextBump(bumpAt, uses, pool) {
  const normalAt = bumpAt + BUMP_COOLDOWN_MS;
  if (!pool) return { dueAt: normalAt, early: false };
  const earlyAt = bumpAt + EARLY_BUMP_COOLDOWN_MS;
  const active = activeUses(uses, earlyAt);
  if (active.length < pool) return { dueAt: earlyAt, early: true };
  const rechargeAt = active[active.length - pool] + EARLY_BUMP_RECHARGE_MS;
  if (rechargeAt < normalAt) return { dueAt: rechargeAt, early: true };
  return { dueAt: normalAt, early: false, rechargeAt };
}

/**
 * If `at` falls in weekday quiet hours, when they end; otherwise null.
 * `quiet` is { start, end } as "HH:MM" (end may be past midnight) or null.
 */
export function quietUntil(at, quiet, timezone) {
  if (!quiet) return null;
  const p = wallParts(at, timezone);
  const [sh, sm] = quiet.start.split(':').map(Number);
  const [eh, em] = quiet.end.split(':').map(Number);
  const now = p.hour * 60 + p.minute;
  const start = sh * 60 + sm;
  const end = eh * 60 + em;
  const weekday = (d) => d >= 1 && d <= 5;
  if (start < end) {
    if (!weekday(p.weekday) || now < start || now >= end) return null;
    return zonedTime(p.year, p.month, p.day, eh, em, 0, timezone);
  }
  // Overnight window, e.g. 11pm–7am: it belongs to the weekday it starts on.
  if (now >= start && weekday(p.weekday)) return zonedTime(p.year, p.month, p.day + 1, eh, em, 0, timezone);
  if (now < end && weekday((p.weekday + 6) % 7)) return zonedTime(p.year, p.month, p.day, eh, em, 0, timezone);
  return null;
}

/** Who ran the /bump that Disboard is replying to, or null. */
export function bumperId(message) {
  return message.interactionMetadata?.user?.id ?? message.interaction?.user?.id ?? null;
}

/** Add a successful bump to the leaderboard (no-op if already recorded). */
export function recordBumpFrom(store, message) {
  const userId = bumperId(message);
  if (!userId) return false;
  return store.recordBump({
    messageId: message.id,
    guildId: message.guildId,
    userId,
    at: message.createdTimestamp,
    early: Boolean(parseEarlyBump(embedText(message))),
  });
}

const PERIODS = {
  all: { label: 'All time', ms: null },
  month: { label: 'Last 30 days', ms: 30 * 24 * 60 * 60 * 1000 },
  week: { label: 'Last 7 days', ms: 7 * 24 * 60 * 60 * 1000 },
};
const PAGE_SIZE = 10;

export const bumpLeaderboardCommand = new SlashCommandBuilder()
  .setName('bumpleaderboard')
  .setDescription('Who has bumped the server the most with Disboard.')
  .setDMPermission(false)
  .addStringOption((opt) =>
    opt
      .setName('period')
      .setDescription('Time range (default: all time)')
      .addChoices(
        { name: 'All time', value: 'all' },
        { name: 'Last 30 days', value: 'month' },
        { name: 'Last 7 days', value: 'week' },
      ),
  )
  .addIntegerOption((opt) => opt.setName('page').setDescription('Page number (default: 1)').setMinValue(1));

/** The /bumpleaderboard embed. */
export function buildBumpLeaderboard(store, { guildId, guildName, userId, period = 'all', page = 1, now = Date.now() }) {
  const { label, ms } = PERIODS[period] ?? PERIODS.all;
  const since = ms ? now - ms : 0;
  const total = store.getBumperCount(guildId, since);
  const embed = new EmbedBuilder().setColor(0x5ab8b1).setTitle(`🚀 ${guildName} bump leaderboard · ${label}`);
  if (!total) {
    return embed.setDescription(`No bumps yet. Run ${DISBOARD_BUMP_COMMAND} to get on the board!`);
  }
  const pages = Math.ceil(total / PAGE_SIZE);
  const current = Math.min(Math.max(1, page), pages);
  const rows = store.getBumpLeaderboard(guildId, since, PAGE_SIZE, (current - 1) * PAGE_SIZE);
  const medals = ['🥇', '🥈', '🥉'];
  const lines = rows.map((row, i) => {
    const position = (current - 1) * PAGE_SIZE + i + 1;
    const badge = medals[position - 1] ?? `**${position}.**`;
    const early = row.early ? ` (⚡ ${row.early} early)` : '';
    return `${badge} <@${row.userId}> · **${row.bumps}** bump${row.bumps === 1 ? '' : 's'}${early}`;
  });
  const mine = store.getUserBumps(guildId, userId, since);
  const you = mine.bumps
    ? `You're #${mine.rank} with ${mine.bumps} bump${mine.bumps === 1 ? '' : 's'}`
    : 'Bump the server to get on the board';
  return embed.setDescription(lines.join('\n')).setFooter({ text: `Page ${current}/${pages} · ${you}` });
}

export function setupBumpReminders(client, store) {
  /** guildId -> timeout handle */
  const timers = new Map();
  const proKey = (guildId) => `bump:pro:${guildId}`;
  const usesKey = (guildId) => `bump:early_uses:${guildId}`;
  const lastKey = (guildId) => `bump:last:${guildId}`;
  const quietKey = (guildId) => `bump:quiet:${guildId}`;
  const nagsKey = (guildId) => `bump:nags:${guildId}`;

  /** Weekday quiet hours { start, end }, or null when turned off. */
  function quietHours(guildId) {
    const value = store.getMeta(quietKey(guildId));
    if (value === 'off') return null;
    if (!value) return DEFAULT_QUIET_HOURS;
    const [start, end] = value.split('-');
    return { start, end };
  }

  /** `at`, or the end of quiet hours if `at` falls inside them. */
  function outsideQuiet(guildId, at) {
    return quietUntil(at, quietHours(guildId), config.timezone) ?? at;
  }

  /** Size of the early-bump pool, or 0 when DISBOARD Pro is off or not detected yet. */
  function poolSize(guildId) {
    const value = store.getMeta(proKey(guildId));
    return value === 'off' ? 0 : Number(value) || 0;
  }

  function getUses(guildId) {
    try {
      return JSON.parse(store.getMeta(usesKey(guildId)) ?? '[]');
    } catch {
      return [];
    }
  }

  function saveUses(guildId, uses, now = Date.now()) {
    store.setMeta(usesKey(guildId), JSON.stringify(activeUses(uses, now)));
  }

  function lastBumpAt(guildId) {
    return Number(store.getMeta(lastKey(guildId))) || null;
  }

  function cancel(guildId) {
    const t = timers.get(guildId);
    if (t) clearTimeout(t);
    timers.delete(guildId);
  }

  /** The reminder text: an early (Pro) bump or a normal one, and whether it is a repeat. */
  function reminderText(guildId, roleId, now, repeat = false) {
    const nudge = repeat ? '⏰ Still no bump! ' : '';
    const pool = poolSize(guildId);
    const last = lastBumpAt(guildId);
    if (pool && last && now < last + BUMP_COOLDOWN_MS) {
      const left = earlyBumpsLeft(getUses(guildId), pool, now);
      return `<@&${roleId}> ${nudge}⚡ An early bump is ready with DISBOARD Pro (${left} of ${pool} left)! Run ${DISBOARD_BUMP_COMMAND} 🚀`;
    }
    return `<@&${roleId}> ${nudge}The server can be bumped again! Run ${DISBOARD_BUMP_COMMAND} 🚀`;
  }

  async function fire(guildId) {
    timers.delete(guildId);
    const reminder = store.getBumpReminder(guildId);
    store.clearBumpReminder(guildId);
    if (!reminder) return;

    const roleId = store.getBumpRole(guildId);
    if (!roleId) return;

    // Quiet hours may have started (or been changed) since this was scheduled.
    const now = Date.now();
    const quietEnd = quietUntil(now, quietHours(guildId), config.timezone);
    if (quietEnd) {
      schedule(guildId, reminder.channelId, quietEnd);
      return;
    }

    const nags = Number(store.getMeta(nagsKey(guildId))) || 0;
    try {
      const channel = await client.channels.fetch(reminder.channelId);
      if (!channel?.isTextBased()) return;
      await channel.send({
        content: reminderText(guildId, roleId, now, nags > 0),
        allowedMentions: { roles: [roleId] },
      });
      console.log(`Sent bump reminder${nags ? ` (repeat ${nags})` : ''} in guild ${guildId}.`);
    } catch (error) {
      console.error(`Failed to send bump reminder for guild ${guildId}:`, error);
      return;
    }
    // Ping again if nobody bumps, up to MAX_BUMP_PINGS in all; a bump starts over.
    store.setMeta(nagsKey(guildId), String(nags + 1));
    if (nags + 1 < MAX_BUMP_PINGS) schedule(guildId, reminder.channelId, now + BUMP_REPEAT_MS);
  }

  function schedule(guildId, channelId, dueAt) {
    cancel(guildId);
    dueAt = outsideQuiet(guildId, dueAt);
    store.setBumpReminder(guildId, channelId, dueAt);
    const delay = Math.max(0, dueAt - Date.now());
    // setTimeout cannot exceed ~24.8 days; bump reminders are at most 2h away.
    timers.set(guildId, setTimeout(() => fire(guildId), delay));
  }

  /** Re-arm reminders that were pending when the bot last stopped. */
  function restore() {
    for (const r of store.getAllBumpReminders()) {
      if (!store.getBumpRole(r.guildId)) {
        store.clearBumpReminder(r.guildId);
        continue;
      }
      schedule(r.guildId, r.channelId, r.dueAt);
    }
    const count = store.getAllBumpReminders().length;
    if (count) console.log(`Restored ${count} pending bump reminder(s).`);
  }

  function onMessage(message) {
    if (!message.inGuild() || !isBumpDone(message)) return;
    const guildId = message.guildId;
    const at = message.createdTimestamp;
    store.setMeta(lastKey(guildId), String(at));
    store.deleteMeta(nagsKey(guildId));
    try {
      recordBumpFrom(store, message);
    } catch (error) {
      console.error('Failed to record bump for the leaderboard:', error);
    }

    let uses = getUses(guildId);
    const early = parseEarlyBump(embedText(message));
    if (early) {
      // Seeing a Pro early bump turns Pro tracking on, unless it was switched off.
      if (store.getMeta(proKey(guildId)) !== 'off') store.setMeta(proKey(guildId), String(early.pool));
      uses = reconcileUses([...uses, ...Array(early.used).fill(at)], at, early.pool, early.left);
      saveUses(guildId, uses, at);
    }

    if (!store.getBumpRole(guildId)) return; // reminders not enabled here
    const plan = planNextBump(at, uses, poolSize(guildId));
    schedule(guildId, message.channelId, plan.dueAt);
    console.log(
      `Bump detected in guild ${guildId}${early ? ` (early, ${early.left} of ${early.pool} left)` : ''}; ` +
        `${plan.early ? 'early' : 'normal'} reminder at ${new Date(plan.dueAt).toISOString()}.`,
    );
  }

  /** Re-plan a pending reminder after the Pro setting changes. */
  function replan(guildId) {
    const pending = store.getBumpReminder(guildId);
    const last = lastBumpAt(guildId);
    if (!pending || !last) return null;
    const plan = planNextBump(last, getUses(guildId), poolSize(guildId));
    schedule(guildId, pending.channelId, plan.dueAt);
    return plan.dueAt;
  }

  function describeTiming(guildId) {
    const pool = poolSize(guildId);
    if (!pool) return 'Reminders come 2 hours after each bump (no DISBOARD Pro early bumps).';
    const now = Date.now();
    const uses = getUses(guildId);
    const left = earlyBumpsLeft(uses, pool, now);
    const active = activeUses(uses, now);
    const recharge = active.length
      ? ` Next early bump recharges <t:${Math.floor((active[0] + EARLY_BUMP_RECHARGE_MS) / 1000)}:R>.`
      : '';
    return (
      `DISBOARD Pro: **${left} of ${pool}** early bumps left.${recharge} ` +
      'Reminders come 30 minutes after a bump while early bumps are left, otherwise after 2 hours.'
    );
  }

  function describeQuiet(guildId) {
    const quiet = quietHours(guildId);
    if (!quiet) return '🔔 No quiet hours: reminders can ping any time. Unanswered reminders repeat every 30 minutes, up to 4 pings in all.';
    return (
      `🤫 Quiet hours: weekdays ${formatReportTime(quiet.start)}–${formatReportTime(quiet.end)} (${config.timezone}). ` +
      'Reminders due then wait until quiet hours end; weekends ping any time. ' +
      'Unanswered reminders repeat every 30 minutes, up to 4 pings in all.'
    );
  }

  async function onLeaderboard(interaction) {
    const embed = buildBumpLeaderboard(store, {
      guildId: interaction.guildId,
      guildName: interaction.guild.name,
      userId: interaction.user.id,
      period: interaction.options.getString('period') ?? 'all',
      page: interaction.options.getInteger('page') ?? 1,
    });
    await interaction.reply({ embeds: [embed], allowedMentions: { parse: [] } });
  }

  async function onCommand(interaction) {
    if (interaction.commandName === 'bumpleaderboard') return onLeaderboard(interaction);
    const guildId = interaction.guildId;
    const sub = interaction.options.getSubcommand();

    if (sub === 'set') {
      const role = interaction.options.getRole('role', true);
      const pro = interaction.options.getBoolean('pro');
      store.setBumpRole(guildId, role.id);
      if (pro === true) store.setMeta(proKey(guildId), String(poolSize(guildId) || DEFAULT_EARLY_BUMPS));
      if (pro === false) store.setMeta(proKey(guildId), 'off');
      const moved = pro === null ? null : replan(guildId);
      const next = moved ? ` Next reminder <t:${Math.floor(moved / 1000)}:R>.` : '';
      await interaction.reply({
        content: `✅ I'll ping ${role} when the server can be bumped again.\n${describeTiming(guildId)}${next}`,
        allowedMentions: { parse: [] },
      });
      return;
    }

    if (sub === 'disable') {
      store.clearBumpRole(guildId);
      store.clearBumpReminder(guildId);
      cancel(guildId);
      await interaction.reply('🛑 Bump reminders disabled.');
      return;
    }

    if (sub === 'quiethours') {
      if (interaction.options.getBoolean('off')) {
        store.setMeta(quietKey(guildId), 'off');
      } else {
        const current = quietHours(guildId) ?? DEFAULT_QUIET_HOURS;
        const startInput = interaction.options.getString('start');
        const endInput = interaction.options.getString('end');
        const start = startInput ? parseReportTime(startInput) : current.start;
        const end = endInput ? parseReportTime(endInput) : current.end;
        if (!start || !end || start === end) {
          await interaction.reply({ content: '⚠️ I couldn’t read those times. Try `start:7am end:3pm`.', flags: MessageFlags.Ephemeral });
          return;
        }
        store.setMeta(quietKey(guildId), `${start}-${end}`);
      }
      // Move a pending reminder out of the new quiet hours.
      const pending = store.getBumpReminder(guildId);
      if (pending) schedule(guildId, pending.channelId, pending.dueAt);
      await interaction.reply(describeQuiet(guildId));
      return;
    }

    // status
    const roleId = store.getBumpRole(guildId);
    if (!roleId) {
      await interaction.reply('Bump reminders are not set up. Use `/bumpreminder set` to pick a role.');
      return;
    }
    const pending = store.getBumpReminder(guildId);
    const next = pending
      ? `Next reminder <t:${Math.floor(pending.dueAt / 1000)}:R> in <#${pending.channelId}>.`
      : 'No bump detected yet; the first reminder will follow the next /bump.';
    await interaction.reply({
      content: `Reminder role: <@&${roleId}>\n${describeTiming(guildId)}\n${describeQuiet(guildId)}\n${next}`,
      allowedMentions: { parse: [] },
    });
  }

  return { restore, onMessage, onCommand, cancel };
}
