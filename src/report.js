import { EmbedBuilder } from 'discord.js';
import { formatDayKey } from './time.js';

const number = new Intl.NumberFormat('en-US');
const decimal = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 });

export function formatGrowth(pct) {
  if (pct === null || Number.isNaN(pct)) return 'n/a (no prior data)';
  const sign = pct > 0 ? '+' : pct < 0 ? '−' : '±';
  return `${sign}${decimal.format(Math.abs(pct))}%`;
}

function growthEmoji(pct) {
  if (pct === null || Number.isNaN(pct)) return '➖';
  if (pct > 0) return '📈';
  if (pct < 0) return '📉';
  return '➖';
}

/**
 * Turn the output of computeStats() into a Discord embed.
 *
 * @param {import('./stats.js').computeStats extends (...a: any) => infer R ? R : never} stats
 * @param {{ title?: string, partial?: boolean }} [options]
 *   `partial` marks the day as still in progress (used by /stats for "today").
 */
export function buildReportEmbed(stats, { title, partial = false } = {}) {
  const { today, members, window, previous, growth, windowDays } = stats;

  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle(title ?? `📊 Daily Stats — ${formatDayKey(stats.day)}`)
    .addFields(
      {
        name: partial ? '💬 Messages (so far today)' : '💬 Messages',
        value: number.format(today.messages),
        inline: true,
      },
      {
        name: partial ? '👥 Returning senders (so far today)' : '👥 Returning senders',
        value: number.format(Math.max(0, today.uniqueSenders - members.firstTimeSenders)),
        inline: true,
      },
      {
        name: partial ? '🆕 New senders (so far today)' : '🆕 New senders',
        value: `${number.format(members.firstTimeSenders)}\n-# first message ever`,
        inline: true,
      },
      {
        name: partial ? '👋 Joined (so far today)' : '👋 Joined',
        value: number.format(members.joins),
        inline: true,
      },
      {
        name: partial ? '🚪 Left (so far today)' : '🚪 Left',
        value: number.format(members.leaves),
        inline: true,
      },
      { name: '​', value: '​', inline: true },
      {
        name: `📆 ${windowDays}-day average`,
        value:
          `**${decimal.format(window.avgMessages)}** messages / day\n` +
          `**${decimal.format(window.avgUniqueSenders)}** unique senders / day\n-# returning + new`,
        inline: true,
      },
      {
        name: `${growthEmoji(growth.messages)} Growth vs. previous ${windowDays} days`,
        value:
          `Messages: **${formatGrowth(growth.messages)}**` +
          (growth.messages === null ? '' : ` (was ${decimal.format(previous.avgMessages)} / day)`) +
          `\nUnique senders: **${formatGrowth(growth.uniqueSenders)}**` +
          (growth.uniqueSenders === null
            ? ''
            : ` (was ${decimal.format(previous.avgUniqueSenders)} / day)`),
        inline: true,
      },
    )
    .setTimestamp();

  const notes = [];
  if (window.days < windowDays) {
    notes.push(`Average based on ${window.days} tracked day${window.days === 1 ? '' : 's'}`);
  }
  if (stats.trackingSince) {
    notes.push(`Tracking since ${stats.trackingSince}`);
  }
  if (notes.length) {
    embed.setFooter({ text: notes.join(' • ') });
  }

  return embed;
}
