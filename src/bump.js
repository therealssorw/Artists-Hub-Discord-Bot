/**
 * Disboard bump reminders.
 *
 * When someone runs Disboard's /bump and Disboard replies "Bump done!", the bot
 * schedules a reminder for two hours later (Disboard's cooldown) that pings a
 * role chosen with /bumpreminder. Pending reminders are stored in SQLite so a
 * restart does not lose them.
 */
import { PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';

export const DISBOARD_BOT_ID = '302050872383242240';
/** Disboard's global /bump command id, used to render a clickable mention. */
const DISBOARD_BUMP_COMMAND = '</bump:947088344167366698>';
export const BUMP_COOLDOWN_MS = 2 * 60 * 60 * 1000;

export const bumpReminderCommand = new SlashCommandBuilder()
  .setName('bumpreminder')
  .setDescription('Ping a role two hours after every Disboard /bump.')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .setDMPermission(false)
  .addSubcommand((sub) =>
    sub
      .setName('set')
      .setDescription('Choose the role to ping when the server can be bumped again.')
      .addRoleOption((opt) =>
        opt.setName('role').setDescription('Role to ping').setRequired(true),
      ),
  )
  .addSubcommand((sub) =>
    sub.setName('disable').setDescription('Stop sending bump reminders.'),
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

export function setupBumpReminders(client, store) {
  /** guildId -> timeout handle */
  const timers = new Map();

  function cancel(guildId) {
    const t = timers.get(guildId);
    if (t) clearTimeout(t);
    timers.delete(guildId);
  }

  async function fire(guildId) {
    timers.delete(guildId);
    const reminder = store.getBumpReminder(guildId);
    store.clearBumpReminder(guildId);
    if (!reminder) return;

    const roleId = store.getBumpRole(guildId);
    if (!roleId) return;

    try {
      const channel = await client.channels.fetch(reminder.channelId);
      if (!channel?.isTextBased()) return;
      await channel.send({
        content: `<@&${roleId}> The server can be bumped again! Run ${DISBOARD_BUMP_COMMAND} 🚀`,
        allowedMentions: { roles: [roleId] },
      });
      console.log(`Sent bump reminder in guild ${guildId}.`);
    } catch (error) {
      console.error(`Failed to send bump reminder for guild ${guildId}:`, error);
    }
  }

  function schedule(guildId, channelId, dueAt) {
    cancel(guildId);
    store.setBumpReminder(guildId, channelId, dueAt);
    const delay = Math.max(0, dueAt - Date.now());
    // setTimeout cannot exceed ~24.8 days; bump cooldowns are 2h so this is fine.
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
    if (!store.getBumpRole(message.guildId)) return; // feature not enabled here
    const dueAt = message.createdTimestamp + BUMP_COOLDOWN_MS;
    schedule(message.guildId, message.channelId, dueAt);
    console.log(
      `Bump detected in guild ${message.guildId}; reminder at ${new Date(dueAt).toISOString()}.`,
    );
  }

  async function onCommand(interaction) {
    const guildId = interaction.guildId;
    const sub = interaction.options.getSubcommand();

    if (sub === 'set') {
      const role = interaction.options.getRole('role', true);
      store.setBumpRole(guildId, role.id);
      await interaction.reply({
        content: `✅ I'll ping ${role} two hours after every Disboard bump.`,
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
      content: `Reminder role: <@&${roleId}>\n${next}`,
      allowedMentions: { parse: [] },
    });
  }

  return { restore, onMessage, onCommand, cancel };
}
