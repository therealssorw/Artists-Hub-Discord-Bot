/**
 * Date helpers. A "day key" is a YYYY-MM-DD string for a calendar day in the
 * configured timezone, so day boundaries line up with local midnight rather
 * than UTC midnight.
 */

const formatters = new Map();

function formatter(timezone) {
  let f = formatters.get(timezone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    formatters.set(timezone, f);
  }
  return f;
}

/** Day key (YYYY-MM-DD) for a Date in the given timezone. */
export function dayKey(date, timezone) {
  const parts = formatter(timezone).formatToParts(date);
  const get = (type) => parts.find((p) => p.type === type).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** Day key for right now in the given timezone. */
export function todayKey(timezone, now = new Date()) {
  return dayKey(now, timezone);
}

/** Shift a day key by a number of days (negative to go backwards). */
export function shiftDay(key, days) {
  const [y, m, d] = key.split('-').map(Number);
  const shifted = new Date(Date.UTC(y, m - 1, d + days));
  return shifted.toISOString().slice(0, 10);
}

/** Human friendly label such as "Saturday, September 13, 2026". */
export function formatDayKey(key) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', {
    timeZone: 'UTC',
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}
