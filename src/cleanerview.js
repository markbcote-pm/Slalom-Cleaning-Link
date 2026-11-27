import crypto from 'node:crypto';
import { buildIcal } from './ical.js';
import { localToUtc, prettyTime, prettyDate, todayIn, addDays } from './dates.js';

// The cleaner's own page: a private link with no password, showing only the cleanings she
// has been texted about. No prices, notes from the thread, guest names or unsent proposals.
// The link lives in meta and can be reset from More (the old one stops working).

const h = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function cleanerKey(db) {
  const row = db.prepare("SELECT value FROM meta WHERE key = 'cleaner_link'").get();
  if (row?.value) return row.value;
  return resetCleanerKey(db);
}

export function resetCleanerKey(db) {
  const key = crypto.randomBytes(18).toString('base64url');
  db.prepare("INSERT INTO meta (key, value) VALUES ('cleaner_link', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key);
  return key;
}

export function checkCleanerKey(db, given) {
  const key = Buffer.from(cleanerKey(db)), g = Buffer.from(String(given || ''));
  return key.length === g.length && crypto.timingSafeEqual(key, g);
}

// Cleanings the group text has been told about, from two months back on.
function texted(db, config) {
  const from = addDays(todayIn(config.timezone), -60);
  return db.prepare(`SELECT * FROM cleanings WHERE status IN ('approved','completed','paid') AND group_known_date IS NOT NULL
    AND date >= ? ORDER BY date`).all(from);
}

function nextArrival(db, date) {
  return db.prepare("SELECT check_in FROM bookings WHERE status='active' AND check_in >= ? ORDER BY check_in LIMIT 1").get(date)?.check_in || null;
}

function window(db, config, c) {
  const checkout = db.prepare("SELECT 1 FROM bookings WHERE status='active' AND check_out = ?").get(c.date);
  const next = nextArrival(db, c.date);
  const out = checkout ? `Guest checks out ${prettyTime(config.checkoutTime)}.` : '';
  const arr = !next ? 'No guests booked right after.'
    : next === c.date ? `Next guests arrive ${prettyTime(config.checkinTime)} the same day, so please be done by then.`
      : `Next guests arrive ${prettyDate(next)}.`;
  return [out, arr].filter(Boolean).join(' ');
}

export function cleanerPage({ db, config, base = '' }) {
  const today = todayIn(config.timezone);
  const name = config.cleaner?.name || 'Cleaner';
  const list = texted(db, config);
  const upcoming = list.filter(c => c.date >= today);
  const past = list.filter(c => c.date < today).reverse();
  const key = cleanerKey(db);
  const feed = `${base}/c/${key}.ics`;
  const row = (c) => {
    const ok = !!c.cleaner_confirmed_at || c.date < today;
    const tag = c.date < today ? '<span class="tag done">Done</span>'
      : ok ? '<span class="tag ok">Confirmed</span>' : '<span class="tag ask">Waiting for your reply</span>';
    return `<li><div class="d">${h(prettyDate(c.date))} ${tag}</div><div class="m">${h(window(db, config, c))}${c.note ? ` Note: ${h(c.note)}` : ''}</div></li>`;
  };
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><meta name="referrer" content="no-referrer"><title>Cleanings at ${h(config.propertyName)}</title>
<link rel="icon" href="/icon.svg" type="image/svg+xml"><style>
:root{--bg:#f6f7f5;--card:#fff;--ink:#1d2421;--mute:#5d6863;--line:#e2e6e3;--ok:#2f7a4f;--okbg:#e3f3e8;--ask:#6b4bb3;--askbg:#eee8fa;--acc:#2f6f5e}
@media (prefers-color-scheme:dark){:root{--bg:#141816;--card:#1d2321;--ink:#e8ece9;--mute:#9aa6a0;--line:#2c3431;--ok:#7fd3a0;--okbg:#1f3a2a;--ask:#c3b0f0;--askbg:#2e2645;--acc:#7fc4ae}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
main{max-width:560px;margin:0 auto;padding:20px 16px 40px}h1{font-size:22px;margin:0 0 4px}h2{font-size:15px;text-transform:uppercase;letter-spacing:.04em;color:var(--mute);margin:24px 0 8px}
p{margin:0 0 8px}.muted{color:var(--mute);font-size:14px}ul{list-style:none;margin:0;padding:0}
li{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px 14px;margin-bottom:8px}.d{font-weight:600;display:flex;gap:8px;align-items:center;flex-wrap:wrap}.m{color:var(--mute);font-size:14px;margin-top:2px}
.tag{font-size:12px;font-weight:600;border-radius:99px;padding:2px 8px}.ok{background:var(--okbg);color:var(--ok)}.ask{background:var(--askbg);color:var(--ask)}.done{background:var(--line);color:var(--mute)}
a.btn{display:inline-block;background:var(--acc);color:#fff;text-decoration:none;border-radius:10px;padding:10px 14px;font-weight:600;margin:4px 6px 4px 0}
@media (prefers-color-scheme:dark){a.btn{color:#10201a}}details summary{cursor:pointer;color:var(--mute);margin:16px 0 8px}
</style></head><body><main>
<h1>Cleanings at ${h(config.propertyName)}</h1>
<p class="muted">Hi ${h(name)}! These are the cleanings from the group text. Each one is ${h(prettyTime(config.checkoutTime))} to ${h(prettyTime(config.checkinTime))} unless the note says otherwise. Reply in the group text to confirm or change a date.</p>
<h2>Coming up</h2>
${upcoming.length ? `<ul>${upcoming.map(row).join('')}</ul>` : '<p class="muted">Nothing scheduled yet.</p>'}
${past.length ? `<details><summary>Recent cleanings (${past.length})</summary><ul>${past.map(row).join('')}</ul></details>` : ''}
<h2>Put these on your phone's calendar</h2>
<p><a class="btn" href="${h(feed.replace(/^https?:/, 'webcal:'))}">Add to my calendar</a></p>
<p class="muted">Works on iPhone and most Android calendars. For Google Calendar, add this address under Other calendars, From URL:<br><code style="word-break:break-all">${h(feed)}</code></p>
<p class="muted">The calendar updates on its own when a cleaning is added or moved.</p>
</main></body></html>`;
}

export function cleanerFeed({ db, config, service }) {
  const today = todayIn(config.timezone);
  const events = texted(db, config).map(c => {
    const ok = !!c.cleaner_confirmed_at || c.date < today;
    return {
      uid: `cleaner-${c.id}@slalom-cleaning-link`,
      sequence: c.sequence,
      start: localToUtc(c.date, config.checkoutTime, config.timezone),
      end: localToUtc(c.date, config.checkinTime, config.timezone),
      summary: `Cleaning · ${config.propertyName}${ok ? '' : ' (not confirmed yet)'}`,
      description: `${window(db, config, c)}${c.note ? `\nNote: ${c.note}` : ''}`,
      categories: 'Cleaning',
    };
  });
  return buildIcal({ name: `Cleanings: ${config.propertyName}`, events });
}
