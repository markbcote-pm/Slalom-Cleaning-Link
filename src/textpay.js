// Payment texts from the group thread, read straight into the tracker:
//   the cleaner: "All done! $140"        -> that cleaning is Cleaned, $140 requested
//   Mark/Danielle: "Paid, sent on Venmo"  -> the cleaning(s) owed are Paid
// When a text can't be tied to exactly one cleaning (or set of cleanings), it waits in
// text_matches and the app asks which cleaning it was the next time someone opens it.
import { addDays, todayIn } from './dates.js';

const METHODS = { venmo: 'Venmo', zelle: 'Zelle', cash: 'Cash', check: 'Check', cheque: 'Check', paypal: 'Other', 'apple pay': 'Other', 'cash app': 'Other' };

export function amountIn(text) {
  const t = String(text || '');
  const m = t.match(/\$\s?(\d{1,4}(?:,\d{3})?(?:\.\d{1,2})?)/) || t.match(/\b(\d{2,4}(?:\.\d{1,2})?)\s*(?:dollars|bucks|usd)\b/i)
    || t.match(/\b(?:total|owe(?:d)?|cost|charge|is|be|for)\s*(?:is|was|of|:)?\s*(\d{2,4}(?:\.\d{1,2})?)\b(?!\s*(?:am|pm|:|st|nd|rd|th|\/))/i);
  if (!m) return null;
  const cents = Math.round(Number(m[1].replace(/,/g, '')) * 100);
  return cents >= 1000 && cents <= 500000 ? cents : null;     // $10 to $5,000
}

export function methodIn(text) {
  const t = String(text || '').toLowerCase();
  for (const [k, v] of Object.entries(METHODS)) if (t.includes(k)) return v;
  return null;
}

// What kind of payment text this is, if any.
export function classifyPaymentText(text, { fromCleaner, fromOwner }) {
  const t = String(text || '').replace(/[\u2018\u2019\u02BC\u2032`´]/g, "'").toLowerCase();
  if (!t.trim()) return null;
  if (fromCleaner) {
    const done = /\b(all done|done|finished|all set|complete(?:d)?|wrapped up|all clean(?:ed)?|just left|leaving now|house is ready|place is ready|ready for (?:the )?(?:next|guests))\b/.test(t)
      && !/\b(not done|will be done|be done by|when (?:i'?m|you'?re) done|almost done|not finished|done yet)\b/.test(t) && !/\?\s*$/.test(t);
    const amount = amountIn(text);
    const asks = amount != null && /(\$|dollars|total|owe|cost|charge|bill|invoice|venmo|zelle|pay)/.test(t);
    if (done || asks) return { kind: 'done', done, amount: asks || done ? amount : null };
    return null;
  }
  if (fromOwner) {
    const paid = /\b(paid|sent (?:you|it|the|over|payment|\$)|just sent|payment sent|venmo'?d|zelle'?d|sent via|sent on)\b/.test(t)
      && !/\b(will|going to|gonna|about to|haven'?t|have not|not yet|need to|forgot to|should|can you|did you)\b[^.]*\b(pay|paid|send|sent)\b/.test(t)
      && !/\?\s*$/.test(t);
    if (paid) return { kind: 'paid', amount: amountIn(text), method: methodIn(text) };
  }
  return null;
}

export function createTextPay({ db, config, service, onUnclear = () => {}, onCleaned = () => {} }) {
  const nowIso = () => new Date().toISOString();
  const money = (c) => `$${(c / 100).toFixed(2).replace(/\.00$/, '')}`;
  const live = "status NOT IN ('declined','cancelled','awaiting_approval')";

  function fromCleaner(author) { return !!config.cleaner && String(author || '').toLowerCase() === config.cleaner.name.toLowerCase(); }
  function fromOwner(author) { return config.approvers.some(a => a.name.toLowerCase() === String(author || '').toLowerCase()); }

  // A note was just saved from the group text. Returns what was done with it, if anything.
  function handle(note) {
    if (!note) return null;
    const p = classifyPaymentText(note.body, { fromCleaner: fromCleaner(note.author), fromOwner: fromOwner(note.author) });
    if (!p) return null;
    const day = todayIn(config.timezone, new Date(note.at));
    const named = (dates) => service.mentionedDates(note.body, dates);
    if (p.kind === 'done') {
      // Cleanings that could be the one she just finished: not billed yet, in the last 3 weeks.
      // A date she names wins, even a coming one (a cleaning done early, or a test).
      const pool = db.prepare(`SELECT * FROM cleanings WHERE status IN ('approved','completed') AND amount_cents IS NULL AND date <= ? AND date >= ? ORDER BY date DESC`)
        .all(addDays(day, 14), addDays(day, -21));
      const byName = named(pool.map(c => c.date));
      let cands = byName.length ? pool.filter(c => byName.includes(c.date)) : pool.filter(c => c.date <= day);
      if (!byName.length && cands.some(c => c.date === day)) cands = cands.filter(c => c.date === day);
      if (cands.length === 1) return { applied: applyDone(cands[0].id, p.amount, note.author, p.done), kind: 'done' };
      return { pending: queue(note, 'done', p.amount, null), kind: 'done' };
    }
    // Paid: match what's owed by amount, or the whole balance, or the only one owed.
    const owed = db.prepare("SELECT * FROM cleanings WHERE status='completed' AND amount_cents IS NOT NULL ORDER BY date").all();
    let ids = null;
    const byName = named(owed.map(c => c.date));
    if (byName.length) ids = owed.filter(c => byName.includes(c.date)).map(c => c.id);
    else if (p.amount != null) {
      const same = owed.filter(c => c.amount_cents === p.amount);
      const total = owed.reduce((s, c) => s + c.amount_cents, 0);
      if (same.length === 1) ids = [same[0].id];
      else if (owed.length && total === p.amount) ids = owed.map(c => c.id);
    } else if (owed.length === 1) ids = [owed[0].id];
    if (ids?.length) return { applied: applyPaid(ids, { method: p.method, by: note.author, at: note.at }), kind: 'paid' };
    return { pending: queue(note, 'paid', p.amount, p.method), kind: 'paid' };
  }

  function applyDone(id, amount, by, saidDone = true) {
    let c = service.get(id);
    if (c.status === 'approved') { service.markCleaned(id, `${by} (group text)`, true); c = service.get(id); }
    if (amount != null && c.status === 'completed') service.recordPaymentRequest(id, amount / 100, `${by} (group text)`);
    const after = service.get(id);
    if (saidDone) onCleaned(after);
    return after;
  }

  function applyPaid(ids, { method, by, at, amount = null }) {
    // Paying for a cleaning whose amount was never entered: use the amount from the text.
    if (amount != null && ids.length === 1) {
      const c = service.get(ids[0]);
      if (c.status === 'approved') service.markCleaned(c.id, `${by} (group text)`, true);
      if (service.get(c.id).amount_cents == null) service.recordPaymentRequest(c.id, amount / 100, `${by} (group text)`);
    }
    const paidOn = todayIn(config.timezone, new Date(at));
    service.markPaid(ids, method, 'group text', paidOn, fromOwner(by) ? config.approvers.find(a => a.name.toLowerCase() === by.toLowerCase()).name : null);
    return ids.map(id => service.get(id));
  }

  function queue(note, kind, amount, method) {
    const r = db.prepare('INSERT INTO text_matches (note_id, kind, body, author, amount_cents, method, at, created_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(note.id ?? null, kind, note.body, note.author, amount, method, note.at, nowIso());
    const m = get(Number(r.lastInsertRowid));
    onUnclear(m);
    return m;
  }

  const get = (id) => db.prepare('SELECT * FROM text_matches WHERE id = ?').get(id);
  const pending = () => db.prepare("SELECT * FROM text_matches WHERE status = 'pending' ORDER BY at").all();

  // Cleanings to choose from in the "Which cleaning?" dialog.
  function candidates(m) {
    const day = todayIn(config.timezone, new Date(m.at));
    const rows = m.kind === 'paid'
      ? db.prepare(`SELECT * FROM cleanings WHERE ${live} AND date <= ? AND (status = 'completed' OR (status = 'approved' AND date >= ?)) ORDER BY date DESC LIMIT 8`).all(day, addDays(day, -60))
      : db.prepare(`SELECT * FROM cleanings WHERE ${live} AND status != 'paid' AND date <= ? AND date >= ? ORDER BY date DESC LIMIT 8`).all(addDays(day, 14), addDays(day, -45));
    return rows;
  }

  // Every other cleaning from the last few months and the next two, for "Another cleaning".
  function others(m, exclude = []) {
    const day = todayIn(config.timezone, new Date(m.at));
    return db.prepare(`SELECT * FROM cleanings WHERE ${live} AND date >= ? AND date <= ? ORDER BY date DESC`).all(addDays(day, -120), addDays(day, 60))
      .filter(c => !exclude.includes(c.id));
  }

  // Mark picked the cleaning(s) in the dialog (or said it isn't about one).
  function resolve(id, { cleaningIds = [], amount = null, method = null, by }) {
    const m = get(id);
    if (!m || m.status !== 'pending') return { error: 'Already handled.' };
    if (!cleaningIds.length) {
      db.prepare("UPDATE text_matches SET status='dismissed', decided_by=? WHERE id=?").run(by, id);
      return { dismissed: true };
    }
    const cents = amount != null && amount !== '' ? Math.round(Number(amount) * 100) : m.amount_cents;
    if (m.kind === 'done') for (const cid of cleaningIds) applyDone(cid, cents > 0 ? cents : null, m.author, false);
    else {
      for (const cid of cleaningIds) {
        const c = service.get(cid);
        if (c.status === 'approved') service.markCleaned(cid, by, true);
        if (service.get(cid).amount_cents == null && cleaningIds.length === 1 && cents > 0) service.recordPaymentRequest(cid, cents / 100, by);
      }
      const ready = cleaningIds.filter(cid => service.get(cid).amount_cents != null);
      service.markPaid(ready, method || m.method, by, todayIn(config.timezone, new Date(m.at)), fromOwner(m.author) ? config.approvers.find(a => a.name.toLowerCase() === m.author.toLowerCase()).name : null);
    }
    db.prepare("UPDATE text_matches SET status='applied', cleaning_ids=?, decided_by=? WHERE id=?").run(cleaningIds.join(','), by, id);
    for (const cid of cleaningIds) service.logEvent(cid, 'Matched group text', `${m.author}: "${m.body.slice(0, 80)}", picked by ${by}`);
    return { applied: cleaningIds.map(cid => service.get(cid)) };
  }

  return { handle, pending, candidates, others, resolve, get, money };
}
