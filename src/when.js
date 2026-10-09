/**
 * Turn the `time` option of /remind into a timestamp.
 *
 * Two kinds of input are understood:
 *  - Durations, with abbreviations: "10m", "1h30m", "2 days", "1.5h", "in 3 wks",
 *    "an hour", "1d 6h". Units: s, m, h, d, w, mo (30 days), y (365 days).
 *  - Wall-clock times in the configured timezone: "3pm", "15:30", "noon",
 *    "tomorrow 9am", "fri 5pm", "next tue 8:30am", "oct 12 3pm", "12/25 8am",
 *    "2026-12-25 08:00". A day with no time means 9 AM ("tonight" means 8 PM);
 *    a time with no day means the next time the clock shows it.
 * Discord timestamps (<t:1760000000>) and raw Unix seconds also work.
 */

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export const MIN_AHEAD_MS = 5 * SECOND;
export const MAX_AHEAD_MS = 366 * DAY;

const UNITS = [
  [/^(s|secs?|seconds?)$/, SECOND],
  [/^(m|mins?|minutes?)$/, MINUTE],
  [/^(h|hrs?|hours?)$/, HOUR],
  [/^(d|days?)$/, DAY],
  [/^(w|wks?|weeks?)$/, 7 * DAY],
  [/^(mo|mos|mths?|months?)$/, 30 * DAY],
  [/^(y|yrs?|years?)$/, 365 * DAY],
];

const MONTHS = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const WEEKDAYS = '(sun(?:day)?|mon(?:day)?|tue(?:s(?:day)?)?|wed(?:nesday)?|thu(?:r(?:s(?:day)?)?)?|fri(?:day)?|sat(?:urday)?)';
const MONTH_KEYS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const WEEKDAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

export const EXAMPLES = '`10m`, `2h30m`, `3d`, `1w`, `3pm`, `tomorrow 9am`, `fri 5:30pm`, `oct 12 3pm`';

// ----- Timezone helpers -----

const partFormatters = new Map();

/** Wall-clock parts of a timestamp in `timezone`. */
export function wallParts(ms, timezone) {
  let f = partFormatters.get(timezone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hourCycle: 'h23',
      weekday: 'short',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    partFormatters.set(timezone, f);
  }
  const p = {};
  for (const { type, value } of f.formatToParts(ms)) p[type] = value;
  return {
    year: Number(p.year),
    month: Number(p.month),
    day: Number(p.day),
    hour: Number(p.hour),
    minute: Number(p.minute),
    second: Number(p.second),
    weekday: WEEKDAY_KEYS.indexOf(p.weekday.toLowerCase().slice(0, 3)),
  };
}

function offsetAt(ms, timezone) {
  const p = wallParts(ms, timezone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(ms / SECOND) * SECOND;
}

/**
 * Timestamp for a wall-clock time in `timezone`. Out-of-range fields roll over
 * like Date.UTC, so `day + 7` is a week later at the same local time.
 */
export function zonedTime(year, month, day, hour, minute, second, timezone) {
  const asUtc = Date.UTC(year, month - 1, day, hour, minute, second);
  const guess = asUtc - offsetAt(asUtc, timezone);
  return asUtc - offsetAt(guess, timezone);
}

// ----- Parsing -----

function parseDuration(s) {
  const text = s.replace(/^in\s+/, '').replace(/\b(and|from now|later)\b|[,+]/g, ' ');
  const token = /(?:^|(?<=[a-z\s]))(\d+(?:\.\d+)?|an?|one)\s*([a-z]+)/g;
  const tokens = [...text.matchAll(token)];
  if (!tokens.length || text.replace(token, ' ').trim()) return null;

  let total = 0;
  for (const [, amount, unit] of tokens) {
    const size = UNITS.find(([re]) => re.test(unit))?.[1];
    if (!size) return null;
    const n = /^\d/.test(amount) ? Number(amount) : 1;
    total += n * size;
  }
  return Math.round(total);
}

function monthIndex(name) {
  return MONTH_KEYS.indexOf(name.slice(0, 3));
}

function parseClock(s, now, timezone) {
  let rest = ` ${s} `;
  const take = (re) => {
    const m = rest.match(re);
    if (m) rest = rest.replace(m[0], ' ');
    return m;
  };

  const today = wallParts(now, timezone);
  let date = null; // { year?, month, day }
  let addDays = null;
  let weekday = null;
  let nextWeekday = false;
  let explicitToday = false;
  let defaultHour = 9;

  let m;
  if ((m = take(/\s(\d{4})-(\d{1,2})-(\d{1,2})\s/))) {
    date = { year: +m[1], month: +m[2], day: +m[3] };
  } else if ((m = take(/\s(\d{1,2})\/(\d{1,2})(?:\/(\d{2}|\d{4}))?\s/))) {
    const year = m[3] ? (m[3].length === 2 ? 2000 + +m[3] : +m[3]) : undefined;
    date = { year, month: +m[1], day: +m[2] };
  } else if ((m = take(new RegExp(`\\s${MONTHS}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?\\s`)))) {
    date = { year: m[3] ? +m[3] : undefined, month: monthIndex(m[1]) + 1, day: +m[2] };
  } else if ((m = take(new RegExp(`\\s(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTHS}\\.?(?:,?\\s+(\\d{4}))?\\s`)))) {
    date = { year: m[3] ? +m[3] : undefined, month: monthIndex(m[2]) + 1, day: +m[1] };
  } else if ((m = take(/\s(today|tonight|tod)\s/))) {
    addDays = 0;
    explicitToday = true;
    if (m[1] === 'tonight') defaultHour = 20;
  } else if ((m = take(/\s(tomorrow|tomorow|tmrw?|tmr|tom)\s/))) {
    addDays = 1;
  } else if ((m = take(new RegExp(`\\s(?:(next|this)\\s+)?${WEEKDAYS}\\s`)))) {
    weekday = WEEKDAY_KEYS.indexOf(m[2].slice(0, 3));
    nextWeekday = m[1] === 'next';
  }

  let time = null; // { hour, minute }
  if ((m = take(/\s(noon|midday)\s/))) {
    time = { hour: 12, minute: 0 };
  } else if ((m = take(/\s(midnight)\s/))) {
    time = { hour: 0, minute: 0 };
  } else if ((m = take(/\s(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.|a|p)\s/))) {
    let hour = +m[1];
    const minute = m[2] ? +m[2] : 0;
    if (hour < 1 || hour > 12 || minute > 59) return { error: `\`${m[0].trim()}\` is not a valid time.` };
    const pm = m[3].startsWith('p');
    if (hour === 12) hour = 0;
    if (pm) hour += 12;
    time = { hour, minute };
  } else if ((m = take(/\s(\d{1,2}):(\d{2})\s/))) {
    const hour = +m[1];
    const minute = +m[2];
    if (hour > 23 || minute > 59) return { error: `\`${m[0].trim()}\` is not a valid time.` };
    time = { hour, minute };
  }

  if (rest.replace(/\b(at|on|the|of|by)\b|[,@]/g, ' ').trim()) return null;
  if (!date && addDays === null && weekday === null && !time) return null;

  const hour = time ? time.hour : defaultHour;
  const minute = time ? time.minute : 0;
  const at = (year, month, day) => zonedTime(year, month, day, hour, minute, 0, timezone);

  if (date) {
    const { month, day } = date;
    let year = date.year ?? today.year;
    let ts = at(year, month, day);
    const check = wallParts(ts, timezone);
    if (month < 1 || month > 12 || check.month !== month || check.day !== day) {
      return { error: 'That date does not exist.' };
    }
    if (ts <= now && date.year === undefined) {
      year += 1;
      ts = at(year, month, day);
    }
    return { at: ts };
  }

  if (weekday !== null) {
    let ahead = (weekday - today.weekday + 7) % 7;
    if (ahead === 0 && (nextWeekday || at(today.year, today.month, today.day) <= now)) ahead = 7;
    return { at: at(today.year, today.month, today.day + ahead) };
  }

  if (addDays !== null) {
    const ts = at(today.year, today.month, today.day + addDays);
    if (explicitToday && ts <= now) return { error: 'That time has already passed today.' };
    return { at: ts };
  }

  // Only a time: the next time the clock shows it.
  let ts = at(today.year, today.month, today.day);
  if (ts <= now) ts = at(today.year, today.month, today.day + 1);
  return { at: ts };
}

/**
 * Parse `input` relative to `now`. Returns `{ at }` (a ms timestamp) or
 * `{ error }` with a message meant for the user.
 */
export function parseWhen(input, { now = Date.now(), timezone }) {
  const s = String(input ?? '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
  if (!s) return { error: `Tell me when, e.g. ${EXAMPLES}.` };

  let result = null;
  const stamp = s.match(/^<t:(\d+)(?::[a-z])?>$/i) ?? s.match(/^(\d{9,11})$/);
  if (stamp) {
    result = { at: Number(stamp[1]) * SECOND };
  } else {
    const duration = parseDuration(s);
    if (duration !== null) result = { at: now + duration };
    else result = parseClock(s, now, timezone);
  }

  if (!result) return { error: `I couldn't read \`${input}\` as a time. Try ${EXAMPLES}.` };
  if (result.error) return result;
  if (result.at - now < MIN_AHEAD_MS) return { error: 'That time is in the past (or a few seconds away).' };
  if (result.at - now > MAX_AHEAD_MS) return { error: 'Reminders can be set at most a year ahead.' };
  return result;
}

// ----- Repeats -----

export const REPEATS = {
  hourly: 'every hour',
  daily: 'every day',
  weekdays: 'every weekday',
  weekly: 'every week',
};

/** The first time after `at` that a reminder repeating `repeat` is due again. */
export function nextOccurrence(at, repeat, timezone) {
  if (repeat === 'hourly') return at + HOUR;
  const p = wallParts(at, timezone);
  const shift = (days) => zonedTime(p.year, p.month, p.day + days, p.hour, p.minute, p.second, timezone);
  if (repeat === 'daily') return shift(1);
  if (repeat === 'weekly') return shift(7);
  if (repeat === 'weekdays') {
    // Fri -> Mon (+3), Sat -> Mon (+2), anything else -> next day.
    const ahead = p.weekday === 5 ? 3 : p.weekday === 6 ? 2 : 1;
    return shift(ahead);
  }
  throw new Error(`Unknown repeat ${repeat}`);
}

// ----- Formatting -----

/** "2 days 3 hours", "45 minutes", "30 seconds": the two largest units. */
export function humanizeDuration(ms) {
  const parts = [];
  let rest = Math.max(0, Math.round(ms / SECOND)) * SECOND;
  for (const [name, size] of [['day', DAY], ['hour', HOUR], ['minute', MINUTE], ['second', SECOND]]) {
    const n = Math.floor(rest / size);
    if (n) parts.push(`${n} ${name}${n === 1 ? '' : 's'}`);
    rest -= n * size;
  }
  return parts.slice(0, 2).join(' ') || '0 seconds';
}

const previewFormatters = new Map();

/** "in 2 hours 30 minutes · Fri, Oct 9, 5:30 PM EDT" */
export function describeWhen(at, { now = Date.now(), timezone }) {
  let f = previewFormatters.get(timezone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZoneName: 'short',
    });
    previewFormatters.set(timezone, f);
  }
  return `in ${humanizeDuration(at - now)} · ${f.format(at)}`;
}
