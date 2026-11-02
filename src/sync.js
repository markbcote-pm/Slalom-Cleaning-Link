import { parseIcal, isReservation } from './ical.js';
import { todayIn } from './dates.js';

// Pull the Airbnb calendar and turn checkouts into cleanings.
export async function syncAirbnb({ db, config, service, fetchImpl = globalThis.fetch, icalText = null, now = new Date() }) {
  let text = icalText;
  if (text == null) {
    if (!config.airbnbIcalUrl) return { skipped: 'AIRBNB_ICAL_URL is not set' };
    const res = await fetchImpl(config.airbnbIcalUrl);
    if (!res.ok) throw new Error(`Airbnb calendar returned ${res.status}`);
    text = await res.text();
  }
  if (!text.includes('BEGIN:VCALENDAR')) throw new Error('Airbnb calendar did not look like a calendar file');

  const today = todayIn(config.timezone, now);
  const stamp = now.toISOString();
  const reservations = parseIcal(text).filter(isReservation);
  const seen = new Set();
  const result = { added: 0, moved: 0, cancelled: 0, total: reservations.length };

  // Pass 1: record every booking first, so messages can mention same-day turnovers.
  const previous = new Map();
  for (const r of reservations) {
    seen.add(r.uid);
    previous.set(r.uid, db.prepare('SELECT * FROM bookings WHERE uid = ?').get(r.uid));
    db.prepare(`INSERT INTO bookings (uid, check_in, check_out, summary, description, status, first_seen, last_seen)
      VALUES (?,?,?,?,?, 'active', ?, ?)
      ON CONFLICT(uid) DO UPDATE SET check_in=excluded.check_in, check_out=excluded.check_out, summary=excluded.summary,
        description=excluded.description, status='active', last_seen=excluded.last_seen`)
      .run(r.uid, r.start, r.end, r.summary || null, r.description || null, stamp, stamp);
  }

  // Pass 2: create or move cleanings.
  for (const r of reservations) {
    const existing = previous.get(r.uid);

    const cleaning = db.prepare('SELECT * FROM cleanings WHERE booking_uid = ?').get(r.uid);
    if (!cleaning) {
      if (r.end < today) continue; // past stays: nothing to schedule
      // If a cleaning is already scheduled between this checkout and the next check-in
      // (for example one Mark arranged by hand), don't propose another; adopt it instead.
      const nextIn = db.prepare("SELECT check_in FROM bookings WHERE status='active' AND check_in >= ? AND uid != ? ORDER BY check_in LIMIT 1").get(r.end, r.uid)?.check_in;
      const covering = service.cleaningInWindow(r.end, nextIn);
      if (covering) {
        if (!covering.booking_uid) {
          service.update(covering.id, { booking_uid: r.uid });
          service.logEvent(covering.id, 'Linked', `Covers the Airbnb stay ${r.start} to ${r.end}`);
        }
        result.covered = (result.covered || 0) + 1;
        continue;
      }
      const ins = db.prepare(`INSERT INTO cleanings (booking_uid, source, date, status, sequence, created_at, updated_at)
        VALUES (?, 'airbnb', ?, 'awaiting_approval', 0, ?, ?)`).run(r.uid, r.end, stamp, stamp);
      const c = service.get(Number(ins.lastInsertRowid));
      service.logEvent(c.id, 'Booked', `Airbnb stay ${r.start} to ${r.end}`);
      await service.requestApproval(c, 'New booking');
      result.added++;
    } else if (existing && existing.check_out !== r.end && cleaning.date === existing.check_out && r.end >= today) {
      // Only follow Airbnb if nobody moved this cleaning by hand.
      await service.move(cleaning.id, r.end, 'Airbnb', { fromAirbnb: true });
      result.moved++;
    }
  }

  // Bookings that vanished from the feed were cancelled. A feed with no events at all
  // while we expect future stays is treated as a glitch, not mass cancellation.
  const future = db.prepare("SELECT * FROM bookings WHERE status='active' AND check_out >= ?").all(today);
  const missing = future.filter(b => !seen.has(b.uid));
  if (missing.length && (reservations.length > 0 || missing.length < 2)) {
    for (const b of missing) {
      db.prepare("UPDATE bookings SET status='cancelled' WHERE uid = ?").run(b.uid);
      const c = db.prepare('SELECT * FROM cleanings WHERE booking_uid = ?').get(b.uid);
      if (c) { await service.cancel(c.id, 'Airbnb', { fromAirbnb: true }); result.cancelled++; }
    }
  } else if (missing.length) {
    result.warning = `Airbnb feed came back empty; kept ${missing.length} bookings as-is.`;
  }

  db.prepare("INSERT INTO meta (key, value) VALUES ('last_sync', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(JSON.stringify({ at: stamp, ...result }));
  return result;
}
