/**
 * Join pings: when someone joins, ping a role (e.g. the owners) in a chosen
 * channel with who joined, the new member count and how old their account is,
 * which helps spot throwaway accounts.
 *
 *   /joinping set role:@Owner [channel:#mod-chat]
 *   /joinping status | disable
 *
 * Settings are per server. Needs the Server Members intent to see joins.
 */
import { ChannelType, MessageFlags, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';

import { ordinal } from './milestone.js';
import { humanizeDuration } from './when.js';

/** Accounts younger than this get a warning in the ping. */
const NEW_ACCOUNT_MS = 7 * 24 * 60 * 60 * 1000;

export const joinPingCommand = new SlashCommandBuilder()
  .setName('joinping')
  .setDescription('Ping a role whenever someone joins the server.')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .setDMPermission(false)
  .addSubcommand((sub) =>
    sub
      .setName('set')
      .setDescription('Choose the role to ping and where.')
      .addRoleOption((opt) => opt.setName('role').setDescription('Role to ping, e.g. @Owner').setRequired(true))
      .addChannelOption((opt) =>
        opt
          .setName('channel')
          .setDescription('Where to post (default: this channel)')
          .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
      ),
  )
  .addSubcommand((sub) => sub.setName('status').setDescription('Show the join ping settings.'))
  .addSubcommand((sub) => sub.setName('disable').setDescription('Stop pinging on joins.'));

/** The join ping message for `member` (a GuildMember-like object). */
export function joinPingText(member, roleId, now = Date.now()) {
  const created = member.user.createdTimestamp;
  const age = now - created;
  const ageNote = age < NEW_ACCOUNT_MS ? ` ⚠️ **New account** (${humanizeDuration(age)} old)` : '';
  return (
    `<@&${roleId}> 👋 ${member} (**${member.user.username}**) just joined, our ${ordinal(member.guild.memberCount)} member!\n` +
    `-# Account created <t:${Math.floor(created / 1000)}:R>.${ageNote}`
  );
}

export function setupJoinPings(client, store) {
  const key = (guildId) => `joinping:${guildId}`;

  function getSettings(guildId) {
    try {
      return JSON.parse(store.getMeta(key(guildId)) ?? 'null');
    } catch {
      return null;
    }
  }

  async function onMemberAdd(member) {
    if (member.user.bot) return;
    const settings = getSettings(member.guild.id);
    if (!settings) return;
    const channel = await client.channels.fetch(settings.channelId).catch(() => null);
    if (!channel?.isTextBased()) {
      console.warn(`Join ping channel ${settings.channelId} is missing in guild ${member.guild.id}.`);
      return;
    }
    await channel.send({
      content: joinPingText(member, settings.roleId),
      allowedMentions: { roles: [settings.roleId] },
    });
  }

  async function onCommand(interaction) {
    const guild = interaction.guild;
    const sub = interaction.options.getSubcommand();
    const reply = (content) => interaction.reply({ content, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });

    if (sub === 'disable') {
      store.deleteMeta(key(guild.id));
      return reply('🛑 Join pings turned off.');
    }

    if (sub === 'status') {
      const settings = getSettings(guild.id);
      return reply(
        settings
          ? `When someone joins, I ping <@&${settings.roleId}> in <#${settings.channelId}>.`
          : 'Join pings are off. Turn them on with `/joinping set role:@Owner`.',
      );
    }

    // set
    const role = interaction.options.getRole('role', true);
    const channelId = interaction.options.getChannel('channel')?.id ?? interaction.channelId;
    const channel = await client.channels.fetch(channelId).catch(() => null);
    const perms = channel?.permissionsFor?.(guild.members.me);
    if (!channel?.isTextBased() || !perms?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages])) {
      return reply(`⚠️ I can't send messages in <#${channelId}>. Give me access or pick another channel.`);
    }
    if (role.id === guild.id) return reply('⚠️ Pick a role rather than @everyone.');
    if (!role.mentionable && !perms.has(PermissionFlagsBits.MentionEveryone)) {
      return reply(
        `⚠️ ${role} isn't pingable. Turn on "Allow anyone to @mention this role" for it, or give me ` +
          `**Mention @everyone, @here, and All Roles** in <#${channelId}>.`,
      );
    }
    store.setMeta(key(guild.id), JSON.stringify({ roleId: role.id, channelId }));
    return reply(`✅ When someone joins, I'll ping ${role} in <#${channelId}>.`);
  }

  return { onMemberAdd, onCommand };
}
