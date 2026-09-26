import { shiftDay } from './time.js';

/**
 * Number of calendar days in [from, to] (inclusive) that were being tracked,
 * i.e. on or after `trackingSince`. Days before tracking began are excluded so
 * a bot that was started recently does not average in a pile of empty days.
 */
function trackedDays(from, to, trackingSince) {
  const start = trackingSince && trackingSince > from ? trackingSince : from;
  if (start > to) return 0;
  const [fy, fm, fd] = start.split('-').map(Number);
  const [ty, tm, td] = to.split('-').map(Number);
  const ms = Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd);
  return Math.round(ms / 86_400_000) + 1;
}

function windowSummary(store, from, to, trackingSince) {
  const rows = store.getRange(from, to);
  const days = trackedDays(from, to, trackingSince);
  const messages = rows.reduce((sum, r) => sum + r.messages, 0);
  const uniqueSenders = rows.reduce((sum, r) => sum + r.uniqueSenders, 0);
  return {
    from,
    to,
    days,
    messages,
    uniqueSenders,
    avgMessages: days ? messages / days : 0,
    avgUniqueSenders: days ? uniqueSenders / days : 0,
  };
}

/** Percentage change from `previous` to `current`, or null when undefined. */
export function percentChange(current, previous) {
  if (!previous) return null;
  return ((current - previous) / previous) * 100;
}

/**
 * Build the numbers behind a stats report for `day`.
 *
 * - `day`: totals for that single day
 * - `window`: the `windowDays` days ending on `day` (inclusive)
 * - `previous`: the `windowDays` days immediately before `window`
 * - `growth`: percentage change of the window's daily averages vs `previous`
 */
export function computeStats(store, day, windowDays = 30) {
  const trackingSince = store.getTrackingSince() ?? store.getFirstDay();

  const windowFrom = shiftDay(day, -(windowDays - 1));
  const previousTo = shiftDay(windowFrom, -1);
  const previousFrom = shiftDay(previousTo, -(windowDays - 1));

  const window = windowSummary(store, windowFrom, day, trackingSince);
  const previous = windowSummary(store, previousFrom, previousTo, trackingSince);

  return {
    day,
    windowDays,
    trackingSince,
    today: store.getDay(day),
    members: {
      ...store.getMemberEvents(day),
      firstTimeSenders: store.getFirstTimeSenders(day),
    },
    window,
    previous,
    growth: {
      messages: percentChange(window.avgMessages, previous.avgMessages),
      uniqueSenders: percentChange(window.avgUniqueSenders, previous.avgUniqueSenders),
    },
  };
}
