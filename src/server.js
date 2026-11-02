import http from 'node:http';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { loadConfig } from './config.js';
import { openDb } from './db.js';
import { createNotifier } from './notify.js';
import { createService } from './service.js';
import { syncAirbnb } from './sync.js';
import { cleaningFeed } from './feed.js';
import { isDate, todayIn, prettyDate, localToUtc } from './dates.js';
import { layout, messagePage, approvalPage, groupDecisionPage, dashboard, notesPage, todosPage, cleaningPage, inboxPage, staysPage, paymentsPage, morePage } from './views.js';
import { createNotes, validTwilioSignature } from './notes.js';

export function createApp(config, deps = {}) {
  const db = deps.db || openDb(config);
  const notifier = deps.notifier || createNotifier(db, config, deps);
  const service = createService({ db, config, notifier });
  const notes = createNotes({ db, config });
  const sync = (opts = {}) => syncAirbnb({ db, config, service, fetchImpl: deps.fetchImpl, ...opts });

  const safeEq = (a, b) => {
    const x = Buffer.from(String(a)), y = Buffer.from(String(b));
    return x.length === y.length && crypto.timingSafeEqual(x, y);
  };

  function authed(req) {
    if (!config.adminPassword) return false;
    const m = (req.headers.authorization || '').match(/^Basic (.+)$/);
    if (!m) return false;
    const pass = Buffer.from(m[1], 'base64').toString().split(':').slice(1).join(':');
    return safeEq(pass, config.adminPassword);
  }

  const readBody = (req) => new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > 1e5) req.destroy(); });
    req.on('end', () => resolve(new URLSearchParams(data)));
    req.on('error', reject);
  });

  const cookie = (req, name) => (req.headers.cookie || '').split(';').map(s => s.trim().split('=')).find(([k]) => k === name)?.[1];

  function send(res, status, body, type = 'text/html; charset=utf-8', headers = {}) {
    res.writeHead(status, { 'Content-Type': type, 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer', ...headers });
    res.end(body);
  }
  const redirect = (res, to, headers = {}) => { res.writeHead(303, { Location: to, ...headers }); res.end(); };
  const wantsJson = (req) => (req.headers.accept || '').includes('application/json');
  const after = (req, res, to) => wantsJson(req) ? send(res, 200, JSON.stringify({ redirect: to }), 'application/json') : redirect(res, to);

  async function handle(req, res) {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;

    if (p === '/health') return send(res, 200, 'ok', 'text/plain');

    // Calendar feed (secret URL, no login so calendar apps can fetch it)
    let m = p.match(/^\/feed\/([^/]+)\.ics$/);
    if (m) {
      if (!config.feedToken || !safeEq(m[1], config.feedToken)) return send(res, 404, 'Not found', 'text/plain');
      return send(res, 200, cleaningFeed({ db, config, service }), 'text/calendar; charset=utf-8');
    }

    // Approval links sent by text/email
    m = p.match(/^\/a\/([\w-]+)$/);
    if (m) {
      const c = db.prepare('SELECT * FROM cleanings WHERE approval_token = ?').get(m[1]);
      if (req.method === 'GET') {
        if (!c) return send(res, 404, messagePage('Link expired', 'This cleaning was already handled or changed. Check the dashboard for the latest.'));
        return send(res, 200, approvalPage(c, service.describe, m[1], url.searchParams.get('by'), config.approvers));
      }
      const body = await readBody(req);
      const by = validName(body.get('by'));
      const r = body.get('action') === 'decline' ? await service.decline(m[1], by) : await service.approve(m[1], by);
      if (r.error) return send(res, 404, messagePage('Link expired', r.error));
      const done = r.cleaning.status === 'approved'
        ? `Approved by ${by}. The group text has been sent and it's on the shared calendar.`
        : `Declined by ${by}. Nothing was sent to the cleaner.`;
      return send(res, 200, messagePage('Thanks', done));
    }

    // "Should I text the group about this change?" links
    m = p.match(/^\/g\/([\w-]+)$/);
    if (m) {
      const gm = db.prepare('SELECT * FROM group_messages WHERE token = ?').get(m[1]);
      if (!gm) return send(res, 404, messagePage('Link expired', 'This message was replaced by a newer change.'));
      if (req.method === 'GET') {
        const c = service.get(gm.cleaning_id);
        const staying = !!db.prepare("SELECT 1 FROM bookings WHERE status='active' AND check_in < ? AND check_out > ?").get(c.date, c.date);
        return send(res, 200, groupDecisionPage(gm, c, url.searchParams.get('by') || cookie(req, 'who'), config.approvers, staying && !['cancelled', 'declined'].includes(c.status)));
      }
      const body = await readBody(req);
      const by = validName(body.get('by'));
      if (body.get('send') === 'test') {
        const t = await service.testGroupMessage(m[1], by, body.get('body'));
        const fresh = db.prepare('SELECT * FROM group_messages WHERE token = ?').get(m[1]);
        const c = service.get(fresh.cleaning_id);
        const staying = !!db.prepare("SELECT 1 FROM bookings WHERE status='active' AND check_in < ? AND check_out > ?").get(c.date, c.date);
        const note = t.error ? t.error
          : `Test sent only to ${t.to.name}${t.to.phone ? ` (${t.to.phone})` : ` by email`}.${t.dryRun ? ' Texting is still in test mode, so it was logged on the More tab instead of really sent.' : ''} The group got nothing.`;
        return send(res, 200, groupDecisionPage(fresh, c, by, config.approvers, staying && !['cancelled', 'declined'].includes(c.status), note));
      }
      const r = await service.decideGroupMessage(m[1], body.get('send') === '1', by, body.get('body'));
      if (r.error) return send(res, 404, messagePage('Link expired', r.error));
      const back = authed(req) ? '<p><a class="btn" href="/">Back to dashboard</a></p>' : '';
      return send(res, 200, messagePage('Done', r.message.status === 'sent' ? 'Sent to the group text.' : 'OK, nothing was sent to the group.', back));
    }

    // Texts coming in from Twilio: replies to the app's number, and group-thread messages.
    if (req.method === 'POST' && (p === '/twilio/sms' || p === '/twilio/conversation')) {
      const body = await readBody(req);
      if (!config.dryRun || config.twilio.token) {
        if (!validTwilioSignature(config.twilio.token, config.baseUrl + p, body, req.headers['x-twilio-signature'])) return send(res, 403, 'Bad signature', 'text/plain');
      }
      if (p === '/twilio/sms') {
        const from = body.get('From');
        const n = notes.add({ body: body.get('Body'), phone: from, source: 'sms' });
        // In "individual" mode there is no real group thread, so pass the text on to the others.
        if (n && config.groupMode !== 'conversation') {
          for (const person of config.groupMembers) {
            if (person.phone && person.phone.replace(/\D/g, '').slice(-10) !== (from || '').replace(/\D/g, '').slice(-10)) await notifier.sms(person.phone, `${n.author}: ${n.body}`);
          }
        }
        return send(res, 200, '<Response></Response>', 'text/xml');
      }
      // Conversations webhook (onMessageAdded). Skip the app's own messages.
      if (body.get('EventType') === 'onMessageAdded' && body.get('Author') !== 'cleaning-link') {
        const author = body.get('Author') || '';
        notes.add({ body: body.get('Body'), phone: author.startsWith('+') ? author : null, author: author.startsWith('+') ? null : author,
          at: body.get('DateCreated') ? new Date(body.get('DateCreated')).toISOString() : undefined, source: 'group' });
      }
      return send(res, 200, '', 'text/plain');
    }

    // Everything below needs the dashboard password.
    if (!authed(req)) return send(res, 401, 'Login required', 'text/plain', { 'WWW-Authenticate': 'Basic realm="Cleaning Link"' });
    const who = validName(decodeURIComponent(cookie(req, 'who') || ''));

    if (req.method === 'GET' && p === '/') {
      const month = /^\d{4}-\d{2}$/.test(url.searchParams.get('month') || '') ? url.searchParams.get('month') : todayIn(config.timezone).slice(0, 7);
      return send(res, 200, dashboard({ config, service, db, month, who, flash: url.searchParams.get('flash'), review: Number(url.searchParams.get('review')) || null }));
    }
    if (req.method === 'GET' && p === '/notes') return send(res, 200, notesPage({ config, db, who }));
    if (req.method === 'GET' && p === '/inbox') return send(res, 200, inboxPage({ config, service, db, who }));
    if (req.method === 'GET' && p === '/stays') return send(res, 200, staysPage({ config, service, db, who, flash: url.searchParams.get('flash') }));
    if (req.method === 'GET' && p === '/payments') return send(res, 200, paymentsPage({ config, db, who }));
    if (req.method === 'GET' && p === '/more') return send(res, 200, morePage({ config, db, who }));
    if (req.method === 'GET' && p === '/todos') return send(res, 200, todosPage({ config, db, who }));
    m = p.match(/^\/cleanings\/(\d+)$/);
    if (req.method === 'GET' && m) {
      const page = cleaningPage({ config, db, who, service, id: Number(m[1]) });
      return page ? send(res, 200, page) : send(res, 404, 'Not found', 'text/plain');
    }
    if (req.method !== 'POST') return send(res, 404, 'Not found', 'text/plain');
    const body = await readBody(req);

    if (p === '/who') {
      const back = req.headers.referer ? new URL(req.headers.referer).pathname : '/';
      return redirect(res, back, { 'Set-Cookie': `who=${encodeURIComponent(validName(body.get('name')))}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax` });
    }
    if (p === '/sync') {
      try {
        const r = await sync();
        return redirect(res, '/?flash=' + encodeURIComponent(r.skipped || `Airbnb checked: ${r.total} bookings, ${r.added} new cleanings proposed, ${r.covered || 0} already covered by a scheduled cleaning, ${r.moved} moved, ${r.cancelled} cancelled.${r.warning ? ' ' + r.warning : ''}`));
      } catch (e) { return redirect(res, '/?flash=' + encodeURIComponent('Could not read the Airbnb calendar: ' + e.message)); }
    }
    if (p === '/cleanings' && body.get('proposal')) {
      const c = service.get(Number(body.get('proposal')));
      if (!c) return redirect(res, '/?flash=' + encodeURIComponent('That cleaning no longer exists.'));
      const back = (msg) => redirect(res, `/?month=${c.date.slice(0, 7)}&flash=${encodeURIComponent(msg)}`);
      if (c.status !== 'awaiting_approval') return back(`The ${prettyDate(c.date)} cleaning was already ${c.status === 'declined' ? 'declined' : 'approved'}.`);
      if (body.get('action') === 'decline') {
        await service.decline(c.approval_token, who);
        return back(`Declined the ${prettyDate(c.date)} cleaning. Nothing was texted.`);
      }
      const r = await service.approveProposal(c.id, who, { alreadyArranged: body.get('arranged') === '1', note: (body.get('note') || '').trim().slice(0, 300) });
      if (r.message) return redirect(res, `/g/${r.message.token}?by=${encodeURIComponent(who)}`);
      return back(`Cleaning approved for ${prettyDate(c.date)}. Nothing was texted.`);
    }
    if (p === '/cleanings') {
      const date = body.get('date');
      if (!isDate(date)) return redirect(res, '/?flash=Pick+a+date');
      const r = await service.addManual(date, (body.get('note') || '').slice(0, 300), who, { alreadyArranged: body.get('arranged') === '1' });
      const extra = (r.replaced ? ` It replaces the ${prettyDate(r.replaced.date)} cleaning that was waiting for approval.` : '')
        + (r.conflict ? ` Heads up: a cleaning on ${prettyDate(r.conflict.date)} is already scheduled for this turnover.` : '');
      if (r.message) return redirect(res, `/g/${r.message.token}?by=${encodeURIComponent(who)}`);
      return redirect(res, `/?month=${date.slice(0, 7)}&flash=${encodeURIComponent(`Cleaning scheduled for ${prettyDate(date)}. Nothing was texted.${extra}`)}`);
    }
    m = p.match(/^\/cleanings\/(\d+)\/(move|cancel|message)$/);
    if (m) {
      const id = Number(m[1]);
      const c = service.get(id);
      if (!c) return send(res, 404, 'Not found', 'text/plain');
      let r;
      if (m[2] === 'move') {
        const date = body.get('date');
        if (!isDate(date)) return after(req, res, '/?flash=Pick+a+date');
        r = await service.move(id, date, who);
      } else if (m[2] === 'cancel') {
        r = await service.cancel(id, who);
      } else {
        const text = (body.get('body') || '').trim() || `Reminder: cleaning ${service.describe(c)}`;
        r = { message: await service.customGroupMessage(id, text, who) };
      }
      if (r.message) return after(req, res, `/g/${r.message.token}?by=${encodeURIComponent(who)}`);
      return after(req, res, `/?month=${service.get(id).date.slice(0, 7)}&flash=${encodeURIComponent(m[2] === 'move' ? `Moved to ${prettyDate(service.get(id).date)}. The group hadn't been told about it yet, so there was nothing to send.` : 'Done.')}`);
    }
    if (p === '/notes') {
      const at = body.get('at') ? localInputToIso(body.get('at')) : undefined;
      const cid = Number(body.get('cleaning_id')) || null;
      const n = notes.add({ body: body.get('body'), author: body.get('author') || who, at, source: 'manual', cleaningId: cid });
      const back = req.headers.referer && new URL(req.headers.referer).pathname.startsWith('/cleanings/') ? new URL(req.headers.referer).pathname : '/notes';
      return redirect(res, n ? back : '/notes');
    }
    m = p.match(/^\/notes\/(\d+)(\/followup)?$/);
    if (m) {
      if (m[2]) notes.setFollowup(Number(m[1]), body.get('status'));
      else notes.update(Number(m[1]), { cleaningId: Number(body.get('cleaning_id')) || null, tags: body.getAll('tag').filter(t => ['supplies', 'condition'].includes(t)), by: who });
      const ref = req.headers.referer ? new URL(req.headers.referer).pathname : '/notes';
      return redirect(res, ref);
    }
    if (p === '/todos') {
      notes.addTodo({ title: body.get('title'), by: who });
      return redirect(res, '/todos');
    }
    m = p.match(/^\/todos\/(\d+)$/);
    if (m) {
      notes.setTodo(Number(m[1]), body.get('done') === '1', who);
      return redirect(res, '/todos');
    }
    if (p === '/personal' || /^\/personal\/[\w-]+(\/delete)?$/.test(p)) {
      const uid = p.split('/')[2];
      const fields = { checkIn: body.get('check_in'), checkOut: body.get('check_out'), name: body.get('name'), by: who };
      if (!p.endsWith('/delete') && (!isDate(fields.checkIn) || !isDate(fields.checkOut))) return redirect(res, '/stays?flash=Pick+both+dates#personal');
      const r = p === '/personal' ? await service.addPersonalStay(fields)
        : p.endsWith('/delete') ? await service.removePersonalStay(uid, who)
        : await service.updatePersonalStay(uid, fields);
      if (r.error) return redirect(res, `/stays?flash=${encodeURIComponent(r.error)}#personal`);
      if (r.message) return redirect(res, `/g/${r.message.token}?by=${encodeURIComponent(who)}`);
      const clash = r.clash?.length ? ` Heads up: it overlaps ${r.clash.map(b => `${b.guest_name || 'a booking'} (${prettyDate(b.check_in)} to ${prettyDate(b.check_out)})`).join(', ')}.` : '';
      const msg = p.endsWith('/delete') ? 'Personal stay removed.'
        : `Personal stay saved.${r.cleaning ? ` A cleaning on ${prettyDate(r.cleaning.date)} is waiting for your OK under "Waiting on you".` : r.covering ? ` The ${prettyDate(r.covering.date)} cleaning already covers it.` : ''}${clash}`;
      const month = (fields.checkIn || '').slice(0, 7);
      return redirect(res, `/?${isDate(fields.checkIn) ? `month=${month}&` : ''}flash=${encodeURIComponent(msg)}`);
    }
    if (p === '/bookings/name') {
      db.prepare('UPDATE bookings SET guest_name = ? WHERE uid = ?').run((body.get('name') || '').trim().slice(0, 60) || null, body.get('uid') || '');
      return wantsJson(req) ? send(res, 200, JSON.stringify({ ok: true }), 'application/json') : redirect(res, '/stays');
    }
    if (p === '/payments/request') {
      const ok = service.recordPaymentRequest(Number(body.get('id')), body.get('amount'), who);
      return redirect(res, '/payments');
    }
    if (p === '/payments/paid') {
      service.markPaid(body.getAll('id').map(Number), body.get('method'), who);
      return redirect(res, '/payments');
    }
    return send(res, 404, 'Not found', 'text/plain');
  }

  // <input type="datetime-local"> gives wall-clock time at the rental
  function localInputToIso(v) {
    const mm = v.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/);
    return mm ? localToUtc(mm[1], mm[2], config.timezone).toISOString() : undefined;
  }

  function validName(n) {
    return config.approvers.find(a => a.name === n)?.name || config.approvers[0]?.name || 'Owner';
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch(err => { console.error(err); if (!res.headersSent) send(res, 500, layout('Error', '<p>Something went wrong.</p>')); });
  });

  let timer = null;
  function startBackground() {
    const tick = async () => {
      try { const r = await sync(); if (!r.skipped) console.log('Airbnb sync', r); } catch (e) { console.error('Airbnb sync failed:', e.message); }
      try { await service.autoComplete(); } catch (e) { console.error('Auto-complete failed:', e.message); }
    };
    tick();
    timer = setInterval(tick, Math.max(5, config.syncMinutes) * 60 * 1000);
  }
  const stop = () => { clearInterval(timer); server.close(); };

  return { server, db, service, notes, sync, notifier, startBackground, stop };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const config = loadConfig();
  if (!config.adminPassword || config.adminPassword === 'change-me') console.warn('Set ADMIN_PASSWORD in .env before putting this online.');
  const app = createApp(config);
  app.server.listen(config.port, () => {
    console.log(`Cleaning Link on ${config.baseUrl} (${config.dryRun ? 'test mode, no real texts' : 'live texting'})`);
    app.startBackground();
  });
}
