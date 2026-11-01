import { prettyDate, prettyTime, addDays, todayIn } from './dates.js';

export const h = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (cents) => `$${((cents || 0) / 100).toFixed(2)}`;

const CSS = `
:root{--bg:#f7f6f3;--card:#fff;--ink:#1d1d1b;--muted:#6b6a66;--line:#e4e2dc;--accent:#2f6f5e;--accent-ink:#fff;--warn:#a5551b;--chip:#e3f0ec;--chip-ink:#1f4f42;--pending:#fbefd9;--pending-ink:#7a4a10;--stay:#3d5a80;--stay-ink:#fff;--win:#eef6f2;--win-ink:#2f6f5e;--win-line:#8fbfae;--tight:#b3412e}
@media (prefers-color-scheme:dark){:root{--bg:#141413;--card:#1e1e1c;--ink:#ecebe6;--muted:#a3a19a;--line:#33322f;--accent:#5fb39a;--accent-ink:#0f1f1a;--warn:#e19a62;--chip:#1f3a32;--chip-ink:#bfe6d9;--pending:#3a2c16;--pending-ink:#f2cf96;--stay:#5b7db0;--stay-ink:#fff;--win:#17302a;--win-ink:#9fd6c3;--win-line:#3f7a69;--tight:#d0604b}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.45 system-ui,-apple-system,Segoe UI,sans-serif}
main{max-width:980px;margin:0 auto;padding:16px}h1{font-size:22px;margin:8px 0 4px}h2{font-size:17px;margin:0 0 10px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px;margin:14px 0}
.muted{color:var(--muted)}.warn{color:var(--tight)}.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
button,.btn{background:var(--accent);color:var(--accent-ink);border:0;border-radius:8px;padding:8px 12px;font:inherit;cursor:pointer;text-decoration:none;display:inline-block}
button.ghost{background:transparent;color:var(--ink);border:1px solid var(--line)}button.danger{background:transparent;color:var(--warn);border:1px solid var(--line)}
input,textarea,select{font:inherit;padding:7px 9px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--ink)}textarea{width:100%;min-height:130px}
table{width:100%;border-collapse:collapse}td,th{padding:8px 6px;border-top:1px solid var(--line);text-align:left;vertical-align:top}th{font-weight:600;color:var(--muted);font-size:13px}
.stages{display:flex;gap:4px;flex-wrap:wrap}.stage{font-size:12px;padding:2px 7px;border-radius:99px;border:1px solid var(--line);color:var(--muted)}.stage.done{background:var(--chip);color:var(--chip-ink);border-color:transparent}
.pill{font-size:12px;padding:2px 8px;border-radius:99px;background:var(--pending);color:var(--pending-ink)}
.dows{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));font-size:12px;color:var(--muted);text-align:center;margin-bottom:4px}
.cal{display:flex;flex-direction:column;gap:4px}
.week{display:grid;grid-template-columns:repeat(14,minmax(0,1fr));grid-template-rows:22px 24px 24px 26px;column-gap:0;row-gap:3px;position:relative}
.day{grid-row:1/-1;min-width:0;border:1px solid var(--line);border-radius:8px;padding:2px 5px;font-size:12px;margin:0 2px}.day.out{opacity:.45}.day.today{border-color:var(--accent);border-width:2px}.day.over{outline:2px dashed var(--accent)}
.bar{min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;font-size:12px;line-height:22px;padding:0 6px;border-radius:11px;z-index:1}
.stay-bar{grid-row:2;background:var(--stay);color:var(--stay-ink);font-weight:600}.stay-bar.cont-l{border-top-left-radius:0;border-bottom-left-radius:0}.stay-bar.cont-r{border-top-right-radius:0;border-bottom-right-radius:0}
.win-bar{grid-row:3;background:var(--win);color:var(--win-ink);border:1px dashed var(--win-line);line-height:20px;font-size:11px}
.win-bar.short{background:var(--pending);color:var(--pending-ink);border-color:var(--pending-ink)}.win-bar.tight{background:var(--tight);color:#fff;border:0;margin:0 4px;text-align:center;font-weight:600}
.chip{grid-row:4;z-index:2;margin:0 4px;padding:2px 5px;border-radius:6px;background:var(--chip);color:var(--chip-ink);cursor:grab;font-size:12px;font-weight:600;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;border:1px solid var(--accent)}
.chip.awaiting_approval{background:var(--pending);color:var(--pending-ink);border-color:var(--pending-ink)}
body.dragging .bar,body.dragging .chip{pointer-events:none}
.legend{display:flex;flex-wrap:wrap;gap:6px 14px;font-size:12px;color:var(--muted);margin:0 0 10px}.legend span{display:flex;align-items:center;gap:6px}.legend i{display:inline-block;width:22px;height:12px;padding:0;margin:0;line-height:0}
@media (max-width:640px){.bar{font-size:10px;padding:0 3px}.chip{font-size:10px;margin:0 1px;padding:2px 2px}.day{margin:0 1px;padding:1px 3px}.hide-sm{display:none}}
.scroll{overflow-x:auto}code{word-break:break-all}
`;

export function layout(title, body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${h(title)}</title><style>${CSS}</style></head><body><main>${body}</main></body></html>`;
}

export function messagePage(title, text, extra = '') {
  return layout(title, `<div class="card"><h1>${h(title)}</h1><p>${h(text)}</p>${extra}</div>`);
}

export function approvalPage(c, describe, token, by, approvers) {
  if (c.status !== 'awaiting_approval') {
    return messagePage('Already handled', `This cleaning is ${c.status.replace('_', ' ')}${c.approved_by ? ` (by ${c.approved_by})` : ''}.`);
  }
  const who = approvers.map(a => `<option ${a.name === by ? 'selected' : ''}>${h(a.name)}</option>`).join('');
  return layout('Approve cleaning', `<div class="card"><h1>Approve this cleaning?</h1><p>${h(describe(c))}</p>
<p class="muted">Approving texts the group thread with the cleaner right away.</p>
<form method="post" class="row"><select name="by">${who}</select>
<button name="action" value="approve">Approve and text the group</button><button class="danger" name="action" value="decline">Decline</button></form></div>`);
}

export function groupDecisionPage(m, c, by, approvers, guestsStaying = false) {
  if (m.status !== 'pending') {
    return messagePage('Already decided', m.status === 'sent' ? `This was sent to the group${m.decided_by ? ` by ${m.decided_by}` : ''}.` : `This was ${m.status}.`, '<p><a class="btn" href="/">Back to dashboard</a></p>');
  }
  const who = approvers.map(a => `<option ${a.name === by ? 'selected' : ''}>${h(a.name)}</option>`).join('');
  return layout('Text the group?', `<div class="card"><h1>Text the group about this change?</h1>
<p class="muted">Cleaning on ${h(prettyDate(c.date))} is now <b>${h(c.status.replace('_', ' '))}</b>. Your cleaner treats the group text as the source of truth, so nothing goes out unless you say so.</p>
${guestsStaying ? `<p class="pill" style="display:inline-block">Heads up: guests are staying at the house on ${h(prettyDate(c.date))}.</p>` : ''}
<form method="post"><textarea name="body">${h(m.body)}</textarea>
<div class="row" style="margin-top:10px"><select name="by">${who}</select>
<button name="send" value="1">Send to group</button><button class="ghost" name="send" value="0">Don't send</button></div></form></div>`);
}

// Airbnb's export has no guest names, only the last 4 digits of the guest's phone.
// Mark or Danielle can type a name on the dashboard; until then we show the digits.
export function guestLabel(b) {
  if (b.guest_name) return b.guest_name;
  const last4 = (b.description || '').match(/Last 4 Digits\)?:\s*(\d{4})/i);
  return last4 ? `Guest ···${last4[1]}` : 'Guest';
}

const daysBetween = (a, b) => Math.round((new Date(b + 'T12:00:00Z') - new Date(a + 'T12:00:00Z')) / 864e5);

// Open windows for cleaning: from one checkout (11 AM) to the next check-in (1 PM).
export function cleaningWindows(bookings) {
  const sorted = [...bookings].sort((a, b) => a.check_in.localeCompare(b.check_in));
  return sorted.map((b, i) => {
    const next = sorted.slice(i + 1).find(n => n.check_in >= b.check_out) || null;
    return { from: b.check_out, to: next ? next.check_in : null, days: next ? daysBetween(b.check_out, next.check_in) + 1 : null };
  });
}

function calendar(month, cleanings, bookings, tz, config) {
  const [y, m] = month.split('-').map(Number);
  const first = `${month}-01`;
  const gridStart = addDays(first, -new Date(first + 'T12:00:00Z').getUTCDay());
  const today = todayIn(tz);
  const prev = new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 7);
  const next = new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 7);
  const label = new Date(first + 'T12:00:00Z').toLocaleDateString('en-US', { timeZone: 'UTC', month: 'long', year: 'numeric' });
  const windows = cleaningWindows(bookings);
  const live = cleanings.filter(c => !['cancelled', 'declined'].includes(c.status));
  const weeks = [];

  // Each week is a 14-column grid (two half-days per day), so a stay can start at the
  // check-in afternoon and end at the checkout morning, and the open window sits between.
  for (let w = 0; w < 6; w++) {
    const ws = addDays(gridStart, w * 7);
    const we = addDays(ws, 6);
    if (w === 5 && ws.slice(0, 7) !== month) break;
    const idx = (d) => daysBetween(ws, d);
    // half-column grid line for the middle of day d (clipped to this week)
    const mid = (d, edge) => { const i = idx(d); return i < 0 ? 1 : i > 6 ? 15 : 2 * i + 2 + (edge || 0); };
    let html = '';
    for (let i = 0; i < 7; i++) {
      const d = addDays(ws, i);
      html += `<div class="day ${d.slice(0, 7) !== month ? 'out' : ''} ${d === today ? 'today' : ''}" data-date="${d}" style="grid-column:${2 * i + 1}/span 2"><b>${Number(d.slice(8))}</b></div>`;
    }
    for (const b of bookings) {
      if (b.check_out < ws || b.check_in > we) continue;
      const s = mid(b.check_in), e = mid(b.check_out);
      if (e <= s) continue;
      const cut = `${b.check_in < ws ? ' cont-l' : ''}${b.check_out > we ? ' cont-r' : ''}`;
      const nights = daysBetween(b.check_in, b.check_out);
      html += `<div class="bar stay-bar${cut}" style="grid-column:${s}/${e}" title="${h(guestLabel(b))}: ${h(prettyDate(b.check_in))} to ${h(prettyDate(b.check_out))}, ${nights} night${nights === 1 ? '' : 's'}">${h(guestLabel(b))}</div>`;
    }
    for (const win of windows) {
      const end = win.to || addDays(we, 1);
      if (end < ws || win.from > we) continue;
      let s = mid(win.from), e = mid(end);
      const sameDay = win.to && win.to === win.from;
      if (sameDay) { s = mid(win.from) - 1; e = s + 2; }
      if (e <= s) continue;
      const text = sameDay ? `Same-day turnover: ${prettyTime(config.checkoutTime)} to ${prettyTime(config.checkinTime)}` : win.to ? `${win.days} days to clean` : 'Open, no next booking yet';
      const showText = win.from >= ws || ws === gridStart; // label once, where the window starts
      html += `<div class="bar win-bar${sameDay ? ' tight' : win.to && win.days <= 2 ? ' short' : ''}" style="grid-column:${s}/${e}" title="${h(text)}">${sameDay ? 'Same day' : showText ? h(text) : ''}</div>`;
    }
    for (const c of live) {
      const i = idx(c.date);
      if (i < 0 || i > 6) continue;
      html += `<span class="chip ${c.status}" draggable="true" data-id="${c.id}" style="grid-column:${2 * i + 1}/span 2" title="Drag to move">${c.status === 'awaiting_approval' ? 'Needs OK' : 'Cleaning'}</span>`;
    }
    weeks.push(`<div class="week">${html}</div>`);
  }

  return `<div class="row" style="justify-content:space-between"><h2>${label}</h2><div class="row">
<a class="btn" href="/?month=${prev}">&lsaquo;</a><a class="btn" href="/?month=${next}">&rsaquo;</a></div></div>
<div class="legend"><span><i class="bar stay-bar"></i>Guests staying</span><span><i class="bar win-bar"></i>Open days to clean</span><span><i class="bar win-bar tight"></i>Same-day turnover</span><span><i class="chip approved"></i>Cleaning</span><span><i class="chip awaiting_approval"></i>Needs approval</span></div>
<div class="dows">${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map(d => `<div>${d}</div>`).join('')}</div>
<div class="cal" id="cal">${weeks.join('')}</div>
<p class="muted">Stays run from ${prettyTime(config.checkinTime)} check-in to ${prettyTime(config.checkoutTime)} checkout. Drag a cleaning to another day to move it. You'll be asked before anything is texted to the group.</p>
<script>
let dragId=null;document.querySelectorAll('.chip[data-id]').forEach(c=>{c.addEventListener('dragstart',e=>{dragId=c.dataset.id;e.dataTransfer.setData('text/plain',dragId);document.body.classList.add('dragging')});c.addEventListener('dragend',()=>document.body.classList.remove('dragging'))});
document.querySelectorAll('.day').forEach(d=>{d.addEventListener('dragover',e=>{e.preventDefault();d.classList.add('over')});
d.addEventListener('dragleave',()=>d.classList.remove('over'));
d.addEventListener('drop',async e=>{e.preventDefault();d.classList.remove('over');const id=e.dataTransfer.getData('text/plain')||dragId;if(!id)return;
const r=await fetch('/cleanings/'+id+'/move',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded','Accept':'application/json'},body:'date='+d.dataset.date});
const j=await r.json();location.href=j.redirect||'/?month=${month}'})});
</script>`;
}

function staysCard(bookings, today, config) {
  const wins = cleaningWindows(bookings);
  const sorted = [...bookings].sort((a, b) => a.check_in.localeCompare(b.check_in));
  const rows = sorted.map((b, i) => [b, wins[i]]).filter(([b]) => b.check_out >= today).map(([b, w]) => {
    const nights = daysBetween(b.check_in, b.check_out);
    const gap = !w.to ? 'No next booking yet' : w.to === w.from ? '<b class="warn">Same day</b>' : `${w.days} days (${h(prettyDate(w.from))} to ${h(prettyDate(w.to))})`;
    return `<tr><td><form method="post" action="/bookings/name" class="row"><input type="hidden" name="uid" value="${h(b.uid)}">
<input name="name" value="${h(b.guest_name || '')}" placeholder="${h(guestLabel(b))}" style="width:150px"><button class="ghost">Save</button></form></td>
<td>${h(prettyDate(b.check_in))} to ${h(prettyDate(b.check_out))}<div class="muted">${nights} night${nights === 1 ? '' : 's'}</div></td><td>${gap}</td></tr>`;
  }).join('');
  return `<div class="card"><h2>Stays and cleaning windows</h2>
<p class="muted">Airbnb's calendar link doesn't include guest names, only the last 4 digits of their phone. Type a name here and it shows on the calendar.</p>
${rows ? `<div class="scroll"><table><tr><th>Guest</th><th>Stay</th><th>Time to clean after</th></tr>${rows}</table></div>` : '<p class="muted">No upcoming stays.</p>'}</div>`;
}

export function dashboard({ config, service, db, month, who, flash }) {
  const cleanings = service.list({ from: addDays(`${month}-01`, -60) });
  const bookings = db.prepare("SELECT * FROM bookings WHERE status='active'").all();
  const today = todayIn(config.timezone);
  const lastSync = JSON.parse(db.prepare("SELECT value FROM meta WHERE key='last_sync'").get()?.value || 'null');
  const pendingMsgs = db.prepare("SELECT g.*, c.date FROM group_messages g JOIN cleanings c ON c.id = g.cleaning_id WHERE g.status='pending' ORDER BY g.created_at").all();
  const awaiting = db.prepare("SELECT * FROM cleanings WHERE status='awaiting_approval' ORDER BY date").all();
  const owed = db.prepare("SELECT * FROM cleanings WHERE status='completed' AND amount_cents IS NOT NULL ORDER BY date").all();
  const awaitingBill = db.prepare("SELECT * FROM cleanings WHERE status='completed' AND amount_cents IS NULL ORDER BY date").all();
  const cleanerName = h(config.cleaner?.name || 'the cleaner');
  const paidYear = db.prepare("SELECT COALESCE(SUM(amount_cents),0) s, COUNT(*) n FROM cleanings WHERE status='paid' AND substr(paid_at,1,4)=?").get(today.slice(0, 4));
  const outbox = db.prepare('SELECT * FROM outbox ORDER BY id DESC LIMIT 15').all();
  const whoSel = config.approvers.map(a => `<option ${a.name === who ? 'selected' : ''}>${h(a.name)}</option>`).join('');

  const decisions = [
    ...pendingMsgs.map(m => `<tr><td>${h(prettyDate(m.date))}</td><td><span class="pill">Text the group?</span> ${h(m.body)}</td><td><a class="btn" href="/g/${m.token}?by=${encodeURIComponent(who)}">Decide</a></td></tr>`),
    ...awaiting.map(c => `<tr><td>${h(prettyDate(c.date))}</td><td><span class="pill">Needs approval</span> ${h(service.describe(c))}</td><td><a class="btn" href="/a/${c.approval_token}?by=${encodeURIComponent(who)}">Review</a></td></tr>`),
  ].join('');

  const upcoming = cleanings.filter(c => c.date >= today && !['cancelled', 'declined'].includes(c.status));
  const rows = upcoming.map(c => `<tr><td><b>${h(prettyDate(c.date))}</b><div class="muted">${c.source === 'manual' ? 'Added by hand' : 'Airbnb'}${c.note ? ` · ${h(c.note)}` : ''}</div></td>
<td><div class="stages">${service.stageOf(c).map(s => `<span class="stage ${s.done ? 'done' : ''}">${h(s.name)}</span>`).join('')}</div></td>
<td><form method="post" action="/cleanings/${c.id}/move" class="row"><input type="date" name="date" value="${c.date}" required><button class="ghost">Move</button></form>
<div class="row" style="margin-top:6px"><form method="post" action="/cleanings/${c.id}/cancel" onsubmit="return confirm('Cancel this cleaning?')"><button class="danger">Cancel</button></form>
<form method="post" action="/cleanings/${c.id}/message"><input type="hidden" name="body" value=""><button class="ghost">Text group</button></form></div></td></tr>`).join('');

  const owedRows = owed.map(c => `<tr><td><input type="checkbox" name="id" value="${c.id}" checked></td><td>${h(prettyDate(c.date))}</td><td>${money(c.amount_cents)}</td></tr>`).join('');
  const owedTotal = owed.reduce((s, c) => s + (c.amount_cents || 0), 0);
  const recentPaid = db.prepare("SELECT * FROM cleanings WHERE status='paid' ORDER BY paid_at DESC LIMIT 8").all()
    .map(c => `<tr><td>${h(prettyDate(c.date))}</td><td>${money(c.amount_cents)}</td><td>${h(c.paid_method || '')}</td><td class="muted">${h(c.paid_at?.slice(0, 10))}</td></tr>`).join('');

  return layout('Cleaning Link', `
<div class="row" style="justify-content:space-between"><div><h1>Cleaning Link</h1>
<div class="muted">${h(config.propertyName)} · ${lastSync ? `Airbnb checked ${h(new Date(lastSync.at).toLocaleString('en-US', { timeZone: config.timezone }))}` : 'Airbnb not checked yet'}${config.dryRun ? ' · <b>Test mode: no texts are really sent</b>' : ''}</div></div>
<div class="row"><form method="post" action="/who" class="row"><label class="muted">You are</label><select name="name" onchange="this.form.submit()">${whoSel}</select></form>
<form method="post" action="/sync"><button>Check Airbnb now</button></form></div></div>
${flash ? `<div class="card">${h(flash)}</div>` : ''}
${decisions ? `<div class="card"><h2>Waiting on you</h2><div class="scroll"><table>${decisions}</table></div></div>` : ''}
<div class="card">${calendar(month, cleanings, bookings, config.timezone, config)}</div>
${staysCard(bookings, today, config)}
<div class="card"><h2>Add a cleaning day</h2><form method="post" action="/cleanings" class="row">
<input type="date" name="date" required min="${today}"><input name="note" placeholder="Note for the cleaner (optional)" style="flex:1;min-width:180px"><button>Add</button></form>
<p class="muted">Days you add count as approved. You'll see the group text before it goes out.</p></div>
<div class="card"><h2>Upcoming cleanings</h2>${rows ? `<div class="scroll"><table><tr><th>Day</th><th>Progress</th><th>Change</th></tr>${rows}</table></div>` : '<p class="muted">Nothing scheduled.</p>'}</div>
<div class="card" id="payments"><h2>Cleaner payments</h2>
<p>Owed now: <b>${money(owedTotal)}</b> for ${owed.length} cleaning(s) · Paid this year: ${money(paidYear.s)} (${paidYear.n})</p>
${awaitingBill.length ? `<h2 style="margin-top:14px">Cleaned, waiting for ${cleanerName}'s request</h2><p class="muted">When ${cleanerName} asks to be paid, enter the amount here.</p><table>
${awaitingBill.map(c => `<tr><td>${h(prettyDate(c.date))}</td><td><form method="post" action="/payments/request" class="row"><input type="hidden" name="id" value="${c.id}"><input name="amount" type="number" min="1" step="0.01" placeholder="Amount $" required style="width:120px"><button class="ghost">Save request</button></form></td></tr>`).join('')}</table>` : ''}
${owed.length ? `<h2 style="margin-top:14px">Requested, not paid yet</h2><form method="post" action="/payments/paid"><table><tr><th></th><th>Cleaning</th><th>Amount</th></tr>${owedRows}</table>
<div class="row" style="margin-top:10px"><select name="method"><option>Venmo</option><option>Zelle</option><option>Cash</option><option>Check</option><option>Other</option></select><button>Mark selected paid</button></div></form>` : ''}
${recentPaid ? `<h2 style="margin-top:14px">Recently paid</h2><table>${recentPaid}</table>` : ''}</div>
<div class="card"><h2>Calendar for Google, iCal and Skylight</h2><p>Subscribe to this address (Google Calendar: Other calendars, From URL):</p>
<p><code>${h(config.baseUrl)}/feed/${h(config.feedToken)}.ics</code></p><p class="muted">Only approved cleanings appear. Google refreshes subscribed calendars every few hours.</p></div>
<div class="card"><h2>Messages sent</h2><div class="scroll"><table><tr><th>When</th><th>To</th><th>Message</th><th>Status</th></tr>
${outbox.map(o => `<tr><td class="muted">${h(new Date(o.at).toLocaleString('en-US', { timeZone: config.timezone }))}</td><td>${h(o.channel === 'group' ? 'Group' : o.to_addr)}</td><td>${h(o.body)}</td><td>${h(o.status)}${o.error ? ` <span class="muted">${h(o.error.slice(0, 80))}</span>` : ''}</td></tr>`).join('')}
</table></div></div>`);
}
