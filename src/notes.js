import crypto from 'node:crypto';
import { addDays, todayIn } from './dates.js';

// ---- Sorting notes into "supplies to buy" and "condition / damage" -------------------

const SUPPLY_WORDS = /\b(out of|ran out|running low|low on|need(s)? more|not enough|almost out|restock|replace|replacement|buy|order|we need|need (a|an|new|some))\b/i;
const SUPPLY_ITEMS = /\b(towels?|hand towels?|wash ?cloths?|washcloths?|sheets?|linens?|pillow ?cases?|toilet paper|tp|paper towels?|soap|shampoo|conditioner|body wash|dish soap|detergent|sponges?|trash bags?|garbage bags?|coffee|filters?|batteries|light ?bulbs?|bulbs?|cleaning supplies|cleaner|bleach|wipes|dishwasher (pods|tabs))\b/i;
const CONDITION_WORDS = /\b(broke|broken|breaks|damage[d]?|cracked?|chipped|stain(s|ed)?|spill(ed)?|burn(t|ed)?|ripped|torn|hole|dent(ed)?|leak(ing|ed)?|missing|stolen|took|dirty|filthy|gross|disgusting|mess(y)?|trashed|smell(s|ed|y)?|smok(e|ed|ing)|vomit|pee|urine|pet hair|dog hair|cat hair|party|extra cleaning|took (me )?longer|hours? (longer|extra)|left (a|the)|garbage everywhere)\b/i;

export function classify(text) {
  const tags = [];
  if (SUPPLY_ITEMS.test(text) && (SUPPLY_WORDS.test(text) || /\b(missing|only \d+|none left|no more)\b/i.test(text))) tags.push('supplies');
  if (CONDITION_WORDS.test(text) && !(tags.includes('supplies') && !/\b(broke|broken|damage|stain|dirty|mess|smell|smok|vomit|party|trashed)/i.test(text))) tags.push('condition');
  return tags;
}

// ---- Which cleaning and which stay a note belongs to ----------------------------------

const localDate = (iso, tz) => todayIn(tz, new Date(iso));

// A note sent on a cleaning day belongs to that cleaning. A note in the two days after a
// cleaning is a report on it. Anything else is prep for the next cleaning coming up.
export function linkNote(db, atIso, tz) {
  const d = localDate(atIso, tz);
  const live = "status NOT IN ('cancelled','declined')";
  const cleaning =
    db.prepare(`SELECT * FROM cleanings WHERE ${live} AND date = ? ORDER BY id LIMIT 1`).get(d) ||
    db.prepare(`SELECT * FROM cleanings WHERE ${live} AND date < ? AND date >= ? ORDER BY date DESC LIMIT 1`).get(d, addDays(d, -2)) ||
    db.prepare(`SELECT * FROM cleanings WHERE ${live} AND date > ? ORDER BY date LIMIT 1`).get(d) ||
    null;
  return { cleaning, booking: priorStay(db, cleaning ? cleaning.date : d) };
}

// The stay the cleaner is cleaning up after: the one checking out that day, or the most
// recent one before it.
export function priorStay(db, date) {
  return db.prepare("SELECT * FROM bookings WHERE status='active' AND check_out <= ? ORDER BY check_out DESC LIMIT 1").get(date) || null;
}

export function reservationUrl(b) {
  return (b?.description || '').match(/https:\/\/www\.airbnb\.[^\s]+/)?.[0] || null;
}

// ---- Storing notes and making to-dos --------------------------------------------------

export function createNotes({ db, config }) {
  const now = () => new Date().toISOString();

  function personByPhone(phone) {
    const digits = (s) => (s || '').replace(/\D/g, '').slice(-10);
    return config.groupMembers.find(p => p.phone && digits(p.phone) === digits(phone))?.name || phone || 'Unknown';
  }

  function add({ body, author, phone = null, at = now(), source = 'manual', cleaningId = null, tags = null }) {
    body = String(body || '').trim().slice(0, 2000);
    if (!body) return null;
    const auto = linkNote(db, at, config.timezone);
    const cleaning = cleaningId ? db.prepare('SELECT * FROM cleanings WHERE id = ?').get(cleaningId) : auto.cleaning;
    const booking = cleaningId ? priorStay(db, cleaning.date) : auto.booking;
    // Only the cleaner's texts are sorted automatically, so a reply like "thanks, I'll order
    // towels" from Mark or Danielle doesn't create a second to-do.
    const name = author || personByPhone(phone);
    const fromOwner = config.approvers.some(a => a.name === name);
    const t = tags ?? (fromOwner ? [] : classify(body));
    const r = db.prepare(`INSERT INTO notes (at, author, phone, body, source, cleaning_id, booking_uid, tags, followup, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(at, author || personByPhone(phone), phone, body, source, cleaning?.id ?? null,
      booking?.uid ?? null, t.join(','), t.includes('condition') ? 'open' : null, now());
    const id = Number(r.lastInsertRowid);
    if (t.includes('supplies')) addTodo({ title: body.length > 140 ? body.slice(0, 137) + '...' : body, noteId: id, cleaningId: cleaning?.id ?? null });
    if (cleaning) db.prepare('INSERT INTO events (cleaning_id, stage, detail, at) VALUES (?,?,?,?)').run(cleaning.id, 'Note', `${author || personByPhone(phone)}: ${body}`, now());
    return get(id);
  }

  const get = (id) => db.prepare('SELECT * FROM notes WHERE id = ?').get(id);

  function update(id, { cleaningId, tags, by }) {
    const n = get(id);
    if (!n) return null;
    const cleaning = cleaningId ? db.prepare('SELECT * FROM cleanings WHERE id = ?').get(cleaningId) : null;
    const booking = cleaning ? priorStay(db, cleaning.date) : null;
    const had = (n.tags || '').split(',').filter(Boolean);
    db.prepare('UPDATE notes SET cleaning_id = ?, booking_uid = ?, tags = ?, followup = ? WHERE id = ?')
      .run(cleaning?.id ?? null, booking?.uid ?? null, tags.join(','),
        tags.includes('condition') ? (n.followup || 'open') : null, id);
    if (tags.includes('supplies') && !had.includes('supplies') && !db.prepare('SELECT 1 FROM todos WHERE note_id = ?').get(id)) {
      addTodo({ title: n.body.slice(0, 140), noteId: id, cleaningId: cleaning?.id ?? null, by });
    }
    return get(id);
  }

  function setFollowup(id, status) {
    db.prepare('UPDATE notes SET followup = ? WHERE id = ? AND followup IS NOT NULL').run(status === 'done' ? 'done' : 'open', id);
  }

  function addTodo({ title, noteId = null, cleaningId = null, by = null }) {
    title = String(title || '').trim().slice(0, 300);
    if (!title) return null;
    return db.prepare('INSERT INTO todos (title, note_id, cleaning_id, status, created_by, created_at) VALUES (?,?,?,?,?,?)')
      .run(title, noteId, cleaningId, 'open', by, now());
  }

  function setTodo(id, done, by) {
    db.prepare('UPDATE todos SET status = ?, done_at = ?, done_by = ? WHERE id = ?')
      .run(done ? 'done' : 'open', done ? now() : null, done ? by : null, id);
  }

  const forCleaning = (id) => db.prepare('SELECT * FROM notes WHERE cleaning_id = ? ORDER BY at').all(id);
  const counts = () => Object.fromEntries(db.prepare('SELECT cleaning_id, COUNT(*) n FROM notes WHERE cleaning_id IS NOT NULL GROUP BY cleaning_id').all().map(r => [r.cleaning_id, r.n]));

  return { add, get, update, setFollowup, addTodo, setTodo, forCleaning, counts, personByPhone };
}

// ---- Twilio webhooks --------------------------------------------------------------------

// https://www.twilio.com/docs/usage/security#validating-requests
export function validTwilioSignature(authToken, url, params, signature) {
  if (!authToken || !signature) return false;
  const data = url + [...params.keys()].sort().map(k => k + params.getAll(k).join('')).join('');
  const expected = crypto.createHmac('sha1', authToken).update(data).digest('base64');
  const a = Buffer.from(expected), b = Buffer.from(signature);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
