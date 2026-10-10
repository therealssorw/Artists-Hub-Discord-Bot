/**
 * Levels, Arcane/MEE6 style.
 *
 * Each message earns 15–25 XP, at most once a minute per member, so spamming
 * does not help. Going from level L to L+1 takes 5L² + 50L + 100 XP (the same
 * curve Arcane and MEE6 use). On a level up the bot congratulates the member
 * and hands out any role rewards for that level, e.g. a self-promotion role at
 * level 5.
 *
 *   /rank [user]        rank card image
 *   /leaderboard [page] top members by XP
 *   /levels ...         (Manage Server) role rewards, level-up messages, XP adjustments
 */
import { createCanvas } from '@napi-rs/canvas';
import {
  AttachmentBuilder,
  ChannelType,
  EmbedBuilder,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';

import { FONT, circleImage, fetchImage, fitText, ring } from './canvas.js';

export const XP_MIN = 15;
export const XP_MAX = 25;
export const XP_COOLDOWN_MS = 60 * 1000;
const PAGE_SIZE = 10;
const MAX_LEVEL = 500;

// ----- Level maths -----

/** XP needed to go from `level` to `level + 1`. */
export function xpToNext(level) {
  return 5 * level * level + 50 * level + 100;
}

/** Total XP needed to reach `level` from zero. */
export function totalXpForLevel(level) {
  let total = 0;
  for (let l = 0; l < level; l += 1) total += xpToNext(l);
  return total;
}

/** { level, current, needed }: the level for `xp` and progress through it. */
export function levelFromXp(xp) {
  let level = 0;
  let rest = Math.max(0, xp);
  while (level < MAX_LEVEL && rest >= xpToNext(level)) {
    rest -= xpToNext(level);
    level += 1;
  }
  return { level, current: rest, needed: xpToNext(level) };
}

export function randomXp(random = Math.random) {
  return XP_MIN + Math.floor(random() * (XP_MAX - XP_MIN + 1));
}

export function levelUpText(userId, level, roleIds = []) {
  const lines = [`🎉 GG <@${userId}>, you just reached **level ${level}**!`];
  if (roleIds.length) lines.push(`🏷️ You unlocked ${roleIds.map((id) => `<@&${id}>`).join(', ')}!`);
  return lines.join('\n');
}

// ----- Rank card -----

const CARD_W = 934;
const CARD_H = 282;

function roundedRect(ctx, x, y, w, h, r) {
  const radius = Math.min(r, h / 2, w / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

const compact = (n) => (n >= 10000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, '')}K` : n.toLocaleString('en-US'));

/** Rank card PNG. `avatar` is a loaded image or null; `nextReward` is { name, level } or null. */
export function renderRankCard({ name, avatar = null, xp, rank, nextReward = null }) {
  const { level, current, needed } = levelFromXp(xp);
  const canvas = createCanvas(CARD_W, CARD_H);
  const ctx = canvas.getContext('2d');

  roundedRect(ctx, 0, 0, CARD_W, CARD_H, 28);
  ctx.clip();
  const bg = ctx.createLinearGradient(0, 0, CARD_W, CARD_H);
  bg.addColorStop(0, '#23243a');
  bg.addColorStop(1, '#141517');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, CARD_W, CARD_H);
  const glow = ctx.createRadialGradient(130, 141, 10, 130, 141, 300);
  glow.addColorStop(0, 'rgba(88, 101, 242, 0.35)');
  glow.addColorStop(1, 'rgba(88, 101, 242, 0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, CARD_W, CARD_H);

  const avatarSize = 180;
  circleImage(ctx, avatar, 40, 51, avatarSize, name);
  ring(ctx, 40, 51, avatarSize, '#5865f2', 6);

  const left = 260;
  const right = CARD_W - 44;

  // Rank and level, right aligned: "RANK #3   LEVEL 5"
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'right';
  let x = right;
  const pair = (label, value, color) => {
    ctx.font = `bold 52px "${FONT}"`;
    ctx.fillStyle = color;
    ctx.fillText(value, x, 92);
    x -= ctx.measureText(value).width + 8;
    ctx.font = `22px "${FONT}"`;
    ctx.fillStyle = '#b5bac1';
    ctx.fillText(label, x, 92);
    x -= ctx.measureText(label).width + 28;
  };
  pair('LEVEL', String(level), '#8e97ff');
  pair('RANK', `#${rank}`, '#ffffff');

  ctx.textAlign = 'right';
  ctx.font = `24px "${FONT}"`;
  ctx.fillStyle = '#b5bac1';
  const progress = `${compact(current)} / ${compact(needed)} XP`;
  ctx.fillText(progress, right, 160);
  const nameRight = right - ctx.measureText(progress).width - 24;

  ctx.textAlign = 'left';
  ctx.font = `bold 38px "${FONT}"`;
  ctx.fillStyle = '#ffffff';
  ctx.fillText(fitText(ctx, name, nameRight - left), left, 160);

  // Progress bar.
  const barY = 180;
  const barH = 38;
  const barW = right - left;
  roundedRect(ctx, left, barY, barW, barH, barH / 2);
  ctx.fillStyle = '#2b2d31';
  ctx.fill();
  const filled = Math.max(barH, barW * Math.min(1, current / needed));
  const fill = ctx.createLinearGradient(left, 0, left + barW, 0);
  fill.addColorStop(0, '#5865f2');
  fill.addColorStop(1, '#eb459e');
  roundedRect(ctx, left, barY, filled, barH, barH / 2);
  ctx.fillStyle = fill;
  ctx.fill();

  ctx.textAlign = 'left';
  ctx.font = `20px "${FONT}"`;
  ctx.fillStyle = '#949ba4';
  const footer = nextReward
    ? `Next reward: ${nextReward.name} at level ${nextReward.level}`
    : `${compact(xp)} XP total`;
  ctx.fillText(fitText(ctx, footer, barW), left, 252);

  return canvas.toBuffer('image/png');
}

// ----- Commands -----

export const rankCommand = new SlashCommandBuilder()
  .setName('rank')
  .setDescription('Show your level and rank card (or someone else’s).')
  .setDMPermission(false)
  .addUserOption((opt) => opt.setName('user').setDescription('Whose rank to show (default: you)'));

export const leaderboardCommand = new SlashCommandBuilder()
  .setName('leaderboard')
  .setDescription('Top members by level and XP.')
  .setDMPermission(false)
  .addIntegerOption((opt) => opt.setName('page').setDescription('Page number (default: 1)').setMinValue(1));

export const levelsCommand = new SlashCommandBuilder()
  .setName('levels')
  .setDescription('Set up leveling: role rewards, level-up messages and XP.')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .setDMPermission(false)
  .addSubcommandGroup((group) =>
    group
      .setName('reward')
      .setDescription('Roles members get when they reach a level.')
      .addSubcommand((sub) =>
        sub
          .setName('add')
          .setDescription('Give a role at a level (e.g. a self-promo role at level 5).')
          .addIntegerOption((opt) =>
            opt.setName('level').setDescription('Level that unlocks the role').setRequired(true).setMinValue(1).setMaxValue(MAX_LEVEL),
          )
          .addRoleOption((opt) => opt.setName('role').setDescription('Role to give').setRequired(true)),
      )
      .addSubcommand((sub) =>
        sub
          .setName('remove')
          .setDescription('Stop giving a role as a level reward (members keep it).')
          .addRoleOption((opt) => opt.setName('role').setDescription('Reward role').setRequired(true)),
      )
      .addSubcommand((sub) => sub.setName('list').setDescription('Show the role rewards.')),
  )
  .addSubcommand((sub) =>
    sub
      .setName('announce')
      .setDescription('Where level-up messages go.')
      .addStringOption((opt) =>
        opt
          .setName('where')
          .setDescription('Where to post level-ups')
          .setRequired(true)
          .addChoices(
            { name: 'The channel they chatted in', value: 'here' },
            { name: 'A specific channel', value: 'channel' },
            { name: 'Nowhere (off)', value: 'off' },
          ),
      )
      .addChannelOption((opt) =>
        opt
          .setName('channel')
          .setDescription('Channel for level-ups (with "A specific channel")')
          .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('givexp')
      .setDescription('Add or remove XP for a member.')
      .addUserOption((opt) => opt.setName('user').setDescription('Member').setRequired(true))
      .addIntegerOption((opt) =>
        opt.setName('xp').setDescription('XP to add (negative to remove)').setRequired(true).setMinValue(-1_000_000).setMaxValue(1_000_000),
      ),
  );

// ----- Runtime -----

export function setupLevels(client, store, { random = Math.random } = {}) {
  const announceKey = (guildId) => `levels:announce:${guildId}`;

  /** Give `member` every reward role for `level` they don't already have. Returns the roles added. */
  async function grantRewards(member, level) {
    const due = store.getLevelRewards(member.guild.id).filter((r) => r.level <= level);
    const added = [];
    for (const { roleId } of due) {
      if (member.roles.cache.has(roleId)) continue;
      const role = member.guild.roles.cache.get(roleId);
      if (!role) continue;
      if (!role.editable) {
        console.warn(`Can't give level reward @${role.name}: it is above my highest role or I lack Manage Roles.`);
        continue;
      }
      try {
        await member.roles.add(role, `Reached level ${level}`);
        added.push(roleId);
      } catch (error) {
        console.error(`Failed to give @${role.name} to ${member.id}:`, error);
      }
    }
    return added;
  }

  async function announce(message, level, roleIds) {
    const mode = store.getMeta(announceKey(message.guildId)) ?? 'here';
    if (mode === 'off') return;
    const channel = mode === 'here' ? message.channel : await client.channels.fetch(mode).catch(() => null);
    if (!channel?.isTextBased()) return;
    await channel.send({
      content: levelUpText(message.author.id, level, roleIds),
      allowedMentions: { users: [message.author.id] },
    });
  }

  /** Award XP for a counted message and handle level-ups. */
  async function onMessage(message) {
    const { guildId } = message;
    const userId = message.author.id;
    const now = message.createdTimestamp ?? Date.now();
    const before = store.getLevel(guildId, userId);
    if (before.lastXpAt && now - before.lastXpAt < XP_COOLDOWN_MS) return;

    const after = store.addXp(guildId, userId, randomXp(random), { messages: 1, at: now });
    const oldLevel = levelFromXp(before.xp).level;
    const newLevel = levelFromXp(after).level;
    if (newLevel <= oldLevel) return;

    console.log(`${message.author.tag} reached level ${newLevel}.`);
    const member = message.member ?? (await message.guild.members.fetch(userId).catch(() => null));
    const added = member ? await grantRewards(member, newLevel) : [];
    await announce(message, newLevel, added);
  }

  /** Rejoining members get back the reward roles for their level. */
  async function onMemberAdd(member) {
    const { xp } = store.getLevel(member.guild.id, member.id);
    if (xp > 0) await grantRewards(member, levelFromXp(xp).level);
  }

  function nextRewardFor(guild, level) {
    const next = store.getLevelRewards(guild.id).find((r) => r.level > level);
    const role = next && guild.roles.cache.get(next.roleId);
    return role ? { name: `@${role.name}`, level: next.level } : null;
  }

  async function onRank(interaction) {
    const user = interaction.options.getUser('user') ?? interaction.user;
    if (user.bot) {
      return interaction.reply({ content: 'Bots don’t earn XP.', flags: MessageFlags.Ephemeral });
    }
    await interaction.deferReply();
    const member = await interaction.guild.members.fetch(user.id).catch(() => null);
    const { xp } = store.getLevel(interaction.guildId, user.id);
    const avatar = await fetchImage(
      (member ?? user).displayAvatarURL({ extension: 'png', size: 256, forceStatic: true }),
    );
    const png = renderRankCard({
      name: member?.displayName ?? user.displayName ?? user.username,
      avatar,
      xp,
      rank: xp > 0 ? store.getRank(interaction.guildId, xp) : store.getRankedCount(interaction.guildId) + 1,
      nextReward: nextRewardFor(interaction.guild, levelFromXp(xp).level),
    });
    return interaction.editReply({ files: [new AttachmentBuilder(png, { name: 'rank.png' })] });
  }

  async function onLeaderboard(interaction) {
    const guildId = interaction.guildId;
    const total = store.getRankedCount(guildId);
    if (!total) {
      return interaction.reply({ content: 'Nobody has earned XP yet. Start chatting! 💬', flags: MessageFlags.Ephemeral });
    }
    const pages = Math.ceil(total / PAGE_SIZE);
    const page = Math.min(interaction.options.getInteger('page') ?? 1, pages);
    const rows = store.getLeaderboard(guildId, PAGE_SIZE, (page - 1) * PAGE_SIZE);
    const medals = ['🥇', '🥈', '🥉'];
    const lines = rows.map((row, i) => {
      const position = (page - 1) * PAGE_SIZE + i + 1;
      const badge = medals[position - 1] ?? `**${position}.**`;
      const { level } = levelFromXp(row.xp);
      return `${badge} <@${row.userId}> · Level **${level}** · ${row.xp.toLocaleString('en-US')} XP`;
    });

    const mine = store.getLevel(guildId, interaction.user.id);
    const you = mine.xp
      ? `You're #${store.getRank(guildId, mine.xp)} at level ${levelFromXp(mine.xp).level}`
      : 'Chat to get on the board';
    const embed = new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle(`🏆 ${interaction.guild.name} leaderboard`)
      .setDescription(lines.join('\n'))
      .setFooter({ text: `Page ${page}/${pages} · ${you}` });
    return interaction.reply({ embeds: [embed], allowedMentions: { parse: [] } });
  }

  async function onLevels(interaction) {
    const guild = interaction.guild;
    const group = interaction.options.getSubcommandGroup(false);
    const sub = interaction.options.getSubcommand();

    if (group === 'reward' && sub === 'add') {
      const level = interaction.options.getInteger('level', true);
      const role = interaction.options.getRole('role', true);
      if (role.id === guild.id || role.managed) {
        return interaction.reply({ content: `⚠️ ${role} can't be given out as a reward.`, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
      }
      const real = guild.roles.cache.get(role.id);
      if (!real?.editable) {
        return interaction.reply({
          content: `⚠️ I can't give ${role}. Give me **Manage Roles** and drag my role above it in Server Settings → Roles.`,
          flags: MessageFlags.Ephemeral,
          allowedMentions: { parse: [] },
        });
      }
      store.setLevelReward(guild.id, role.id, level);
      await interaction.deferReply();

      // Members already at that level get it now.
      let given = 0;
      for (const { userId, xp } of store.getUsersWithXp(guild.id, totalXpForLevel(level))) {
        const member = await guild.members.fetch(userId).catch(() => null);
        if (member && (await grantRewards(member, levelFromXp(xp).level)).includes(role.id)) given += 1;
      }
      const already = given ? ` Gave it to ${given} member${given === 1 ? '' : 's'} who were already there.` : '';
      return interaction.editReply({
        content: `✅ Members get ${role} at **level ${level}** (${totalXpForLevel(level).toLocaleString('en-US')} XP).${already}`,
        allowedMentions: { parse: [] },
      });
    }

    if (group === 'reward' && sub === 'remove') {
      const role = interaction.options.getRole('role', true);
      const removed = store.deleteLevelReward(guild.id, role.id);
      return interaction.reply({
        content: removed ? `🗑️ ${role} is no longer a level reward. Members who have it keep it.` : `${role} isn't a level reward.`,
        allowedMentions: { parse: [] },
      });
    }

    if (group === 'reward' && sub === 'list') {
      const rewards = store.getLevelRewards(guild.id);
      const content = rewards.length
        ? `**Level rewards**\n${rewards.map((r) => `Level **${r.level}** → <@&${r.roleId}>`).join('\n')}`
        : 'No level rewards yet. Add one with `/levels reward add level:5 role:@Self Promo`.';
      return interaction.reply({ content, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
    }

    if (sub === 'announce') {
      const where = interaction.options.getString('where', true);
      const channel = interaction.options.getChannel('channel');
      if (where === 'channel' && !channel) {
        return interaction.reply({ content: '⚠️ Pick the channel too.', flags: MessageFlags.Ephemeral });
      }
      store.setMeta(announceKey(guild.id), where === 'channel' ? channel.id : where);
      const text = {
        here: 'Level-ups will be posted in the channel where the member chatted.',
        channel: `Level-ups will be posted in ${channel}.`,
        off: 'Level-up messages are off (roles are still given).',
      }[where];
      return interaction.reply({ content: `✅ ${text}`, flags: MessageFlags.Ephemeral });
    }

    // givexp
    const user = interaction.options.getUser('user', true);
    const amount = interaction.options.getInteger('xp', true);
    if (user.bot) return interaction.reply({ content: 'Bots don’t earn XP.', flags: MessageFlags.Ephemeral });
    const before = store.getLevel(guild.id, user.id).xp;
    const after = store.addXp(guild.id, user.id, amount);
    const level = levelFromXp(after).level;
    const member = await guild.members.fetch(user.id).catch(() => null);
    const added = member ? await grantRewards(member, level) : [];
    const roles = added.length ? ` and got ${added.map((id) => `<@&${id}>`).join(', ')}` : '';
    return interaction.reply({
      content: `✅ ${user} now has ${after.toLocaleString('en-US')} XP (was ${before.toLocaleString('en-US')}), level **${level}**${roles}.`,
      allowedMentions: { parse: [] },
    });
  }

  async function onCommand(interaction) {
    if (interaction.commandName === 'rank') return onRank(interaction);
    if (interaction.commandName === 'leaderboard') return onLeaderboard(interaction);
    return onLevels(interaction);
  }

  return { onMessage, onMemberAdd, onCommand };
}
