import { buildIcal } from './ical.js';
import { localToUtc, prettyTime, todayIn, prettyDate } from './dates.js';
import { cleaningState, stayReadiness, guestLabel } from './views.js';

// The calendar Mark and Danielle subscribe to in Google Calendar / iCal / Skylight. It mirrors
// the web calendar: every stay and every cleaning, with the same colors. Calendar apps mostly
// ignore per-event colors, so each title starts with a matching colored dot, and
// ?only=stays / ?only=cleanings give separate feeds that Skylight can color one each.
const STAY = {
  ready: { dot: '🔵', color: 'steelblue', note: 'Cleaning confirmed before check-in' },
  pending: { dot: '🟡', color: 'darkgoldenrod', note: 'Cleaning planned but not confirmed with the cleaner yet', tag: 'cleaning not confirmed' },
  missing: { dot: '🟠', color: 'orangered', note: 'No cleaning scheduled before check-in', tag: 'no cleaning yet' },
  past: { dot: '⚪', color: 'gray', note: 'Past stay' },
};
const CLEAN = {
  confirmed: { dot: '🟢', color: 'seagreen', label: 'booked' },
  asked: { dot: '🟣', color: 'mediumpurple', label: (who) => `waiting on ${who}` },
  proposed: { dot: '🟡', color: 'goldenrod', label: 'needs OK' },
  unsent: { dot: '🟡', color: 'goldenrod', label: 'text not sent' },
  past: { dot: '⚪', color: 'silver', label: 'done' },
};

export function cleaningFeed({ db, config, service, only = '' }) {
  const today = todayIn(config.timezone);
  const cleaner = config.cleaner?.name || 'cleaner';
  const bookings = db.prepare("SELECT * FROM bookings WHERE status='active' ORDER BY check_in").all();
  const cleanings = db.prepare("SELECT * FROM cleanings WHERE status NOT IN ('cancelled','declined') ORDER BY date").all();
  const events = [];
  if (only !== 'cleanings') {
    const ready = stayReadiness(bookings, cleanings, today);
    for (const b of bookings) {
      const s = STAY[ready[b.uid]] || STAY.ready;
      const who = b.source === 'personal' ? `${b.guest_name || 'Personal'} (your stay)` : guestLabel(b);
      events.push({
        uid: `stay-${b.uid}@slalom-cleaning-link`,
        start: localToUtc(b.check_in, config.checkinTime, config.timezone),
        end: localToUtc(b.check_out, config.checkoutTime, config.timezone),
        summary: `${s.dot} ${who}${s.tag ? ` · ${s.tag}` : ''}`,
        description: `${b.source === 'personal' ? 'Personal stay' : 'Airbnb stay'} at ${config.propertyName}: ${prettyDate(b.check_in)} ${prettyTime(config.checkinTime)} to ${prettyDate(b.check_out)} ${prettyTime(config.checkoutTime)}.\n${s.note}.`,
        color: s.color, categories: 'Stay',
      });
    }
  }
  if (only !== 'stays') {
    for (const c of cleanings) {
      let st = cleaningState(c, today);
      if (st === 'proposed' && c.status !== 'awaiting_approval') st = 'unsent';
      const k = CLEAN[st];
      const label = typeof k.label === 'function' ? k.label(cleaner) : k.label;
      events.push({
        uid: `cleaning-${c.id}@slalom-cleaning-link`,
        sequence: c.sequence,
        start: localToUtc(c.date, config.checkoutTime, config.timezone),
        end: localToUtc(c.date, config.checkinTime, config.timezone),
        summary: `${k.dot} Cleaning · ${label}`,
        description: `${service.describe(c)}\nWindow ${prettyTime(config.checkoutTime)} to ${prettyTime(config.checkinTime)}.\nStatus: ${label}${c.approved_by ? `, approved by ${c.approved_by}` : ''}.`,
        color: k.color, categories: 'Cleaning',
      });
    }
  }
  const name = only === 'stays' ? `Stays: ${config.propertyName}` : only === 'cleanings' ? `Cleanings: ${config.propertyName}` : config.propertyName;
  return buildIcal({ name, events });
}
