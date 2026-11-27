// After-cleaning photos, kept with each cleaning so they can be shared with the next guest.
//
// The fastest way in on Android: in Messages, select the cleaner's photos, tap Share and pick
// "Cleaning" (the app is a share target once it's on the home screen). The photos land in a
// short-lived holding area, then a page asks which cleaning they're from (best guess already
// picked). They can also be added from the cleaning's page.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { sniff } from './finance.js';
import { todayIn } from './dates.js';

const IMAGE = ['image/jpeg', 'image/png', 'image/webp', 'image/heic'];
const MAX_FILES = 40, MAX_BYTES = 20e6, HOLD_MS = 2 * 3600e3, MAX_HOLDS = 5;

export function createPhotos({ db, config }) {
  const dir = path.join(config.dataDir, 'photos');
  const holdDir = path.join(dir, '_incoming');
  const nowIso = () => new Date().toISOString();
  const tok = () => crypto.randomBytes(12).toString('hex');

  function store(cleaningId, data, by) {
    const kind = sniff(data);
    if (!kind || !IMAGE.includes(kind[0]) || data.length > MAX_BYTES) return null;
    fs.mkdirSync(dir, { recursive: true });
    const file = `${cleaningId}-${tok()}.${kind[1]}`;
    fs.writeFileSync(path.join(dir, file), data);
    const r = db.prepare('INSERT INTO photos (cleaning_id, file, mime, bytes, added_by, created_at) VALUES (?,?,?,?,?,?)')
      .run(cleaningId, file, kind[0], data.length, by || null, nowIso());
    return Number(r.lastInsertRowid);
  }

  function add(cleaningId, files, by) {
    const ids = files.slice(0, MAX_FILES).map(f => store(cleaningId, f.data, by)).filter(Boolean);
    if (ids.length) db.prepare('INSERT INTO events (cleaning_id, stage, detail, at) VALUES (?,?,?,?)').run(cleaningId, 'Photos saved', `${ids.length} photo${ids.length === 1 ? '' : 's'}, added by ${by}`, nowIso());
    return ids;
  }

  const list = (cleaningId) => db.prepare('SELECT * FROM photos WHERE cleaning_id = ? ORDER BY id').all(cleaningId);
  const get = (id) => db.prepare('SELECT * FROM photos WHERE id = ?').get(id);
  const read = (p) => fs.readFileSync(path.join(dir, p.file));

  function remove(id) {
    const p = get(id);
    if (!p) return null;
    try { fs.unlinkSync(path.join(dir, p.file)); } catch {}
    db.prepare('DELETE FROM photos WHERE id = ?').run(id);
    return p;
  }

  // Secret link for the guest: /p/<token> shows this cleaning's photos, nothing else.
  function shareToken(cleaningId) {
    const c = db.prepare('SELECT photos_token FROM cleanings WHERE id = ?').get(cleaningId);
    if (!c) return null;
    if (c.photos_token) return c.photos_token;
    const t = tok();
    db.prepare('UPDATE cleanings SET photos_token = ? WHERE id = ?').run(t, cleaningId);
    return t;
  }
  const byToken = (t) => /^[a-f0-9]{24}$/.test(t || '') ? db.prepare('SELECT * FROM cleanings WHERE photos_token = ?').get(t) : null;

  // Best guess for photos shared just now: the latest cleaning on or before today.
  function likelyCleaning(now = new Date()) {
    return db.prepare("SELECT * FROM cleanings WHERE status IN ('approved','completed','paid') AND date <= ? ORDER BY date DESC, id DESC LIMIT 1")
      .get(todayIn(config.timezone, now));
  }
  const recentCleanings = (now = new Date()) => db.prepare("SELECT * FROM cleanings WHERE status IN ('approved','completed','paid') AND date <= ? ORDER BY date DESC LIMIT 8")
    .all(todayIn(config.timezone, now));

  // ---- Holding area for photos shared in from another app ----
  function cleanHolds() {
    if (!fs.existsSync(holdDir)) return;
    const holds = fs.readdirSync(holdDir).map(n => ({ n, t: fs.statSync(path.join(holdDir, n)).mtimeMs })).sort((a, b) => b.t - a.t);
    holds.forEach((h, i) => { if (i >= MAX_HOLDS || Date.now() - h.t > HOLD_MS) fs.rmSync(path.join(holdDir, h.n), { recursive: true, force: true }); });
  }
  function hold(files) {
    cleanHolds();
    const keep = files.filter(f => { const k = sniff(f.data); return k && IMAGE.includes(k[0]) && f.data.length <= MAX_BYTES; }).slice(0, MAX_FILES);
    if (!keep.length) return null;
    const t = tok();
    fs.mkdirSync(path.join(holdDir, t), { recursive: true });
    keep.forEach((f, i) => fs.writeFileSync(path.join(holdDir, t, String(i)), f.data));
    return t;
  }
  function held(t) {
    if (!/^[a-f0-9]{24}$/.test(t || '')) return null;
    const d = path.join(holdDir, t);
    if (!fs.existsSync(d)) return null;
    return fs.readdirSync(d).sort((a, b) => a - b).map(n => ({ n, data: fs.readFileSync(path.join(d, n)) }));
  }
  function claim(t, cleaningId, by) {
    const files = held(t);
    if (!files) return null;
    const ids = add(cleaningId, files, by);
    fs.rmSync(path.join(holdDir, t), { recursive: true, force: true });
    return ids;
  }
  function discard(t) { if (/^[a-f0-9]{24}$/.test(t || '')) fs.rmSync(path.join(holdDir, t), { recursive: true, force: true }); }

  const usage = () => db.prepare('SELECT COUNT(*) n, COALESCE(SUM(bytes),0) b FROM photos').get();

  return { add, list, get, read, remove, shareToken, byToken, likelyCleaning, recentCleanings, hold, held, claim, discard, usage };
}
