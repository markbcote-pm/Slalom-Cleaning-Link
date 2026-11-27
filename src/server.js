import http from 'node:http';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import fs from 'node:fs';
import { loadConfig } from './config.js';
import { openDb } from './db.js';
import { createNotifier, twilioHint } from './notify.js';
import { createService } from './service.js';
import { syncAirbnb } from './sync.js';
import { cleaningFeed } from './feed.js';
import { isDate, todayIn, prettyDate, localToUtc } from './dates.js';
import { layout, messagePage, approvalPage, groupDecisionPage, dashboard, notesPage, todosPage, cleaningPage, inboxPage, staysPage, paymentsCsv, morePage, loginPage, shareInPage, shareTextPage, guestPhotosPage } from './views.js';
import { createNotes, validTwilioSignature } from './notes.js';
import { createPush, SERVICE_WORKER } from './push.js';
import { createFinance, financeRoutes, readForm, sniff } from './finance.js';
import { createTextPay } from './textpay.js';
import { createPhotos } from './photos.js';
import { createPhoneInbox, inboundFields } from './phone.js';
import { liveStamp } from './live.js';
import { smsInfoPage, privacyPage, termsPage, confirmationText, joinPage } from './policy.js';

const ASSETS = {
  '/icon.svg': ['icon.svg', 'image/svg+xml'], '/favicon.ico': ['icon-192.png', 'image/png'],
  '/apple-touch-icon.png': ['apple-touch-icon.png', 'image/png'], '/icon-192.png': ['icon-192.png', 'image/png'],
  '/sms-optin-screenshot.png': ['sms-optin-screenshot.png', 'image/png'],
  '/icon-512.png': ['icon-512.png', 'image/png'], '/icon-maskable.png': ['icon-maskable.png', 'image/png'],
};

export function createApp(config, deps = {}) {
  const db = deps.db || openDb(config);
  const push = deps.push || createPush({ db, config, fetchImpl: deps.fetchImpl });
  // When a text doesn't go through, tell the owners' phones (at most once every 30 minutes).
  let lastTextProblem = 0;
  const textProblem = async ({ to, error }) => {
    if (Date.now() - lastTextProblem < 30 * 60e3) return;
    lastTextProblem = Date.now();
    const who = config.groupMembers.find(x => x.phone && x.phone.replace(/\D/g, '').slice(-10) === String(to).replace(/\D/g, '').slice(-10))?.name || to;
    try { await push.send({ title: 'A text did not go through', body: `Text to ${who}: ${error} See More > Messages sent.`, url: '/more#texting' }); } catch {}
  };
  const notifier = deps.notifier || createNotifier(db, config, { onProblem: textProblem, ...deps });
  const service = createService({ db, config, notifier });
  const notes = createNotes({ db, config });
  const cleanerName = config.cleaner?.name || 'The cleaner';
  const quietly = (p) => { Promise.resolve(p).catch(e => console.error('Notification failed:', e.message)); };
  const textPay = createTextPay({ db, config, service,
    onUnclear: (m) => quietly(push.send({ title: 'Which cleaning was this for?', body: `${m.author}: ${m.body}`.slice(0, 180), url: '/' })),
    onCleaned: (c) => quietly(push.send({ title: `${cleanerName} finished the ${prettyDate(c.date)} cleaning`, body: 'To keep her photos for the next guest: in Messages, select them, tap Share, pick Cleaning.', url: `/cleanings/${c.id}` })) });
  service.hooks.suggested = (r) => quietly(push.send(r.moved
    ? { title: `${cleanerName} moved the cleaning to ${prettyDate(r.to)}`, body: `She can't do ${prettyDate(r.from)}. ${prettyDate(r.to)} fits before the next guests, so the calendar is updated.`, url: `/cleanings/${r.cleaning.id}` }
    : { title: `${cleanerName} suggested ${prettyDate(r.to)}, which doesn't fit`, body: `Not moved: ${r.why}. The cleaning is still ${prettyDate(r.from)}.`, url: `/cleanings/${r.cleaning.id}` }));
  const photos = createPhotos({ db, config });
  const phoneInbox = createPhoneInbox({ db, config, notes, service, onNote: (n) => textPay.handle(n), clock: deps.clock || (() => Date.now()) });
  const fin = createFinance({ db, config });
  const financeRoute = financeRoutes({ db, config, fin });
  const sync = async (opts = {}) => {
    const r = await syncAirbnb({ db, config, service, fetchImpl: deps.fetchImpl, ...opts });
    if (r.newBookings?.length || r.changed?.length || r.cancelledBookings?.length) {
      try { await push.bookingNews(r); } catch (e) { console.error('Booking notification failed:', e.message); }
    }
    return r;
  };

  const safeEq = (a, b) => {
    const x = Buffer.from(String(a)), y = Buffer.from(String(b));
    return x.length === y.length && crypto.timingSafeEqual(x, y);
  };

  // Signed-in devices carry a cookie "<expiry>.<signature>". The signature is keyed on the
  // password, so changing ADMIN_PASSWORD in Render signs every device out.
  const SESSION = 'cl_session';
  const sign = (exp) => crypto.createHmac('sha256', 'cleaning-link:' + config.adminPassword).update(String(exp)).digest('base64url');
  const sessionCookie = (remember) => {
    const exp = Date.now() + (remember ? 365 : 1) * 86400e3;
    const secure = (config.baseUrl || '').startsWith('https:') ? '; Secure' : '';
    return `${SESSION}=${exp}.${sign(exp)}; Path=/; HttpOnly; SameSite=Lax${secure}${remember ? '; Max-Age=31536000' : ''}`;
  };
  function authed(req) {
    if (!config.adminPassword) return false;
    const [exp, sig] = (cookie(req, SESSION) || '').split('.');
    if (exp && sig && Number(exp) > Date.now() && safeEq(sig, sign(exp))) return true;
    const m = (req.headers.authorization || '').match(/^Basic (.+)$/);
    if (!m) return false;
    const pass = Buffer.from(m[1], 'base64').toString().split(':').slice(1).join(':');
    return safeEq(pass, config.adminPassword);
  }
  // A simple password needs a brake on guessing: 10 wrong tries locks that address out for 15 minutes.
  const failures = new Map();
  const clientIp = (req) => String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  const lockedOut = (ip) => { const f = failures.get(ip); return f && f.count >= 10 && Date.now() - f.first < 15 * 60e3; };
  const noteFailure = (ip) => {
    const f = failures.get(ip);
    if (!f || Date.now() - f.first >= 15 * 60e3) failures.set(ip, { count: 1, first: Date.now() }); else f.count++;
  };
  const joins = new Map();
  const joinTries = (ip) => { const now = Date.now(), j = (joins.get(ip) || []).filter(t => now - t < 3600e3); j.push(now); joins.set(ip, j); return j.length; };
  // Who paid the cleaner: one of the owners, or nobody recorded.
  const payer = (v) => config.approvers.find(a => a.name === v)?.name || null;
  const safeNext = (n) => /^\/(?!\/)[^\s]*$/.test(n || '') && !n.startsWith('/login') ? n : '/';

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

  // Where to decide on a drafted group text: a dialog over that cleaning's month.
  const msgUrl = (tok, extra = '') => {
    const gm = db.prepare('SELECT g.token, c.date FROM group_messages g JOIN cleanings c ON c.id = g.cleaning_id WHERE g.token = ?').get(tok);
    return gm ? `/?month=${gm.date.slice(0, 7)}&msg=${gm.token}${extra}` : '/inbox';
  };

  async function handle(req, res) {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;

    if (p === '/health') return send(res, 200, 'ok', 'text/plain');
    // Public pages for carrier registration (no login).
    if (req.method === 'GET' && p === '/sms') return send(res, 200, smsInfoPage(config));
    if (req.method === 'GET' && p === '/privacy') return send(res, 200, privacyPage(config));
    if (req.method === 'GET' && (p === '/terms' || p === '/sms-terms')) return send(res, 200, termsPage(config));
    if (p === '/join' && req.method === 'GET') return send(res, 200, joinPage(config));
    if (p === '/join' && req.method === 'POST') {
      const b = await readBody(req);
      const name = (b.get('name') || '').trim().slice(0, 60), phone = (b.get('phone') || '').trim().slice(0, 30);
      const digits = phone.replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '');
      const again = (error) => send(res, 400, joinPage(config, { error, name, phone, sms: b.get('consent') === 'yes' }));
      const sms = b.get('consent') === 'yes';
      if (!name || digits.length !== 10) return again('Please enter your name and a 10-digit US mobile number.');
      const ip = clientIp(req);
      if (joinTries(ip) > 10) return send(res, 429, joinPage(config, { error: 'Too many sign-ups from here. Try again later.', name, phone }));
      const member = config.groupMembers.find(x => x.phone && x.phone.replace(/\D/g, '').slice(-10) === digits);
      db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
        .run('consent:' + digits, JSON.stringify({ at: new Date().toISOString(), by: 'web form', method: 'web form', name, member: member?.name || null, sms }));
      // Only people the owners have set up get the confirmation text; anyone else is just recorded,
      // so the form can't be used to send texts to strangers. Either way the owners hear about it.
      let sent = false, why = '';
      if (member && sms) {
        const r = await notifier.sms(member.phone, confirmationText(config));
        sent = !!r?.sid;
        if (!sent) {
          const last = db.prepare("SELECT status, error FROM outbox WHERE channel='sms' ORDER BY id DESC LIMIT 1").get();
          why = last?.status === 'held' ? `${member.phone} isn't in SMS_ONLY_TO in Render, so the safety switch held it.`
            : last?.status === 'dry_run' ? `texting is in test mode (${!config.twilio.sid ? 'TWILIO_ACCOUNT_SID is missing' : 'DRY_RUN is not 0'} in Render).`
            : `Twilio refused it: ${twilioHint(last?.error)}`;
        }
      }
      try {
        await push.send({ title: `${name} signed up for texts`, url: '/more#texting',
          body: !sms ? `${phone}${member ? ` (${member.name})` : ''} joined without agreeing to texts, so the app won't text that number.`
            : !member ? `From ${phone}. That number isn't in APPROVERS or CLEANER in Render, so no confirmation text was sent.`
            : sent ? `Confirmation text sent to ${member.name} at ${member.phone}.`
            : `No confirmation text went out: ${why}` });
      } catch {}
      return send(res, 200, joinPage(config, { done: !sms
        ? `Thanks, ${name}. You're on the cleaning schedule list. You won't get any texts. If you change your mind, fill in this form again and tick the box.`
        : member
        ? (sent ? `Thanks, ${name}. A confirmation text is on its way to ${phone}. Reply STOP at any time to stop.`
          : `Thanks, ${name}. Your sign-up is recorded. The confirmation text couldn't be sent just now; the owners have been told and will sort it out.`)
        : `Thanks, ${name}. Your sign-up is recorded. You'll start getting texts once the owners add you to the cleaning schedule.` }));
    }

    // Logo, app icons and the home-screen manifest (public, so phones can fetch them).
    if (req.method === 'GET' && ASSETS[p]) {
      const [file, type] = ASSETS[p];
      return send(res, 200, fs.readFileSync(new URL('../public/' + file, import.meta.url)), type, { 'Cache-Control': 'public, max-age=86400' });
    }
    if (req.method === 'GET' && p === '/sw.js') return send(res, 200, SERVICE_WORKER, 'text/javascript; charset=utf-8', { 'Cache-Control': 'no-cache' });
    if (req.method === 'GET' && p === '/manifest.webmanifest') {
      return send(res, 200, JSON.stringify({
        name: 'Cleaning Link', short_name: 'Cleaning', start_url: '/', display: 'standalone',
        background_color: '#f7f6f3', theme_color: '#2f6f5e',
        icons: [{ src: '/icon-192.png', sizes: '192x192', type: 'image/png' }, { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: '/icon-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }, { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml' }],
        // Lets "Share" in Messages or Photos send pictures straight to the app (Android, installed app).
        share_target: { action: '/share-photos', method: 'POST', enctype: 'multipart/form-data', params: { title: 'title', text: 'text', files: [{ name: 'photos', accept: ['image/*'] }] } },
      }), 'application/manifest+json');
    }

    // Calendar feed (secret URL, no login so calendar apps can fetch it)
    let m = p.match(/^\/feed\/(.+)\.ics$/);
    if (m) {
      let given = m[1];
      try { given = decodeURIComponent(given); } catch {}
      if (!config.feedToken || !(safeEq(given, config.feedId) || safeEq(given, config.feedToken))) return send(res, 404, 'Not found', 'text/plain');
      const only = ['stays', 'cleanings'].includes(url.searchParams.get('only')) ? url.searchParams.get('only') : '';
      return send(res, 200, cleaningFeed({ db, config, service, only }), 'text/calendar; charset=utf-8');
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
      // Phone mode: approving leaves the group text waiting; the next page shares it from this phone.
      if (config.groupMode === 'phone' && r.cleaning.status === 'approved' && !r.already) {
        const gm = db.prepare("SELECT token FROM group_messages WHERE cleaning_id = ? AND status = 'pending' ORDER BY id DESC").get(r.cleaning.id);
        if (gm) return redirect(res, `/g/${gm.token}?by=${encodeURIComponent(by)}`);
      }
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
        return send(res, 200, groupDecisionPage(gm, c, url.searchParams.get('by') || cookie(req, 'who'), config.approvers, staying && !['cancelled', 'declined'].includes(c.status), '', config.groupMode === 'phone'));
      }
      const body = await readBody(req);
      const by = validName(body.get('by'));
      const inApp = authed(req);
      // Phone mode: a text marked sent that never reached the group goes back to waiting.
      if (body.get('send') === 'unsend' && inApp) {
        const u = service.unsendGroupMessage(m[1], by);
        if (u.error) return redirect(res, '/?flash=' + encodeURIComponent(u.error));
        return redirect(res, msgUrl(m[1], `&msgnote=${encodeURIComponent('Back to waiting. Tap Share to the group on your phone to send it.')}`));
      }
      // Phone mode: only a share made on a phone counts as sending (the page's script adds shared=1).
      if (config.groupMode === 'phone' && body.get('send') === '1' && body.get('shared') !== '1') {
        const note = 'Group texts go out from your phone. Open Cleaning on your phone and tap Share to the group. This one is still waiting.';
        return inApp ? redirect(res, msgUrl(m[1], `&msgnote=${encodeURIComponent(note)}`)) : send(res, 409, messagePage('Not sent yet', note));
      }
      if (body.get('send') === 'undo') {
        const u = service.undoSkip(m[1], by);
        if (u.error) return send(res, 409, messagePage('Can\'t undo', u.error, inApp ? '<p><a class="btn" href="/inbox">Waiting on you</a></p>' : ''));
        return redirect(res, inApp ? msgUrl(m[1]) : `/g/${m[1]}?by=${encodeURIComponent(by)}`);
      }
      if (inApp && body.get('ui') === 'dialog') {
        if (body.get('send') === 'test') {
          const t = await service.testGroupMessage(m[1], by, body.get('body'));
          const note = t.error || `Test sent only to ${t.to.name}.${t.dryRun ? ' Texting is in test mode, so it was logged on the More tab instead.' : ''} The group got nothing.`;
          return redirect(res, msgUrl(m[1], `&msgnote=${encodeURIComponent(note)}`));
        }
        const r = await service.decideGroupMessage(m[1], body.get('send') === '1', by, body.get('body'));
        if (r.error) return redirect(res, '/?flash=' + encodeURIComponent(r.error));
        if (body.get('js') === '1') return send(res, 200, JSON.stringify({ ok: true, status: r.message.status }), 'application/json');
        const month = msgUrl(m[1]).match(/month=([\d-]+)/)?.[1] || '';
        const msg = r.already ? 'That text was already decided.' : r.message.status === 'sent' ? 'Sent to the group text.' : 'Not sent. To change your mind, use Undo under Waiting on you, Recently cleared.';
        return redirect(res, `/?month=${month}&flash=${encodeURIComponent(msg)}`);
      }
      if (body.get('send') === 'test') {
        const t = await service.testGroupMessage(m[1], by, body.get('body'));
        const fresh = db.prepare('SELECT * FROM group_messages WHERE token = ?').get(m[1]);
        const c = service.get(fresh.cleaning_id);
        const staying = !!db.prepare("SELECT 1 FROM bookings WHERE status='active' AND check_in < ? AND check_out > ?").get(c.date, c.date);
        const note = t.error ? t.error
          : `Test sent only to ${t.to.name}${t.to.phone ? ` (${t.to.phone})` : ` by email`}.${t.dryRun ? ' Texting is still in test mode, so it was logged on the More tab instead of really sent.' : ''} The group got nothing.`;
        return send(res, 200, groupDecisionPage(fresh, c, by, config.approvers, staying && !['cancelled', 'declined'].includes(c.status), note, config.groupMode === 'phone'));
      }
      const r = await service.decideGroupMessage(m[1], body.get('send') === '1', by, body.get('body'));
      if (r.error) return send(res, 404, messagePage('Link expired', r.error));
      if (body.get('js') === '1') return send(res, 200, JSON.stringify({ ok: true, status: r.message.status }), 'application/json');
      const back = authed(req) ? '<p><a class="btn" href="/">Back to dashboard</a></p>' : '';
      const undo = r.message.status === 'skipped' && !r.already
        ? `<form method="post" style="margin-bottom:10px"><input type="hidden" name="by" value="${by.replace(/"/g, '&quot;')}"><button class="ghost" name="send" value="undo">Undo, bring the message back</button></form>` : '';
      return send(res, 200, messagePage('Done', r.message.status === 'sent' ? 'Sent to the group text.' : 'OK, nothing was sent to the group.', undo + back));
    }

    // Photos shared in from another app. They wait in a holding area until someone signed in
    // picks the cleaning (the share can arrive without the sign-in cookie).
    if (p === '/share-photos' && req.method === 'POST') {
      let form;
      try { form = await readForm(req); } catch (e) { return send(res, 413, messagePage('Too big', 'That was more than the app can take at once. Try fewer photos.')); }
      const t = photos.hold(form.files);
      // A text message shared in (one the phone didn't forward, e.g. the chat was open on screen).
      const sharedText = [form.get('text'), form.get('title')].find(x => x && x.trim());
      if (!t && sharedText) return redirect(res, `/share-text?text=${encodeURIComponent(sharedText.trim().slice(0, 2000))}`);
      if (!t) return send(res, 400, messagePage('No photos', 'Nothing in that share was a photo the app can keep (JPEG, PNG, WebP or HEIC).'));
      return redirect(res, `/share-photos/${t}`);
    }
    // The guest's link: just this cleaning's photos.
    m = p.match(/^\/p\/([a-f0-9]+)(?:\/(\d+))?$/);
    if (m && req.method === 'GET') {
      const c = photos.byToken(m[1]);
      if (!c) return send(res, 404, messagePage('Not found', 'This link is not valid.'));
      if (m[2]) {
        const ph = photos.get(Number(m[2]));
        if (!ph || ph.cleaning_id !== c.id) return send(res, 404, 'Not found', 'text/plain');
        return send(res, 200, photos.read(ph), ph.mime, { 'Cache-Control': 'private, max-age=86400' });
      }
      return send(res, 200, guestPhotosPage({ config, cleaning: c, photos: photos.list(c.id), base: `/p/${m[1]}` }));
    }

    // GROUP_MODE=phone: the phone forwards each group-text notification here (MacroDroid/Tasker).
    if (p === '/phone/inbound' && (req.method === 'POST' || req.method === 'GET')) {
      if (!config.phone.key || !safeEq(url.searchParams.get('key') || '', config.phone.key)) return send(res, 403, JSON.stringify({ error: 'bad key' }), 'application/json');
      let raw = '';
      if (req.method === 'POST') raw = await new Promise((resolve, reject) => { let d = ''; req.on('data', c => { d += c; if (d.length > 1e5) req.destroy(); }); req.on('end', () => resolve(d)); req.on('error', reject); });
      let json = null;
      if (/^\s*\{/.test(raw)) { try { json = JSON.parse(raw); } catch {} }
      const params = new URLSearchParams(json ? '' : raw);
      for (const [k, v] of url.searchParams) if (k !== 'key' && !params.has(k)) params.set(k, v);
      return send(res, 200, JSON.stringify(phoneInbox.receive(inboundFields(params, json))), 'application/json');
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
        if (n) { service.cleanerReply({ body: n.body, phone: from }); textPay.handle(n); }
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
        const gn = notes.add({ body: body.get('Body'), phone: author.startsWith('+') ? author : null, author: author.startsWith('+') ? null : author,
          at: body.get('DateCreated') ? new Date(body.get('DateCreated')).toISOString() : undefined, source: 'group' });
        textPay.handle(gn);
        service.cleanerReply({ body: body.get('Body'), phone: author.startsWith('+') ? author : null, author: author.startsWith('+') ? null : author });
      }
      return send(res, 200, '', 'text/plain');
    }

    // Everything below needs the dashboard password.
    if (p === '/login') {
      if (req.method === 'POST') {
        const b = await readBody(req);
        const ip = clientIp(req);
        const next = safeNext(b.get('next'));
        if (lockedOut(ip)) return send(res, 429, loginPage({ next, error: 'Too many wrong tries. Wait 15 minutes and try again.' }));
        if (!config.adminPassword || !safeEq(b.get('password') || '', config.adminPassword)) {
          noteFailure(ip);
          return send(res, 401, loginPage({ next, error: config.adminPassword ? "That password didn't match." : 'No password is set yet. Add ADMIN_PASSWORD in Render.', remember: b.get('remember') === '1' }));
        }
        failures.delete(ip);
        return redirect(res, next, { 'Set-Cookie': sessionCookie(b.get('remember') === '1') });
      }
      if (authed(req)) return redirect(res, safeNext(url.searchParams.get('next')));
      return send(res, 200, loginPage({ next: safeNext(url.searchParams.get('next')) }));
    }
    if (p === '/logout' && req.method === 'POST') return redirect(res, '/login', { 'Set-Cookie': `${SESSION}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0` });
    if (!authed(req)) {
      if (req.method === 'GET' && !wantsJson(req)) return redirect(res, '/login' + (p === '/' && !url.search ? '' : '?next=' + encodeURIComponent(p + url.search)));
      return send(res, 401, 'Login required', 'text/plain');
    }
    // Signed-in pages check this every few seconds and refresh when the data changes.
    if (p === '/live') return send(res, 200, JSON.stringify({ v: liveStamp(db) }), 'application/json', { 'Cache-Control': 'no-store' });
    const who = validName(decodeURIComponent(cookie(req, 'who') || ''));
    // Keep "Waiting on you" honest: clear proposals already covered by a confirmed cleaning.
    if (req.method === 'GET' && ['/', '/inbox', '/stays'].includes(p)) service.dropCoveredProposals(who || 'the app');
    // Income, expenses, receipts and the CPA package (reads its own form bodies, including photo uploads).
    if (await financeRoute({ req, res, p, url, who, send, redirect })) return;

    // ---- Photos and unclear payment texts ----
    m = p.match(/^\/share-photos\/([a-f0-9]{24})(?:\/(\d+))?$/);
    if (m) {
      if (req.method === 'GET' && m[2] != null) {
        const f = photos.held(m[1])?.find(x => x.n === m[2]);
        return f ? send(res, 200, f.data, sniff(f.data)?.[0] || 'application/octet-stream', { 'Cache-Control': 'no-store' }) : send(res, 404, 'Not found', 'text/plain');
      }
      if (req.method === 'GET') {
        const files = photos.held(m[1]);
        if (!files) return send(res, 404, messagePage('Already saved', 'These photos were already saved or the share expired. Share them again from Messages.', '<p><a class="btn" href="/">Back to the calendar</a></p>'));
        return send(res, 200, shareInPage({ config, db, who, token: m[1], count: files.length, likely: photos.likelyCleaning(), cleanings: photos.recentCleanings() }));
      }
      const body = await readBody(req);
      if (body.get('discard') === '1') { photos.discard(m[1]); return redirect(res, '/?flash=' + encodeURIComponent('Photos not saved.')); }
      const cid = Number(body.get('cleaning_id'));
      if (!service.get(cid)) return redirect(res, `/share-photos/${m[1]}`);
      const ids = photos.claim(m[1], cid, who || 'Owner');
      return redirect(res, ids ? `/cleanings/${cid}#photos` : '/');
    }
    m = p.match(/^\/photos\/(\d+)(\/delete)?$/);
    if (m) {
      const ph = photos.get(Number(m[1]));
      if (!ph) return send(res, 404, 'Not found', 'text/plain');
      if (req.method === 'GET' && !m[2]) return send(res, 200, photos.read(ph), ph.mime, { 'Cache-Control': 'private, max-age=86400' });
      if (req.method === 'POST' && m[2]) { photos.remove(ph.id); return redirect(res, `/cleanings/${ph.cleaning_id}#photos`); }
    }
    m = p.match(/^\/cleanings\/(\d+)\/photos$/);
    if (m && req.method === 'POST') {
      const id = Number(m[1]);
      if (!service.get(id)) return send(res, 404, 'Not found', 'text/plain');
      let form;
      try { form = await readForm(req); } catch { return send(res, 413, 'Too many photos at once. Try fewer.', 'text/plain'); }
      photos.add(id, form.files, who || 'Owner');
      return redirect(res, `/cleanings/${id}#photos`);
    }
    // Save a group text that was shared in by hand, as if the phone had forwarded it.
    if (p === '/share-text') {
      if (req.method === 'GET') return send(res, 200, shareTextPage({ config, db, who, text: url.searchParams.get('text') || '' }));
      const body = await readBody(req);
      const person = config.groupMembers.find(x => x.name === body.get('author'));
      const r = person ? phoneInbox.ingest({ body: body.get('body'), author: person.name, phone: person.phone }) : { saved: false };
      const msg = r.reason === 'duplicate' ? 'That text was already saved.' : !r.saved ? 'Nothing saved.' : r.confirmed?.length ? `Saved, and ${person.name} confirmed ${r.confirmed.join(', ')}.`
        : r.payment === 'done' && r.matched ? 'Saved, and the cleaning was marked cleaned.' : r.payment === 'paid' && r.matched ? 'Saved, and marked paid.'
        : r.unclear ? 'Saved. The app will ask which cleaning it was about.' : 'Saved to Notes.';
      return redirect(res, '/?flash=' + encodeURIComponent(msg));
    }
    m = p.match(/^\/text-matches\/(\d+)$/);
    if (m && req.method === 'POST') {
      const body = await readBody(req);
      const r = textPay.resolve(Number(m[1]), { cleaningIds: body.get('skip') === '1' ? [] : [...new Set(body.getAll('cleaning_id').map(v => Number(v === 'other' ? body.get('other_id') : v)))].filter(id => service.get(id)),
        amount: body.get('amount'), method: body.get('method'), by: who || 'Owner' });
      const msg = r.error || (r.dismissed ? 'OK, that text is not about a cleaning.' : 'Saved to the tracker.');
      return redirect(res, '/?flash=' + encodeURIComponent(msg));
    }

    if (req.method === 'GET' && p === '/') {
      const month = /^\d{4}-\d{2}$/.test(url.searchParams.get('month') || '') ? url.searchParams.get('month') : todayIn(config.timezone).slice(0, 7);
      return send(res, 200, dashboard({ config, service, db, month, who, flash: url.searchParams.get('flash'), review: Number(url.searchParams.get('review')) || null, msg: url.searchParams.get('msg'), msgnote: url.searchParams.get('msgnote'), textPay }));
    }
    if (req.method === 'GET' && p === '/notes') return send(res, 200, notesPage({ config, db, who }));
    if (req.method === 'GET' && p === '/inbox') return send(res, 200, inboxPage({ config, service, db, who }));
    if (req.method === 'GET' && p === '/stays') return send(res, 200, staysPage({ config, service, db, who, flash: url.searchParams.get('flash') }));
    if (req.method === 'GET' && p === '/payments.csv') {
      const year = /^\d{4}$/.test(url.searchParams.get('year') || '') ? url.searchParams.get('year') : todayIn(config.timezone).slice(0, 4);
      return send(res, 200, paymentsCsv(db, config, year), 'text/csv; charset=utf-8', { 'Content-Disposition': `attachment; filename="cleaning-payments-${year}.csv"` });
    }
    if (req.method === 'GET' && p === '/more') return send(res, 200, morePage({ config, db, who, flash: url.searchParams.get('flash'), push, phoneInbox }));
    if (req.method === 'GET' && p === '/todos') return send(res, 200, todosPage({ config, db, who }));
    m = p.match(/^\/cleanings\/(\d+)$/);
    if (req.method === 'GET' && m) {
      const page = cleaningPage({ config, db, who, service, id: Number(m[1]), receipts: fin.receiptsForCleaning(Number(m[1])), photos: photos.list(Number(m[1])), photosLink: `${config.baseUrl}/p/${photos.shareToken(Number(m[1]))}`, flash: url.searchParams.get('flash') });
      return page ? send(res, 200, page) : send(res, 404, 'Not found', 'text/plain');
    }
    if (req.method !== 'POST') return send(res, 404, 'Not found', 'text/plain');
    const body = await readBody(req);

    if (p === '/push/subscribe') {
      let sub = null; try { sub = JSON.parse(body.get('sub') || ''); } catch {}
      return push.subscribe(sub, who || 'someone') ? send(res, 200, '{"ok":true}', 'application/json') : send(res, 400, '{"ok":false}', 'application/json');
    }
    if (p === '/push/unsubscribe') { push.unsubscribe(body.get('endpoint') || ''); return send(res, 200, '{"ok":true}', 'application/json'); }
    if (p === '/push/test') {
      const items = push.unsettled();
      const r = await push.send({ title: 'Cleaning Link test', body: items.length ? `Right now: ${items[0].text}${items.length > 1 ? ` (+${items.length - 1} more)` : ''}` : 'Notifications work. Nothing in the next 7 days needs you.', url: '/inbox' });
      const ok = r.filter(x => x.ok).length;
      return redirect(res, '/more?flash=' + encodeURIComponent(!r.length ? 'No phones have notifications turned on yet.' : `Test notification sent to ${ok} of ${r.length} device${r.length === 1 ? '' : 's'}.${ok < r.length ? ' One or more failed; turn notifications off and on again on that phone.' : ''}`) + '#push');
    }
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
      const back = (msg) => redirect(res, body.get('back') === 'cleaning' ? `/cleanings/${c.id}?flash=${encodeURIComponent(msg)}` : `/?month=${c.date.slice(0, 7)}&flash=${encodeURIComponent(msg)}`);
      if (c.status !== 'awaiting_approval') return back(`The ${prettyDate(c.date)} cleaning was already ${c.status === 'declined' ? 'declined' : 'approved'}.`);
      if (body.get('action') === 'decline') {
        await service.decline(c.approval_token, who);
        return back(`Declined the ${prettyDate(c.date)} cleaning. Nothing was texted.`);
      }
      const r = await service.approveProposal(c.id, who, { alreadyArranged: body.get('arranged') === '1', note: (body.get('note') || '').trim().slice(0, 300) });
      if (r.message) return redirect(res, msgUrl(r.message.token));
      return back(`Cleaning approved for ${prettyDate(c.date)}. Nothing was texted.`);
    }
    if (p === '/cleanings') {
      const date = body.get('date');
      if (!isDate(date)) return redirect(res, '/?flash=Pick+a+date');
      const r = await service.addManual(date, (body.get('note') || '').slice(0, 300), who, { alreadyArranged: body.get('arranged') === '1' });
      const extra = (r.replaced ? ` It replaces the ${prettyDate(r.replaced.date)} cleaning that was waiting for approval.` : '')
        + (r.conflict ? ` Heads up: a cleaning on ${prettyDate(r.conflict.date)} is already scheduled for this turnover.` : '');
      if (r.message) return redirect(res, msgUrl(r.message.token));
      return redirect(res, `/?month=${date.slice(0, 7)}&flash=${encodeURIComponent(`Cleaning scheduled for ${prettyDate(date)}. Nothing was texted.${extra}`)}`);
    }
    if (p === '/texting/consent') {
      const person = config.groupMembers.find(x => x.phone && x.phone === body.get('phone'));
      const back = (msg) => redirect(res, `/more?flash=${encodeURIComponent(msg)}#texting`);
      if (!person) return back('That number is not in the group.');
      const key = 'consent:' + person.phone.replace(/\D/g, '').slice(-10);
      db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
        .run(key, JSON.stringify({ at: new Date().toISOString(), by: who, name: person.name }));
      await notifier.sms(person.phone, confirmationText(config));
      const last = db.prepare("SELECT status FROM outbox WHERE channel='sms' ORDER BY id DESC LIMIT 1").get();
      return back(`Consent recorded for ${person.name}. Confirmation text ${last?.status === 'sent' ? 'sent' : last?.status === 'held' ? 'held by the safety switch' : 'logged (test mode)'}.`);
    }
    if (p === '/texting/test') {
      const me = config.approvers.find(a => a.name === who);
      const back = (msg) => redirect(res, `/more?flash=${encodeURIComponent(msg)}#texting`);
      if (config.dryRun) return back('Texting is in test mode (DRY_RUN), so nothing was sent.');
      if (!me?.phone) return back(`No phone number on file for ${who}.`);
      const r = await notifier.sms(me.phone, `Cleaning Link test text for ${me.name}. If you got this, texting works.`);
      if (!r?.sid) {
        const last = db.prepare("SELECT status, error FROM outbox WHERE channel='sms' ORDER BY id DESC LIMIT 1").get();
        return back(last?.status === 'held' ? `Held: ${me.phone} isn't in SMS_ONLY_TO.` : `Twilio refused it: ${twilioHint(last?.error)}`);
      }
      // Carriers can reject a text after Twilio accepts it, so look again a few seconds later.
      let st = r;
      for (let i = 0; i < 4 && ['queued', 'accepted', 'sending'].includes(st.status); i++) {
        await new Promise(ok => setTimeout(ok, deps.testPollMs ?? 2000));
        try { st = await notifier.smsStatus(r.sid); } catch { break; }
      }
      if (st.error_code) return back(`Twilio accepted it but it failed (${st.status}): ${twilioHint(`code ${st.error_code}`)}`);
      return back(st.status === 'delivered' ? `Delivered to ${me.phone}. Texting works.` : `Twilio says "${st.status}". It should arrive shortly; if not, check the Messages sent list below.`);
    }
    m = p.match(/^\/cleanings\/(\d+)\/(confirm|unconfirm)$/);
    if (m) {
      const r = service.confirmByCleaner(Number(m[1]), who, m[2] === 'confirm');
      const back = body.get('back') === 'inbox' ? '/inbox' : `/cleanings/${m[1]}`;
      return redirect(res, r.error ? `/cleanings/${m[1]}` : back);
    }
    m = p.match(/^\/cleanings\/(\d+)\/delete$/);
    if (m) {
      const id = Number(m[1]);
      for (const ph of photos.list(id)) photos.remove(ph.id);
      const r = service.remove(id);
      if (r.error) return redirect(res, `/cleanings/${id}`);
      return redirect(res, `/?month=${r.deleted.date.slice(0, 7)}&flash=${encodeURIComponent(`Deleted the ${prettyDate(r.deleted.date)} cleaning.`)}`);
    }
    m = p.match(/^\/cleanings\/(\d+)\/restore$/);
    if (m) {
      const r = service.restoreDeclined(Number(m[1]), who);
      if (r.error) return redirect(res, '/inbox');
      return redirect(res, `/?month=${r.cleaning.date.slice(0, 7)}&review=${r.cleaning.id}`);
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
      if (r.message) return after(req, res, msgUrl(r.message.token));
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
      if (r.message) return redirect(res, msgUrl(r.message.token));
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
    m = p.match(/^\/cleanings\/(\d+)\/(cleaned|quote|paid)$/);
    if (m) {
      const id = Number(m[1]);
      if (m[2] === 'cleaned') service.markCleaned(id, who, body.get('yes') !== '0');
      if (m[2] === 'quote') service.recordPaymentRequest(id, body.get('amount'), who);
      if (m[2] === 'paid') {
        if (body.get('undo') === '1') service.unmarkPaid(id, who);
        else {
          const c = service.get(id);
          if (c && c.status !== 'paid' && body.get('amount') && Math.round(Number(body.get('amount')) * 100) !== c.amount_cents) service.recordPaymentRequest(id, body.get('amount'), who);
          else if (c && c.status === 'approved' && c.amount_cents != null) service.markCleaned(id, who, true);
          service.markPaid([id], body.get('method'), who, body.get('paid_on'), payer(body.get('paid_by')));
        }
      }
      return redirect(res, `/cleanings/${id}`);
    }
    if (p === '/payments/request') {
      const ok = service.recordPaymentRequest(Number(body.get('id')), body.get('amount'), who);
      return redirect(res, '/payments');
    }
    if (p === '/payments/paid') {
      service.markPaid(body.getAll('id').map(Number), body.get('method'), who, null, payer(body.get('paid_by')));
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
      try { const r = await push.dailyReminder(); if (r.sent) console.log('Push reminder', r.items.length); } catch (e) { console.error('Push reminder failed:', e.message); }
    };
    tick();
    timer = setInterval(tick, Math.max(5, config.syncMinutes) * 60 * 1000);
  }
  const stop = () => { clearInterval(timer); server.close(); };

  return { server, db, service, notes, phoneInbox, textPay, photos, sync, notifier, push, fin, startBackground, stop };
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
