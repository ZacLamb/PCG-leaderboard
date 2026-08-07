/**
 * Date range resolution for the leaderboard filters.
 *
 * All ranges are computed in a fixed reporting timezone (REPORT_TZ) rather than
 * the server's local time, so a Railway container in UTC and a broker in New
 * York agree on which deals belong to "this month".
 */

const MS_DAY = 24 * 60 * 60 * 1000;

/** Current date parts (y/m/d) in the reporting timezone. */
function nowParts(tz) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const [y, m, d] = fmt.format(new Date()).split('-').map(Number);
  return { year: y, month: m - 1, day: d };
}

/**
 * Build a UTC instant for a wall-clock time in the given timezone.
 * Uses a two-pass correction to account for the zone's UTC offset.
 */
function zonedTime(tz, year, month, day, h = 0, min = 0, s = 0, ms = 0) {
  const guess = Date.UTC(year, month, day, h, min, s, ms);
  const asUTC = new Date(guess);

  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });

  const parts = Object.fromEntries(
    fmt.formatToParts(asUTC).filter((p) => p.type !== 'literal').map((p) => [p.type, Number(p.value)])
  );

  const rendered = Date.UTC(
    parts.year, parts.month - 1, parts.day,
    parts.hour % 24, parts.minute, parts.second
  );

  return new Date(guess - (rendered - guess));
}

function startOfMonth(tz, year, month) {
  return zonedTime(tz, year, month, 1, 0, 0, 0, 0);
}

function endOfMonth(tz, year, month) {
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return zonedTime(tz, year, month, lastDay, 23, 59, 59, 999);
}

/**
 * Resolve a filter spec into { start, end, label }.
 *
 * Supported:
 *   { preset: 'mtd' }                              current month to date
 *   { preset: 'last30' | 'last60' | 'last90' }     rolling window ending now
 *   { preset: 'lastMonth' }                        previous full calendar month
 *   { preset: 'ytd' }                              Jan 1 -> now
 *   { month: '2026-02' }                           one specific month, full
 *   { from: '2026-01', to: '2026-03' }             span of months, inclusive
 *   { start: '2026-01-15', to: '2026-02-04' }      explicit day range
 */
export function resolveRange(spec = {}, tz = 'America/New_York') {
  const { year, month, day } = nowParts(tz);
  const now = new Date();

  const MONTHS = ['January','February','March','April','May','June',
                  'July','August','September','October','November','December'];

  // Explicit day-level range
  if (spec.start && spec.end) {
    const [sy, sm, sd] = spec.start.split('-').map(Number);
    const [ey, em, ed] = spec.end.split('-').map(Number);
    return {
      start: zonedTime(tz, sy, sm - 1, sd, 0, 0, 0, 0),
      end: zonedTime(tz, ey, em - 1, ed, 23, 59, 59, 999),
      label: `${spec.start} → ${spec.end}`,
      preset: 'custom',
    };
  }

  // Span of months, inclusive
  if (spec.from && spec.to) {
    const [fy, fm] = spec.from.split('-').map(Number);
    const [ty, tm] = spec.to.split('-').map(Number);
    return {
      start: startOfMonth(tz, fy, fm - 1),
      end: endOfMonth(tz, ty, tm - 1),
      label: `${MONTHS[fm - 1]} ${fy} → ${MONTHS[tm - 1]} ${ty}`,
      preset: 'monthRange',
    };
  }

  // One specific month
  if (spec.month) {
    const [my, mm] = spec.month.split('-').map(Number);
    const isCurrent = my === year && mm - 1 === month;
    return {
      start: startOfMonth(tz, my, mm - 1),
      end: isCurrent ? now : endOfMonth(tz, my, mm - 1),
      label: `${MONTHS[mm - 1]} ${my}${isCurrent ? ' (MTD)' : ''}`,
      preset: isCurrent ? 'mtd' : 'month',
    };
  }

  const preset = spec.preset || 'mtd';

  switch (preset) {
    case 'last30':
    case 'last60':
    case 'last90': {
      const days = Number(preset.replace('last', ''));
      return {
        start: new Date(now.getTime() - days * MS_DAY),
        end: now,
        label: `Last ${days} days`,
        preset,
      };
    }

    case 'lastMonth': {
      const pm = month === 0 ? 11 : month - 1;
      const py = month === 0 ? year - 1 : year;
      return {
        start: startOfMonth(tz, py, pm),
        end: endOfMonth(tz, py, pm),
        label: `${MONTHS[pm]} ${py}`,
        preset,
      };
    }

    case 'ytd':
      return {
        start: startOfMonth(tz, year, 0),
        end: now,
        label: `${year} Year to Date`,
        preset,
      };

    case 'all':
      return { start: new Date(0), end: now, label: 'All time', preset };

    case 'mtd':
    default:
      return {
        start: startOfMonth(tz, year, month),
        end: now,
        label: `${MONTHS[month]} 1–${day}, ${year}`,
        preset: 'mtd',
      };
  }
}

/** Months present in the data, newest first, for the dropdown. */
export function availableMonths(rows) {
  const seen = new Map();

  for (const r of rows) {
    if (!r.fundedDate) continue;
    const d = new Date(r.fundedDate);
    if (isNaN(d.getTime())) continue;
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    seen.set(key, (seen.get(key) || 0) + 1);
  }

  return [...seen.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.key.localeCompare(a.key));
}
