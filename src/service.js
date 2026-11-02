import crypto from 'node:crypto';
import { tx } from './db.js';
import { prettyDate, prettyTime, todayIn, addDays } from './dates.js';

const token = () => crypto.randomBytes(18).toString('base64url');
const nowIso = () => new Date().toISOString();

// Stages shown on the dashboard for every cleaning, in order.
export const STAGES = ['Booked', 'Approval requested', 'Approved', 'Cleaner texted', 'Cleaner confirmed', 'Cleaned', 'Payment requested', 'Paid'];

export function createService({ db, config, notifier }) {
  const link = (p) => `${config.baseUrl}${p}`;

  function logEvent(cleaningId, stage, detail = null) {
    db.prepare('INSERT INTO events (cleaning_id, stage, detail, at) VALUES (?,?,?,?)').run(cleaningId, stage, detail, nowIso());
  }

  const get = (id) => db.prepare('SELECT * FROM cleanings WHERE id = ?').get(id);

  function update(id, fields) {
    const keys = Object.keys(fields);
    db.prepare(`UPDATE cleanings SET ${keys.map(k => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`)
      .run(...keys.map(k => fields[k]), nowIso(), id);
    return get(id);
  }

  // What the next guests look like after a cleaning date, for the message text.
  function turnoverNote(date) {
    const sameDay = db.prepare("SELECT 1 FROM bookings WHERE status='active' AND check_in = ?").get(date);
    if (sameDay) return `Next guests arrive ${prettyTime(config.checkinTime)} the same day, so please be done by then.`;
    const next = db.prepare("SELECT check_in FROM bookings WHERE status='active' AND check_in > ? ORDER BY check_in LIMIT 1").get(date);
    return next ? `Next guests arrive ${prettyDate(next.check_in)}.` : 'No guests booked right after.';
  }

  // "<date>. Guest checks out at 11 AM. Next guests arrive <date>." plus any note.
  function dayDetails(c) {
    const isCheckout = db.prepare("SELECT 1 FROM bookings WHERE status='active' AND check_out = ?").get(c.date);
    const checkout = isCheckout ? `Guest checks out at ${prettyTime(config.checkoutTime)}. ` : '';
    return `${prettyDate(c.date)}. ${checkout}${turnoverNote(c.date)}${c.note ? ` Note: ${c.note}` : ''}`;
  }

  function describe(c) {
    return dayDetails(c).replace(/^([^.]*)\./, `$1 at ${config.propertyName}.`);
  }

  // The group text for a new cleaning (Mark's wording, 2026-11-02).
  function requestText(c) {
    return `New cleaning request for ${config.propertyName}: ${dayDetails(c)}`;
  }

  // ---- Approval of a new cleaning ------------------------------------------------

  async function requestApproval(c, reason = 'New booking', { text = true } = {}) {
    const t = token();
    c = update(c.id, { status: 'awaiting_approval', approval_token: t });
    logEvent(c.id, 'Approval requested', reason);
    if (text) await notifier.approvers(`Approve cleaning ${prettyDate(c.date)}?`, (p) =>
      `${reason}: cleaning needed ${describe(c)} Approve or decline: ${link(`/a/${t}?by=${encodeURIComponent(p.name)}`)}`);
    return c;
  }

  function confirmText(c) {
    return requestText(c);
  }

  async function approve(approvalToken, by) {
    const c = db.prepare('SELECT * FROM cleanings WHERE approval_token = ?').get(approvalToken);
    if (!c) return { error: 'This link is not valid any more.' };
    if (c.status !== 'awaiting_approval') return { cleaning: c, already: true };
    const done = update(c.id, { status: 'approved', approved_by: by, approved_at: nowIso(), approval_token: null });
    logEvent(c.id, 'Approved', `by ${by}`);
    // Approving is the go-ahead to tell the group, so this one is sent straight away.
    const kind = c.group_known_date ? 'moved' : 'confirmed';
    const body = kind === 'moved'
      ? `CLEANING DATE CHANGED: was ${prettyDate(c.group_known_date)}, now ${describe(done)}`
      : confirmText(done);
    await sendGroupNow(done, kind, body, by);
    return { cleaning: get(c.id) };
  }

  // Approve a proposed cleaning from the calendar, the same two ways as adding one by hand:
  // already arranged (nothing texted) or text the group (the message is shown before it goes out).
  async function approveProposal(id, by, { alreadyArranged = false, note = '' } = {}) {
    let c = get(id);
    if (!c) return { error: 'Cleaning not found.' };
    if (c.status !== 'awaiting_approval') return { cleaning: c, already: true };
    const prevKnown = c.group_known_date;
    c = update(c.id, { status: 'approved', approved_by: by, approved_at: nowIso(), approval_token: null, ...(note ? { note } : {}) });
    logEvent(c.id, 'Approved', `by ${by}`);
    if (alreadyArranged) {
      c = update(c.id, { group_known_date: c.date, cleaner_confirmed_at: nowIso() });
      logEvent(c.id, 'Cleaner texted', `Arranged directly with ${config.cleaner?.name || 'the cleaner'}, no text sent`);
      logEvent(c.id, 'Cleaner confirmed', 'Already arranged');
      return { cleaning: c };
    }
    const moved = prevKnown && prevKnown !== c.date;
    const msg = await askAboutGroupMessage(c, moved ? 'moved' : 'confirmed',
      moved ? `CLEANING DATE CHANGED: was ${prettyDate(prevKnown)}, now ${describe(c)}` : confirmText(c));
    return { cleaning: c, message: msg };
  }

  async function decline(approvalToken, by) {
    const c = db.prepare('SELECT * FROM cleanings WHERE approval_token = ?').get(approvalToken);
    if (!c) return { error: 'This link is not valid any more.' };
    if (c.status !== 'awaiting_approval') return { cleaning: c, already: true };
    update(c.id, { status: 'declined', approval_token: null });
    logEvent(c.id, 'Declined', `by ${by}`);
    if (c.group_known_date) await askAboutGroupMessage(get(c.id), 'cancelled', `CLEANING CANCELLED: ${prettyDate(c.group_known_date)} is no longer needed.`, { askBy: 'text' });
    return { cleaning: get(c.id) };
  }

  // ---- Group messages: every change asks before texting the shared thread ----------

  async function sendGroupNow(c, kind, body, by) {
    db.prepare("UPDATE group_messages SET status='superseded' WHERE cleaning_id = ? AND status='pending'").run(c.id);
    db.prepare('INSERT INTO group_messages (cleaning_id, kind, body, status, token, decided_by, decided_at, created_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(c.id, kind, body, 'sent', token(), by, nowIso(), nowIso());
    await notifier.group(body);
    const live = ['approved', 'completed', 'paid'].includes(get(c.id).status);
    update(c.id, { group_notified_at: nowIso(), group_known_date: live ? get(c.id).date : null, ...(kind !== 'custom' ? { cleaner_confirmed_at: null } : {}) });
    logEvent(c.id, 'Cleaner texted', body);
  }

  // Creates a draft for the shared thread. askBy 'text' also texts Mark and Danielle a
  // link to decide (used when the change came from Airbnb and nobody is at the dashboard).
  async function askAboutGroupMessage(c, kind, body, { askBy = 'dashboard' } = {}) {
    db.prepare("UPDATE group_messages SET status='superseded' WHERE cleaning_id = ? AND status='pending'").run(c.id);
    const t = token();
    const r = db.prepare('INSERT INTO group_messages (cleaning_id, kind, body, status, token, created_at) VALUES (?,?,?,?,?,?)')
      .run(c.id, kind, body, 'pending', t, nowIso());
    logEvent(c.id, 'Group message drafted', body);
    if (askBy === 'text') {
      await notifier.approvers('Text the cleaner about a change?', (p) =>
        `Change for ${prettyDate(c.date)}: should I tell the group text? "${body}" Decide: ${link(`/g/${t}?by=${encodeURIComponent(p.name)}`)}`);
    }
    return db.prepare('SELECT * FROM group_messages WHERE id = ?').get(Number(r.lastInsertRowid));
  }

  // "Test send": the draft goes only to the person reviewing it, so they can see how it reads
  // on a phone. The draft stays pending and nothing reaches the group.
  async function testGroupMessage(msgToken, by, editedBody) {
    const m = db.prepare('SELECT * FROM group_messages WHERE token = ?').get(msgToken);
    if (!m) return { error: 'This link is not valid any more.' };
    const person = config.approvers.find(a => a.name === by);
    if (!person || (!person.phone && !person.email)) return { error: `No phone number on file for ${by || 'that person'}.` };
    const body = (editedBody || m.body).trim();
    if (editedBody && body !== m.body) db.prepare('UPDATE group_messages SET body = ? WHERE id = ?').run(body, m.id);
    const text = `[TEST, only you got this] ${body}`;
    if (person.phone) await notifier.sms(person.phone, text);
    else await notifier.email(person.email, 'Test of a group text', text);
    logEvent(m.cleaning_id, 'Test text', `Sent only to ${person.name}`);
    return { to: person, body, dryRun: config.dryRun };
  }

  // Undo "Don't send": the skipped draft goes back to waiting for a decision. Only the newest
  // message for that cleaning can come back, so an older draft never overrides a later change.
  function undoSkip(msgToken, by) {
    const m = db.prepare('SELECT * FROM group_messages WHERE token = ?').get(msgToken);
    if (!m) return { error: 'This message no longer exists.' };
    if (m.status !== 'skipped') return { message: m, already: true };
    const newer = db.prepare("SELECT 1 FROM group_messages WHERE cleaning_id = ? AND id > ? AND status IN ('pending','sent')").get(m.cleaning_id, m.id);
    if (newer) return { error: 'A newer message for this cleaning has been drafted or sent since, so this one can\'t come back.' };
    db.prepare("UPDATE group_messages SET status='superseded' WHERE cleaning_id = ? AND status='pending'").run(m.cleaning_id);
    db.prepare("UPDATE group_messages SET status='pending', decided_by=NULL, decided_at=NULL WHERE id = ?").run(m.id);
    logEvent(m.cleaning_id, 'Group message restored', `Put back in Waiting on you by ${by}`);
    return { message: db.prepare('SELECT * FROM group_messages WHERE id = ?').get(m.id) };
  }

  // Undo "Not needed": a declined cleaning goes back to waiting for approval.
  function restoreDeclined(id, by) {
    const c = get(id);
    if (!c) return { error: 'Cleaning not found.' };
    if (c.status !== 'declined') return { cleaning: c, already: true };
    const done = update(c.id, { status: 'awaiting_approval', approval_token: token() });
    logEvent(c.id, 'Approval requested', `Restored by ${by} after it was declined`);
    return { cleaning: done };
  }

  async function decideGroupMessage(msgToken, send, by, editedBody) {
    const m = db.prepare('SELECT * FROM group_messages WHERE token = ?').get(msgToken);
    if (!m) return { error: 'This link is not valid any more.' };
    if (m.status !== 'pending') return { message: m, already: true };
    const c = get(m.cleaning_id);
    if (send) {
      const body = (editedBody || m.body).trim();
      db.prepare("UPDATE group_messages SET status='sent', body=?, decided_by=?, decided_at=? WHERE id=?").run(body, by, nowIso(), m.id);
      await notifier.group(body);
      const live = ['approved', 'completed', 'paid'].includes(c.status);
      update(c.id, { group_notified_at: nowIso(), group_known_date: live ? c.date : null, ...(m.kind !== 'custom' ? { cleaner_confirmed_at: null } : {}) });
      logEvent(c.id, 'Cleaner texted', body);
    } else {
      db.prepare("UPDATE group_messages SET status='skipped', decided_by=?, decided_at=? WHERE id=?").run(by, nowIso(), m.id);
      logEvent(c.id, 'Group message skipped', `by ${by}`);
    }
    return { message: db.prepare('SELECT * FROM group_messages WHERE id = ?').get(m.id) };
  }

  // ---- Changes made by hand on the dashboard ----------------------------------------

  // The stays on either side of a date: the one that checked out on or before it, and the
  // next one checking in on or after it. A cleaning between them covers that turnover.
  function windowFor(date) {
    const prior = db.prepare("SELECT * FROM bookings WHERE status='active' AND check_out <= ? ORDER BY check_out DESC LIMIT 1").get(date) || null;
    const next = db.prepare("SELECT * FROM bookings WHERE status='active' AND check_in >= ? ORDER BY check_in LIMIT 1").get(date) || null;
    return { prior, next };
  }

  // Any live cleaning already covering the turnover after a stay's checkout.
  function cleaningInWindow(checkOut, nextCheckIn, excludeId = 0) {
    const end = nextCheckIn || addDays(checkOut, 14);
    return db.prepare(`SELECT * FROM cleanings WHERE status NOT IN ('cancelled','declined') AND date >= ? AND date <= ? AND id != ?
      ORDER BY date LIMIT 1`).get(checkOut, end, excludeId) || null;
  }

  // Drop proposals that are no longer needed: a proposed cleaning whose turnover (the prior
  // stay's checkout to the next check-in) already has a confirmed cleaning, whether it was
  // proposed and approved or added by hand. Nothing is texted: the group never heard of it.
  function dropCoveredProposals(by = 'the app') {
    const dropped = [];
    const pending = db.prepare("SELECT * FROM cleanings WHERE status='awaiting_approval' AND group_known_date IS NULL ORDER BY date").all();
    for (const c of pending) {
      const prior = db.prepare("SELECT * FROM bookings WHERE status='active' AND check_out <= ? ORDER BY check_out DESC LIMIT 1").get(c.date);
      if (!prior) continue;
      const next = db.prepare("SELECT check_in FROM bookings WHERE status='active' AND check_in >= ? AND uid != ? ORDER BY check_in LIMIT 1").get(prior.check_out, prior.uid);
      if (next && c.date > next.check_in) continue; // proposal isn't in a turnover window
      const end = next ? next.check_in : addDays(prior.check_out, 14);
      const cover = db.prepare(`SELECT * FROM cleanings WHERE status IN ('approved','completed','paid') AND date >= ? AND date <= ? AND id != ?
        ORDER BY date LIMIT 1`).get(prior.check_out, end, c.id);
      if (!cover) continue;
      update(c.id, { status: 'cancelled', approval_token: null });
      db.prepare("UPDATE group_messages SET status='superseded' WHERE cleaning_id = ? AND status='pending'").run(c.id);
      logEvent(c.id, 'Cancelled', `Not needed: the ${prettyDate(cover.date)} cleaning already covers this turnover (checked by ${by})`);
      dropped.push({ cleaning: c, cover });
    }
    return dropped;
  }

  // alreadyArranged: Mark already agreed the day with the cleaner, so nothing is texted and
  // the group counts as knowing about it (later moves or cancellations still ask first).
  async function addManual(date, note, by, { alreadyArranged = false } = {}) {
    const r = db.prepare(`INSERT INTO cleanings (source, date, note, status, approved_by, approved_at, sequence, created_at, updated_at)
      VALUES ('manual', ?, ?, 'approved', ?, ?, 0, ?, ?)`).run(date, note || null, by, nowIso(), nowIso(), nowIso());
    let c = get(Number(r.lastInsertRowid));
    logEvent(c.id, 'Booked', `Scheduled by hand by ${by}`);
    logEvent(c.id, 'Approved', `by ${by}`);

    // Take over the turnover this day sits in, so the app doesn't propose another cleaning for it.
    // Only when the day falls between that stay's checkout and the next check-in; a
    // mid-stay cleaning doesn't cover any turnover.
    let { prior } = windowFor(date);
    if (prior) {
      const following = db.prepare("SELECT check_in FROM bookings WHERE status='active' AND check_in >= ? AND uid != ? ORDER BY check_in LIMIT 1").get(prior.check_out, prior.uid);
      if (following && following.check_in < date) prior = null;
    }
    let replaced = null, conflict = null;
    if (prior) {
      const existing = db.prepare('SELECT * FROM cleanings WHERE booking_uid = ?').get(prior.uid);
      if (existing && existing.status === 'awaiting_approval') {
        update(existing.id, { status: 'cancelled', approval_token: null, booking_uid: null });
        logEvent(existing.id, 'Cancelled', `Replaced by the ${prettyDate(date)} cleaning ${by} scheduled by hand`);
        replaced = existing;
      } else if (existing && !['cancelled', 'declined'].includes(existing.status)) {
        conflict = existing;
      }
      if (!conflict) {
        if (existing) update(existing.id, { booking_uid: null });
        c = update(c.id, { booking_uid: prior.uid });
      }
    }

    if (alreadyArranged) {
      c = update(c.id, { group_known_date: date, cleaner_confirmed_at: nowIso() });
      logEvent(c.id, 'Cleaner texted', `Arranged directly with ${config.cleaner?.name || 'the cleaner'}, no text sent`);
      logEvent(c.id, 'Cleaner confirmed', 'Already arranged');
      return { cleaning: c, replaced, conflict };
    }
    const msg = await askAboutGroupMessage(c, 'added', requestText(c));
    return { cleaning: c, message: msg, replaced, conflict };
  }

  async function move(id, newDate, by, { fromAirbnb = false } = {}) {
    const c = get(id);
    if (!c || c.date === newDate) return { cleaning: c };
    const old = c.date;
    let moved = update(id, { date: newDate, sequence: c.sequence + 1, cleaner_confirmed_at: null });
    logEvent(id, 'Moved', `${prettyDate(old)} to ${prettyDate(newDate)}${fromAirbnb ? ' (Airbnb dates changed)' : ` by ${by}`}`);
    if (c.status === 'awaiting_approval') {
      if (fromAirbnb) moved = await requestApproval(moved, 'Booking dates changed');
      return { cleaning: moved };
    }
    if (!['approved', 'completed'].includes(c.status)) return { cleaning: moved };
    if (!c.group_known_date) return { cleaning: moved }; // group never heard about it, nothing to correct
    const body = `CLEANING DATE CHANGED: was ${prettyDate(c.group_known_date)}, now ${describe(moved)}`;
    const msg = await askAboutGroupMessage(moved, 'moved', body, { askBy: fromAirbnb ? 'text' : 'dashboard' });
    return { cleaning: moved, message: msg };
  }

  async function cancel(id, by, { fromAirbnb = false } = {}) {
    const c = get(id);
    if (!c || ['cancelled', 'paid', 'completed'].includes(c.status)) return { cleaning: c };
    update(id, { status: 'cancelled', approval_token: null, sequence: c.sequence + 1 });
    logEvent(id, 'Cancelled', fromAirbnb ? 'Booking cancelled on Airbnb' : `by ${by}`);
    if (!c.group_known_date) return { cleaning: get(id) };
    const msg = await askAboutGroupMessage(get(id), 'cancelled',
      `CLEANING CANCELLED: ${prettyDate(c.group_known_date)} at ${config.propertyName} is no longer needed.`,
      { askBy: fromAirbnb ? 'text' : 'dashboard' });
    return { cleaning: get(id), message: msg };
  }

  // The cleaner said yes to the date she was texted (marked by Mark or Danielle).
  function confirmByCleaner(id, by, yes = true) {
    const c = get(id);
    if (!c) return { error: 'Cleaning not found.' };
    if (yes) {
      if (c.group_known_date !== c.date) return { error: `${config.cleaner?.name || 'The cleaner'} hasn't been texted this date yet.` };
      update(id, { cleaner_confirmed_at: nowIso() });
      logEvent(id, 'Cleaner confirmed', `Marked by ${by}`);
    } else {
      update(id, { cleaner_confirmed_at: null });
      logEvent(id, 'Cleaner confirmation removed', `by ${by}`);
    }
    return { cleaning: get(id) };
  }

  async function customGroupMessage(id, body, by) {
    return askAboutGroupMessage(get(id), 'custom', body);
  }

  // ---- Personal stays ---------------------------------------------------------------------
  // Airbnb only shows these as blocked dates, so they're entered here. Each one gets a cleaning
  // proposed for the departure day (unless one is already scheduled before the next arrival).

  function overlaps(checkIn, checkOut, exceptUid = '') {
    return db.prepare("SELECT * FROM bookings WHERE status='active' AND uid != ? AND check_in < ? AND check_out > ?").all(exceptUid, checkOut, checkIn);
  }

  async function proposeCleaningAfter(b, by) {
    const nextIn = db.prepare("SELECT check_in FROM bookings WHERE status='active' AND check_in >= ? AND uid != ? ORDER BY check_in LIMIT 1").get(b.check_out, b.uid)?.check_in;
    const covering = cleaningInWindow(b.check_out, nextIn);
    if (covering) {
      if (!covering.booking_uid) update(covering.id, { booking_uid: b.uid });
      return { covering };
    }
    const r = db.prepare(`INSERT INTO cleanings (booking_uid, source, date, status, sequence, created_at, updated_at)
      VALUES (?, 'personal', ?, 'awaiting_approval', 0, ?, ?)`).run(b.uid, b.check_out, nowIso(), nowIso());
    const c = get(Number(r.lastInsertRowid));
    logEvent(c.id, 'Booked', `After ${b.guest_name || 'a personal stay'}, ${prettyDate(b.check_in)} to ${prettyDate(b.check_out)} (added by ${by})`);
    // Whoever added the stay is at the dashboard, so it goes on the "Waiting on you" list instead of a text.
    return { cleaning: await requestApproval(c, 'Personal stay', { text: false }) };
  }

  async function addPersonalStay({ checkIn, checkOut, name, by }) {
    if (!(checkOut > checkIn)) return { error: 'The departure date has to be after the arrival date.' };
    const uid = `personal-${crypto.randomBytes(6).toString('hex')}`;
    const clash = overlaps(checkIn, checkOut);
    db.prepare(`INSERT INTO bookings (uid, check_in, check_out, summary, description, status, first_seen, last_seen, guest_name, source)
      VALUES (?,?,?,?,?, 'active', ?, ?, ?, 'personal')`).run(uid, checkIn, checkOut, 'Personal stay', `Personal stay added by ${by}`, nowIso(), nowIso(), (name || '').trim().slice(0, 60) || 'Personal stay');
    const b = db.prepare('SELECT * FROM bookings WHERE uid = ?').get(uid);
    return { booking: b, clash, ...(await proposeCleaningAfter(b, by)) };
  }

  async function updatePersonalStay(uid, { checkIn, checkOut, name, by }) {
    const b = db.prepare("SELECT * FROM bookings WHERE uid = ? AND source = 'personal'").get(uid);
    if (!b) return { error: 'Stay not found.' };
    if (!(checkOut > checkIn)) return { error: 'The departure date has to be after the arrival date.' };
    db.prepare('UPDATE bookings SET check_in = ?, check_out = ?, guest_name = ?, last_seen = ? WHERE uid = ?')
      .run(checkIn, checkOut, (name || '').trim().slice(0, 60) || b.guest_name, nowIso(), uid);
    const c = db.prepare('SELECT * FROM cleanings WHERE booking_uid = ?').get(uid);
    let moved = null;
    // Follow the new departure date unless the cleaning was moved to some other day by hand.
    if (c && c.date === b.check_out && checkOut !== b.check_out) moved = await move(c.id, checkOut, by);
    else if (!c) await proposeCleaningAfter(db.prepare('SELECT * FROM bookings WHERE uid = ?').get(uid), by);
    return { booking: db.prepare('SELECT * FROM bookings WHERE uid = ?').get(uid), clash: overlaps(checkIn, checkOut, uid), message: moved?.message };
  }

  async function removePersonalStay(uid, by) {
    const b = db.prepare("SELECT * FROM bookings WHERE uid = ? AND source = 'personal'").get(uid);
    if (!b) return { error: 'Stay not found.' };
    db.prepare("UPDATE bookings SET status = 'cancelled' WHERE uid = ?").run(uid);
    const c = db.prepare('SELECT * FROM cleanings WHERE booking_uid = ?').get(uid);
    const r = c && c.source === 'personal' ? await cancel(c.id, by) : {};
    return { message: r.message };
  }

  // ---- Payment tracking ---------------------------------------------------------------

  // The day after an approved cleaning it counts as cleaned. With a fixed CLEANING_FEE the fee
  // is owed straight away; with CLEANING_FEE=0 (the default for Jenn, who bills per stay) it
  // waits until her payment request is entered on the dashboard.
  async function autoComplete(now = new Date()) {
    const today = todayIn(config.timezone, now);
    const due = db.prepare("SELECT * FROM cleanings WHERE status='approved' AND date < ?").all(today);
    const fixed = config.cleaningFeeCents > 0;
    for (const c of due) {
      update(c.id, { status: 'completed', amount_cents: c.amount_cents ?? (fixed ? config.cleaningFeeCents : null) });
      logEvent(c.id, 'Cleaned');
      if (fixed) logEvent(c.id, 'Payment requested', `$${(config.cleaningFeeCents / 100).toFixed(2)} (standard fee)`);
    }
    if (due.length && fixed) {
      const owed = db.prepare("SELECT COALESCE(SUM(amount_cents),0) AS s, COUNT(*) AS n FROM cleanings WHERE status='completed' AND amount_cents IS NOT NULL").get();
      const name = config.cleaner?.name || 'the cleaner';
      await notifier.approvers('Cleaner payment due', () =>
        `${due.length} cleaning(s) done. You now owe ${name} $${(owed.s / 100).toFixed(2)} for ${owed.n} cleaning(s). Mark paid: ${link('/payments')}`);
    }
    return due.length;
  }

  // Jenn sends her request after cleaning; this records the amount she asked for.
  function recordPaymentRequest(id, dollars, by) {
    const c = get(id);
    const cents = Math.round(Number(dollars) * 100);
    if (!c || !['completed', 'approved'].includes(c.status) || !(cents > 0)) return null;
    update(id, { amount_cents: cents, status: 'completed' });
    logEvent(id, 'Payment requested', `$${(cents / 100).toFixed(2)}, entered by ${by}`);
    return get(id);
  }

  function markPaid(ids, method, by) {
    return tx(db, () => {
      for (const id of ids) {
        const c = get(id);
        if (!c || c.status !== 'completed' || c.amount_cents == null) continue;
        update(id, { status: 'paid', paid_at: nowIso(), paid_method: method || null });
        logEvent(id, 'Paid', `$${(c.amount_cents / 100).toFixed(2)}${method ? ` by ${method}` : ''}, marked by ${by}`);
      }
    });
  }

  // ---- Read models --------------------------------------------------------------------

  function stageOf(c) {
    const ev = db.prepare('SELECT stage FROM events WHERE cleaning_id = ?').all(c.id).map(e => e.stage);
    return STAGES.map(s => ({ name: s, done: s === 'Booked' ? true
      : s === 'Cleaner confirmed' ? !!c.cleaner_confirmed_at || ['completed', 'paid'].includes(c.status)
      : ev.includes(s) || (s === 'Approval requested' && c.source === 'manual') }));
  }

  function list({ from } = {}) {
    const start = from || addDays(todayIn(config.timezone), -60);
    return db.prepare('SELECT * FROM cleanings WHERE date >= ? ORDER BY date, id').all(start);
  }

  return {
    get, list, stageOf, describe, windowFor, cleaningInWindow, addPersonalStay, updatePersonalStay, removePersonalStay, requestApproval, approve, approveProposal, dropCoveredProposals, decline, decideGroupMessage, testGroupMessage, undoSkip, restoreDeclined, addManual, move, cancel,
    customGroupMessage, confirmByCleaner, autoComplete, recordPaymentRequest, markPaid, logEvent, update,
  };
}
