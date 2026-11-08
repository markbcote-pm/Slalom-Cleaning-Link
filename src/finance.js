// The rental as a business: rental income, expenses with receipts, a year summary,
// and a package for the CPA. Money is counted on the day it came in or went out (cash basis).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { prettyDate, todayIn, addDays, isDate } from './dates.js';
import { layout, header, h, usd, guestLabel, receiptStrip, receiptInputs, UPLOAD_JS, cleanerCard, paymentsCsv, paidInYear } from './views.js';

// Expense categories, in the words an owner uses, with the IRS Schedule E line a CPA files them under.
export const EXPENSE_CATS = [
  { key: 'supplies', label: 'Supplies', hint: 'toiletries, linens, coffee, cleaning supplies', line: '15', lineName: 'Supplies' },
  { key: 'repairs', label: 'Repairs & maintenance', hint: 'fixes, handyman, landscaping, pest control', line: '14', lineName: 'Repairs' },
  { key: 'cleaning', label: 'Cleaning', hint: 'cleaner payments, laundry service', line: '7', lineName: 'Cleaning and maintenance' },
  { key: 'utilities', label: 'Utilities', hint: 'power, gas, water, trash, internet, TV', line: '17', lineName: 'Utilities' },
  { key: 'insurance', label: 'Insurance', hint: 'home and rental insurance', line: '9', lineName: 'Insurance' },
  { key: 'taxes', label: 'Property & occupancy taxes', hint: 'property tax, lodging tax you paid yourself', line: '16', lineName: 'Taxes' },
  { key: 'mortgage', label: 'Mortgage interest', hint: 'interest only, from your 1098', line: '12', lineName: 'Mortgage interest' },
  { key: 'platform', label: 'Airbnb & booking fees', hint: 'host service fees (added automatically from income)', line: '8', lineName: 'Commissions' },
  { key: 'management', label: 'Management fees', hint: 'co-host or property manager', line: '11', lineName: 'Management fees' },
  { key: 'professional', label: 'Legal & professional', hint: 'CPA, permits, business license', line: '10', lineName: 'Legal and other professional fees' },
  { key: 'advertising', label: 'Advertising', hint: 'listing photos, ads', line: '5', lineName: 'Advertising' },
  { key: 'travel', label: 'Travel & mileage', hint: 'trips to the property for the rental', line: '6', lineName: 'Auto and travel' },
  { key: 'hoa', label: 'HOA & dues', hint: 'HOA, memberships', line: '19', lineName: 'Other' },
  { key: 'furnishings', label: 'Furniture & appliances', hint: 'bigger purchases your CPA may depreciate', line: '18', lineName: 'Depreciation (CPA to review)' },
  { key: 'other', label: 'Other', hint: 'anything else for the rental', line: '19', lineName: 'Other' },
];
export const INCOME_CATS = [
  { key: 'rent', label: 'Rental income', hint: 'stays, booked on Airbnb or directly', line: '3', lineName: 'Rents received' },
  { key: 'other_income', label: 'Other income', hint: 'damage claims, reimbursements', line: '3', lineName: 'Rents received (other)' },
];
const CAT = Object.fromEntries([...EXPENSE_CATS, ...INCOME_CATS].map(c => [c.key, c]));
const METHODS = ['Card', 'Bank transfer', 'Venmo', 'Zelle', 'Cash', 'Check', 'Other'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// "$1,234.56", "1234.5" or "-20" -> cents. Null when it isn't a number.
export function parseCents(v) {
  const s = String(v ?? '').replace(/[$,\s]/g, '').replace(/^\((.*)\)$/, '-$1');
  if (!/^-?\d+(\.\d{1,2})?$/.test(s)) return null;
  return Math.round(Number(s) * 100);
}

// ---------- Reading forms, including photo uploads ----------

async function readRaw(req, limit) {
  const chunks = []; let n = 0;
  for await (const c of req) { n += c.length; if (n > limit) throw Object.assign(new Error('too big'), { tooBig: true }); chunks.push(c); }
  return Buffer.concat(chunks);
}

export function parseMultipart(buf, contentType) {
  const fields = new Map(), files = [];
  const m = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  if (m) {
    const boundary = Buffer.from('--' + (m[1] || m[2]).trim());
    let pos = buf.indexOf(boundary);
    while (pos !== -1) {
      pos += boundary.length;
      if (buf[pos] === 45 && buf[pos + 1] === 45) break;          // "--" ends the body
      pos += 2;                                                    // CRLF
      const headEnd = buf.indexOf('\r\n\r\n', pos);
      if (headEnd === -1) break;
      const next = buf.indexOf(boundary, headEnd + 4);
      if (next === -1) break;
      const head = buf.subarray(pos, headEnd).toString('utf8');
      const data = buf.subarray(headEnd + 4, next - 2);
      const name = head.match(/name="([^"]*)"/i)?.[1];
      const filename = head.match(/filename="([^"]*)"/i)?.[1];
      if (name != null) {
        if (filename !== undefined) { if (data.length) files.push({ field: name, filename, data }); }
        else { if (!fields.has(name)) fields.set(name, []); fields.get(name).push(data.toString('utf8')); }
      }
      pos = next;
    }
  }
  return { get: (k) => fields.get(k)?.[0] ?? null, getAll: (k) => fields.get(k) || [], files };
}

export async function readForm(req) {
  const ct = req.headers['content-type'] || '';
  const multipart = ct.startsWith('multipart/form-data');
  const buf = await readRaw(req, multipart ? 60e6 : 1e6);
  if (multipart) return parseMultipart(buf, ct);
  const q = new URLSearchParams(buf.toString('utf8'));
  return { get: (k) => q.get(k), getAll: (k) => q.getAll(k), files: [] };
}

// What a file really is, from its first bytes, so nothing but photos and PDFs is stored or served.
export function sniff(data) {
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return ['image/jpeg', 'jpg'];
  if (data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return ['image/png', 'png'];
  if (data.subarray(0, 4).toString('latin1') === '%PDF') return ['application/pdf', 'pdf'];
  if (data.subarray(0, 4).toString('latin1') === 'RIFF' && data.subarray(8, 12).toString('latin1') === 'WEBP') return ['image/webp', 'webp'];
  if (data.subarray(4, 8).toString('latin1') === 'ftyp' && /^(heic|heix|mif1|msf1|hevc)/.test(data.subarray(8, 12).toString('latin1'))) return ['image/heic', 'heic'];
  return null;
}

// ---------- Tiny ZIP writer (stored, no compression: photos and PDFs are already compressed) ----------

export function zip(entries) {
  const parts = [], central = []; let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8'), data = e.data, crc = zlib.crc32(data);
    const d = e.date || new Date();
    const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
    const date = ((Math.max(1980, d.getFullYear()) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(0, 8);
    local.writeUInt16LE(time, 10); local.writeUInt16LE(date, 12); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(name.length, 26); local.writeUInt16LE(0, 28);
    parts.push(local, name, data);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0); cen.writeUInt16LE(20, 4); cen.writeUInt16LE(20, 6); cen.writeUInt16LE(0x0800, 8); cen.writeUInt16LE(0, 10);
    cen.writeUInt16LE(time, 12); cen.writeUInt16LE(date, 14); cen.writeUInt32LE(crc, 16); cen.writeUInt32LE(data.length, 20); cen.writeUInt32LE(data.length, 24);
    cen.writeUInt16LE(name.length, 28); cen.writeUInt32LE(offset, 42);
    central.push(cen, name);
    offset += 30 + name.length + data.length;
  }
  const cd = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cd, end]);
}

// ---------- CSV ----------

export function parseCsv(text) {
  const rows = []; let row = [], field = '', q = false;
  text = text.replace(/^﻿/, '');
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') q = false;
      else field += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(field); rows.push(row); row = []; field = ''; }
    else field += ch;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.some(c => c.trim() !== ''));
}
const csvLine = (cells) => cells.map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',');

// "11/05/2026" or "2026-11-05" -> "2026-11-05"
function csvDate(s) {
  s = String(s || '').trim();
  let m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

// ---------- The money model ----------

export function createFinance({ db, config }) {
  const receiptsDir = path.join(config.dataDir, 'receipts');
  const now = () => new Date().toISOString();
  const today = () => todayIn(config.timezone);
  const stayCode = (b) => (b?.description || '').match(/details\/([A-Z0-9]{6,})/)?.[1] || null;

  function saveReceipts(files, { moneyId = null, cleaningId = null, by = null }) {
    const saved = [], rejected = [];
    for (const f of files) {
      const kind = sniff(f.data);
      if (!kind || f.data.length > 25e6) { rejected.push(f.filename || 'file'); continue; }
      fs.mkdirSync(receiptsDir, { recursive: true });
      const file = `${crypto.randomBytes(12).toString('hex')}.${kind[1]}`;
      fs.writeFileSync(path.join(receiptsDir, file), f.data);
      const r = db.prepare('INSERT INTO receipts (money_id, cleaning_id, file, name, mime, bytes, created_by, created_at) VALUES (?,?,?,?,?,?,?,?)')
        .run(moneyId, cleaningId, file, (f.filename || '').slice(0, 120) || null, kind[0], f.data.length, by, now());
      saved.push(Number(r.lastInsertRowid));
    }
    return { saved, rejected };
  }

  function removeReceipt(id) {
    const r = db.prepare('SELECT * FROM receipts WHERE id = ?').get(id);
    if (!r) return null;
    db.prepare('DELETE FROM receipts WHERE id = ?').run(id);
    try { fs.unlinkSync(path.join(receiptsDir, r.file)); } catch {}
    return r;
  }

  const receiptFile = (r) => path.join(receiptsDir, r.file);
  const receiptsFor = (moneyId) => db.prepare('SELECT * FROM receipts WHERE money_id = ? ORDER BY id').all(moneyId);
  const receiptsForCleaning = (cleaningId) => db.prepare('SELECT * FROM receipts WHERE cleaning_id = ? ORDER BY id').all(cleaningId);

  // Validates a form into a money row. Returns { row } or { error }.
  function fromForm(form, kind) {
    const cats = kind === 'income' ? INCOME_CATS : EXPENSE_CATS;
    const amount = parseCents(form.get('amount'));
    const fee = kind === 'income' && String(form.get('fee') || '').trim() ? parseCents(form.get('fee')) : null;
    const date = form.get('date');
    const category = cats.some(c => c.key === form.get('category')) ? form.get('category') : null;
    if (amount == null || amount === 0) return { error: 'Enter the amount, like 45.10.' };
    if (kind === 'expense' && amount < 0) return { error: 'Enter the expense as a positive amount.' };
    if (fee != null && fee < 0) return { error: "Enter Airbnb's fee as a positive amount." };
    if (kind === 'income' && String(form.get('fee') || '').trim() && fee == null) return { error: "Airbnb's fee should be a number, like 18.75." };
    if (!isDate(date || '')) return { error: 'Pick the date.' };
    if (!category) return { error: 'Pick a category.' };
    const uid = kind === 'income' && form.get('stay') ? db.prepare('SELECT uid FROM bookings WHERE uid = ?').get(form.get('stay'))?.uid || null : null;
    const paidBy = config.approvers.find(a => a.name === form.get('paid_by'))?.name || null;
    const clip = (v, n) => (String(v ?? '').trim().slice(0, n) || null);
    return { row: { kind, date, amount_cents: amount, fee_cents: fee, category, party: clip(form.get('party'), 80), booking_uid: uid, note: clip(form.get('note'), 500), method: METHODS.includes(form.get('method')) ? form.get('method') : null, paid_by: paidBy } };
  }

  function add(row, by) {
    const r = db.prepare(`INSERT INTO money (kind, date, amount_cents, fee_cents, category, party, booking_uid, note, method, paid_by, source, ext_ref, created_by, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(row.kind, row.date, row.amount_cents, row.fee_cents ?? null, row.category, row.party ?? null, row.booking_uid ?? null,
      row.note ?? null, row.method ?? null, row.paid_by ?? null, row.source || 'manual', row.ext_ref ?? null, by, now(), now());
    return Number(r.lastInsertRowid);
  }
  function update(id, row) {
    db.prepare(`UPDATE money SET date=?, amount_cents=?, fee_cents=?, category=?, party=?, booking_uid=?, note=?, method=?, paid_by=?, updated_at=? WHERE id=?`)
      .run(row.date, row.amount_cents, row.fee_cents ?? null, row.category, row.party ?? null, row.booking_uid ?? null, row.note ?? null, row.method ?? null, row.paid_by ?? null, now(), id);
  }
  function remove(id) {
    for (const r of receiptsFor(id)) removeReceipt(r.id);
    db.prepare('DELETE FROM money WHERE id = ?').run(id);
  }
  const get = (id) => db.prepare('SELECT * FROM money WHERE id = ?').get(id);

  // Airbnb's "Transaction history" CSV (Earnings > Create report). One row per reservation,
  // adjustment, resolution and payout. Payouts are bank transfers of money already counted, so skipped.
  function importAirbnbCsv(text, by) {
    const rows = parseCsv(text);
    if (rows.length < 2) return { error: 'That file is empty.' };
    const head = rows[0].map(x => x.trim().toLowerCase());
    const col = (...names) => names.map(n => head.indexOf(n)).find(i => i >= 0) ?? -1;
    const c = { date: col('date'), type: col('type'), code: col('confirmation code'), start: col('start date'), end: col('end date'), nights: col('nights'),
      guest: col('guest', 'guest name'), amount: col('amount'), fee: col('service fee', 'host fee'), gross: col('gross earnings'), details: col('details') };
    if (c.type < 0 || c.amount < 0 || c.date < 0) {
      return { error: "This doesn't look like Airbnb's transaction history. Download it from Airbnb under Earnings: it's a CSV with Date, Type, Confirmation code and Amount columns." };
    }
    const out = { added: 0, updated: 0, already: 0, names: 0, unmatched: 0, skipped: 0 };
    const bookings = db.prepare('SELECT * FROM bookings').all();
    for (const r of rows.slice(1)) {
      const type = (r[c.type] || '').trim();
      const amount = parseCents(r[c.amount]);
      const date = csvDate(r[c.date]);
      if (!type || /^payout$/i.test(type) || /tax/i.test(type) || amount == null || amount === 0 || !date) { out.skipped++; continue; }
      const code = c.code >= 0 ? (r[c.code] || '').trim() : '';
      const start = c.start >= 0 ? csvDate(r[c.start]) : null;
      const fee = c.fee >= 0 ? Math.abs(parseCents(r[c.fee]) ?? 0) || null : null;
      const guest = c.guest >= 0 ? (r[c.guest] || '').trim() : '';
      const stay = (code && bookings.find(b => stayCode(b) === code)) || (start && bookings.find(b => b.check_in === start && (b.source || 'airbnb') === 'airbnb')) || null;
      if (!stay && /reservation/i.test(type)) out.unmatched++;
      const ref = `airbnb:${code || start || ''}:${type}:${date}:${amount}`;
      if (db.prepare('SELECT 1 FROM money WHERE ext_ref = ?').get(ref)) { out.already++; continue; }
      const row = { kind: 'income', date, amount_cents: amount, fee_cents: fee, category: /resolution|reimburse/i.test(type) ? 'other_income' : 'rent',
        party: 'Airbnb', booking_uid: stay?.uid || null, note: [type !== 'Reservation' ? type : '', code ? `Confirmation ${code}` : ''].filter(Boolean).join(' · ') || null,
        method: 'Bank transfer', source: 'airbnb_csv', ext_ref: ref };
      // A stay typed in by hand earlier gets replaced by Airbnb's exact numbers instead of counted twice.
      const manual = stay && /reservation/i.test(type) ? db.prepare("SELECT * FROM money WHERE kind='income' AND category='rent' AND booking_uid=? AND source='manual' ORDER BY id LIMIT 1").get(stay.uid) : null;
      if (manual) {
        db.prepare("UPDATE money SET date=?, amount_cents=?, fee_cents=?, source='airbnb_csv', ext_ref=?, note=COALESCE(note, ?), updated_at=? WHERE id=?")
          .run(date, amount, fee, ref, row.note, now(), manual.id);
        out.updated++;
      } else { add(row, by); out.added++; }
      if (stay && guest && !stay.guest_name) {
        db.prepare('UPDATE bookings SET guest_name = ? WHERE uid = ?').run(guest.slice(0, 60), stay.uid);
        stay.guest_name = guest; out.names++;
      }
    }
    return out;
  }

  // Everything for one year, as the summary, lists and CPA files need it.
  function year(y) {
    y = String(y);
    const money = db.prepare('SELECT * FROM money WHERE substr(date,1,4)=? ORDER BY date, id').all(y);
    const allReceipts = db.prepare('SELECT * FROM receipts ORDER BY id').all();
    const byMoney = new Map(), byCleaning = new Map();
    for (const r of allReceipts) {
      if (r.money_id) (byMoney.get(r.money_id) || byMoney.set(r.money_id, []).get(r.money_id)).push(r);
      if (r.cleaning_id) (byCleaning.get(r.cleaning_id) || byCleaning.set(r.cleaning_id, []).get(r.cleaning_id)).push(r);
    }
    const bookings = db.prepare('SELECT * FROM bookings').all();
    const stayOf = (uid) => bookings.find(b => b.uid === uid) || null;
    const cleaner = config.cleaner?.name || 'Cleaner';
    const entries = [
      ...money.map(m => ({ ...m, receipts: byMoney.get(m.id) || [], stay: stayOf(m.booking_uid) })),
      ...paidInYear(db, y).map(c => ({ kind: 'expense', cleaning_id: c.id, date: c.paid_at.slice(0, 10), amount_cents: c.amount_cents, fee_cents: null, category: 'cleaning',
        party: cleaner, note: `For ${prettyDate(c.date)}`, method: c.paid_method, paid_by: c.paid_by, receipts: byCleaning.get(c.id) || [], stay: null, cleaning: c })),
    ].sort((a, b) => a.date.localeCompare(b.date) || (a.kind === b.kind ? 0 : a.kind === 'income' ? -1 : 1));
    const income = entries.filter(e => e.kind === 'income'), expenses = entries.filter(e => e.kind === 'expense');
    const gross = income.reduce((t, e) => t + e.amount_cents + (e.fee_cents || 0), 0);
    const fees = income.reduce((t, e) => t + (e.fee_cents || 0), 0);
    const byCat = Object.fromEntries(EXPENSE_CATS.map(c => [c.key, 0]));
    for (const e of expenses) byCat[e.category] = (byCat[e.category] || 0) + e.amount_cents;
    byCat.platform += fees;
    const spent = Object.values(byCat).reduce((t, v) => t + v, 0);
    const months = MONTHS.map((name, i) => {
      const k = `${y}-${String(i + 1).padStart(2, '0')}`;
      const inc = income.filter(e => e.date.startsWith(k)).reduce((t, e) => t + e.amount_cents + (e.fee_cents || 0), 0);
      const exp = expenses.filter(e => e.date.startsWith(k)).reduce((t, e) => t + e.amount_cents, 0) + income.filter(e => e.date.startsWith(k)).reduce((t, e) => t + (e.fee_cents || 0), 0);
      return { name, key: k, income: inc, expenses: exp, net: inc - exp };
    });
    // Nights in this year: rented (Airbnb) vs your own use. The IRS cares about the split for a home you also use.
    const start = `${y}-01-01`, end = `${Number(y) + 1}-01-01`;
    const nightsIn = (b) => Math.max(0, Math.round((new Date((b.check_out < end ? b.check_out : end) + 'T12:00:00Z') - new Date((b.check_in > start ? b.check_in : start) + 'T12:00:00Z')) / 864e5));
    const active = bookings.filter(b => b.status === 'active');
    const rentedNights = active.filter(b => (b.source || 'airbnb') !== 'personal').reduce((t, b) => t + nightsIn(b), 0);
    const personalNights = active.filter(b => b.source === 'personal').reduce((t, b) => t + nightsIn(b), 0);
    // Stays this year (by check-in), with what came in for each.
    const stays = active.filter(b => (b.source || 'airbnb') !== 'personal' && b.check_in.startsWith(y))
      .concat(bookings.filter(b => income.some(e => e.booking_uid === b.uid) && !(b.status === 'active' && b.check_in.startsWith(y) && (b.source || 'airbnb') !== 'personal')))
      .sort((a, b) => a.check_in.localeCompare(b.check_in))
      .map(b => {
        const rows = db.prepare("SELECT * FROM money WHERE kind='income' AND booking_uid=? ORDER BY date").all(b.uid);
        return { b, rows, received: rows.reduce((t, r) => t + r.amount_cents, 0), fee: rows.reduce((t, r) => t + (r.fee_cents || 0), 0) };
      });
    const missing = stays.filter(s => !s.rows.length && s.b.status === 'active' && s.b.check_in <= today());
    return { year: y, entries, income, expenses, gross, fees, byCat, spent, net: gross - spent, months, rentedNights, personalNights, stays, missing };
  }

  const years = () => {
    const ys = db.prepare(`SELECT DISTINCT substr(date,1,4) y FROM money UNION SELECT DISTINCT substr(paid_at,1,4) FROM cleanings WHERE status='paid' AND paid_at IS NOT NULL
      UNION SELECT DISTINCT substr(check_in,1,4) FROM bookings`).all().map(r => r.y).filter(Boolean);
    return [...new Set([today().slice(0, 4), ...ys])].sort().reverse();
  };

  return { receiptsDir, saveReceipts, removeReceipt, receiptFile, receiptsFor, receiptsForCleaning, fromForm, add, update, remove, get, importAirbnbCsv, year, years };
}

// ---------- Pages ----------

const catOptions = (cats, sel) => cats.filter(c => c.key !== 'platform' || sel === 'platform').map(c => `<option value="${c.key}" ${c.key === sel ? 'selected' : ''}>${h(c.label)}${c.hint ? ` (${h(c.hint)})` : ''}</option>`).join('');
const stayName = (b) => b ? `${guestLabel(b)}, ${prettyDate(b.check_in)} to ${prettyDate(b.check_out)}` : '';
const kpi = (label, cents, cls = '') => `<div class="kpi ${cls}"><span>${label}</span><b>${usd(cents)}</b></div>`;

function entryRow(e) {
  const cat = CAT[e.category];
  const link = e.cleaning_id ? `/cleanings/${e.cleaning_id}` : `/money/${e.id}`;
  const who = [e.paid_by ? `paid by ${e.paid_by}` : '', e.method].filter(Boolean).join(' · ');
  return `<tr><td class="sub" style="white-space:nowrap">${h(prettyDate(e.date))}</td>
<td><a href="${link}"><b>${h(e.party || cat?.label || '')}</b></a><div class="sub">${h(cat?.label || e.category)}${e.note ? ` · ${h(e.note)}` : ''}${who ? ` · ${h(who)}` : ''}</div>${receiptStrip(e.receipts)}</td>
<td class="num">${usd(e.amount_cents)}${e.receipts.length ? '' : '<div class="sub">no receipt</div>'}</td></tr>`;
}

export function financePage({ config, db, who, fin, year, flash = '' }) {
  const Y = fin.year(year);
  const profit = Y.net >= 0;
  const yearSel = `<form method="get" action="/payments" class="row noprint"><select name="year" aria-label="Year" onchange="this.form.submit()">${fin.years().map(y => `<option ${y === Y.year ? 'selected' : ''}>${h(y)}</option>`).join('')}</select></form>`;
  const catRows = EXPENSE_CATS.filter(c => Y.byCat[c.key]).map(c => `<tr><td>${h(c.label)}</td><td class="num">${usd(Y.byCat[c.key])}</td></tr>`).join('');
  const activeMonths = Y.months.filter(m => m.income || m.expenses);
  const cleanerName = h(config.cleaner?.name || 'Cleaner');
  const cleanerPaid = paidInYear(db, Y.year);
  const cleanerTotal = cleanerPaid.reduce((t, c) => t + (c.amount_cents || 0), 0);
  const stayRows = Y.stays.map(s => {
    const b = s.b, past = b.check_in <= todayIn(config.timezone);
    const status = b.status !== 'active' ? 'Cancelled' : '';
    return `<tr><td><b>${h(guestLabel(b))}</b>${status ? ` <span class="tag none">${status}</span>` : ''}<div class="sub">${h(prettyDate(b.check_in))} to ${h(prettyDate(b.check_out))}</div></td>
<td class="num">${s.rows.length ? `${usd(s.received)}${s.fee ? `<div class="sub">+ ${usd(s.fee)} Airbnb fee</div>` : ''}` : past ? `<a class="btn ghost small" href="/money/new?kind=income&stay=${encodeURIComponent(b.uid)}">Add amount</a>` : '<span class="sub">Upcoming</span>'}
${s.rows.length ? `<div class="sub">${s.rows.map(r => `<a href="/money/${r.id}">${r.source === 'airbnb_csv' ? 'from Airbnb' : 'edit'}</a>`).join(' · ')}</div>` : ''}</td></tr>`;
  }).join('');
  const otherIncome = Y.income.filter(e => !e.booking_uid);
  const expenseRows = Y.expenses.slice().reverse().map(entryRow).join('');
  const noReceipt = Y.expenses.filter(e => !e.receipts.length).length;

  return layout('Payments', `${header({ config, db, who, active: 'payments' })}
${flash ? `<div class="flash">${h(flash)}</div>` : ''}
<div class="card"><div class="row" style="justify-content:space-between"><h2 style="margin:0">${h(Y.year)} at a glance</h2>${yearSel}</div>
<div class="kpis">${kpi('Income', Y.gross)}${kpi('Expenses', Y.spent)}${kpi(profit ? 'Profit' : 'Loss', Y.net, profit ? 'good' : 'bad')}</div>
<p class="sub" style="margin:4px 0 10px">${Y.rentedNights} nights rented · ${Y.personalNights} nights your own use · ${Y.stays.filter(s => s.b.status === 'active').length} stays</p>
${Y.missing.length ? `<p class="missing-text">${Y.missing.length} stay${Y.missing.length === 1 ? '' : 's'} with no income entered yet. <a href="#import">Import from Airbnb</a> or tap Add amount below.</p>` : ''}
<div class="row noprint"><a class="btn" href="/money/new?kind=expense">Add expense or receipt</a><a class="btn ghost" href="/money/new?kind=income">Add income</a><a class="btn ghost" href="#import">Import from Airbnb</a></div>
${catRows || activeMonths.length ? `<div class="form-grid" style="margin-top:14px">
<div><div class="h3">Where the money went</div><table>${catRows || '<tr><td class="sub">No expenses yet.</td></tr>'}<tr class="total"><td>Total expenses</td><td class="num">${usd(Y.spent)}</td></tr></table></div>
<div><div class="h3">By month</div><table><tr><th>Month</th><th class="num">In</th><th class="num">Out</th><th class="num">Net</th></tr>${activeMonths.map(m => `<tr><td>${m.name}</td><td class="num">${usd(m.income)}</td><td class="num">${usd(m.expenses)}</td><td class="num ${m.net < 0 ? 'warn' : ''}">${usd(m.net)}</td></tr>`).join('')}</table></div></div>` : ''}
<p class="sub" style="margin-bottom:0">Income is what guests paid before Airbnb's fee. Expenses include Airbnb's fees, ${cleanerName}'s payments and everything you add. Each amount counts in the year it was paid.</p></div>
${cleanerCard({ config, db, who })}
<div class="card" id="income"><h2>Rental income</h2>
${stayRows ? `<table><tr><th>Stay</th><th class="num">You received</th></tr>${stayRows}</table>` : '<p class="sub">No stays this year yet.</p>'}
${otherIncome.length ? `<div class="h3">Other income</div><table>${otherIncome.map(entryRow).join('')}</table>` : ''}</div>
<div class="card" id="expenses"><div class="row" style="justify-content:space-between"><h2 style="margin:0">Expenses</h2><a class="btn small noprint" href="/money/new?kind=expense">Add</a></div>
${noReceipt ? `<p class="sub">${noReceipt} without a receipt. Tap one to add a photo.</p>` : ''}
${expenseRows ? `<table style="margin-top:8px">${expenseRows}</table>` : '<p class="sub">Nothing yet. Add your first expense, and snap the receipt while you have it.</p>'}</div>
<div class="card noprint" id="import"><h2>Import from Airbnb</h2>
<p>Airbnb's calendar link doesn't include money, but its earnings report does. On airbnb.com, open <b>Menu &gt; Earnings</b>, choose to create a report or download your transaction history as a CSV for the year, then upload that file here.</p>
<p class="sub">It fills in what you received and Airbnb's fee for each stay, adds guest names that are missing, and skips anything already imported, so you can import again any time.</p>
<form method="post" action="/payments/import" enctype="multipart/form-data" class="row"><input type="file" name="csv" accept=".csv,text/csv" required><button>Import</button></form></div>
<div class="card" id="records"><h2>For your CPA</h2>
<p>Everything for ${h(Y.year)} in one download: a spreadsheet of every amount with its tax category, a printable summary, and all receipts named by date and payee.</p>
<div class="row noprint"><a class="btn" href="/payments/package.zip?year=${h(Y.year)}">Download ${h(Y.year)} package (.zip)</a><a class="btn ghost" href="/payments/report?year=${h(Y.year)}">Printable summary</a><a class="btn ghost" href="/payments/ledger.csv?year=${h(Y.year)}" download>Spreadsheet only</a></div>
<p class="sub" style="margin-top:12px">${h(Y.year)} total paid to ${cleanerName}: <b>${usd(cleanerTotal)}</b> for ${cleanerPaid.length} cleaning${cleanerPaid.length === 1 ? '' : 's'}. If that's $600 or more, your CPA may file a 1099 for ${cleanerName}. <a href="/payments.csv?year=${h(Y.year)}" download>Cleaner payments (.csv)</a></p></div>`);
}

export function moneyForm({ config, db, who, fin, kind, entry = null, stayUid = null, error = '', values = null }) {
  const isIncome = kind === 'income';
  const e = values || entry || {};
  const today = todayIn(config.timezone);
  const stay = stayUid ? db.prepare('SELECT * FROM bookings WHERE uid = ?').get(stayUid) : null;
  const defDate = e.date || (stay ? (addDays(stay.check_in, 1) < today ? addDays(stay.check_in, 1) : today) : today);
  const yr = (e.date || today).slice(0, 4);
  const stays = db.prepare("SELECT * FROM bookings WHERE (source IS NULL OR source != 'personal') ORDER BY check_in DESC LIMIT 80").all();
  const sel = e.booking_uid || stayUid || '';
  const dollars = (c) => c == null ? '' : (c / 100).toFixed(2);
  const action = entry ? `/money/${entry.id}` : '/money/new';
  const receipts = entry ? fin.receiptsFor(entry.id) : [];
  const title = entry ? (isIncome ? 'Income' : 'Expense') : (isIncome ? 'Add income' : 'Add expense');
  const payer = config.approvers.map(a => `<option ${a.name === (e.paid_by || who) ? 'selected' : ''}>${h(a.name)}</option>`).join('');
  return layout(title, `${header({ config, db, who, active: 'payments' })}
<div class="card"><p><a href="/payments?year=${h(yr)}#${isIncome ? 'income' : 'expenses'}">&lsaquo; Payments</a></p><h2>${title}</h2>
${entry?.source === 'airbnb_csv' ? '<p class="sub">Imported from Airbnb. Changes you make here are kept.</p>' : ''}
${error ? `<p class="flash" style="background:var(--w-missing);color:var(--w-missing-ink)">${h(error)}</p>` : ''}
<form method="post" action="${action}" enctype="multipart/form-data" data-upload><input type="hidden" name="kind" value="${kind}">
${isIncome ? '' : receiptInputs('Receipt (photo or PDF)')}
<div class="form-grid">
<label>${isIncome ? 'Amount you received ($)' : 'Amount ($)'}<input name="amount" type="number" step="0.01" ${isIncome ? '' : 'min="0.01"'} inputmode="decimal" required value="${h(dollars(e.amount_cents))}" placeholder="0.00"></label>
<label>${isIncome ? 'Date received' : 'Date paid'}<input name="date" type="date" required value="${h(defDate)}"></label>
${isIncome ? `<label>Airbnb fee ($, optional)<input name="fee" type="number" step="0.01" min="0" inputmode="decimal" value="${h(dollars(e.fee_cents))}" placeholder="0.00"><span class="sub">Airbnb's host fee, taken out before you were paid. It counts as an expense.</span></label>
<label>Type<select name="category">${catOptions(INCOME_CATS, e.category || 'rent')}</select></label>
<label class="wide">Stay<select name="stay"><option value="">Not for a particular stay</option>${stays.map(b => `<option value="${h(b.uid)}" ${b.uid === sel ? 'selected' : ''}>${h(stayName(b))}</option>`).join('')}</select></label>
<label>From<input name="party" maxlength="80" value="${h(e.party ?? (stay || !entry ? 'Airbnb' : ''))}" placeholder="Airbnb, or the guest's name"></label>`
    : `<label class="wide">Category<select name="category" required>${e.category ? '' : '<option value="">Pick one</option>'}${catOptions(EXPENSE_CATS, e.category)}</select></label>
<label>Paid to<input name="party" maxlength="80" value="${h(e.party || '')}" placeholder="Store or person" autocomplete="off"></label>
<label>Who paid<select name="paid_by">${payer}</select></label>`}
<label>How<select name="method"><option value="">Not recorded</option>${METHODS.map(m => `<option ${m === e.method ? 'selected' : ''}>${m}</option>`).join('')}</select></label>
<label class="wide">Note (optional)<input name="note" maxlength="500" value="${h(e.note || '')}" placeholder="${isIncome ? 'Anything to remember' : 'What it was for'}"></label>
</div>
${isIncome ? receiptInputs('Statement or proof (optional)') : ''}
${receipts.length ? `<div class="h3">Saved receipts</div>${receiptStrip(receipts, { deletable: true, back: `/money/${entry.id}` })}` : ''}
<div class="row" style="margin-top:14px"><button style="flex:1">Save</button></div></form>
${entry ? `<form method="post" action="/money/${entry.id}/delete" onsubmit="return confirm('Delete this ${isIncome ? 'income' : 'expense'}${receipts.length ? ' and its receipts' : ''}?')" style="margin-top:10px"><button class="danger">Delete</button></form>` : ''}
${entry ? `<p class="sub" style="margin-bottom:0">Added by ${h(entry.created_by || 'someone')} on ${h(prettyDate(entry.created_at.slice(0, 10)))}.</p>` : ''}</div>
${UPLOAD_JS}`);
}

// A plain summary to print or save as PDF, and the same page inside the CPA package.
export function reportHtml({ config, Y, receiptHref }) {
  const owners = config.approvers.map(a => a.name).join(' and ');
  const lineRows = EXPENSE_CATS.filter(c => Y.byCat[c.key]).map(c => `<tr><td>${h(c.line)}</td><td>${h(c.lineName)}</td><td>${h(c.label)}</td><td class="num">${usd(Y.byCat[c.key])}</td></tr>`).join('');
  const rows = Y.entries.map(e => {
    const cat = CAT[e.category];
    const amount = e.kind === 'income' ? e.amount_cents + (e.fee_cents || 0) : e.amount_cents;
    return `<tr><td>${h(e.date)}</td><td>${e.kind === 'income' ? 'Income' : 'Expense'}</td><td>${h(cat?.label || e.category)}</td><td>${h(e.party || '')}${e.stay ? `<div class="sub">${h(stayName(e.stay))}</div>` : ''}${e.note ? `<div class="sub">${h(e.note)}</div>` : ''}</td>
<td class="num">${usd(amount)}${e.fee_cents ? `<div class="sub">Airbnb fee ${usd(e.fee_cents)}</div>` : ''}</td><td>${e.receipts.map((r, i) => `<a href="${h(receiptHref(r, e, i))}">receipt${e.receipts.length > 1 ? ` ${i + 1}` : ''}</a>`).join(' ') || '<span class="sub">none</span>'}</td></tr>`;
  }).join('');
  return layout(`${config.propertyName} ${Y.year} rental income and expenses`, `<div class="card"><h1>${h(config.propertyName)}: ${h(Y.year)} rental income and expenses</h1>
<p class="sub">Short-term rental owned by ${h(owners)}. Cash basis: each amount is counted on the day it was received or paid. Prepared from Cleaning Link on ${h(new Date().toISOString().slice(0, 10))}.</p>
<table><tr><td>Gross rental income (before Airbnb fees)</td><td class="num"><b>${usd(Y.gross)}</b></td></tr>
<tr><td>Total expenses (including ${usd(Y.fees)} of Airbnb fees)</td><td class="num"><b>${usd(Y.spent)}</b></td></tr>
<tr class="total"><td>Net ${Y.net >= 0 ? 'profit' : 'loss'}</td><td class="num">${usd(Y.net)}</td></tr>
<tr><td>Nights rented / nights of personal use</td><td class="num">${Y.rentedNights} / ${Y.personalNights}</td></tr></table>
<h2 style="margin-top:18px">Expenses by Schedule E line (suggested)</h2>
<table><tr><th>Line</th><th>Schedule E</th><th>Category</th><th class="num">Amount</th></tr>${lineRows || '<tr><td colspan="4" class="sub">None</td></tr>'}</table>
<p class="sub">Line numbers are a starting point for your CPA. Furniture and appliances may need to be depreciated rather than deducted in one year.</p>
<h2 style="margin-top:18px">Every amount</h2>
<div class="scroll"><table><tr><th>Date</th><th>Type</th><th>Category</th><th>From / to</th><th class="num">Amount</th><th>Receipt</th></tr>${rows || '<tr><td colspan="6" class="sub">Nothing recorded.</td></tr>'}</table></div></div>`);
}

// File name for a receipt inside the package: 2026-03-04_Home-Depot_45.10.jpg
const safeName = (s) => String(s || '').normalize('NFKD').replace(/[^\w.-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'receipt';
export function receiptZipName(r, e, i) {
  const ext = r.file.split('.').pop();
  return `receipts/${e.date}_${safeName(e.party || CAT[e.category]?.label)}_${(e.amount_cents / 100).toFixed(2)}${e.receipts.length > 1 ? `_${i + 1}` : ''}_${r.id}.${ext}`;
}

export function ledgerCsv(config, Y, nameOf = (r, e, i) => receiptZipName(r, e, i)) {
  const lines = [csvLine(['Date', 'Type', 'Category', 'Schedule E line', 'From / paid to', 'Stay', 'Gross amount', 'Airbnb fee', 'Net amount', 'Paid by', 'Method', 'Note', 'Receipts'])];
  for (const e of Y.entries) {
    const cat = CAT[e.category];
    const fee = e.fee_cents || 0;
    const gross = e.kind === 'income' ? e.amount_cents + fee : e.amount_cents;
    lines.push(csvLine([e.date, e.kind === 'income' ? 'Income' : 'Expense', cat?.label || e.category, cat ? `${cat.line} ${cat.lineName}` : '', e.party || '', e.stay ? stayName(e.stay) : '',
      (gross / 100).toFixed(2), fee ? (fee / 100).toFixed(2) : '', (e.amount_cents / 100).toFixed(2), e.paid_by || '', e.method || '', e.note || '', e.receipts.map((r, i) => nameOf(r, e, i)).join('; ')]));
  }
  lines.push('');
  lines.push(csvLine(['', '', 'Gross rental income', '3 Rents received', '', '', (Y.gross / 100).toFixed(2)]));
  for (const c of EXPENSE_CATS.filter(c => Y.byCat[c.key])) lines.push(csvLine(['', '', c.label, `${c.line} ${c.lineName}`, '', '', (Y.byCat[c.key] / 100).toFixed(2)]));
  lines.push(csvLine(['', '', 'Total expenses', '', '', '', (Y.spent / 100).toFixed(2)]));
  lines.push(csvLine(['', '', Y.net >= 0 ? 'Net profit' : 'Net loss', '', '', '', (Y.net / 100).toFixed(2)]));
  return lines.join('\r\n') + '\r\n';
}

// ---------- Routes ----------

export function financeRoutes({ db, config, fin }) {
  const yearOf = (v) => /^\d{4}$/.test(v || '') ? v : todayIn(config.timezone).slice(0, 4);
  const back = (v, dflt) => /^\/(?!\/)[\w/?=&#%.-]*$/.test(v || '') ? v : dflt;

  return async function route({ req, res, p, url, who, send, redirect }) {
    const by = who || 'someone';
    if (req.method === 'GET' && p === '/payments') {
      send(res, 200, financePage({ config, db, who, fin, year: yearOf(url.searchParams.get('year')), flash: url.searchParams.get('flash') || '' }));
      return true;
    }
    if (req.method === 'GET' && p === '/payments/report') {
      const Y = fin.year(yearOf(url.searchParams.get('year')));
      send(res, 200, reportHtml({ config, Y, receiptHref: (r) => `/receipts/${r.id}` }));
      return true;
    }
    if (req.method === 'GET' && p === '/payments/ledger.csv') {
      const Y = fin.year(yearOf(url.searchParams.get('year')));
      send(res, 200, ledgerCsv(config, Y), 'text/csv; charset=utf-8', { 'Content-Disposition': `attachment; filename="rental-income-expenses-${Y.year}.csv"` });
      return true;
    }
    if (req.method === 'GET' && p === '/payments/package.zip') {
      const Y = fin.year(yearOf(url.searchParams.get('year')));
      const files = [];
      for (const e of Y.entries) e.receipts.forEach((r, i) => {
        try { files.push({ name: receiptZipName(r, e, i), data: fs.readFileSync(fin.receiptFile(r)), date: new Date(r.created_at) }); } catch {}
      });
      const zipped = new Set(files.map(f => f.name));
      const nameOf = (r, e, i) => zipped.has(receiptZipName(r, e, i)) ? receiptZipName(r, e, i) : '(file missing)';
      const base = `${safeName(config.propertyName)}-${Y.year}`;
      const body = zip([
        { name: `${base}/summary.html`, data: Buffer.from(reportHtml({ config, Y, receiptHref: (r, e, i) => nameOf(r, e, i) })) },
        { name: `${base}/income-and-expenses.csv`, data: Buffer.from(ledgerCsv(config, Y, nameOf)) },
        { name: `${base}/cleaner-payments.csv`, data: Buffer.from(paymentsCsv(db, config, Y.year)) },
        ...files.map(f => ({ ...f, name: `${base}/${f.name}` })),
      ]);
      send(res, 200, body, 'application/zip', { 'Content-Disposition': `attachment; filename="${base}-tax-package.zip"` });
      return true;
    }
    if (req.method === 'GET' && p === '/money/new') {
      const kind = url.searchParams.get('kind') === 'income' ? 'income' : 'expense';
      send(res, 200, moneyForm({ config, db, who, fin, kind, stayUid: url.searchParams.get('stay') }));
      return true;
    }
    let m = p.match(/^\/money\/(\d+)$/);
    if (req.method === 'GET' && m) {
      const entry = fin.get(Number(m[1]));
      if (!entry) { send(res, 404, 'Not found', 'text/plain'); return true; }
      send(res, 200, moneyForm({ config, db, who, fin, kind: entry.kind, entry }));
      return true;
    }
    m = p.match(/^\/receipts\/(\d+)$/);
    if (req.method === 'GET' && m) {
      const r = db.prepare('SELECT * FROM receipts WHERE id = ?').get(Number(m[1]));
      let data = null;
      try { data = r && fs.readFileSync(fin.receiptFile(r)); } catch {}
      if (!data) { send(res, 404, 'Receipt not found', 'text/plain'); return true; }
      const ext = r.file.split('.').pop();
      send(res, 200, data, r.mime, { 'Content-Disposition': `inline; filename="receipt-${r.id}.${ext}"`, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, max-age=86400' });
      return true;
    }

    if (req.method !== 'POST') return false;
    const isOurs = p === '/money/new' || p === '/payments/import' || /^\/money\/\d+(\/delete)?$/.test(p) || /^\/receipts\/\d+\/delete$/.test(p) || /^\/cleanings\/\d+\/receipt$/.test(p);
    if (!isOurs) return false;
    let form;
    try { form = await readForm(req); }
    catch (err) { send(res, 413, 'That upload is too big. Try fewer or smaller files.', 'text/plain'); return true; }
    const rejectedNote = (r) => r.length ? ` ${r.length} file${r.length === 1 ? " wasn't" : "s weren't"} a photo or PDF and ${r.length === 1 ? 'was' : 'were'} skipped.` : '';

    if (p === '/payments/import') {
      const f = form.files[0];
      const r = f ? fin.importAirbnbCsv(f.data.toString('utf8'), by) : { error: 'Choose the CSV file from Airbnb first.' };
      const msg = r.error || `Imported from Airbnb: ${r.added} new, ${r.updated} replaced your typed-in amounts, ${r.already} already here.${r.names ? ` Added ${r.names} guest name${r.names === 1 ? '' : 's'}.` : ''}${r.unmatched ? ` ${r.unmatched} reservation${r.unmatched === 1 ? " didn't" : "s didn't"} match a stay on the calendar and ${r.unmatched === 1 ? 'is' : 'are'} listed under Other income.` : ''}`;
      redirect(res, `/payments?flash=${encodeURIComponent(msg)}#income`);
      return true;
    }
    if (p === '/money/new') {
      const kind = form.get('kind') === 'income' ? 'income' : 'expense';
      const { row, error } = fin.fromForm(form, kind);
      if (error) { send(res, 400, moneyForm({ config, db, who, fin, kind, error, values: { ...Object.fromEntries(['date', 'category', 'party', 'note', 'method', 'paid_by'].map(k => [k, form.get(k)])), booking_uid: form.get('stay'), amount_cents: parseCents(form.get('amount')), fee_cents: parseCents(form.get('fee')) } })); return true; }
      const id = fin.add(row, by);
      const { saved, rejected } = fin.saveReceipts(form.files.filter(f => f.field === 'receipt'), { moneyId: id, by });
      const what = kind === 'income' ? `Saved ${usd(row.amount_cents)} of income` : `Saved ${usd(row.amount_cents)} for ${CAT[row.category].label.toLowerCase()}${saved.length ? ` with ${saved.length} receipt${saved.length === 1 ? '' : 's'}` : ''}`;
      redirect(res, `/payments?year=${row.date.slice(0, 4)}&flash=${encodeURIComponent(what + '.' + rejectedNote(rejected))}#${kind === 'income' ? 'income' : 'expenses'}`);
      return true;
    }
    m = p.match(/^\/money\/(\d+)$/);
    if (m) {
      const entry = fin.get(Number(m[1]));
      if (!entry) { send(res, 404, 'Not found', 'text/plain'); return true; }
      const { row, error } = fin.fromForm(form, entry.kind);
      if (error) { send(res, 400, moneyForm({ config, db, who, fin, kind: entry.kind, entry, error })); return true; }
      fin.update(entry.id, row);
      const { saved, rejected } = fin.saveReceipts(form.files.filter(f => f.field === 'receipt'), { moneyId: entry.id, by });
      redirect(res, `/payments?year=${row.date.slice(0, 4)}&flash=${encodeURIComponent(`Saved.${saved.length ? ` Added ${saved.length} receipt${saved.length === 1 ? '' : 's'}.` : ''}${rejectedNote(rejected)}`)}#${entry.kind === 'income' ? 'income' : 'expenses'}`);
      return true;
    }
    m = p.match(/^\/money\/(\d+)\/delete$/);
    if (m) {
      const entry = fin.get(Number(m[1]));
      if (entry) fin.remove(entry.id);
      redirect(res, `/payments?year=${(entry?.date || '').slice(0, 4)}&flash=${encodeURIComponent(entry ? 'Deleted.' : 'Already deleted.')}`);
      return true;
    }
    m = p.match(/^\/receipts\/(\d+)\/delete$/);
    if (m) {
      fin.removeReceipt(Number(m[1]));
      redirect(res, back(form.get('next'), '/payments'));
      return true;
    }
    m = p.match(/^\/cleanings\/(\d+)\/receipt$/);
    if (m) {
      const id = Number(m[1]);
      if (!db.prepare('SELECT 1 FROM cleanings WHERE id = ?').get(id)) { send(res, 404, 'Not found', 'text/plain'); return true; }
      fin.saveReceipts(form.files.filter(f => f.field === 'receipt'), { cleaningId: id, by });
      redirect(res, `/cleanings/${id}`);
      return true;
    }
    return false;
  };
}
