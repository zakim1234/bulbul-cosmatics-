import Branch from '../models/Branch.js';
import { runWithBranch } from './branchContext.js';
import { closeDay, openDay, getBusinessDayStatus } from './dayCloseService.js';
import { logAudit } from './auditService.js';

// Auto Close Day: at 10:00 PM (business time) every open branch is closed
// on its own -- exactly what pressing Close Day does -- so a day the staff
// forgot to close never runs into the next one. Checked every minute from
// 22:00 until midnight; a branch already closed is left alone.
//
// Time zone: AUTO_CLOSE_TZ (default Africa/Mogadishu), hour: AUTO_CLOSE_HOUR
// (default 22). AUTO_CLOSE=off switches it off.
//
// Auto Open Day: at 6:00 AM (AUTO_OPEN_HOUR) a branch closed the night
// before opens on its own. A day closed by hand during the day (after 6:00)
// stays closed. AUTO_OPEN=off switches it off.

const TZ = process.env.AUTO_CLOSE_TZ || 'Africa/Mogadishu';
const HOUR = Number(process.env.AUTO_CLOSE_HOUR ?? 22);
const SYSTEM_USER = { _id: null, name: 'Auto close (10:00 PM)' };
const OPEN_HOUR = Number(process.env.AUTO_OPEN_HOUR ?? 6);
const OPEN_USER = { _id: null, name: 'Auto open (6:00 AM)' };
const AUTO_OPEN = String(process.env.AUTO_OPEN || '').toLowerCase() !== 'off';

// The business clock's date (YYYY-MM-DD) and hour, whatever the server's own time zone.
function businessNow(date = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' })
      .formatToParts(date)
      .map((p) => [p.type, p.value])
  );
  return { day: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) };
}

const doneToday = new Map(); // branch key -> day it was handled (closed, or reported as not closable)
let running = false;

async function closeBranch(branchId, label, day) {
  const key = String(branchId || 'single');
  if (doneToday.get(key) === day) return;
  await runWithBranch(branchId, async () => {
    const status = await getBusinessDayStatus();
    if (status.status === 'CLOSED') {
      doneToday.set(key, day);
      return;
    }
    try {
      const { dayClose, confirmedSales } = await closeDay({ user: SYSTEM_USER });
      doneToday.set(key, day);
      console.log(`[auto-close] ${label}: day closed at ${HOUR}:00 (${confirmedSales.length} invoice(s)).`);
      await logAudit({ user: null, action: 'dayclose.auto', entityType: 'DayClose', entityId: dayClose._id, details: { invoiceCount: confirmedSales.length, by: SYSTEM_USER.name } }).catch(() => {});
    } catch (err) {
      // e.g. a draft invoice that must be fixed first: say so once, try again in 10 minutes.
      console.warn(`[auto-close] ${label}: could not close the day -- ${err.message}`);
      doneToday.set(key, `${day}-retry-${Math.floor(Date.now() / 600000)}`);
    }
  });
}

// Opens a branch closed before 6:00 this morning (last night's close).
async function openBranch(branchId, label, day) {
  await runWithBranch(branchId, async () => {
    const status = await getBusinessDayStatus();
    if (status.status !== 'CLOSED') return;
    const closed = status.closedAt ? businessNow(new Date(status.closedAt)) : null;
    const closedBeforeOpening = !closed || closed.day < day || (closed.day === day && closed.hour < OPEN_HOUR);
    if (!closedBeforeOpening) return; // closed by hand today: leave it closed
    try {
      const bd = await openDay({ user: OPEN_USER });
      console.log(`[auto-open] ${label}: day opened at ${OPEN_HOUR}:00.`);
      await logAudit({ user: null, action: 'dayclose.autoopen', entityType: 'BusinessDay', details: { businessDay: bd?._id ?? null, by: OPEN_USER.name } }).catch(() => {});
    } catch (err) {
      if (err.statusCode !== 409 && err.status !== 409) console.warn(`[auto-open] ${label}: could not open the day -- ${err.message}`);
    }
  });
}

async function tick() {
  if (running) return;
  const { day, hour } = businessNow();
  const closing = hour >= HOUR;
  const opening = AUTO_OPEN && hour >= OPEN_HOUR && hour < HOUR;
  if (!closing && !opening) return;
  running = true;
  try {
    const branches = await Branch.find({ active: { $ne: false } }).select('_id name').lean();
    if (opening) {
      if (!branches.length) await openBranch(null, 'shop', day);
      for (const b of branches) await openBranch(b._id, b.name || String(b._id), day);
      return;
    }
    if (!branches.length) await closeBranch(null, 'shop', day);
    for (const b of branches) await closeBranch(b._id, b.name || String(b._id), day);
  } catch (err) {
    console.warn('[auto-close] check failed:', err.message);
  } finally {
    running = false;
  }
}

export function startAutoCloseDay() {
  if (String(process.env.AUTO_CLOSE || '').toLowerCase() === 'off') return;
  console.log(`[auto-close] on: every day at ${HOUR}:00 (${TZ}).${AUTO_OPEN ? ` Auto open at ${OPEN_HOUR}:00.` : ''}`);
  setInterval(tick, 60 * 1000).unref?.();
  tick();
}
