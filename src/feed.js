import { buildIcal } from './ical.js';
import { localToUtc, prettyTime } from './dates.js';

// The calendar Mark and Danielle subscribe to in Google Calendar / iCal (and Skylight).
export function cleaningFeed({ db, config, service }) {
  const rows = db.prepare("SELECT * FROM cleanings WHERE status IN ('approved','completed','paid') ORDER BY date").all();
  const events = rows.map(c => ({
    uid: `cleaning-${c.id}@slalom-cleaning-link`,
    sequence: c.sequence,
    start: localToUtc(c.date, config.checkoutTime, config.timezone),
    end: localToUtc(c.date, config.checkinTime, config.timezone),
    summary: `Cleaning${config.cleaner?.name ? ` (${config.cleaner.name})` : ''}`,
    description: `${service.describe(c)}\nWindow ${prettyTime(config.checkoutTime)} to ${prettyTime(config.checkinTime)}.\nStatus: ${c.status}${c.approved_by ? `, approved by ${c.approved_by}` : ''}.`,
  }));
  return buildIcal({ name: `Cleanings: ${config.propertyName}`, events });
}
