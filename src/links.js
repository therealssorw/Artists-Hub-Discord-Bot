/**
 * Link gate: members need LINK_MIN_MESSAGES messages (50 by default) before
 * they can post links. A link from someone below that is removed and the bot
 * tells them how far they have to go. GIFs (Tenor, Giphy, Klipy, or any .gif
 * URL) are always allowed, as are attachments. Moderators (Manage Messages)
 * and LINK_EXEMPT_ROLE_IDS are exempt.
 *
 * Reading links needs the Message Content intent, and deleting them needs the
 * Manage Messages permission.
 */
import { PermissionFlagsBits } from 'discord.js';

import { config } from './config.js';

const URL_PATTERN = /\b(?:https?:\/\/|www\.)[^\s<>]+|\b(?:discord\.gg|discord(?:app)?\.com\/invite)\/[\w-]+/gi;
const GIF_HOSTS = ['tenor.com', 'giphy.com', 'klipy.com', 'gfycat.com'];
/** The warning is deleted after this long to keep the channel tidy. */
const WARNING_LIFETIME_MS = 15 * 1000;
/** At most one warning per member in this window, so link spam does not become warning spam. */
const WARNING_COOLDOWN_MS = 30 * 1000;

/** Every link-looking thing in `text`. */
export function findLinks(text) {
  return [...String(text ?? '').matchAll(URL_PATTERN)].map((m) => m[0].replace(/[)\].,!?'"]+$/, ''));
}

/** Is this link a GIF (always allowed)? */
export function isGifLink(link) {
  let url;
  try {
    url = new URL(/^https?:\/\//i.test(link) ? link : `https://${link}`);
  } catch {
    return false;
  }
  const host = url.hostname.toLowerCase();
  if (GIF_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))) return true;
  return /\.gifv?$/i.test(url.pathname);
}

/** Links in `text` that are not GIFs. */
export function blockedLinks(text) {
  return findLinks(text).filter((link) => !isGifLink(link));
}

export function warningText(userId, count, required) {
  const left = required - count;
  return (
    `👋 <@${userId}>, links unlock after **${required} messages** so we know you're not a spam bot. ` +
    `You're at ${count}, just ${left} more to go! Chat with everyone for a bit and try again. ` +
    'GIFs are always fine. 🎨'
  );
}

export function setupLinkGate(store) {
  /** userId -> time of the last warning */
  const lastWarned = new Map();

  function isExempt(member) {
    if (!member) return false;
    if (member.permissions?.has(PermissionFlagsBits.ManageMessages)) return true;
    return config.linkExemptRoleIds.some((id) => member.roles?.cache?.has(id));
  }

  async function warn(message, count) {
    const now = Date.now();
    if (now - (lastWarned.get(message.author.id) ?? 0) < WARNING_COOLDOWN_MS) return;
    lastWarned.set(message.author.id, now);
    const notice = await message.channel.send({
      content: warningText(message.author.id, count, config.linkMinMessages),
      allowedMentions: { users: [message.author.id] },
    });
    setTimeout(() => notice.delete().catch(() => {}), WARNING_LIFETIME_MS);
  }

  /**
   * Remove `message` if it has a non-GIF link and its author has not sent
   * enough messages yet. Returns true when the message was removed.
   */
  async function check(message) {
    if (config.linkMinMessages <= 0) return false;
    if (!message.inGuild() || message.author?.bot || message.system) return false;
    if (!blockedLinks(message.content).length) return false;
    if (isExempt(message.member)) return false;

    const count = store.getUserMessageCount(message.author.id);
    if (count >= config.linkMinMessages) return false;

    try {
      await message.delete();
    } catch (error) {
      console.error(`Could not remove a link from ${message.author.id} (missing Manage Messages?):`, error.message);
      return false;
    }
    console.log(`Removed a link from ${message.author.tag} (${count}/${config.linkMinMessages} messages).`);
    try {
      await warn(message, count);
    } catch (error) {
      console.error('Failed to send the link warning:', error);
    }
    return true;
  }

  return { check };
}
