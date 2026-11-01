import crypto from 'node:crypto';
import { tx } from './db.js';
import { prettyDate, prettyTime, todayIn, addDays } from './dates.js';

const token = () => crypto.randomBytes(18).toString('base64url');
const nowIso = () => new Date().toISOString();

// Stages shown on the dashboard for every cleaning, in order.
export const STAGES = ['Booked', 'Approval requested', 'Approved', 'Cleaner texted', 'Cleaned', 'Payment requested', 'Paid'];

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

  function describe(c) {
    const isCheckout = db.prepare("SELECT 1 FROM bookings WHERE status='active' AND check_out = ?").get(c.date);
    const checkout = isCheckout ? `Guest checks out ${prettyTime(config.checkoutTime)}. ` : '';
    return `${prettyDate(c.date)} at ${config.propertyName}. ${checkout}${turnoverNote(c.date)}${c.note ? ` Note: ${c.note}` : ''}`;
  }

  // ---- Approval of a new cleaning ------------------------------------------------

  async function requestApproval(c, reason = 'New booking') {
    const t = token();
    c = update(c.id, { status: 'awaiting_approval', approval_token: t });
    logEvent(c.id, 'Approval requested', reason);
    await notifier.approvers(`Approve cleaning ${prettyDate(c.date)}?`, (p) =>
      `${reason}: cleaning needed ${describe(c)} Approve or decline: ${link(`/a/${t}?by=${encodeURIComponent(p.name)}`)}`);
    return c;
  }

  function confirmText(c) {
    return `CLEANING CONFIRMED: ${describe(c)}`;
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
    update(c.id, { group_notified_at: nowIso(), group_known_date: live ? get(c.id).date : null });
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
      update(c.id, { group_notified_at: nowIso(), group_known_date: live ? c.date : null });
      logEvent(c.id, 'Cleaner texted', body);
    } else {
      db.prepare("UPDATE group_messages SET status='skipped', decided_by=?, decided_at=? WHERE id=?").run(by, nowIso(), m.id);
      logEvent(c.id, 'Group message skipped', `by ${by}`);
    }
    return { message: db.prepare('SELECT * FROM group_messages WHERE id = ?').get(m.id) };
  }

  // ---- Changes made by hand on the dashboard ----------------------------------------

  async function addManual(date, note, by) {
    const r = db.prepare(`INSERT INTO cleanings (source, date, note, status, approved_by, approved_at, sequence, created_at, updated_at)
      VALUES ('manual', ?, ?, 'approved', ?, ?, 0, ?, ?)`).run(date, note || null, by, nowIso(), nowIso(), nowIso());
    const c = get(Number(r.lastInsertRowid));
    logEvent(c.id, 'Booked', `Added by hand by ${by}`);
    logEvent(c.id, 'Approved', `by ${by}`);
    const msg = await askAboutGroupMessage(c, 'added', `CLEANING ADDED: ${describe(c)}`);
    return { cleaning: c, message: msg };
  }

  async function move(id, newDate, by, { fromAirbnb = false } = {}) {
    const c = get(id);
    if (!c || c.date === newDate) return { cleaning: c };
    const old = c.date;
    let moved = update(id, { date: newDate, sequence: c.sequence + 1 });
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

  async function customGroupMessage(id, body, by) {
    return askAboutGroupMessage(get(id), 'custom', body);
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
        `${due.length} cleaning(s) done. You now owe ${name} $${(owed.s / 100).toFixed(2)} for ${owed.n} cleaning(s). Mark paid: ${link('/#payments')}`);
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
    return STAGES.map(s => ({ name: s, done: s === 'Booked' ? true : ev.includes(s) || (s === 'Approval requested' && c.source === 'manual') }));
  }

  function list({ from } = {}) {
    const start = from || addDays(todayIn(config.timezone), -60);
    return db.prepare('SELECT * FROM cleanings WHERE date >= ? ORDER BY date, id').all(start);
  }

  return {
    get, list, stageOf, describe, requestApproval, approve, decline, decideGroupMessage, addManual, move, cancel,
    customGroupMessage, autoComplete, recordPaymentRequest, markPaid, logEvent, update,
  };
}
