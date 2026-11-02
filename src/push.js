import crypto from 'node:crypto';
import { todayIn, addDays, prettyDate } from './dates.js';
import { cleaningState, stayReadiness, guestLabel } from './views.js';

// Web Push (the notifications an installed home-screen app gets), with no libraries:
// VAPID signing (RFC 8292) and aes128gcm payload encryption (RFC 8291) using node:crypto.

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const unb64u = (s) => Buffer.from(String(s), 'base64url');
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();

export function createPush({ db, config, fetchImpl = globalThis.fetch }) {
  // VAPID keys are made once and kept in the database, so there is nothing to set in Render.
  function vapid() {
    const row = db.prepare("SELECT value FROM meta WHERE key='vapid'").get();
    if (row) return JSON.parse(row.value);
    const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const jwk = privateKey.export({ format: 'jwk' });
    const keys = { jwk, publicKey: b64u(Buffer.concat([Buffer.from([4]), unb64u(jwk.x), unb64u(jwk.y)])) };
    db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('vapid', ?)").run(JSON.stringify(keys));
    return keys;
  }

  function jwt(audience) {
    const { jwk } = vapid();
    const head = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
    const body = b64u(JSON.stringify({ aud: audience, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: config.baseUrl?.startsWith('https:') ? config.baseUrl : 'mailto:noreply@example.com' }));
    const sig = crypto.sign('sha256', Buffer.from(`${head}.${body}`), { key: crypto.createPrivateKey({ key: jwk, format: 'jwk' }), dsaEncoding: 'ieee-p1363' });
    return `${head}.${body}.${b64u(sig)}`;
  }

  // RFC 8291: encrypt one record for the browser's p256dh key and auth secret.
  function encrypt(sub, payload) {
    const uaPublic = unb64u(sub.keys.p256dh), authSecret = unb64u(sub.keys.auth);
    const ecdh = crypto.createECDH('prime256v1');
    const asPublic = ecdh.generateKeys();
    const shared = ecdh.computeSecret(uaPublic);
    const ikm = hmac(hmac(authSecret, shared), Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic, Buffer.from([1])]));
    const salt = crypto.randomBytes(16);
    const prk = hmac(salt, ikm);
    const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01')).subarray(0, 16);
    const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01')).subarray(0, 12);
    const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
    const body = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(payload), Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
    const rs = Buffer.alloc(4); rs.writeUInt32BE(4096);
    return Buffer.concat([salt, rs, Buffer.from([asPublic.length]), asPublic, body]);
  }

  const subscriptions = () => db.prepare("SELECT key, value FROM meta WHERE key LIKE 'push:sub:%'").all().map(r => ({ key: r.key, ...JSON.parse(r.value) }));

  function subscribe(sub, who) {
    if (!sub?.endpoint?.startsWith('https://') || !sub.keys?.p256dh || !sub.keys?.auth) return false;
    const id = crypto.createHash('sha256').update(sub.endpoint).digest('hex').slice(0, 24);
    db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(`push:sub:${id}`,
      JSON.stringify({ endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth }, who, at: new Date().toISOString() }));
    return true;
  }
  function unsubscribe(endpoint) {
    for (const s of subscriptions()) if (s.endpoint === endpoint) db.prepare('DELETE FROM meta WHERE key = ?').run(s.key);
  }

  // Sends to every phone that turned notifications on. Gone subscriptions are cleaned up.
  async function send({ title, body, url = '/' }) {
    const results = [];
    for (const s of subscriptions()) {
      try {
        const r = await fetchImpl(s.endpoint, {
          method: 'POST',
          headers: { 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', TTL: '86400', Urgency: 'high',
            Authorization: `vapid t=${jwt(new URL(s.endpoint).origin)}, k=${vapid().publicKey}` },
          body: encrypt(s, JSON.stringify({ title, body, url })),
        });
        if (r.status === 404 || r.status === 410) db.prepare('DELETE FROM meta WHERE key = ?').run(s.key);
        results.push({ who: s.who, ok: r.ok, status: r.status });
      } catch (e) { results.push({ who: s.who, ok: false, error: e.message }); }
    }
    return results;
  }

  // Turnovers in the next 7 days that aren't settled: a cleaning not yet confirmed with the
  // cleaner, or a stay arriving with no cleaning before it.
  function unsettled(today = todayIn(config.timezone)) {
    const horizon = addDays(today, 7);
    const cleaner = config.cleaner?.name || 'the cleaner';
    const items = [];
    const cleanings = db.prepare("SELECT * FROM cleanings WHERE status NOT IN ('cancelled','declined') ORDER BY date").all();
    for (const c of cleanings) {
      if (c.date < today || c.date > horizon) continue;
      const st = cleaningState(c, today);
      if (st === 'confirmed' || st === 'past') continue;
      const what = st === 'asked' ? `waiting on ${cleaner}` : c.status === 'awaiting_approval' ? 'needs your OK' : `not sent to ${cleaner}`;
      items.push({ date: c.date, text: `${prettyDate(c.date)} cleaning ${what}` });
    }
    const bookings = db.prepare("SELECT * FROM bookings WHERE status='active' ORDER BY check_in").all();
    const ready = stayReadiness(bookings, cleanings, today);
    for (const b of bookings) {
      if (ready[b.uid] === 'missing' && b.check_in >= today && b.check_in <= horizon) items.push({ date: b.check_in, text: `${guestLabel(b)} arrives ${prettyDate(b.check_in)} with no cleaning set` });
    }
    return items.sort((a, b) => a.date.localeCompare(b.date));
  }

  // Once a day, from 9 AM local, while something in the next week is unsettled.
  async function dailyReminder(now = new Date()) {
    const today = todayIn(config.timezone, now);
    const hour = Number(new Intl.DateTimeFormat('en-US', { timeZone: config.timezone, hour: 'numeric', hourCycle: 'h23' }).format(now));
    if (hour < 9) return { skipped: 'before 9 AM' };
    if (db.prepare("SELECT value FROM meta WHERE key='push:last_reminder'").get()?.value === today) return { skipped: 'already sent today' };
    if (!subscriptions().length) return { skipped: 'no phones signed up' };
    db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('push:last_reminder', ?)").run(today);
    const items = unsettled(today);
    if (!items.length) return { skipped: 'nothing unsettled' };
    const title = items.length === 1 ? 'Cleaning not set yet' : `${items.length} cleanings not set yet`;
    return { sent: await send({ title, body: items.slice(0, 4).map(i => i.text).join('\n') + (items.length > 4 ? `\n+${items.length - 4} more` : ''), url: '/inbox' }), items };
  }

  // A new Airbnb booking (or changed dates) needs Mark or Danielle to OK the cleaning and
  // text the cleaner. Tapping opens the calendar with that cleaning's review dialog.
  async function bookingNews({ newBookings = [], changed = [] } = {}) {
    const cleaner = config.cleaner?.name || 'the cleaner';
    const out = [];
    for (const [kind, list] of [['new', newBookings], ['changed', changed]]) {
      for (const { uid, cleaning: c, covered } of list) {
        const b = db.prepare('SELECT * FROM bookings WHERE uid = ?').get(uid);
        if (!b || !c) continue;
        const stay = `${guestLabel(b)}, ${prettyDate(b.check_in)} to ${prettyDate(b.check_out)}`;
        const body = covered ? `${stay}. Already covered by the ${prettyDate(c.date)} cleaning.`
          : `${stay}. Cleaning proposed for ${prettyDate(c.date)}. Tap to approve and text ${cleaner}.`;
        const msg = { title: kind === 'new' ? 'New Airbnb booking' : 'Airbnb booking dates changed', body,
          url: covered ? `/?month=${b.check_in.slice(0, 7)}` : `/?month=${c.date.slice(0, 7)}&review=${c.id}` };
        out.push({ ...msg, results: await send(msg) });
      }
    }
    return out;
  }

  return { bookingNews, publicKey: () => vapid().publicKey, subscribe, unsubscribe, subscriptions, send, unsettled, dailyReminder, encrypt };
}

// The service worker that shows the notification and opens the app when it's tapped.
export const SERVICE_WORKER = `self.addEventListener('push', e => {
  let d = {}; try { d = e.data.json(); } catch { d = { title: 'Cleaning Link', body: e.data ? e.data.text() : '' }; }
  e.waitUntil(self.registration.showNotification(d.title || 'Cleaning Link', { body: d.body || '', icon: '/icon-192.png', badge: '/icon-192.png', data: { url: d.url || '/' } }));
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || '/';
  e.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    for (const c of list) { if ('focus' in c) { c.navigate(url); return c.focus(); } }
    return clients.openWindow(url);
  }));
});
`;
