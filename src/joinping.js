/**
 * Join pings: when someone joins, ping up to five roles (e.g. the owners) in a chosen
 * channel with who joined, the new member count and how old their account is,
 * which helps spot throwaway accounts.
 *
 *   /joinping set role:@Owner [role2:@Mods …] [channel:#mod-chat]
 *   /joinping status | disable
 *
 * Settings are per server. Needs the Server Members intent to see joins.
 */
import { ChannelType, MessageFlags, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';

import { ordinal } from './milestone.js';
import { humanizeDuration } from './when.js';

const ROLE_OPTIONS = ['role', 'role2', 'role3', 'role4', 'role5'];

/** Accounts younger than this get a warning in the ping. */
const NEW_ACCOUNT_MS = 7 * 24 * 60 * 60 * 1000;

export const joinPingCommand = new SlashCommandBuilder()
  .setName('joinping')
  .setDescription('Ping roles whenever someone joins the server.')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .setDMPermission(false)
  .addSubcommand((sub) =>
    sub
      .setName('set')
      .setDescription('Choose the roles to ping and where.')
      .addRoleOption((opt) => opt.setName('role').setDescription('Role to ping, e.g. @Owner').setRequired(true))
      .addRoleOption((opt) => opt.setName('role2').setDescription('Another role to ping'))
      .addRoleOption((opt) => opt.setName('role3').setDescription('Another role to ping'))
      .addRoleOption((opt) => opt.setName('role4').setDescription('Another role to ping'))
      .addRoleOption((opt) => opt.setName('role5').setDescription('Another role to ping'))
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
export function joinPingText(member, roleIds, now = Date.now()) {
  const roles = roleIds.map((id) => `<@&${id}>`).join(' ');
  const created = member.user.createdTimestamp;
  const age = now - created;
  const ageNote = age < NEW_ACCOUNT_MS ? ` ⚠️ **New account** (${humanizeDuration(age)} old)` : '';
  return (
    `${roles} 👋 ${member} (**${member.user.username}**) just joined, our ${ordinal(member.guild.memberCount)} member!\n` +
    `-# Account created <t:${Math.floor(created / 1000)}:R>.${ageNote}`
  );
}

export function setupJoinPings(client, store) {
  const key = (guildId) => `joinping:${guildId}`;

  /** { roleIds, channelId } or null. Older settings stored a single roleId. */
  function getSettings(guildId) {
    try {
      const settings = JSON.parse(store.getMeta(key(guildId)) ?? 'null');
      if (!settings) return null;
      return { roleIds: settings.roleIds ?? [settings.roleId], channelId: settings.channelId };
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
      content: joinPingText(member, settings.roleIds),
      allowedMentions: { roles: settings.roleIds },
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
          ? `When someone joins, I ping ${settings.roleIds.map((id) => `<@&${id}>`).join(', ')} in <#${settings.channelId}>.`
          : 'Join pings are off. Turn them on with `/joinping set role:@Owner`.',
      );
    }

    // set
    const roles = [];
    for (const name of ROLE_OPTIONS) {
      const role = interaction.options.getRole(name);
      if (role && !roles.some((r) => r.id === role.id)) roles.push(role);
    }
    const channelId = interaction.options.getChannel('channel')?.id ?? interaction.channelId;
    const channel = await client.channels.fetch(channelId).catch(() => null);
    const perms = channel?.permissionsFor?.(guild.members.me);
    if (!channel?.isTextBased() || !perms?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages])) {
      return reply(`⚠️ I can't send messages in <#${channelId}>. Give me access or pick another channel.`);
    }
    if (roles.some((r) => r.id === guild.id)) return reply('⚠️ Pick roles rather than @everyone.');
    const unpingable = roles.filter((r) => !r.mentionable);
    if (unpingable.length && !perms.has(PermissionFlagsBits.MentionEveryone)) {
      return reply(
        `⚠️ ${unpingable.join(', ')} can't be pinged. Turn on "Allow anyone to @mention this role" for ` +
          `${unpingable.length === 1 ? 'it' : 'them'}, or give me **Mention @everyone, @here, and All Roles** in <#${channelId}>.`,
      );
    }
    store.setMeta(key(guild.id), JSON.stringify({ roleIds: roles.map((r) => r.id), channelId }));
    return reply(`✅ When someone joins, I'll ping ${roles.join(', ')} in <#${channelId}>.`);
  }

  return { onMemberAdd, onCommand };
}
