import { prettyDate, prettyTime, addDays, todayIn } from './dates.js';

export const h = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (cents) => `$${((cents || 0) / 100).toFixed(2)}`;

const CSS = `
:root{--bg:#f7f6f3;--card:#fff;--ink:#1d1d1b;--muted:#6b6a66;--line:#e4e2dc;--accent:#2f6f5e;--accent-ink:#fff;--warn:#a5551b;--chip:#e3f0ec;--chip-ink:#1f4f42;--pending:#fbefd9;--pending-ink:#7a4a10;--stay:#3d5a80;--stay-ink:#fff;--win:#eef6f2;--win-ink:#2f6f5e;--win-line:#8fbfae;--tight:#b3412e;--tight-ring:#ffb199;--s-pending:#a16207;--s-missing:#d9480f;--s-past:#8a939e;--w-missing:#fff0e6;--w-missing-ink:#a8360a;--out:#efeee9}
@media (prefers-color-scheme:dark){:root{--bg:#141413;--card:#1e1e1c;--ink:#ecebe6;--muted:#a3a19a;--line:#33322f;--accent:#5fb39a;--accent-ink:#0f1f1a;--warn:#e19a62;--chip:#1f3a32;--chip-ink:#bfe6d9;--pending:#3a2c16;--pending-ink:#f2cf96;--stay:#5b7db0;--stay-ink:#fff;--win:#17302a;--win-ink:#9fd6c3;--win-line:#3f7a69;--tight:#d0604b;--tight-ring:#ffb199;--s-pending:#b7791f;--s-missing:#e8590c;--s-past:#4b5563;--w-missing:#3b1d0e;--w-missing-ink:#ffb48a;--out:#181817}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.45 system-ui,-apple-system,Segoe UI,sans-serif}
main{max-width:980px;margin:0 auto;padding:16px}h1{font-size:22px;margin:8px 0 4px}h2{font-size:17px;margin:0 0 10px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px;margin:14px 0}
.muted{color:var(--muted)}.warn{color:var(--tight)}.missing-text{color:var(--s-missing);font-weight:600}.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
button,.btn{background:var(--accent);color:var(--accent-ink);border:0;border-radius:8px;padding:8px 12px;font:inherit;cursor:pointer;text-decoration:none;display:inline-block}
button.ghost{background:transparent;color:var(--ink);border:1px solid var(--line)}button.danger{background:transparent;color:var(--warn);border:1px solid var(--line)}
input,textarea,select{font:inherit;padding:7px 9px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--ink)}textarea{width:100%;min-height:130px}
table{width:100%;border-collapse:collapse}td,th{padding:8px 6px;border-top:1px solid var(--line);text-align:left;vertical-align:top}th{font-weight:600;color:var(--muted);font-size:13px}
.stages{display:flex;gap:4px;flex-wrap:wrap}.stage{font-size:12px;padding:2px 7px;border-radius:99px;border:1px solid var(--line);color:var(--muted)}.stage.done{background:var(--chip);color:var(--chip-ink);border-color:transparent}
.pill{font-size:12px;padding:2px 8px;border-radius:99px;background:var(--pending);color:var(--pending-ink)}
.dows{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));font-size:12px;color:var(--muted);text-align:center;margin-bottom:4px}
.cal{display:flex;flex-direction:column;gap:4px}
.week{display:grid;grid-template-columns:repeat(14,minmax(0,1fr));grid-template-rows:22px 24px 24px 26px;column-gap:0;row-gap:3px;position:relative}
.day{cursor:pointer;grid-row:1/-1;min-width:0;border:1px solid var(--line);border-radius:8px;padding:2px 5px;font-size:12px;margin:0 2px}.day.out{background:var(--out);color:var(--muted)}.day.out b{font-weight:500}.day:hover{background:var(--win)}.day[data-past]{cursor:default}.day[data-past]:hover{background:none}.day.today{border-color:var(--accent);border-width:2px}.day.over{outline:2px dashed var(--accent)}.day.review{background:var(--pending);border:2px solid var(--s-pending);animation:pulse 1.2s ease-in-out 3}@keyframes pulse{50%{box-shadow:0 0 0 6px rgba(161,98,7,.25)}}.danger-text{color:var(--warn)}
.bar{pointer-events:none;min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;font-size:12px;line-height:22px;padding:0 6px;border-radius:11px;z-index:1}
.stay-bar{grid-row:2;background:var(--stay);color:#fff;font-weight:600}.stay-bar.pending{background:var(--s-pending)}.stay-bar.missing{background:var(--s-missing)}.stay-bar.past{background:var(--s-past)}.stay-bar.personal{background-image:repeating-linear-gradient(135deg,rgba(255,255,255,.18) 0 6px,transparent 6px 12px)}.stay-bar.flagged{box-shadow:inset 0 0 0 2px #ffd43b}.stay-bar.cont-l{border-top-left-radius:0;border-bottom-left-radius:0}.stay-bar.cont-r{border-top-right-radius:0;border-bottom-right-radius:0}
.win-bar{grid-row:3;background:var(--win);color:var(--win-ink);border:1px dashed var(--win-line);line-height:20px;font-size:11px}
.win-bar.open,.win-bar.past{background:transparent;color:var(--muted);border-color:var(--line)}
.win-bar.pending{background:var(--pending);color:var(--pending-ink);border-color:var(--s-pending)}
.win-bar.missing{background:var(--w-missing);color:var(--w-missing-ink);border:1px solid var(--s-missing);font-weight:600}
.win-bar.tight{color:#fff;border:0;margin:0 4px;text-align:center;font-weight:600;background:var(--accent)}.win-bar.tight.pending{background:var(--s-pending)}.win-bar.tight.missing{background:var(--s-missing)}
.chip{grid-row:4;z-index:2;margin:0 4px;padding:2px 5px;border-radius:6px;background:var(--chip);color:var(--chip-ink);cursor:grab;font-size:12px;font-weight:600;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;border:1px solid var(--accent)}
.chip.awaiting_approval{background:var(--pending);color:var(--pending-ink);border-color:var(--pending-ink)}
body.dragging .bar,body.dragging .chip{pointer-events:none}
.monthnav{display:flex;align-items:center;justify-content:space-between;gap:8px;margin:0 0 10px}.monthtitle{text-align:center;flex:1;min-width:0}.monthtitle h2{margin:0;font-size:22px}.monthtitle span{font-size:12px}.btn.ghost{background:none;color:var(--accent);border:1px solid var(--line);white-space:nowrap}.btn.ghost:hover{background:var(--win)}
.legend{display:flex;flex-wrap:wrap;gap:6px 14px;font-size:12px;color:var(--muted);margin:0 0 6px;align-items:center}.legend b{color:var(--ink)}.legend span{display:flex;align-items:center;gap:6px}.legend i{display:inline-block;width:22px;height:12px;padding:0;margin:0;line-height:0}
@media (max-width:640px){.cal-help{font-size:13px}.bar{font-size:10px;padding:0 3px}.chip{font-size:10px;margin:0 1px;padding:2px 2px}.day{margin:0 1px;padding:1px 3px}.hide-sm{display:none}}
.scroll{overflow-x:auto}
.topbar{display:flex;justify-content:space-between;align-items:center;gap:8px}.topbar h1{display:inline;margin:0 8px 0 0}.test-badge{font-size:12px;padding:2px 8px;border-radius:99px;background:var(--pending);color:var(--pending-ink);vertical-align:middle}
.toolbar{display:flex;justify-content:space-between;align-items:center;gap:8px;margin-top:10px;font-size:13px}button.small{padding:5px 10px;font-size:13px}
.flash{margin-top:10px;padding:8px 12px;border-radius:8px;background:var(--chip);color:var(--chip-ink);font-size:14px}.alerts{display:flex;flex-wrap:wrap;gap:4px 16px;margin-top:8px;font-size:14px}
.card:has(#cal){margin-top:10px}
.tabs{display:flex;gap:2px;margin:10px 0 0;border-bottom:1px solid var(--line);overflow-x:auto;scrollbar-width:none;white-space:nowrap}.tab{padding:8px 12px;white-space:nowrap;color:var(--muted);text-decoration:none;border-bottom:2px solid transparent;margin-bottom:-1px}.tab.on{color:var(--ink);border-color:var(--accent);font-weight:600}
.count{background:var(--tight);color:#fff;border-radius:99px;padding:0 7px;font-size:12px}
.notes,.todos{list-style:none;margin:0;padding:0}.note{border-top:1px solid var(--line);padding:10px 0}.note-body{margin:4px 0;white-space:pre-wrap}
.tag{font-size:12px;padding:2px 8px;border-radius:99px}.tag.supplies{background:var(--pending);color:var(--pending-ink)}.tag.condition{background:var(--tight);color:#fff}
.todo{display:flex;gap:10px;align-items:flex-start;border-top:1px solid var(--line);padding:10px 0}.todo.done>div{opacity:.6;text-decoration:line-through}
.check{width:24px;height:24px;padding:0;border-radius:6px;background:transparent;border:2px solid var(--accent);color:var(--accent);font-weight:700;line-height:1}
details summary{cursor:pointer;font-size:13px}label{font-size:14px}
.chip small{font-weight:400}
dialog{border:1px solid var(--line);border-radius:12px;background:var(--card);color:var(--ink);padding:18px;width:min(440px,calc(100vw - 32px))}dialog::backdrop{background:rgba(0,0,0,.4)}
.personal-add{margin-top:14px;border-top:1px solid var(--line);padding-top:10px}.personal-add summary{font-weight:600}
.dialog-actions{display:flex;flex-direction:column;gap:8px;margin-top:12px}code{word-break:break-all}
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

export function groupDecisionPage(m, c, by, approvers, guestsStaying = false, flash = '') {
  if (m.status !== 'pending') {
    return messagePage('Already decided', m.status === 'sent' ? `This was sent to the group${m.decided_by ? ` by ${m.decided_by}` : ''}.` : `This was ${m.status}.`, '<p><a class="btn" href="/">Back to dashboard</a></p>');
  }
  const who = approvers.map(a => `<option ${a.name === by ? 'selected' : ''}>${h(a.name)}</option>`).join('');
  return layout('Text the group?', `<div class="card"><h1>Text the group about this change?</h1>
<p class="muted">Cleaning on ${h(prettyDate(c.date))} is now <b>${h(c.status.replace('_', ' '))}</b>. Your cleaner treats the group text as the source of truth, so nothing goes out unless you say so.</p>
${guestsStaying ? `<p class="pill" style="display:inline-block">Heads up: guests are staying at the house on ${h(prettyDate(c.date))}.</p>` : ''}
${flash ? `<div class="flash">${h(flash)}</div>` : ''}
<form method="post"><textarea name="body">${h(m.body)}</textarea>
<div class="row" style="margin-top:10px"><select name="by" aria-label="Who is deciding">${who}</select>
<button name="send" value="1">Send to group</button><button class="ghost" name="send" value="test">Send me a test</button><button class="ghost" name="send" value="0">Don't send</button></div></form>
<p class="muted" style="margin-bottom:0">"Send me a test" texts this message only to the person picked above, so you can see how it reads. The group gets nothing until you press "Send to group."</p></div>`);
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
    return { from: b.check_out, to: next ? next.check_in : null, days: next ? daysBetween(b.check_out, next.check_in) + 1 : null, nextUid: next ? next.uid : null };
  });
}

// Is the house going to be cleaned before these guests arrive?
//   ready   - a confirmed cleaning sits between the previous checkout and this check-in
//   pending - a cleaning is proposed but still waiting for approval
//   missing - nothing scheduled in that gap
//   past    - the stay is over (shown greyed out)
// Stays that have already started, or have no stay before them, count as ready.
export function stayReadiness(bookings, cleanings, today) {
  const live = cleanings.filter(c => !['cancelled', 'declined'].includes(c.status));
  const out = {};
  for (const b of bookings) {
    if (b.check_out < today) { out[b.uid] = 'past'; continue; }
    if (b.check_in < today) { out[b.uid] = 'ready'; continue; }
    const prev = bookings.filter(p => p.uid !== b.uid && p.check_out <= b.check_in).sort((x, y) => y.check_out.localeCompare(x.check_out))[0];
    if (!prev) { out[b.uid] = 'ready'; continue; }
    const inGap = live.filter(c => c.date >= prev.check_out && c.date <= b.check_in);
    out[b.uid] = inGap.some(c => c.status !== 'awaiting_approval') ? 'ready' : inGap.length ? 'pending' : 'missing';
    // Your own stays don't raise the alarm if the house wasn't cleaned before you arrive.
    if (b.source === 'personal' && out[b.uid] === 'missing') out[b.uid] = 'ready';
  }
  return out;
}

const READINESS_NOTE = { ready: 'Cleaning scheduled before check-in', pending: 'Cleaning proposed, waiting for approval', missing: 'No cleaning scheduled before check-in', past: 'Past stay' };

function calendar(month, cleanings, bookings, tz, config, extras = { counts: {}, flagged: new Set() }) {
  const [y, m] = month.split('-').map(Number);
  const first = `${month}-01`;
  const gridStart = addDays(first, -new Date(first + 'T12:00:00Z').getUTCDay());
  const today = todayIn(tz);
  const prev = new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 7);
  const next = new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 7);
  const label = new Date(first + 'T12:00:00Z').toLocaleDateString('en-US', { timeZone: 'UTC', month: 'long', year: 'numeric' });
  const windows = cleaningWindows(bookings);
  const live = cleanings.filter(c => !['cancelled', 'declined'].includes(c.status));
  const ready = stayReadiness(bookings, cleanings, today);
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
      const staying = bookings.some(b => b.check_in < d && d < b.check_out);
      const turnover = bookings.some(b => b.check_out === d) && bookings.some(b => b.check_in === d);
      const booked = live.filter(c => c.date === d).length;
      html += `<div class="day ${d.slice(0, 7) !== month ? 'out' : ''} ${d === today ? 'today' : ''} ${extras.review?.date === d ? 'review' : ''}" data-date="${d}" data-label="${h(prettyDate(d))}"${staying ? ' data-staying="1"' : ''}${turnover ? ' data-turnover="1"' : ''}${booked ? ` data-booked="${booked}"` : ''}${d < today ? ' data-past="1"' : ''} style="grid-column:${2 * i + 1}/span 2" role="button" tabindex="0" aria-label="Add a cleaning on ${h(prettyDate(d))}"><b>${d.slice(8) === '01' || (d.slice(0, 7) !== month && d === ws) ? `${new Date(d + 'T12:00:00Z').toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short' })} ` : ''}${Number(d.slice(8))}</b></div>`;
    }
    for (const b of bookings) {
      if (b.check_out < ws || b.check_in > we) continue;
      const s = mid(b.check_in), e = mid(b.check_out);
      if (e <= s) continue;
      const cut = `${b.check_in < ws ? ' cont-l' : ''}${b.check_out > we ? ' cont-r' : ''}`;
      const nights = daysBetween(b.check_in, b.check_out);
      const flag = extras.flagged.has(b.uid);
      const st = ready[b.uid] || 'ready';
      html += `<div class="bar stay-bar ${st}${b.source === 'personal' ? ' personal' : ''}${cut}${flag ? ' flagged' : ''}" style="grid-column:${s}/${e}" title="${h(guestLabel(b))}: ${h(prettyDate(b.check_in))} to ${h(prettyDate(b.check_out))}, ${nights} night${nights === 1 ? '' : 's'}. ${READINESS_NOTE[st]}${flag ? '. Has notes to raise with Airbnb' : ''}">${flag ? '⚠ ' : ''}${st === 'missing' ? '! ' : ''}${b.source === 'personal' ? '⌂ ' : ''}${h(guestLabel(b))}</div>`;
    }
    for (const win of windows) {
      const end = win.to || addDays(we, 1);
      if (end < ws || win.from > we) continue;
      let s = mid(win.from), e = mid(end);
      const sameDay = win.to && win.to === win.from;
      if (sameDay) { s = mid(win.from) - 1; e = s + 2; }
      if (e <= s) continue;
      const st = win.nextUid ? (ready[win.nextUid] || 'ready') : 'open';
      const status = { ready: 'cleaning set', pending: 'needs OK', missing: 'no cleaning yet', past: '' }[st] || '';
      const text = sameDay ? `Same-day turnover: ${prettyTime(config.checkoutTime)} to ${prettyTime(config.checkinTime)}${status ? `, ${status}` : ''}`
        : win.to ? `${win.days} days to clean${status ? ` · ${status}` : ''}` : 'Open, no next booking yet';
      const showText = win.from >= ws || ws === gridStart; // label once, where the window starts
      html += `<div class="bar win-bar ${st}${sameDay ? ' tight' : ''}" style="grid-column:${s}/${e}" title="${h(text)}">${sameDay ? 'Same day' : showText ? h(text) : ''}</div>`;
    }
    for (const c of live) {
      const i = idx(c.date);
      if (i < 0 || i > 6) continue;
      html += `<span class="chip ${c.status}" draggable="true" data-id="${c.id}" style="grid-column:${2 * i + 1}/span 2" title="Click to open, drag to move">${c.status === 'awaiting_approval' ? 'Needs OK' : 'Cleaning'}${extras.counts[c.id] ? ` <small>✎${extras.counts[c.id]}</small>` : ''}</span>`;
    }
    weeks.push(`<div class="week">${html}</div>`);
  }

  const short = (ym) => new Date(ym + '-01T12:00:00Z').toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short' });
  const thisMonth = today.slice(0, 7);
  const rel = month === thisMonth ? 'This month' : month < thisMonth ? 'Past month' : 'Upcoming';
  return `<div class="monthnav">
<a class="btn ghost" href="/?month=${prev}" aria-label="Previous month">&lsaquo; ${short(prev)}</a>
<div class="monthtitle"><h2>${label}</h2><span class="muted">${rel}${month !== thisMonth ? ` · <a href="/?month=${thisMonth}">Back to today</a>` : ''}</span></div>
<a class="btn ghost" href="/?month=${next}" aria-label="Next month">${short(next)} &rsaquo;</a></div>
<div class="legend"><b>Stays:</b><span><i class="bar stay-bar ready"></i>Cleaning set before check-in</span><span><i class="bar stay-bar pending"></i>Cleaning waiting for approval</span><span><i class="bar stay-bar missing"></i>No cleaning before check-in</span><span><i class="bar stay-bar past"></i>Past</span><span><i class="bar stay-bar ready personal"></i>⌂ Personal stay</span></div>
<div class="legend"><b>Cleanings:</b><span><i class="chip approved"></i>Confirmed (✎ = notes)</span><span><i class="chip awaiting_approval"></i>Needs approval</span><span>⚠ Something to raise with Airbnb</span></div>
<div class="dows">${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map(d => `<div>${d}</div>`).join('')}</div>
<div class="cal" id="cal">${weeks.join('')}</div>
<p class="muted cal-help">Stays run from ${prettyTime(config.checkinTime)} check-in to ${prettyTime(config.checkoutTime)} checkout. Tap a day to add a cleaning. Tap a cleaning to open it, or drag it to another day to move it. You'll be asked before anything is texted to the group.</p>
<dialog id="add-dialog"><form method="post" action="/cleanings">
<h2 id="add-title">Add a cleaning</h2><input type="hidden" name="date" id="add-date"><input type="hidden" name="proposal" id="add-proposal">
<p id="add-about" class="muted" hidden></p>
<p id="add-warn" class="warn" hidden></p>
<label for="add-note" class="muted">Note (optional)</label><textarea name="note" id="add-note" maxlength="300" placeholder="e.g. deep clean the oven" style="min-height:70px"></textarea>
<div class="dialog-actions"><button name="arranged" value="1" id="add-arranged">Schedule, already arranged with ${h(config.cleaner?.name || 'the cleaner')}</button>
<button class="ghost" name="arranged" value="0" id="add-text">Schedule and text the group</button>
<button class="ghost danger-text" name="action" value="decline" id="add-decline" hidden formnovalidate onclick="return confirm('Decline this cleaning? Nothing is texted.')">Not needed</button>
<button class="ghost" type="button" id="add-cancel">Cancel</button></div>
<p class="muted" style="margin-bottom:0">"Already arranged" adds it without texting anyone. "Text the group" shows you the message before it goes out.<span id="add-other" hidden> To use a different day, close this and tap that day instead.</span></p></form>
<details class="personal-add" id="personal-add"><summary>Or add a personal stay starting this day</summary>
<form method="post" action="/personal" class="row" style="margin-top:8px"><input type="hidden" name="check_in" id="ps-in">
<label class="muted">Leaving <input type="date" name="check_out" id="ps-out" required></label>
<input name="name" placeholder="Who's staying (optional)" style="flex:1;min-width:150px"><button>Add personal stay</button></form>
<p class="muted" style="margin-bottom:0">A cleaning is proposed for the day you leave, unless one is already scheduled.</p></details></dialog>
<script>
const dlg=document.getElementById('add-dialog');
function openAdd(d){if(d.dataset.past)return;document.getElementById('add-date').value=d.dataset.date;
document.getElementById('ps-in').value=d.dataset.date;const o=document.getElementById('ps-out');o.min=d.dataset.date;const nx=new Date(d.dataset.date+'T12:00:00Z');nx.setUTCDate(nx.getUTCDate()+2);o.value=nx.toISOString().slice(0,10);document.getElementById('add-title').textContent='Add a cleaning on '+d.dataset.label;
const w=[];if(d.dataset.staying)w.push('Guests are staying that day.');if(d.dataset.turnover)w.push('Same-day turnover: the window is ${prettyTime(config.checkoutTime)} to ${prettyTime(config.checkinTime)}.');if(d.dataset.booked)w.push('There is already a cleaning that day.');
const el=document.getElementById('add-warn');el.textContent=w.join(' ');el.hidden=!w.length;document.getElementById('add-note').value='';const rv=review&&review.date===d.dataset.date?review:null;if(rv)el.hidden=true;setReview(rv);dlg.showModal();}
const cleanerName=${JSON.stringify(config.cleaner?.name || 'the cleaner').replace(/</g, '\\u003c')};
function setReview(r){const $=(i)=>document.getElementById(i);$('add-proposal').value=r?r.id:'';$('add-decline').hidden=!r;$('add-other').hidden=!r;$('add-about').hidden=!r;$('add-about').textContent=r?r.about:'';
$('add-arranged').textContent=(r?'Approve':'Schedule')+', already arranged with '+cleanerName;$('add-text').textContent=(r?'Approve':'Schedule')+' and text the group';$('personal-add').hidden=!!r;
if(r){$('add-title').textContent='Approve the cleaning on '+r.label;$('add-note').value=r.note;}}
const review=${JSON.stringify(extras.review || null).replace(/</g, '\\u003c')};
if(review){const d=document.querySelector('.day[data-date="'+review.date+'"]');if(d){d.scrollIntoView({block:'center'});setTimeout(()=>openAdd(d),350);}}
document.getElementById('add-cancel').addEventListener('click',()=>dlg.close());
dlg.addEventListener('click',e=>{if(e.target===dlg)dlg.close();});
document.querySelectorAll('.day').forEach(d=>{d.addEventListener('click',()=>openAdd(d));d.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();openAdd(d);}});});
let dragId=null;document.querySelectorAll('.chip[data-id]').forEach(c=>{c.addEventListener('click',()=>location.href='/cleanings/'+c.dataset.id);c.addEventListener('dragstart',e=>{dragId=c.dataset.id;e.dataTransfer.setData('text/plain',dragId);document.body.classList.add('dragging')});c.addEventListener('dragend',()=>document.body.classList.remove('dragging'))});
document.querySelectorAll('.day').forEach(d=>{d.addEventListener('dragover',e=>{e.preventDefault();d.classList.add('over')});
d.addEventListener('dragleave',()=>d.classList.remove('over'));
d.addEventListener('drop',async e=>{e.preventDefault();d.classList.remove('over');const id=e.dataTransfer.getData('text/plain')||dragId;if(!id)return;
const r=await fetch('/cleanings/'+id+'/move',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded','Accept':'application/json'},body:'date='+d.dataset.date});
const j=await r.json();location.href=j.redirect||'/?month=${month}'})});
{let sx=null,sy=0;const cal=document.getElementById('cal');cal.addEventListener('touchstart',e=>{sx=e.touches[0].clientX;sy=e.touches[0].clientY},{passive:true});cal.addEventListener('touchend',e=>{if(sx===null)return;const dx=e.changedTouches[0].clientX-sx,dy=e.changedTouches[0].clientY-sy;sx=null;if(Math.abs(dx)>70&&Math.abs(dx)>2*Math.abs(dy))location.href='/?month='+(dx<0?'${next}':'${prev}')})}
</script>`;
}

function reviewFor(service, id) {
  const c = id && service.get(id);
  if (!c || c.status !== 'awaiting_approval') return null;
  return { id: c.id, date: c.date, label: prettyDate(c.date), about: service.describe(c), note: c.note || '' };
}

function calendarExtras(db) {
  const counts = Object.fromEntries(db.prepare('SELECT cleaning_id, COUNT(*) n FROM notes WHERE cleaning_id IS NOT NULL GROUP BY cleaning_id').all().map(r => [r.cleaning_id, r.n]));
  const flagged = new Set(db.prepare("SELECT DISTINCT booking_uid FROM notes WHERE followup='open' AND booking_uid IS NOT NULL").all().map(r => r.booking_uid));
  return { counts, flagged };
}

export function header({ config, db, who, active }) {
  const whoSel = config.approvers.map(a => `<option ${a.name === who ? 'selected' : ''}>${h(a.name)}</option>`).join('');
  const openTodos = db.prepare("SELECT COUNT(*) n FROM todos WHERE status='open'").get().n
    + db.prepare("SELECT COUNT(*) n FROM notes WHERE followup='open'").get().n;
  const waiting = db.prepare("SELECT COUNT(*) n FROM group_messages WHERE status='pending'").get().n
    + db.prepare("SELECT COUNT(*) n FROM cleanings WHERE status='awaiting_approval'").get().n;
  const badge = (n) => n ? ` <span class="count">${n}</span>` : '';
  const tab = (key, href, label) => `<a class="tab ${active === key ? 'on' : ''}" href="${href}">${label}</a>`;
  return `<div class="topbar"><div><h1>Cleaning Link</h1>${config.dryRun ? '<span class="test-badge">Test mode</span>' : ''}</div>
<form method="post" action="/who" class="row"><label class="muted hide-sm">You are</label><select name="name" onchange="this.form.submit()" aria-label="You are">${whoSel}</select></form></div>
<nav class="tabs">${tab('calendar', '/', 'Calendar')}${tab('inbox', '/inbox', `Waiting on you${badge(waiting)}`)}${tab('stays', '/stays', 'Stays')}${tab('todos', '/todos', `To-do${badge(openTodos)}`)}${tab('notes', '/notes', 'Notes')}${tab('payments', '/payments', 'Payments')}${tab('more', '/more', 'More')}</nav>`;
}

const TAG_LABEL = { supplies: 'Supplies', condition: 'Condition / damage' };
const tagPills = (tags) => (tags || '').split(',').filter(Boolean).map(t => `<span class="tag ${t}">${TAG_LABEL[t] || h(t)}</span>`).join(' ');
const when = (iso, tz) => new Date(iso).toLocaleString('en-US', { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

function noteItem(n, { config, cleanings, showCleaning = true }) {
  const opts = ['<option value="">Not tied to a cleaning</option>', ...cleanings.map(c => `<option value="${c.id}" ${c.id === n.cleaning_id ? 'selected' : ''}>Cleaning ${h(prettyDate(c.date))}</option>`)].join('');
  const tags = (n.tags || '').split(',');
  const cleaning = cleanings.find(c => c.id === n.cleaning_id);
  return `<li class="note"><div class="row" style="justify-content:space-between"><div><b>${h(n.author)}</b> <span class="muted">${h(when(n.at, config.timezone))}${n.source === 'manual' ? ' · added by hand' : ''}</span></div><div>${tagPills(n.tags)}</div></div>
<div class="note-body">${h(n.body)}</div>
${showCleaning && cleaning ? `<div class="muted">About the <a href="/cleanings/${cleaning.id}">${h(prettyDate(cleaning.date))} cleaning</a></div>` : ''}
<details><summary class="muted">Change</summary><form method="post" action="/notes/${n.id}" class="row" style="margin-top:6px">
<select name="cleaning_id">${opts}</select>
<label><input type="checkbox" name="tag" value="supplies" ${tags.includes('supplies') ? 'checked' : ''}> Supplies to-do</label>
<label><input type="checkbox" name="tag" value="condition" ${tags.includes('condition') ? 'checked' : ''}> Airbnb follow-up</label>
<button class="ghost">Save</button></form></details></li>`;
}

function addNoteForm(config, cleanings, cleaningId = null) {
  const people = config.groupMembers.map(p => `<option>${h(p.name)}</option>`).join('');
  const opts = ['<option value="">Pick automatically from the time</option>', ...cleanings.map(c => `<option value="${c.id}" ${c.id === cleaningId ? 'selected' : ''}>Cleaning ${h(prettyDate(c.date))}</option>`)].join('');
  return `<form method="post" action="/notes"><textarea name="body" placeholder="Paste or type a text from the group thread" required></textarea>
<div class="row" style="margin-top:8px"><select name="author">${people}</select><input type="datetime-local" name="at" title="When it was sent (leave blank for now)">
<select name="cleaning_id">${opts}</select><button>Add note</button></div>
<p class="muted">Leave the time blank for now. Notes from the cleaner about missing supplies become to-dos, and notes about damage or mess are flagged for Airbnb follow-up. You can change either afterwards.</p></form>`;
}

const pickable = (db) => db.prepare("SELECT * FROM cleanings WHERE status NOT IN ('cancelled','declined') ORDER BY date DESC LIMIT 60").all();

export function notesPage({ config, db, who }) {
  const notes = db.prepare('SELECT * FROM notes ORDER BY at DESC LIMIT 200').all();
  const cleanings = pickable(db);
  return layout('Notes', `${header({ config, db, who, active: 'notes' })}
<div class="card"><h2>Add a note</h2>${addNoteForm(config, cleanings)}</div>
<div class="card"><h2>All notes</h2><p class="muted">${config.groupMode === 'conversation' ? 'Texts in the group thread are saved here automatically.' : 'Texts sent to the app\'s number are saved here automatically.'} Each one is tied to the cleaning it's about and the stay before it.</p>
${notes.length ? `<ul class="notes">${notes.map(n => noteItem(n, { config, cleanings })).join('')}</ul>` : '<p class="muted">No notes yet.</p>'}</div>`);
}

export function todosPage({ config, db, who }) {
  const open = db.prepare("SELECT t.*, c.date FROM todos t LEFT JOIN cleanings c ON c.id = t.cleaning_id WHERE t.status='open' ORDER BY t.created_at").all();
  const done = db.prepare("SELECT * FROM todos WHERE status='done' ORDER BY done_at DESC LIMIT 15").all();
  const follow = db.prepare("SELECT n.*, b.check_in, b.check_out, b.guest_name, b.description FROM notes n LEFT JOIN bookings b ON b.uid = n.booking_uid WHERE n.followup IS NOT NULL ORDER BY n.followup = 'done', n.at DESC LIMIT 50").all();
  const todoRow = (t) => `<li class="todo ${t.status}"><form method="post" action="/todos/${t.id}"><input type="hidden" name="done" value="${t.status === 'open' ? 1 : 0}">
<button class="check" title="${t.status === 'open' ? 'Mark done' : 'Reopen'}">${t.status === 'open' ? '' : '✓'}</button></form>
<div><div>${h(t.title)}</div><div class="muted">${t.note_id ? 'From a text' : `Added${t.created_by ? ` by ${h(t.created_by)}` : ''}`}${t.date ? ` · <a href="/cleanings/${t.cleaning_id}">${h(prettyDate(t.date))} cleaning</a>` : ''}${t.done_by ? ` · done by ${h(t.done_by)}` : ''}</div></div></li>`;
  const followRow = (n) => {
    const stay = n.check_in ? `${h(n.guest_name || guestLabel(n))}, ${h(prettyDate(n.check_in))} to ${h(prettyDate(n.check_out))}` : 'Stay not known';
    const url = (n.description || '').match(/https:\/\/www\.airbnb\.[^\s]+/)?.[0];
    return `<li class="todo ${n.followup === 'done' ? 'done' : 'open'}"><form method="post" action="/notes/${n.id}/followup"><input type="hidden" name="status" value="${n.followup === 'open' ? 'done' : 'open'}">
<button class="check" title="${n.followup === 'open' ? 'Mark followed up' : 'Reopen'}">${n.followup === 'open' ? '' : '✓'}</button></form>
<div><div>${h(n.body)}</div><div class="muted">${h(n.author)}, ${h(when(n.at, config.timezone))} · Stay: ${stay}${url ? ` · <a href="${h(url)}" target="_blank" rel="noopener">Open reservation on Airbnb</a>` : ''}</div></div></li>`;
  };
  return layout('To-do', `${header({ config, db, who, active: 'todos' })}
<div class="card"><h2>To-do</h2>
${open.length ? `<ul class="todos">${open.map(todoRow).join('')}</ul>` : '<p class="muted">Nothing to do.</p>'}
<form method="post" action="/todos" class="row" style="margin-top:10px"><input name="title" placeholder="Add a to-do, e.g. buy 6 hand towels" required style="flex:1;min-width:200px"><button>Add</button></form></div>
<div class="card"><h2>Raise with Airbnb</h2><p class="muted">Notes about damage, mess or anything unusual, tied to the stay they happened after.</p>
${follow.length ? `<ul class="todos">${follow.map(followRow).join('')}</ul>` : '<p class="muted">Nothing flagged.</p>'}</div>
${done.length ? `<div class="card"><h2>Done recently</h2><ul class="todos">${done.map(todoRow).join('')}</ul></div>` : ''}`);
}

export function cleaningPage({ config, db, who, service, id }) {
  const c = service.get(id);
  if (!c) return null;
  const stay = db.prepare("SELECT * FROM bookings WHERE status='active' AND check_out <= ? ORDER BY check_out DESC LIMIT 1").get(c.date);
  const nextStay = db.prepare("SELECT * FROM bookings WHERE status='active' AND check_in >= ? ORDER BY check_in LIMIT 1").get(c.date);
  const notes = db.prepare('SELECT * FROM notes WHERE cleaning_id = ? ORDER BY at').all(id);
  const todos = db.prepare('SELECT * FROM todos WHERE cleaning_id = ? ORDER BY created_at').all(id);
  const events = db.prepare("SELECT * FROM events WHERE cleaning_id = ? AND stage != 'Note' ORDER BY at").all(id);
  const cleanings = pickable(db);
  const stayText = (b) => b ? `${h(guestLabel(b))}, ${h(prettyDate(b.check_in))} to ${h(prettyDate(b.check_out))}` : 'None';
  return layout(`Cleaning ${prettyDate(c.date)}`, `${header({ config, db, who, active: 'calendar' })}
<div class="card"><p><a href="/?month=${c.date.slice(0, 7)}">&lsaquo; Calendar</a></p><h2>Cleaning ${h(prettyDate(c.date))}</h2>
<div class="stages">${service.stageOf(c).map(s => `<span class="stage ${s.done ? 'done' : ''}">${h(s.name)}</span>`).join('')}</div>
<table style="margin-top:10px"><tr><th>After the stay of</th><td>${stayText(stay)}</td></tr><tr><th>Before the stay of</th><td>${stayText(nextStay)}</td></tr>
${c.note ? `<tr><th>Note</th><td>${h(c.note)}</td></tr>` : ''}</table></div>
<div class="card"><h2>Notes</h2>${notes.length ? `<ul class="notes">${notes.map(n => noteItem(n, { config, cleanings, showCleaning: false })).join('')}</ul>` : '<p class="muted">No notes for this cleaning yet.</p>'}
<h2 style="margin-top:14px">Add a note</h2>${addNoteForm(config, cleanings, c.id)}</div>
${todos.length ? `<div class="card"><h2>To-dos from this cleaning</h2><ul>${todos.map(t => `<li>${t.status === 'done' ? '✓ ' : ''}${h(t.title)}</li>`).join('')}</ul></div>` : ''}
<div class="card"><h2>History</h2><table>${events.map(e => `<tr><td class="muted" style="white-space:nowrap">${h(when(e.at, config.timezone))}</td><td><b>${h(e.stage)}</b> ${h(e.detail || '')}</td></tr>`).join('')}</table></div>`);
}

function staysCard(bookings, today, config, cleanings = []) {
  const live = cleanings.filter(c => !['cancelled', 'declined'].includes(c.status));
  const wins = cleaningWindows(bookings);
  const sorted = [...bookings].sort((a, b) => a.check_in.localeCompare(b.check_in));
  const rows = sorted.map((b, i) => [b, wins[i]]).filter(([b]) => b.check_out >= today).map(([b, w]) => {
    const nights = daysBetween(b.check_in, b.check_out);
    const gap = !w.to ? 'No next booking yet' : w.to === w.from ? '<b class="warn">Same day</b>' : `${w.days} days (${h(prettyDate(w.from))} to ${h(prettyDate(w.to))})`;
    const covering = live.find(c => c.date >= w.from && (!w.to || c.date <= w.to));
    const plan = !covering && w.to && w.to >= today
      ? '<div class="missing-text">No cleaning scheduled</div>'
      : covering
      ? `<div><a href="/cleanings/${covering.id}">${covering.status === 'awaiting_approval' ? 'Proposed' : 'Cleaning'} ${h(prettyDate(covering.date))}</a>${covering.status === 'awaiting_approval' ? ' <span class="muted">(waiting for approval)</span>' : ' ✓'}</div>`
      : '';
    const form = !covering || covering.status === 'awaiting_approval'
      ? `<form method="post" action="/cleanings" class="row" style="margin-top:4px"><input type="hidden" name="arranged" value="1">
<input type="date" name="date" value="${w.from}" min="${w.from}" ${w.to ? `max="${w.to}"` : ''} required><button class="ghost" title="Already arranged with the cleaner, nothing is texted">Schedule</button></form>`
      : '';
    return `<tr><td><form method="post" action="/bookings/name" class="row"><input type="hidden" name="uid" value="${h(b.uid)}">
<input name="name" value="${h(b.guest_name || '')}" placeholder="${h(guestLabel(b))}" style="width:150px"><button class="ghost">Save</button></form></td>
<td>${b.source === 'personal' ? '<b>⌂ Personal</b><br>' : ''}${h(prettyDate(b.check_in))} to ${h(prettyDate(b.check_out))}<div class="muted">${nights} night${nights === 1 ? '' : 's'}</div></td><td>${gap}${plan}${form}</td></tr>`;
  }).join('');
  return `<div class="card"><h2>Stays and cleaning windows</h2>
<p class="muted">Airbnb's calendar link doesn't include guest names, only the last 4 digits of their phone. Type a name here and it shows on the calendar. "Schedule" books a cleaning you've already arranged, without texting anyone.</p>
${rows ? `<div class="scroll"><table><tr><th>Guest</th><th>Stay</th><th>Time to clean after</th></tr>${rows}</table></div>` : '<p class="muted">No upcoming stays.</p>'}</div>`;
}

function pageData({ config, service, db, month }) {
  const today = todayIn(config.timezone);
  return {
    today,
    cleanings: service.list({ from: addDays(`${month || today.slice(0, 7)}-01`, -60) }),
    bookings: db.prepare("SELECT * FROM bookings WHERE status='active'").all(),
  };
}

function decisionsList({ db, service, who }) {
  const pendingMsgs = db.prepare("SELECT g.*, c.date FROM group_messages g JOIN cleanings c ON c.id = g.cleaning_id WHERE g.status='pending' ORDER BY g.created_at").all();
  const awaiting = db.prepare("SELECT * FROM cleanings WHERE status='awaiting_approval' ORDER BY date").all();
  return [
    ...pendingMsgs.map(m => `<tr><td>${h(prettyDate(m.date))}</td><td><span class="pill">Text the group?</span> ${h(m.body)}</td><td><a class="btn" href="/g/${m.token}?by=${encodeURIComponent(who)}">Decide</a></td></tr>`),
    ...awaiting.map(c => `<tr><td>${h(prettyDate(c.date))}</td><td><span class="pill">Needs approval</span> ${h(service.describe(c))}</td><td><a class="btn" href="/?month=${c.date.slice(0, 7)}&review=${c.id}">Review</a></td></tr>`),
  ];
}

// Home: just the calendar, with one line for anything that needs attention.
export function dashboard({ config, service, db, month, who, flash, review }) {
  const { today, cleanings, bookings } = pageData({ config, service, db, month });
  const lastSync = JSON.parse(db.prepare("SELECT value FROM meta WHERE key='last_sync'").get()?.value || 'null');
  const waiting = decisionsList({ db, service, who }).length;
  const missing = Object.entries(stayReadiness(bookings, cleanings, today)).filter(([, v]) => v === 'missing').length;
  const alerts = [
    waiting ? `<a href="/inbox">${waiting} thing${waiting === 1 ? '' : 's'} waiting on you &rsaquo;</a>` : '',
    missing ? `<a href="/stays" class="missing-text">${missing} upcoming stay${missing === 1 ? ' has' : 's have'} no cleaning before check-in &rsaquo;</a>` : '',
  ].filter(Boolean);
  return layout('Cleaning Link', `${header({ config, db, who, active: 'calendar' })}
<div class="toolbar"><span class="muted">${lastSync ? `Airbnb checked ${h(new Date(lastSync.at).toLocaleString('en-US', { timeZone: config.timezone, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }))}` : 'Airbnb not checked yet'}</span>
<form method="post" action="/sync"><button class="ghost small">Check Airbnb now</button></form></div>
${flash ? `<div class="flash">${h(flash)}</div>` : ''}
${alerts.length ? `<div class="alerts">${alerts.join('')}</div>` : ''}
<div class="card">${calendar(month, cleanings, bookings, config.timezone, config, { ...calendarExtras(db), review: reviewFor(service, review) })}</div>`);
}

export function inboxPage({ config, service, db, who }) {
  const { today, cleanings } = pageData({ config, service, db });
  const decisions = decisionsList({ db, service, who }).join('');
  const upcoming = cleanings.filter(c => c.date >= today && !['cancelled', 'declined'].includes(c.status));
  const rows = upcoming.map(c => `<tr><td><a href="/cleanings/${c.id}"><b>${h(prettyDate(c.date))}</b></a><div class="muted">${c.source === 'manual' ? 'Added by hand' : 'Airbnb'}${c.note ? ` · ${h(c.note)}` : ''}</div></td>
<td><div class="stages">${service.stageOf(c).map(s => `<span class="stage ${s.done ? 'done' : ''}">${h(s.name)}</span>`).join('')}</div></td>
<td><form method="post" action="/cleanings/${c.id}/move" class="row"><input type="date" name="date" value="${c.date}" required><button class="ghost">Move</button></form>
<div class="row" style="margin-top:6px"><form method="post" action="/cleanings/${c.id}/cancel" onsubmit="return confirm('Cancel this cleaning?')"><button class="danger">Cancel</button></form>
<form method="post" action="/cleanings/${c.id}/message"><input type="hidden" name="body" value=""><button class="ghost">Text group</button></form></div></td></tr>`).join('');
  return layout('Waiting on you', `${header({ config, db, who, active: 'inbox' })}
<div class="card"><h2>Waiting on you</h2>${decisions ? `<div class="scroll"><table>${decisions}</table></div>` : '<p class="muted">Nothing needs a decision right now.</p>'}</div>
<div class="card"><h2>Upcoming cleanings</h2>${rows ? `<div class="scroll"><table><tr><th>Day</th><th>Progress</th><th>Change</th></tr>${rows}</table></div>` : '<p class="muted">Nothing scheduled.</p>'}</div>`);
}

export function staysPage({ config, service, db, who, flash }) {
  const { today, cleanings, bookings } = pageData({ config, service, db });
  const cleaner = h(config.cleaner?.name || 'the cleaner');
  return layout('Stays', `${header({ config, db, who, active: 'stays' })}
${flash ? `<div class="flash">${h(flash)}</div>` : ''}
${staysCard(bookings, today, config, cleanings)}
${personalCard(bookings, today)}
<div class="card"><h2>Schedule a cleaning</h2><form method="post" action="/cleanings">
<div class="row"><input type="date" name="date" required min="${today}"><input name="note" placeholder="Note (optional)" style="flex:1;min-width:180px"></div>
<div class="row" style="margin-top:8px"><button name="arranged" value="1">Schedule, already arranged with ${cleaner}</button><button class="ghost" name="arranged" value="0">Schedule and text the group</button></div></form>
<p class="muted">You can also tap a day on the calendar. A scheduled cleaning covers the turnover it falls in, so the app won't propose another one between those two stays.</p></div>`);
}

function personalCard(bookings, today) {
  const mine = bookings.filter(b => b.source === 'personal' && b.check_out >= today).sort((a, b) => a.check_in.localeCompare(b.check_in));
  const rows = mine.map(b => `<tr><td><form method="post" action="/personal/${h(b.uid)}" class="row">
<input name="name" value="${h(b.guest_name || '')}" placeholder="Who's staying" style="width:150px">
<input type="date" name="check_in" value="${b.check_in}" required><input type="date" name="check_out" value="${b.check_out}" required>
<button class="ghost">Save</button></form></td>
<td><form method="post" action="/personal/${h(b.uid)}/delete" onsubmit="return confirm('Remove this personal stay and its proposed cleaning?')"><button class="danger">Remove</button></form></td></tr>`).join('');
  return `<div class="card" id="personal"><h2>Personal stays</h2>
<p class="muted">Airbnb only shows these as blocked dates, so add them here. A cleaning is proposed for the day you leave (it appears under "Waiting on you"), unless one is already scheduled before the next guests. You can also tap a day on the calendar.</p>
<form method="post" action="/personal" class="row"><label class="muted">Arriving <input type="date" name="check_in" required min="${today}"></label>
<label class="muted">Leaving <input type="date" name="check_out" required min="${today}"></label>
<input name="name" placeholder="Who's staying (optional)" style="flex:1;min-width:150px"><button>Add personal stay</button></form>
${rows ? `<div class="scroll" style="margin-top:10px"><table>${rows}</table></div>` : ''}</div>`;
}

export function paymentsPage({ config, db, who }) {
  const today = todayIn(config.timezone);
  const owed = db.prepare("SELECT * FROM cleanings WHERE status='completed' AND amount_cents IS NOT NULL ORDER BY date").all();
  const awaitingBill = db.prepare("SELECT * FROM cleanings WHERE status='completed' AND amount_cents IS NULL ORDER BY date").all();
  const cleanerName = h(config.cleaner?.name || 'the cleaner');
  const paidYear = db.prepare("SELECT COALESCE(SUM(amount_cents),0) s, COUNT(*) n FROM cleanings WHERE status='paid' AND substr(paid_at,1,4)=?").get(today.slice(0, 4));
  const owedRows = owed.map(c => `<tr><td><input type="checkbox" name="id" value="${c.id}" checked></td><td>${h(prettyDate(c.date))}</td><td>${money(c.amount_cents)}</td></tr>`).join('');
  const owedTotal = owed.reduce((s, c) => s + (c.amount_cents || 0), 0);
  const recentPaid = db.prepare("SELECT * FROM cleanings WHERE status='paid' ORDER BY paid_at DESC LIMIT 12").all()
    .map(c => `<tr><td>${h(prettyDate(c.date))}</td><td>${money(c.amount_cents)}</td><td>${h(c.paid_method || '')}</td><td class="muted">${h(c.paid_at?.slice(0, 10))}</td></tr>`).join('');
  return layout('Payments', `${header({ config, db, who, active: 'payments' })}
<div class="card"><h2>Cleaner payments</h2>
<p>Owed now: <b>${money(owedTotal)}</b> for ${owed.length} cleaning(s) · Paid this year: ${money(paidYear.s)} (${paidYear.n})</p>
${awaitingBill.length ? `<h2 style="margin-top:14px">Cleaned, waiting for ${cleanerName}'s request</h2><p class="muted">When ${cleanerName} asks to be paid, enter the amount here.</p><table>
${awaitingBill.map(c => `<tr><td>${h(prettyDate(c.date))}</td><td><form method="post" action="/payments/request" class="row"><input type="hidden" name="id" value="${c.id}"><input name="amount" type="number" min="1" step="0.01" placeholder="Amount $" required style="width:120px"><button class="ghost">Save request</button></form></td></tr>`).join('')}</table>` : ''}
${owed.length ? `<h2 style="margin-top:14px">Requested, not paid yet</h2><form method="post" action="/payments/paid"><table><tr><th></th><th>Cleaning</th><th>Amount</th></tr>${owedRows}</table>
<div class="row" style="margin-top:10px"><select name="method"><option>Venmo</option><option>Zelle</option><option>Cash</option><option>Check</option><option>Other</option></select><button>Mark selected paid</button></div></form>` : ''}
${recentPaid ? `<h2 style="margin-top:14px">Recently paid</h2><table>${recentPaid}</table>` : ''}</div>`);
}

export function morePage({ config, db, who }) {
  const outbox = db.prepare('SELECT * FROM outbox ORDER BY id DESC LIMIT 40').all();
  return layout('More', `${header({ config, db, who, active: 'more' })}
<div class="card"><h2>Calendar for Google, iCal and Skylight</h2><p>Subscribe to this address (Google Calendar: Other calendars, From URL):</p>
<p><code>${h(config.baseUrl)}/feed/${h(config.feedToken)}.ics</code></p><p class="muted">Only approved cleanings appear. Google refreshes subscribed calendars every few hours.</p></div>
<div class="card"><h2>Messages sent</h2><div class="scroll"><table><tr><th>When</th><th>To</th><th>Message</th><th>Status</th></tr>
${outbox.map(o => `<tr><td class="muted">${h(new Date(o.at).toLocaleString('en-US', { timeZone: config.timezone }))}</td><td>${h(o.channel === 'group' ? 'Group' : o.to_addr)}</td><td>${h(o.body)}</td><td>${h(o.status)}${o.error ? ` <span class="muted">${h(o.error.slice(0, 80))}</span>` : ''}</td></tr>`).join('')}
</table></div></div>`);
}
