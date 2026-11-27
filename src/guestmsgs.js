import { prettyDate, prettyTime, todayIn, addDays } from './dates.js';

// Check-in and check-out messages for guests, filled in for each stay, to copy into Airbnb.
// Templates and the house details (wifi, lockbox code) live in the database, not in the code,
// and are edited on the Guest messages tab.

const h = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const DEFAULT_CHECKIN = `Hey {guests}, welcome to you and your group! We're excited to host you in Tahoe! I hope you have a great drive today. You can check in anytime after {checkin time} today, {checkin day}.

Address: {address}

Wifi: {wifi name} / Password: {wifi password}

The front door keys are in a lockbox on the left side of the door. The code is {lockbox code}. One key is for the knob and one is for the deadbolt. Please put them back in the lockbox when you leave.

Snow: It snowed recently and we've cleared the driveway and walkway, but it may still be slippery, so please be careful outside. If more than 4 inches falls during your stay, our snow service will come once a day to clear the driveway and the walkway to the front door, as long as no cars are in the driveway. Otherwise there are shovels and a snow blower in the garage. If you use the electric snow blower, please charge the batteries afterward.

You're welcome to use the garage for gear, plus the treadmill, Zwift bike and sauna. There isn't room to park a car in there.

We have a strict no-party policy, and quiet hours are 10 PM to 8 AM.

Below are photos from the professional cleaning this week so you know the home is ready for you!

Let me know if you have any questions. Enjoy your stay!

Mark and Danielle`;

export const DEFAULT_CHECKOUT = `We hope you've had a nice stay in Tahoe!

For checkout by {checkout time} on {checkout day},

Put all used bedding, towels, and dish towels in the hampers in the laundry room.

Clean up the kitchen and run the dishwasher. It's fine to leave the clean dishes inside.

Close and lock all windows and the sliding deck doors.

Turn the thermostat off and turn off the lights.

Sign out of any personal accounts on the TVs and the Apple TV.

Put any remaining trash, in tied bags, in the bear box and latch it.

Lock the front door on your way out. And please replace the keys to the front door in the lock box.

Thank you again!`;

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
    details: Object.fromEntries(DETAILS.map(([k, , d]) => [k, get(db, 'guestmsg:' + k, d)])),
  };
}

export function saveGuestSettings(db, form) {
  for (const k of ['checkin', 'checkout']) if (form.has(k)) put(db, 'guestmsg:' + k, String(form.get(k)).replace(/\r\n/g, '\n').trim());
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

export function fillMessage(template, { booking, config, details }) {
  const vals = {
    guests: booking.guest_name || 'there',
    'checkin day': longDay(booking.check_in), 'checkin time': clock(config.checkinTime),
    'checkout day': longDay(booking.check_out), 'checkout time': clock(config.checkoutTime),
    ...details,
  };
  return template.replace(/\{([a-z ]+)\}/gi, (m, k) => (vals[k.toLowerCase()] !== undefined && vals[k.toLowerCase()] !== '' ? vals[k.toLowerCase()] : m));
}

export function guestMessagesPage({ db, config, header, layout, flash = '', edit = false }) {
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
${block(`in-${h(b.uid)}`, 'Check-in message', fillMessage(s.checkin, { booking: b, config, details: s.details }))}
${block(`out-${h(b.uid)}`, 'Check-out message', fillMessage(s.checkout, { booking: b, config, details: s.details }))}</div>`;
  }).join('');
  return layout('Guest messages', `${header}
${flash ? `<div class="card"><p class="flash">${h(flash)}</p></div>` : ''}
${missing.length ? `<div class="card"><p class="flash">Fill in ${h(missing.join(', '))} under Edit messages below, so they're filled in for you.</p></div>` : ''}
${cards || '<div class="card"><p class="muted">No guests in the next 90 days.</p></div>'}
<div class="card" id="edit"><details ${edit || missing.length ? 'open' : ''}><summary><b>Edit messages</b></summary>
<form method="post" action="/guest-messages">
<p class="muted">Words in braces are filled in for each stay: {guests}, {checkin day}, {checkin time}, {checkout day}, {checkout time}, {address}, {wifi name}, {wifi password}, {lockbox code}. The guest's name comes from the Stays tab.</p>
${DETAILS.map(([k, label]) => `<label>${h(label)}<input name="${h(k)}" value="${h(s.details[k])}" autocomplete="off"></label>`).join('')}
<label>Check-in message<textarea name="checkin" rows="12">${h(s.checkin)}</textarea></label>
<label>Check-out message<textarea name="checkout" rows="10">${h(s.checkout)}</textarea></label>
<div class="dialog-actions"><button>Save</button></div></form></details></div>
<style>.gm{margin-top:10px}.gm-head{display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:4px}.gm textarea{width:100%;font:inherit;font-size:14px}label{display:block;margin:8px 0}label input,label textarea{display:block;width:100%;margin-top:4px;font:inherit}</style>
<script>document.querySelectorAll('button.copy').forEach(b=>b.addEventListener('click',async()=>{const t=document.getElementById(b.dataset.for);try{await navigator.clipboard.writeText(t.value)}catch{t.select();document.execCommand('copy')}const o=b.textContent;b.textContent='Copied!';setTimeout(()=>b.textContent=o,2000);}));</script>`);
}
