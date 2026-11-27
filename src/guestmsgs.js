import { prettyDate, prettyTime, todayIn, addDays } from './dates.js';
import { describeCode } from './weather.js';

// Check-in and check-out messages for guests, filled in for each stay, to copy into Airbnb.
// Templates and the house details (wifi, lockbox code) live in the database, not in the code,
// and are edited on the Guest messages tab.

const h = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const DEFAULT_CHECKIN = `Hey {guests}, welcome to you and your group! We're excited to host you in Tahoe{holiday}! I hope you have a great drive today. You can check in anytime after {checkin time} today, {checkin day}.

Address: {address}

Wifi: {wifi name} / Password: {wifi password}

The front door keys are in a lockbox on the left side of the door. The code is {lockbox code}. One key is for the knob and one is for the deadbolt. Please put them back in the lockbox when you leave.

{weather}

{snow}

You're welcome to use the garage for gear, plus the treadmill, Zwift bike and sauna. There isn't room to park a car in there.

We have a strict no-party policy, and quiet hours are 10 PM to 8 AM.

Below are photos from the professional cleaning this week so you know the home is ready for you!

Let me know if you have any questions. Enjoy your stay!

Mark and Danielle`;

export const DEFAULT_CHECKOUT = `We hope you've had a nice stay in Tahoe!

{checkout weather}

{turnover}

For checkout by {checkout time} on {checkout day},

Put all used bedding, towels, and dish towels in the hampers in the laundry room.

Clean up the kitchen and run the dishwasher. It's fine to leave the clean dishes inside.

Close and lock all windows and the sliding deck doors.

Turn the thermostat off and turn off the lights.

Sign out of any personal accounts on the TVs and the Apple TV.

Put any remaining trash, in tied bags, in the bear box and latch it.

Lock the front door on your way out. And please replace the keys to the front door in the lock box.

Thank you again!`;

export const DEFAULT_SNOW = `Snow: If more than 4 inches falls during your stay, our snow service will come once a day to clear the driveway and the walkway to the front door, as long as no cars are in the driveway. Otherwise there are shovels and a snow blower in the garage. If you use the electric snow blower, please charge the batteries afterward. Driveways and walkways can be slippery, so please be careful outside.`;

const DETAILS = [['address', 'Address', '2072 Slalom Court, South Lake Tahoe, CA 96150'], ['wifi name', 'Wifi name', ''], ['wifi password', 'Wifi password', ''], ['lockbox code', 'Lockbox code', '']];

function get(db, key, fallback) {
  const v = db.prepare('SELECT value FROM meta WHERE key = ?').get(key)?.value;
  return v == null ? fallback : v;
}
function put(db, key, value) {
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}

export function guestSettings(db) {
  return {
    checkin: get(db, 'guestmsg:checkin', DEFAULT_CHECKIN),
    checkout: get(db, 'guestmsg:checkout', DEFAULT_CHECKOUT),
    snow: get(db, 'guestmsg:snow', DEFAULT_SNOW),
    details: Object.fromEntries(DETAILS.map(([k, , d]) => [k, get(db, 'guestmsg:' + k, d)])),
  };
}

export function saveGuestSettings(db, form) {
  for (const k of ['checkin', 'checkout', 'snow']) if (form.has(k)) put(db, 'guestmsg:' + k, String(form.get(k)).replace(/\r\n/g, '\n').trim());
  for (const [k] of DETAILS) if (form.has(k)) put(db, 'guestmsg:' + k, String(form.get(k)).trim());
}

// "Tuesday November 24th"
function longDay(date) {
  const d = new Date(date + 'T12:00:00Z');
  const n = d.getUTCDate();
  const suf = n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] || 'th';
  return `${d.toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' })} ${d.toLocaleDateString('en-US', { month: 'long', timeZone: 'UTC' })} ${n}${suf}`;
}
const clock = (t) => prettyTime(t).replace(/^(\d+) (AM|PM)$/, '$1:00 $2');

// US holidays a stay might fall on (date strings for one year).
function holidays(y) {
  const nth = (m, wd, n) => { const d = new Date(Date.UTC(y, m, 1)); d.setUTCDate(1 + ((wd - d.getUTCDay() + 7) % 7) + 7 * (n - 1)); return d.toISOString().slice(0, 10); };
  const last = (m, wd) => { const d = new Date(Date.UTC(y, m + 1, 0)); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() - wd + 7) % 7)); return d.toISOString().slice(0, 10); };
  const p = (m, d) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  return [
    ['New Year', [p(1, 1), p(12, 31)]], ['Martin Luther King Jr. Day', [nth(0, 1, 3)]], ["Presidents' Day", [nth(1, 1, 3)]],
    ['Memorial Day', [last(4, 1)]], ['Fourth of July', [p(7, 4)]], ['Labor Day', [nth(8, 1, 1)]],
    ['Thanksgiving', [nth(10, 4, 4)]], ['Christmas', [p(12, 24), p(12, 25)]],
  ];
}
export function holidayFor(checkIn, checkOut) {
  for (const y of new Set([checkIn.slice(0, 4), checkOut.slice(0, 4)])) {
    for (const [name, days] of holidays(Number(y))) if (days.some(d => d >= checkIn && d <= checkOut)) return name;
  }
  return null;
}

const weekday = (d) => new Date(d + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' });
const inches = (n) => (n < 1 ? 'a dusting' : `about ${Math.round(n)} inch${Math.round(n) === 1 ? '' : 'es'}`);
const nightsOf = (b) => { const out = []; const d = new Date(b.check_in + 'T12:00:00Z'); while (d.toISOString().slice(0, 10) <= b.check_out) { out.push(d.toISOString().slice(0, 10)); d.setUTCDate(d.getUTCDate() + 1); } return out; };

// "Weather: Tuesday looks sunny, with highs around 45 and lows near 20. Snow is in the forecast
// Thursday (about 6 inches), so plan for chains or 4WD." Nothing when there's no forecast yet.
export function weatherLine(b, days) {
  if (!days) return '';
  const first = days[b.check_in];
  if (!first) return '';
  const snowy = nightsOf(b).filter(d => d !== b.check_out && days[d]?.snow >= 0.5);
  let line = `Weather: ${weekday(b.check_in)} looks ${describe(first.code)}, with a high around ${first.hi}°F and a low near ${first.lo}°F.`;
  if (snowy.length) line += ` Snow is in the forecast ${snowy.slice(0, 3).map(d => `${weekday(d)} (${inches(days[d].snow)})`).join(', ')}, so plan for chains or 4WD.`;
  return line;
}
export function checkoutWeatherLine(b, days) {
  const d = days?.[b.check_out];
  if (!d) return '';
  if (d.snow >= 0.5) return `Snow is forecast for ${weekday(b.check_out)} (${inches(d.snow)}), so please leave extra time for the drive home.`;
  if (describe(d.code) === 'stormy' || describe(d.code) === 'rainy') return `It looks ${describe(d.code)} on ${weekday(b.check_out)}, so leave a little extra time for the drive home.`;
  return '';
}
const describe = (c) => describeCode(c);

function snowSeason(b, days) {
  const m = Number(b.check_in.slice(5, 7)), m2 = Number(b.check_out.slice(5, 7));
  const winter = (x) => x >= 11 || x <= 4;
  return winter(m) || winter(m2) || nightsOf(b).some(d => days?.[d]?.snow >= 0.5);
}

export function fillMessage(template, { booking, config, details, db, days = null, snow = DEFAULT_SNOW }) {
  const holiday = holidayFor(booking.check_in, booking.check_out);
  const sameDay = db ? db.prepare("SELECT 1 FROM bookings WHERE status='active' AND uid != ? AND check_in = ?").get(booking.uid, booking.check_out) : null;
  const vals = {
    guests: booking.guest_name || 'there',
    'checkin day': longDay(booking.check_in), 'checkin time': clock(config.checkinTime),
    'checkout day': longDay(booking.check_out), 'checkout time': clock(config.checkoutTime),
    holiday: holiday ? ` over the ${holiday} holiday` : '',
    weather: weatherLine(booking, days),
    snow: snowSeason(booking, days) ? snow : '',
    turnover: sameDay ? `Our next guests arrive later that day, so we really appreciate you being out by ${clock(config.checkoutTime)}.` : '',
    'checkout weather': checkoutWeatherLine(booking, days),
  };
  const optional = new Set(['holiday', 'weather', 'snow', 'turnover', 'checkout weather']);
  return template.replace(/\{([a-z ]+)\}/gi, (m, k) => {
    const key = k.toLowerCase();
    if (vals[key] === undefined) return details?.[key] ? details[key] : m;
    return vals[key] !== '' || optional.has(key) ? vals[key] : m;
  }).replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

export function guestMessagesPage({ db, config, header, layout, flash = '', edit = false, days = null }) {
  const today = todayIn(config.timezone);
  const s = guestSettings(db);
  const stays = db.prepare("SELECT * FROM bookings WHERE status='active' AND source != 'personal' AND check_out >= ? AND check_in <= ? ORDER BY check_in").all(today, addDays(today, 90));
  const missing = DETAILS.filter(([k]) => !s.details[k]).map(([, label]) => label);
  const block = (id, title, text) => `<div class="gm"><div class="gm-head"><b>${h(title)}</b><button type="button" class="copy" data-for="${id}">Copy</button></div>
<textarea id="${id}" readonly rows="6">${h(text)}</textarea></div>`;
  const cards = stays.map(b => {
    const now = b.check_in <= today ? ' <span class="pill">Here now</span>' : '';
    return `<div class="card"><h2>${h(b.guest_name || 'Guest (no name yet)')}${now}</h2>
<p class="muted">${h(prettyDate(b.check_in))} to ${h(prettyDate(b.check_out))}${b.guest_name ? '' : ' · add their name on the Stays tab so the message greets them'}</p>
${block(`in-${h(b.uid)}`, 'Check-in message', fillMessage(s.checkin, { booking: b, config, details: s.details, db, days, snow: s.snow }))}
${block(`out-${h(b.uid)}`, 'Check-out message', fillMessage(s.checkout, { booking: b, config, details: s.details, db, days, snow: s.snow }))}</div>`;
  }).join('');
  return layout('Guest messages', `${header}
${flash ? `<div class="card"><p class="flash">${h(flash)}</p></div>` : ''}
${missing.length ? `<div class="card"><p class="flash">Fill in ${h(missing.join(', '))} under Edit messages below, so they're filled in for you.</p></div>` : ''}
${cards || '<div class="card"><p class="muted">No guests in the next 90 days.</p></div>'}
<div class="card" id="edit"><details ${edit || missing.length ? 'open' : ''}><summary><b>Edit messages</b></summary>
<form method="post" action="/guest-messages">
<p class="muted">Words in braces are filled in for each stay: {guests}, {checkin day}, {checkin time}, {checkout day}, {checkout time}, {address}, {wifi name}, {wifi password}, {lockbox code}. These are added only when they apply: {holiday} (" over the Thanksgiving holiday"), {weather} (the forecast for arrival, plus any snow days), {snow}, {checkout weather} (snow or rain on the way home) and {turnover} (next guests arrive the same day). The guest's name comes from the Stays tab.</p>
${DETAILS.map(([k, label]) => `<label>${h(label)}<input name="${h(k)}" value="${h(s.details[k])}" autocomplete="off"></label>`).join('')}
<label>Check-in message<textarea name="checkin" rows="12">${h(s.checkin)}</textarea></label>
<label>Check-out message<textarea name="checkout" rows="10">${h(s.checkout)}</textarea></label>
<label>Snow paragraph ({snow}: used November to April, or any time snow is forecast during the stay)<textarea name="snow" rows="5">${h(s.snow)}</textarea></label>
<div class="dialog-actions"><button>Save</button></div></form></details></div>
<style>.gm{margin-top:10px}.gm-head{display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:4px}.gm textarea{width:100%;font:inherit;font-size:14px}label{display:block;margin:8px 0}label input,label textarea{display:block;width:100%;margin-top:4px;font:inherit}</style>
<script>document.querySelectorAll('button.copy').forEach(b=>b.addEventListener('click',async()=>{const t=document.getElementById(b.dataset.for);try{await navigator.clipboard.writeText(t.value)}catch{t.select();document.execCommand('copy')}const o=b.textContent;b.textContent='Copied!';setTimeout(()=>b.textContent=o,2000);}));</script>`);
}

// One message, ready to paste: what the 9 AM / 6 PM alert opens.
export function guestMessagePage({ db, config, layout, header, booking, which, days }) {
  const s = guestSettings(db);
  const text = fillMessage(which === 'in' ? s.checkin : s.checkout, { booking, config, details: s.details, db, days, snow: s.snow });
  const res = (booking.description || '').match(/https:\/\/www\.airbnb\.com\/hosting\/reservations\/details\/[A-Z0-9]+/i)?.[0];
  const airbnb = res || 'https://www.airbnb.com/hosting/messages';
  return layout(`${which === 'in' ? 'Check-in' : 'Check-out'} message`, `${header}
<div class="card"><h2>${which === 'in' ? 'Check-in' : 'Check-out'} message for ${h(booking.guest_name || 'your guests')}</h2>
<p class="muted">${h(prettyDate(booking.check_in))} to ${h(prettyDate(booking.check_out))}. Copy it, then open Airbnb and paste it into your chat with them.</p>
<p><button type="button" id="copy" style="width:100%;padding:14px;font-size:17px">Copy message</button></p>
<p><a class="btn ghost" style="display:block;text-align:center" href="${h(airbnb)}">Open ${res ? 'this reservation' : 'messages'} in Airbnb</a></p>
<textarea id="msg" rows="18" style="width:100%;font:inherit;font-size:14px">${h(text)}</textarea>
<p class="muted">You can tweak the words above before copying. To change the message for every stay, use Edit messages on the <a href="/guest-messages#edit">Guest messages</a> tab.</p></div>
<script>document.getElementById('copy').addEventListener('click',async e=>{const t=document.getElementById('msg');try{await navigator.clipboard.writeText(t.value)}catch{t.select();document.execCommand('copy')}e.target.textContent='Copied! Now paste it in Airbnb';setTimeout(()=>e.target.textContent='Copy message',3000);});</script>`);
}

// When each alert is due: check-in at 9 AM on arrival day, check-out at 6 PM the evening
// before (only until checkout time). Returns the alerts due now that haven't been sent.
export function dueGuestAlerts(db, config, now = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: config.timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now).map(p => [p.type, p.value]));
  const today = `${parts.year}-${parts.month}-${parts.day}`, hm = `${parts.hour}:${parts.minute}`;
  const tomorrow = addDays(today, 1);
  const out = [];
  const stays = db.prepare("SELECT * FROM bookings WHERE status='active' AND source != 'personal' AND check_out >= ? AND check_in <= ?").all(today, tomorrow);
  for (const b of stays) {
    if (b.check_in === today && hm >= '09:00' && hm < config.checkinTime) out.push({ booking: b, which: 'in' });
    if ((b.check_out === tomorrow && hm >= '18:00') || (b.check_out === today && hm < config.checkoutTime)) out.push({ booking: b, which: 'out' });
  }
  return out.filter(a => !db.prepare('SELECT 1 FROM meta WHERE key = ?').get(`alert:guestmsg:${a.which}:${a.booking.uid}:${a.which === 'in' ? a.booking.check_in : a.booking.check_out}`));
}
export function markGuestAlert(db, a, now = new Date()) {
  db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(`alert:guestmsg:${a.which}:${a.booking.uid}:${a.which === 'in' ? a.booking.check_in : a.booking.check_out}`, now.toISOString());
}
