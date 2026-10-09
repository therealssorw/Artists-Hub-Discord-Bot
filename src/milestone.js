/**
 * Member milestones.
 *
 * When the server reaches a milestone member count (100 by default), the bot
 * renders a snapshot card of the moment (server icon and name, the count, when
 * it happened, the member who tipped it over and the latest arrivals) and posts
 * it in the milestone channel, pinging the server owner. Each milestone is
 * announced once; the fact is stored in the meta table so restarts and
 * leave/rejoin churn around the threshold do not repeat it.
 */
import { createRequire } from 'node:module';

import { GlobalFonts, createCanvas, loadImage } from '@napi-rs/canvas';
import { AttachmentBuilder, MessageFlags, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';

import { config } from './config.js';

const require = createRequire(import.meta.url);
const FONT = 'DejaVu Sans';
GlobalFonts.registerFromPath(require.resolve('dejavu-fonts-ttf/ttf/DejaVuSans.ttf'), FONT);
GlobalFonts.registerFromPath(require.resolve('dejavu-fonts-ttf/ttf/DejaVuSans-Bold.ttf'), FONT);

const WIDTH = 1200;
const HEIGHT = 675;
const RECENT_AVATARS = 10;

export const milestoneCommand = new SlashCommandBuilder()
  .setName('milestone')
  .setDescription('Member milestone announcements.')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .setDMPermission(false)
  .addSubcommand((sub) =>
    sub
      .setName('preview')
      .setDescription('Show the snapshot that will be posted at the next milestone (only you see it).'),
  );

export function ordinal(n) {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  return `${n}${{ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] ?? 'th'}`;
}

/** Milestones newly reached at `count` that have not been announced yet. */
export function reachedMilestones(milestones, count, isAnnounced) {
  return milestones.filter((m) => count >= m && !isAnnounced(m));
}

function circleImage(ctx, image, x, y, size, fallbackText) {
  ctx.save();
  ctx.beginPath();
  ctx.arc(x + size / 2, y + size / 2, size / 2, 0, Math.PI * 2);
  ctx.closePath();
  ctx.clip();
  if (image) {
    ctx.drawImage(image, x, y, size, size);
  } else {
    ctx.fillStyle = '#5865f2';
    ctx.fillRect(x, y, size, size);
    ctx.fillStyle = '#ffffff';
    ctx.font = `bold ${Math.round(size * 0.42)}px "${FONT}"`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText((fallbackText || '?').slice(0, 1).toUpperCase(), x + size / 2, y + size / 2 + 2);
  }
  ctx.restore();
}

function ring(ctx, x, y, size, color, width) {
  ctx.save();
  ctx.beginPath();
  ctx.arc(x + size / 2, y + size / 2, size / 2 + width / 2, 0, Math.PI * 2);
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.stroke();
  ctx.restore();
}

/** Shrink `text` until it fits in `maxWidth`, adding an ellipsis if it must be cut. */
function fitText(ctx, text, maxWidth) {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let cut = text;
  while (cut.length > 1 && ctx.measureText(`${cut}…`).width > maxWidth) cut = cut.slice(0, -1);
  return `${cut}…`;
}

/** Deterministic confetti so every render of the same milestone looks the same. */
function confetti(ctx, seed) {
  let s = seed;
  const rand = () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
  const colors = ['#5865f2', '#eb459e', '#fee75c', '#57f287', '#ed4245', '#ffffff'];
  for (let i = 0; i < 90; i += 1) {
    const x = rand() * WIDTH;
    const y = rand() * HEIGHT;
    // Keep the middle readable.
    if (x > 160 && x < WIDTH - 160 && y > 110 && y < HEIGHT - 150) continue;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(rand() * Math.PI);
    ctx.globalAlpha = 0.35 + rand() * 0.5;
    ctx.fillStyle = colors[Math.floor(rand() * colors.length)];
    ctx.fillRect(-6, -2.5, 12, 5);
    ctx.restore();
  }
}

/**
 * Render the milestone snapshot as a PNG buffer. Images are already-loaded
 * canvas images or null (a coloured initial is drawn instead).
 */
export function renderMilestoneCard({
  guildName,
  guildIcon = null,
  milestone,
  count,
  reachedAt,
  timezone,
  featured = null, // { name, avatar, label }
  recent = [], // [{ name, avatar }]
}) {
  const canvas = createCanvas(WIDTH, HEIGHT);
  const ctx = canvas.getContext('2d');

  const bg = ctx.createLinearGradient(0, 0, WIDTH, HEIGHT);
  bg.addColorStop(0, '#1e1f3b');
  bg.addColorStop(1, '#111214');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);

  const glow = ctx.createRadialGradient(WIDTH / 2, 300, 20, WIDTH / 2, 300, 520);
  glow.addColorStop(0, 'rgba(88, 101, 242, 0.45)');
  glow.addColorStop(1, 'rgba(88, 101, 242, 0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);
  confetti(ctx, milestone);

  // Header: server icon and name.
  ctx.textBaseline = 'alphabetic';
  ctx.font = `bold 34px "${FONT}"`;
  const name = fitText(ctx, guildName, 760);
  const iconSize = 64;
  const headerWidth = iconSize + 18 + ctx.measureText(name).width;
  const headerX = (WIDTH - headerWidth) / 2;
  circleImage(ctx, guildIcon, headerX, 40, iconSize, guildName);
  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'left';
  ctx.fillText(name, headerX + iconSize + 18, 84);

  // The number.
  ctx.textAlign = 'center';
  ctx.fillStyle = '#ffffff';
  ctx.shadowColor = 'rgba(0, 0, 0, 0.45)';
  ctx.shadowBlur = 24;
  ctx.font = `bold 210px "${FONT}"`;
  ctx.fillText(String(milestone), WIDTH / 2, 320);
  ctx.shadowBlur = 0;
  ctx.font = `bold 40px "${FONT}"`;
  ctx.fillStyle = '#c9cdfb';
  ctx.fillText('M E M B E R S', WIDTH / 2, 380);

  const when = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(reachedAt);
  ctx.font = `24px "${FONT}"`;
  ctx.fillStyle = '#b5bac1';
  const countNote = count > milestone ? ` · ${count} members now` : '';
  ctx.fillText(fitText(ctx, `Reached ${when}${countNote}`, WIDTH - 120), WIDTH / 2, 428);

  // Featured member.
  if (featured) {
    const size = 56;
    ctx.font = `bold 26px "${FONT}"`;
    const label = `${featured.label}: `;
    const memberName = fitText(ctx, featured.name, 520);
    const labelWidth = ctx.measureText(label).width;
    ctx.font = `26px "${FONT}"`;
    const total = size + 16 + labelWidth + ctx.measureText(memberName).width;
    const x = (WIDTH - total) / 2;
    circleImage(ctx, featured.avatar, x, 462, size, featured.name);
    ring(ctx, x, 462, size, '#fee75c', 3);
    ctx.textAlign = 'left';
    ctx.font = `bold 26px "${FONT}"`;
    ctx.fillStyle = '#fee75c';
    ctx.fillText(label, x + size + 16, 500);
    ctx.font = `26px "${FONT}"`;
    ctx.fillStyle = '#ffffff';
    ctx.fillText(memberName, x + size + 16 + labelWidth, 500);
  }

  // Latest arrivals.
  const shown = recent.slice(0, RECENT_AVATARS);
  if (shown.length) {
    const size = 52;
    const gap = 14;
    const rowWidth = shown.length * size + (shown.length - 1) * gap;
    let x = (WIDTH - rowWidth) / 2;
    ctx.textAlign = 'center';
    ctx.font = `18px "${FONT}"`;
    ctx.fillStyle = '#949ba4';
    ctx.fillText('Latest arrivals', WIDTH / 2, 572);
    for (const member of shown) {
      circleImage(ctx, member.avatar, x, 590, size, member.name);
      x += size + gap;
    }
  }

  return canvas.toBuffer('image/png');
}

async function fetchImage(url) {
  if (!url) return null;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return await loadImage(Buffer.from(await res.arrayBuffer()));
  } catch {
    return null;
  }
}

export function setupMilestones(client, store) {
  const metaKey = (guildId, milestone) => `milestone:${guildId}:${milestone}`;
  const isAnnounced = (guildId) => (m) => Boolean(store.getMeta(metaKey(guildId, m)));

  /** Snapshot card for `guild` at `milestone`, as a Discord attachment. */
  async function buildCard(guild, milestone, newest = null) {
    let members = [...guild.members.cache.values()];
    try {
      members = [...(await guild.members.fetch()).values()];
    } catch {
      // Without the Server Members intent only cached members are available.
    }
    const humans = members
      .filter((m) => !m.user.bot && m.joinedTimestamp)
      .sort((a, b) => b.joinedTimestamp - a.joinedTimestamp);
    const featuredMember = newest ?? humans[0] ?? null;
    const recent = humans.filter((m) => m.id !== featuredMember?.id).slice(0, RECENT_AVATARS);
    const avatarUrl = (m) => m.displayAvatarURL({ extension: 'png', size: 128, forceStatic: true });

    const [guildIcon, featuredAvatar, ...recentAvatars] = await Promise.all([
      fetchImage(guild.iconURL({ extension: 'png', size: 256, forceStatic: true })),
      featuredMember ? fetchImage(avatarUrl(featuredMember)) : null,
      ...recent.map((m) => fetchImage(avatarUrl(m))),
    ]);

    const count = guild.memberCount;
    const png = renderMilestoneCard({
      guildName: guild.name,
      guildIcon,
      milestone,
      count,
      reachedAt: new Date(),
      timezone: config.timezone,
      featured: featuredMember && {
        name: featuredMember.displayName,
        avatar: featuredAvatar,
        label: newest && count === milestone ? `${ordinal(milestone)} member` : 'Newest member',
      },
      recent: recent.map((m, i) => ({ name: m.displayName, avatar: recentAvatars[i] })),
    });
    return { file: new AttachmentBuilder(png, { name: `milestone-${milestone}.png` }), featuredMember };
  }

  async function announce(guild, milestone, newest) {
    const channel = await client.channels.fetch(config.milestoneChannelId);
    if (!channel?.isTextBased()) throw new Error(`Milestone channel ${config.milestoneChannelId} is not a text channel.`);
    const pingId = config.milestoneUserId || guild.ownerId;
    const { file, featuredMember } = await buildCard(guild, milestone, newest);
    const welcome =
      newest && featuredMember && guild.memberCount === milestone
        ? ` Welcome ${featuredMember}, our ${ordinal(milestone)} member!`
        : '';
    await channel.send({
      content: `🎉 <@${pingId}> **${guild.name} just hit ${milestone} members!**${welcome}`,
      files: [file],
      allowedMentions: { users: [pingId] },
    });
    console.log(`Announced the ${milestone}-member milestone in guild ${guild.id}.`);
  }

  /** Announce the highest milestone `guild` has newly reached, if any. */
  async function check(guild, newest = null) {
    if (config.guildId && guild.id !== config.guildId) return;
    const reached = reachedMilestones(config.milestones, guild.memberCount, isAnnounced(guild.id));
    if (!reached.length) return;
    // Mark before any await so two quick joins cannot both announce.
    for (const m of reached) store.setMeta(metaKey(guild.id, m), new Date().toISOString());
    const milestone = Math.max(...reached);
    try {
      await announce(guild, milestone, newest);
    } catch (error) {
      console.error(`Failed to announce the ${milestone}-member milestone:`, error);
      store.deleteMeta(metaKey(guild.id, milestone)); // try again on the next join or restart
    }
  }

  /** Startup: catch milestones reached while the bot was offline. */
  async function checkAll() {
    for (const guild of client.guilds.cache.values()) await check(guild);
  }

  function onMemberAdd(member) {
    if (member.user.bot) return check(member.guild);
    return check(member.guild, member);
  }

  async function onCommand(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const guild = interaction.guild;
    const count = guild.memberCount;
    const next = config.milestones.find((m) => !isAnnounced(guild.id)(m) && m > count);
    const milestone = next ?? config.milestones.at(-1);
    const { file } = await buildCard(guild, milestone);
    const pingId = config.milestoneUserId || guild.ownerId;
    const status = next
      ? `${count} members now, ${next - count} to go. At ${next} I'll post this in <#${config.milestoneChannelId}> and ping <@${pingId}>.`
      : `${count} members now; every configured milestone (${config.milestones.join(', ')}) has been reached.`;
    await interaction.editReply({ content: `Preview · ${status}`, files: [file], allowedMentions: { parse: [] } });
  }

  return { checkAll, onMemberAdd, onCommand };
}
