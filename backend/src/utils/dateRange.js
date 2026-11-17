import { ApiError } from './ApiError.js';

// A plain date (YYYY-MM-DD) is that calendar day here, from its first
// moment -- new Date('2026-10-31') would be midnight UTC, i.e. the evening
// before (or the morning of) the day the user picked, depending on the zone.
function parseDate(value) {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value));
  return d ? new Date(Number(d[1]), Number(d[2]) - 1, Number(d[3])) : new Date(value);
}

// Resolves a named range (today/week/month/year) or explicit from/to query
// params into a concrete [start, end) Date pair using the server's local
// timezone consistently, so daily/weekly/monthly/yearly reports behave the
// same way everywhere in the app.

export function resolveDateRange({ range, from, to }) {
  const now = new Date();

  if (from || to) {
    const start = from ? parseDate(from) : new Date(0);
    const end = to ? parseDate(to) : now;
    // include the whole "to" day if only a date (no time) was supplied
    if (to && to.length <= 10) end.setHours(23, 59, 59, 999);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) throw new ApiError(400, 'Choose valid dates.');
    // Picked the wrong way round: read it as the span between the two days.
    if (start > end) {
      const first = to ? parseDate(to) : new Date(0);
      const last = from ? parseDate(from) : now;
      last.setHours(23, 59, 59, 999);
      return { start: first, end: last };
    }
    return { start, end };
  }

  switch (range) {
    case 'today': {
      const start = new Date(now);
      start.setHours(0, 0, 0, 0);
      const end = new Date(now);
      end.setHours(23, 59, 59, 999);
      return { start, end };
    }
    case 'yesterday': {
      const start = new Date(now);
      start.setDate(start.getDate() - 1);
      start.setHours(0, 0, 0, 0);
      const end = new Date(now);
      end.setDate(end.getDate() - 1);
      end.setHours(23, 59, 59, 999);
      return { start, end };
    }
    case 'week': {
      const start = new Date(now);
      const day = start.getDay();
      const diff = (day + 6) % 7; // Monday as start of week
      start.setDate(start.getDate() - diff);
      start.setHours(0, 0, 0, 0);
      const end = new Date(now);
      end.setHours(23, 59, 59, 999);
      return { start, end };
    }
    case 'month': {
      const start = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
      const end = new Date(now);
      end.setHours(23, 59, 59, 999);
      return { start, end };
    }
    case 'year': {
      const start = new Date(now.getFullYear(), 0, 1, 0, 0, 0, 0);
      const end = new Date(now);
      end.setHours(23, 59, 59, 999);
      return { start, end };
    }
    default: {
      // default to "today"
      const start = new Date(now);
      start.setHours(0, 0, 0, 0);
      const end = new Date(now);
      end.setHours(23, 59, 59, 999);
      return { start, end };
    }
  }
}
