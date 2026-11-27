import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';
import { createApp } from '../src/server.js';
import { parseIcal } from '../src/ical.js';
import { localToUtc } from '../src/dates.js';
import { cleaningFeed } from '../src/feed.js';
import { cleaningWindows, guestLabel, cleaningState } from '../src/views.js';
import { cleanerKey } from '../src/cleanerview.js';
import { fillMessage, guestSettings, dueGuestAlerts } from '../src/guestmsgs.js';

const NOW = new Date('2026-11-01T18:00:00Z');

function airbnb(stays) {
  const ev = stays.map(([uid, s, e, summary = 'Reserved']) => [
    'BEGIN:VEVENT', `DTEND;VALUE=DATE:${e.replace(/-/g, '')}`, `DTSTART;VALUE=DATE:${s.replace(/-/g, '')}`,
    `UID:${uid}`, 'DESCRIPTION:Reservation URL: https://www.airbnb.com/hosting/reservations/details/HMABC\\nPhone ',
    ' Number (Last 4 Digits): 1234', `SUMMARY:${summary}`, 'END:VEVENT'].join('\r\n'));
  return ['BEGIN:VCALENDAR', 'PRODID:-//Airbnb Inc//Hosting Calendar 0.8.8//EN', 'VERSION:2.0', ...ev, 'END:VCALENDAR'].join('\r\n');
}

function setup() {
  const config = loadConfig({ DOTENV: '0',
    DB_FILE: ':memory:', DRY_RUN: '1', ADMIN_PASSWORD: 'pw', FEED_TOKEN: 'feedtok', CLEANING_FEE: '120',
    APPROVERS: 'Mark:+15550000001:mark@example.com,Danielle:+15550000002:', CLEANER: 'Rosa:+15550000003',
    BASE_URL: 'http://test', TIMEZONE: 'America/Los_Angeles',
  });
  const app = createApp(config);
  const outbox = () => app.db.prepare('SELECT * FROM outbox ORDER BY id').all();
  const clearOutbox = () => app.db.exec('DELETE FROM outbox');
  const sync = (stays) => app.sync({ icalText: airbnb(stays), now: NOW });
  return { app, config, outbox, clearOutbox, sync };
}

const token = (body, prefix) => body.match(new RegExp(`/${prefix}/([\\w-]+)`))[1];

test('parses Airbnb export, ignores blocked dates', () => {
  const evs = parseIcal(airbnb([['a', '2026-11-05', '2026-11-08'], ['b', '2026-12-01', '2026-12-03', 'Airbnb (Not available)']]));
  assert.equal(evs.length, 2);
  assert.equal(evs[0].start, '2026-11-05');
  assert.match(evs[0].description, /Phone Number/);
});

test('timezone conversion handles DST', () => {
  assert.equal(localToUtc('2026-11-08', '11:00', 'America/Los_Angeles').toISOString(), '2026-11-08T19:00:00.000Z');
  assert.equal(localToUtc('2026-07-08', '11:00', 'America/Los_Angeles').toISOString(), '2026-07-08T18:00:00.000Z');
});

test('new booking -> approval request -> approve -> group text -> calendar', async () => {
  const { app, config, outbox, clearOutbox, sync } = setup();
  const r = await sync([['s1', '2026-11-05', '2026-11-08'], ['s2', '2026-11-08', '2026-11-10'], ['old', '2026-10-01', '2026-10-03'], ['blk', '2026-12-01', '2026-12-04', 'Airbnb (Not available)']]);
  assert.equal(r.added, 2);
  const msgs = outbox();
  // 2 cleanings x (Mark sms + Mark email + Danielle sms)
  assert.equal(msgs.length, 6);
  assert.ok(msgs.every(m => m.status === 'dry_run'));
  const first = msgs.find(m => m.to_addr === '+15550000002' && m.body.includes('Sun, Nov 8'));
  assert.match(first.body, /same day/);
  const t = token(first.body, 'a');

  // On the calendar as "needs OK" until approved; stays show too.
  let feed = cleaningFeed({ db: app.db, config, service: app.service });
  assert.equal((feed.match(/UID:cleaning-/g) || []).length, 2);
  assert.match(feed, /SUMMARY:🟡 Cleaning · needs OK/);
  assert.match(feed, /UID:stay-/);
  assert.doesNotMatch(cleaningFeed({ db: app.db, config, service: app.service, only: 'stays' }), /UID:cleaning-/);

  clearOutbox();
  const res = await app.service.approve(t, 'Danielle');
  assert.equal(res.cleaning.status, 'approved');
  const g = outbox();
  assert.deepEqual(g.map(m => m.to_addr), ['+15550000001', '+15550000002', '+15550000003']);
  assert.equal(g[0].body, 'New cleaning request for 2072 Slalom Ct: Sun, Nov 8. Guest checks out at 11 AM. Next guests arrive 4 PM the same day, so please be done by then.');

  // second approval of same link is harmless
  const again = await app.service.approve(t, 'Mark');
  assert.ok(again.error || again.already);

  const ics = cleaningFeed({ db: app.db, config, service: app.service, only: 'cleanings' });
  assert.equal((ics.match(/UID:cleaning-/g) || []).length, 2);
  assert.doesNotMatch(ics, /UID:stay-/);
  assert.match(ics, /SUMMARY:🟣 Cleaning · waiting on Rosa\r\nDESCRIPTION:Sun\\, Nov 8/);
  assert.match(ics, /COLOR:mediumpurple/);
  assert.match(ics, /DTSTART:20261108T190000Z/);
  assert.match(ics, /DTEND:20261109T000000Z/);
});

test('Airbnb date change on a confirmed cleaning asks before texting the group', async () => {
  const { app, outbox, clearOutbox, sync } = setup();
  await sync([['s1', '2026-11-05', '2026-11-08']]);
  const c = app.db.prepare('SELECT * FROM cleanings').get();
  await app.service.approve(c.approval_token, 'Mark');
  clearOutbox();

  const r = await sync([['s1', '2026-11-05', '2026-11-09']]);
  assert.equal(r.moved, 1);
  assert.equal(app.service.get(c.id).date, '2026-11-09');
  let msgs = outbox();
  assert.equal(msgs.filter(m => m.to_addr === '+15550000003').length, 0, 'cleaner not texted yet');
  const ask = msgs.find(m => m.to_addr === '+15550000001');
  assert.match(ask.body, /should I tell the group text/);
  const gt = token(ask.body, 'g');

  clearOutbox();
  await app.service.decideGroupMessage(gt, true, 'Mark');
  msgs = outbox();
  assert.equal(msgs.length, 3);
  assert.match(msgs[0].body, /CLEANING DATE CHANGED: was Sun, Nov 8, now Mon, Nov 9/);
});

test('Airbnb cancellation: say no and nothing is texted', async () => {
  const { app, config, outbox, clearOutbox, sync } = setup();
  await sync([['s1', '2026-11-05', '2026-11-08'], ['s2', '2026-11-20', '2026-11-22']]);
  const c = app.db.prepare("SELECT * FROM cleanings WHERE booking_uid='s1'").get();
  await app.service.approve(c.approval_token, 'Mark');
  clearOutbox();
  const r = await sync([['s2', '2026-11-20', '2026-11-22']]);
  assert.equal(r.cancelled, 1);
  assert.equal(app.service.get(c.id).status, 'cancelled');
  const gt = token(outbox()[0].body, 'g');
  clearOutbox();
  await app.service.decideGroupMessage(gt, false, 'Danielle');
  assert.equal(outbox().length, 0);
  // the cancelled stay and its cleaning leave the calendar; the other stay remains
  const feed = cleaningFeed({ db: app.db, config, service: app.service });
  assert.doesNotMatch(feed, new RegExp(`UID:cleaning-${c.id}@|UID:stay-s1@`));
  assert.match(feed, /UID:stay-s2@/);
});

test('empty Airbnb feed does not cancel everything', async () => {
  const { app, sync } = setup();
  await sync([['s1', '2026-11-05', '2026-11-08'], ['s2', '2026-11-20', '2026-11-22']]);
  const r = await sync([]);
  assert.equal(r.cancelled, 0);
  assert.ok(r.warning);
});

test('unapproved cleaning moved on Airbnb gets a fresh approval request', async () => {
  const { app, outbox, clearOutbox, sync } = setup();
  await sync([['s1', '2026-11-05', '2026-11-08']]);
  const oldToken = app.db.prepare('SELECT approval_token FROM cleanings').get().approval_token;
  clearOutbox();
  await sync([['s1', '2026-11-05', '2026-11-12']]);
  assert.match(outbox()[0].body, /Booking dates changed.*Thu, Nov 12/);
  assert.ok((await app.service.approve(oldToken, 'Mark')).error, 'old link no longer works');
});

test('manual add and manual move go through the "text the group?" step', async () => {
  const { app, outbox, clearOutbox } = setup();
  const { cleaning, message } = await app.service.addManual('2026-11-15', 'Deep clean the oven', 'Mark');
  assert.equal(cleaning.status, 'approved');
  assert.equal(outbox().length, 0, 'nothing sent until confirmed');
  await app.service.decideGroupMessage(message.token, true, 'Mark', 'CLEANING ADDED: Sun Nov 15, oven deep clean please');
  assert.equal(outbox().length, 3);
  assert.equal(outbox()[0].body, 'CLEANING ADDED: Sun Nov 15, oven deep clean please');

  clearOutbox();
  const mv = await app.service.move(cleaning.id, '2026-11-16', 'Mark');
  assert.ok(mv.message);
  assert.equal(outbox().length, 0);
  await app.service.decideGroupMessage(mv.message.token, true, 'Mark');
  assert.match(outbox()[0].body, /was Sun, Nov 15, now Mon, Nov 16/);
});

test('payments: done cleanings become owed, then paid', async () => {
  const { app, outbox, clearOutbox } = setup();
  const { cleaning } = await app.service.addManual('2026-11-03', null, 'Mark');
  clearOutbox();
  assert.equal(await app.service.autoComplete(new Date('2026-11-04T18:00:00Z')), 1);
  const c = app.service.get(cleaning.id);
  assert.equal(c.status, 'completed');
  assert.equal(c.amount_cents, 12000);
  assert.match(outbox()[0].body, /owe Rosa \$120\.00/);
  app.service.markPaid([c.id], 'Venmo', 'Danielle');
  assert.equal(app.service.get(c.id).status, 'paid');
  assert.deepEqual(app.service.stageOf(app.service.get(c.id)).map(s => s.done), [true, true, true, false, true, true, true, true]);
});

test('HTTP: dashboard needs password, feed needs token, approval page works, drag-move returns redirect', async () => {
  const { app, sync } = setup();
  await new Promise(r => app.server.listen(0, r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const auth = { Authorization: 'Basic ' + Buffer.from('x:pw').toString('base64') };
  try {
    const noLogin = await fetch(base + '/', { redirect: 'manual' });
    assert.equal(noLogin.status, 303);
    assert.equal(noLogin.headers.get('location'), '/login');
    assert.equal((await fetch(base + '/sync', { method: 'POST' })).status, 401);
    assert.equal((await fetch(base + '/feed/wrong.ics')).status, 404);
    assert.equal((await fetch(base + '/feed/feedtok.ics')).status, 200);
    await sync([['s1', '2026-11-05', '2026-11-08']]);
    const dash = await fetch(base + '/?month=2026-11', { headers: auth });
    assert.equal(dash.status, 200);
    const html = await dash.text();
    assert.match(html, /1 thing waiting on you/);
    for (const page of ['/inbox', '/stays', '/payments', '/more', '/todos', '/notes']) {
      const r = await fetch(base + page, { headers: auth });
      assert.equal(r.status, 200, page);
    }
    assert.match(await (await fetch(base + '/inbox', { headers: auth })).text(), /Needs approval/);
    assert.match(html, /class="bar stay-bar ready cont-r" style="grid-column:10\/15"[^>]*>Guest ···1234</, 'Thu 5th 1 PM to Sun 8th 11 AM spans weeks: first week from Thu afternoon');
    assert.match(html, /class="bar stay-bar ready cont-l" style="grid-column:1\/2"/, 'continues into Sunday morning');
    assert.match(html, /class="chip cs-proposed" draggable="true" data-id="\d+" style="grid-column:1\/span 2"[^>]*><span class="l-long">Needs OK</);
    assert.match(html, /Open, no next booking yet/);

    const saved = await fetch(`${base}/bookings/name`, { method: 'POST', headers: { ...auth, Accept: 'application/json' }, body: new URLSearchParams({ uid: 's1', name: 'Smith family' }) });
    assert.deepEqual(await saved.json(), { ok: true }, 'autosave gets JSON back, not a page reload');
    assert.match(await (await fetch(base + '/?month=2026-11', { headers: auth })).text(), /stay-bar[^"]*" style="grid-column:10\/15"[^>]*>Smith family</);

    const c = app.db.prepare('SELECT * FROM cleanings').get();
    const page = await (await fetch(`${base}/a/${c.approval_token}?by=Danielle`)).text();
    assert.match(page, /<option selected>Danielle<\/option>/);
    const post = await fetch(`${base}/a/${c.approval_token}`, { method: 'POST', body: new URLSearchParams({ by: 'Danielle', action: 'approve' }) });
    assert.match(await post.text(), /Approved by Danielle/);

    const mv = await fetch(`${base}/cleanings/${c.id}/move`, { method: 'POST', headers: { ...auth, Accept: 'application/json' }, body: new URLSearchParams({ date: '2026-11-09' }) });
    const { redirect } = await mv.json();
    assert.match(redirect, /^\/\?month=2026-11&msg=[\w-]+$/);
    const decide = await (await fetch(base + redirect, { headers: auth })).text();
    assert.match(decide, /<dialog id="msg-dialog">[\s\S]*Decide later/);
  } finally { app.stop(); }
});

test('test phase: cleaner without a number is never texted', async () => {
  const config = loadConfig({ DOTENV: '0', DB_FILE: ':memory:', DRY_RUN: '1', APPROVERS: 'Mark:+12075550000:,Danielle:+18315550000:', CLEANER: 'Jenn:', CLEANING_FEE: '100' });
  const app = createApp(config);
  const { cleaning, message } = await app.service.addManual('2026-11-15', null, 'Mark');
  await app.service.decideGroupMessage(message.token, true, 'Mark');
  const to = app.db.prepare('SELECT to_addr FROM outbox').all().map(r => r.to_addr);
  assert.deepEqual(to, ['+12075550000', '+18315550000']);
  app.stop();
});

test('per-stay billing: cleaned -> Jenn requests amount -> paid', async () => {
  const config = loadConfig({ DOTENV: '0', DB_FILE: ':memory:', DRY_RUN: '1', APPROVERS: 'Mark:+12075550000:', CLEANER: 'Jenn:', CLEANING_FEE: '0', TIMEZONE: 'America/Los_Angeles' });
  const app = createApp(config);
  const { cleaning, message } = await app.service.addManual('2026-11-15', null, 'Mark');
  await app.service.decideGroupMessage(message.token, true, 'Mark');
  const before = app.db.prepare('SELECT COUNT(*) n FROM outbox').get().n;
  await app.service.autoComplete(new Date('2026-11-16T18:00:00Z'));
  assert.equal(app.db.prepare('SELECT COUNT(*) n FROM outbox').get().n, before, 'no owed text until she asks');
  let c = app.service.get(cleaning.id);
  assert.equal(c.status, 'completed');
  assert.equal(c.amount_cents, null);
  app.service.markPaid([c.id], 'Venmo', 'Mark');
  assert.equal(app.service.get(c.id).status, 'completed', 'cannot pay before an amount is entered');
  assert.equal(app.service.recordPaymentRequest(c.id, '0', 'Mark'), null);
  app.service.recordPaymentRequest(c.id, '145.50', 'Mark');
  app.service.markPaid([c.id], 'Venmo', 'Mark');
  c = app.service.get(c.id);
  assert.equal(c.status, 'paid');
  assert.equal(c.amount_cents, 14550);
  app.stop();
});

test('cleaning windows between stays', () => {
  const w = cleaningWindows([
    { check_in: '2026-11-10', check_out: '2026-11-12' },
    { check_in: '2026-11-01', check_out: '2026-11-05' },
    { check_in: '2026-11-05', check_out: '2026-11-08' },
  ]);
  assert.deepEqual(w.map(({ from, to, days }) => ({ from, to, days })), [
    { from: '2026-11-05', to: '2026-11-05', days: 1 },  // same-day turnover
    { from: '2026-11-08', to: '2026-11-10', days: 3 },  // Sun 11 AM to Tue 1 PM: Sun, Mon, Tue
    { from: '2026-11-12', to: null, days: null },
  ]);
  assert.equal(guestLabel({ description: 'Phone Number (Last 4 Digits): 9876' }), 'Guest ···9876');
  assert.equal(guestLabel({ guest_name: 'Lee', description: '' }), 'Lee');
});

import { classify, validTwilioSignature } from '../src/notes.js';
import crypto from 'node:crypto';

test('classifies cleaner notes', () => {
  assert.deepEqual(classify('Not enough hand towels or wash cloths'), ['supplies']);
  assert.deepEqual(classify('Guests broke a lamp and left a stain on the rug'), ['condition']);
  assert.deepEqual(classify('Really dirty this time, took me 2 extra hours'), ['condition']);
  assert.deepEqual(classify('All done! See you Friday'), []);
});

test('notes tie to the right cleaning and stay; supplies become to-dos; damage is flagged', async () => {
  const { app, sync } = setup();
  await sync([['s1', '2026-11-05', '2026-11-08'], ['s2', '2026-11-12', '2026-11-15']]);
  const [c1, c2] = app.db.prepare('SELECT * FROM cleanings ORDER BY date').all();
  // Nov 8 afternoon Pacific: on cleaning day 1
  const n1 = app.notes.add({ body: 'Not enough hand towels or wash cloths', phone: '+15550000003', at: '2026-11-08T22:00:00Z', source: 'group' });
  assert.equal(n1.author, 'Rosa');
  assert.equal(n1.cleaning_id, c1.id);
  assert.equal(n1.booking_uid, 's1');
  assert.equal(app.db.prepare("SELECT COUNT(*) n FROM todos WHERE status='open'").get().n, 1);
  // Nov 9: report on the cleaning the day before
  const n2 = app.notes.add({ body: 'Forgot to say, guests broke a wine glass', phone: '+15550000003', at: '2026-11-09T18:00:00Z', source: 'group' });
  assert.equal(n2.cleaning_id, c1.id);
  assert.equal(n2.followup, 'open');
  // Nov 13: prep for the next cleaning, after stay s2
  const n3 = app.notes.add({ body: 'Can I come at 10 on Sunday?', phone: '+15550000003', at: '2026-11-13T18:00:00Z', source: 'group' });
  assert.equal(n3.cleaning_id, c2.id);
  assert.equal(n3.booking_uid, 's2');
  // re-file by hand
  app.notes.update(n3.id, { cleaningId: c1.id, tags: ['condition'], by: 'Mark' });
  assert.equal(app.notes.get(n3.id).booking_uid, 's1');
  assert.equal(app.notes.get(n3.id).followup, 'open');
  // owners' replies are saved but not turned into to-dos
  app.notes.add({ body: "Thanks, I'll order more towels today", phone: '+15550000001', at: '2026-11-08T23:00:00Z', source: 'group' });
  assert.equal(app.db.prepare("SELECT COUNT(*) n FROM todos").get().n, 1);
  app.notes.setFollowup(n2.id, 'done');
  assert.equal(app.notes.get(n2.id).followup, 'done');
});

test('Twilio webhooks: signature checked, notes saved, text passed on in individual mode', async () => {
  const config = loadConfig({ DOTENV: '0', DB_FILE: ':memory:', DRY_RUN: '1', ADMIN_PASSWORD: 'pw', TWILIO_AUTH_TOKEN: 'secret',
    APPROVERS: 'Mark:+15550000001:,Danielle:+15550000002:', CLEANER: 'Rosa:+15550000003', BASE_URL: 'https://app.example' });
  const app = createApp(config);
  await new Promise(r => app.server.listen(0, r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const params = new URLSearchParams({ From: '+15550000003', Body: 'We are out of toilet paper', To: '+15559999999' });
  const sign = (url, p) => crypto.createHmac('sha1', 'secret').update(url + [...p.keys()].sort().map(k => k + p.get(k)).join('')).digest('base64');
  try {
    assert.equal((await fetch(base + '/twilio/sms', { method: 'POST', body: params, headers: { 'X-Twilio-Signature': 'nope' } })).status, 403);
    assert.ok(validTwilioSignature('secret', 'https://app.example/twilio/sms', params, sign('https://app.example/twilio/sms', params)));
    const ok = await fetch(base + '/twilio/sms', { method: 'POST', body: params, headers: { 'X-Twilio-Signature': sign('https://app.example/twilio/sms', params) } });
    assert.equal(ok.status, 200);
    assert.equal(app.db.prepare('SELECT author FROM notes').get().author, 'Rosa');
    assert.deepEqual(app.db.prepare("SELECT to_addr FROM outbox").all().map(r => r.to_addr), ['+15550000001', '+15550000002']);
    assert.match(app.db.prepare("SELECT body FROM outbox").get().body, /^Rosa: We are out of toilet paper/);
    assert.equal(app.db.prepare("SELECT COUNT(*) n FROM todos").get().n, 1);

    const conv = new URLSearchParams({ EventType: 'onMessageAdded', Author: '+15550000001', Body: 'Thanks Rosa!', DateCreated: '2026-11-08T22:00:00Z' });
    await fetch(base + '/twilio/conversation', { method: 'POST', body: conv, headers: { 'X-Twilio-Signature': sign('https://app.example/twilio/conversation', conv) } });
    const own = new URLSearchParams({ EventType: 'onMessageAdded', Author: 'cleaning-link', Body: 'CLEANING CONFIRMED' });
    await fetch(base + '/twilio/conversation', { method: 'POST', body: own, headers: { 'X-Twilio-Signature': sign('https://app.example/twilio/conversation', own) } });
    assert.deepEqual(app.db.prepare('SELECT author, source FROM notes ORDER BY id').all().map(r => `${r.author}/${r.source}`), ['Rosa/sms', 'Mark/group']);

    // pages render
    const auth = { Authorization: 'Basic ' + Buffer.from('x:pw').toString('base64') };
    assert.match(await (await fetch(base + '/todos', { headers: auth })).text(), /We are out of toilet paper/);
    assert.match(await (await fetch(base + '/notes', { headers: auth })).text(), /Thanks Rosa!/);
  } finally { app.stop(); }
});

test('hand-scheduled cleanings: no text when already arranged, and Airbnb sync does not propose another', async () => {
  const { app, outbox, clearOutbox, sync } = setup();
  // Mark already arranged Nov 9 with the cleaner, before the app saw the bookings.
  const { cleaning, message } = await app.service.addManual('2026-11-09', null, 'Mark', { alreadyArranged: true });
  assert.equal(message, undefined);
  assert.equal(outbox().length, 0, 'nothing texted');
  assert.equal(cleaning.group_known_date, '2026-11-09');
  assert.ok(app.service.stageOf(cleaning).find(s => s.name === 'Cleaner texted').done);

  const r = await sync([['s1', '2026-11-05', '2026-11-08'], ['s2', '2026-11-12', '2026-11-15'], ['s3', '2026-11-15', '2026-11-18']]);
  assert.equal(r.covered, 1);
  assert.equal(r.added, 2, 's2 and s3 still get proposals');
  assert.equal(app.service.get(cleaning.id).booking_uid, 's1', 'manual cleaning adopted the stay');
  assert.equal(app.db.prepare("SELECT COUNT(*) n FROM cleanings WHERE date='2026-11-08'").get().n, 0);
  // syncing again doesn't propose it either
  assert.equal((await sync([['s1', '2026-11-05', '2026-11-08'], ['s2', '2026-11-12', '2026-11-15'], ['s3', '2026-11-15', '2026-11-18']])).added, 0);

  // Scheduling by hand in a turnover that already has a pending proposal replaces it.
  const pending = app.db.prepare("SELECT * FROM cleanings WHERE booking_uid='s3'").get();
  assert.equal(pending.status, 'awaiting_approval');
  clearOutbox();
  const r2 = await app.service.addManual('2026-11-19', null, 'Danielle', { alreadyArranged: true });
  assert.equal(r2.replaced.id, pending.id);
  assert.equal(app.service.get(pending.id).status, 'cancelled');
  assert.equal(app.service.get(r2.cleaning.id).booking_uid, 's3');
  assert.equal(outbox().length, 0);
  assert.ok((await app.service.approve(pending.approval_token, 'Mark')).error, 'old approval link is dead');

  // A mid-stay cleaning (guests of s2 are there Nov 12-15) doesn't take over any turnover.
  const s2Pending = app.db.prepare("SELECT * FROM cleanings WHERE booking_uid='s2'").get();
  const mid = await app.service.addManual('2026-11-13', 'Mid-stay refresh', 'Mark', { alreadyArranged: true });
  assert.equal(mid.replaced, null);
  assert.equal(mid.cleaning.booking_uid, null);
  assert.equal(app.service.get(s2Pending.id).status, 'awaiting_approval');

  // Moving an arranged cleaning later still asks before texting the group.
  const mv = await app.service.move(cleaning.id, '2026-11-10', 'Mark');
  assert.ok(mv.message);
  assert.match(mv.message.body, /was Mon, Nov 9, now Tue, Nov 10/);
});

import { stayReadiness } from '../src/views.js';
test('stay colors: ready, pending, missing, past', () => {
  const bookings = [
    { uid: 'old', check_in: '2026-10-20', check_out: '2026-10-25' },
    { uid: 'a', check_in: '2026-11-03', check_out: '2026-11-06' },
    { uid: 'b', check_in: '2026-11-08', check_out: '2026-11-10' },   // gap Nov 6-8
    { uid: 'c', check_in: '2026-11-10', check_out: '2026-11-12' },   // same-day after b
    { uid: 'd', check_in: '2026-11-15', check_out: '2026-11-18' },   // gap Nov 12-15
  ];
  const cleanings = [
    { date: '2026-11-07', status: 'approved', group_known_date: '2026-11-07', cleaner_confirmed_at: 'x' }, // confirmed, covers b
    { date: '2026-11-10', status: 'awaiting_approval' },  // proposed for c
    { date: '2026-11-13', status: 'cancelled' },          // doesn't count for d
    { date: '2026-11-19', status: 'approved', group_known_date: '2026-11-19' }, // texted, not confirmed: e is pending
  ];
  bookings.push({ uid: 'e', check_in: '2026-11-20', check_out: '2026-11-22' });
  assert.deepEqual(stayReadiness(bookings, cleanings, '2026-11-02'), { old: 'past', a: 'missing', b: 'ready', c: 'pending', d: 'missing', e: 'pending' });
  const t = '2026-11-02';
  assert.deepEqual([
    { date: '2026-11-05', status: 'awaiting_approval' },
    { date: '2026-11-05', status: 'approved', group_known_date: null },
    { date: '2026-11-05', status: 'approved', group_known_date: '2026-11-04' },
    { date: '2026-11-05', status: 'approved', group_known_date: '2026-11-05' },
    { date: '2026-11-05', status: 'approved', group_known_date: '2026-11-05', cleaner_confirmed_at: 'x' },
    { date: '2026-11-01', status: 'approved', group_known_date: '2026-11-01', cleaner_confirmed_at: 'x' },
    { date: '2026-11-05', status: 'completed' },
  ].map(c => cleaningState(c, t)), ['proposed', 'proposed', 'proposed', 'asked', 'confirmed', 'past', 'past']);
});

test('personal stays: cleaning proposed for departure day, survives Airbnb sync, edit and remove', async () => {
  const { app, outbox, clearOutbox, sync } = setup();
  await sync([['s1', '2026-11-05', '2026-11-08'], ['s2', '2026-11-20', '2026-11-22']]);
  clearOutbox();
  const r = await app.service.addPersonalStay({ checkIn: '2026-11-12', checkOut: '2026-11-15', name: 'Cote family', by: 'Mark' });
  assert.equal(r.cleaning.date, '2026-11-15');
  assert.equal(r.cleaning.status, 'awaiting_approval');
  assert.equal(outbox().length, 0, 'no text: it shows under Waiting on you');
  assert.equal(r.clash.length, 0);

  // Airbnb doesn't know about it, but sync must not cancel it.
  const s = await sync([['s1', '2026-11-05', '2026-11-08'], ['s2', '2026-11-20', '2026-11-22']]);
  assert.equal(s.cancelled, 0);
  assert.equal(app.db.prepare('SELECT status FROM bookings WHERE uid = ?').get(r.booking.uid).status, 'active');

  // Personal stay with no cleaning before it isn't flagged orange.
  const { stayReadiness } = await import('../src/views.js');
  const bookings = app.db.prepare("SELECT * FROM bookings WHERE status='active'").all();
  const noCleanings = app.db.prepare("SELECT * FROM cleanings WHERE booking_uid != 's1'").all();  // nothing between s1 and this stay
  const ready = stayReadiness(bookings, noCleanings, '2026-11-02');
  assert.equal(ready[r.booking.uid], 'ready');

  // Leaving a day later moves the proposed cleaning with it.
  await app.service.updatePersonalStay(r.booking.uid, { checkIn: '2026-11-12', checkOut: '2026-11-16', name: 'Cote family', by: 'Mark' });
  assert.equal(app.service.get(r.cleaning.id).date, '2026-11-16');

  // Overlap with an Airbnb booking is reported.
  const clash = await app.service.addPersonalStay({ checkIn: '2026-11-21', checkOut: '2026-11-23', name: '', by: 'Mark' });
  assert.equal(clash.clash[0].uid, 's2');

  // Removing it cancels its cleaning (never texted, so nothing to ask).
  const rm = await app.service.removePersonalStay(r.booking.uid, 'Mark');
  assert.equal(rm.message, undefined);
  assert.equal(app.service.get(r.cleaning.id).status, 'cancelled');
});

test('Review on the calendar: approve without texting, approve and text after preview, or decline', async () => {
  const { app, sync, outbox, clearOutbox } = setup();
  await new Promise(r => app.server.listen(0, r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const auth = { Authorization: 'Basic ' + Buffer.from('x:pw').toString('base64') };
  const post = (fields) => fetch(base + '/cleanings', { method: 'POST', headers: auth, body: new URLSearchParams(fields), redirect: 'manual' });
  try {
    await sync([['s1', '2026-11-05', '2026-11-08'], ['s2', '2026-11-12', '2026-11-15'], ['s3', '2026-11-20', '2026-11-22']]);
    const [c1, c2, c3] = app.db.prepare('SELECT * FROM cleanings ORDER BY date').all();
    clearOutbox();

    const inbox = await (await fetch(base + '/inbox', { headers: auth })).text();
    assert.match(inbox, new RegExp(`href="/\\?month=2026-11&review=${c1.id}">Review<`));
    const cal = await (await fetch(`${base}/?month=2026-11&review=${c1.id}`, { headers: auth })).text();
    assert.match(cal, /class="day [^"]*\breview" data-date="2026-11-08"/);
    assert.match(cal, new RegExp(`const review=\\{"id":${c1.id},"date":"2026-11-08"`));

    // Already arranged: approved, nothing texted.
    let r = await post({ proposal: c1.id, arranged: '1', note: 'Bring extra towels' });
    assert.match(r.headers.get('location'), /Nothing\+was\+texted|Nothing%20was%20texted/);
    let c = app.service.get(c1.id);
    assert.equal(c.status, 'approved');
    assert.equal(c.source, 'airbnb');
    assert.equal(c.group_known_date, '2026-11-08');
    assert.equal(c.note, 'Bring extra towels');
    assert.equal(outbox().length, 0);

    // Text the group: approved, but the message waits for the preview step.
    r = await post({ proposal: c2.id, arranged: '0' });
    assert.match(r.headers.get('location'), /^\/\?month=2026-11&msg=/);
    assert.equal(app.service.get(c2.id).status, 'approved');
    assert.equal(outbox().filter(o => o.channel !== 'email').length, 0, 'nothing sent until the preview is confirmed');

    // Not needed: declined, nothing texted.
    r = await post({ proposal: c3.id, action: 'decline' });
    assert.equal(app.service.get(c3.id).status, 'declined');
    assert.equal(outbox().length, 0);

    // A stale Review link just says it was handled.
    r = await post({ proposal: c1.id, arranged: '1' });
    assert.match(decodeURIComponent(r.headers.get('location')), /already approved/);
  } finally { app.stop(); }
});

test('Send me a test: only the reviewer gets the draft, it stays pending, edits are kept', async () => {
  const { app, outbox, clearOutbox } = setup();
  await new Promise(r => app.server.listen(0, r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  try {
    const { message } = await app.service.addManual('2026-11-20', '', 'Mark');
    clearOutbox();
    const r = await fetch(`${base}/g/${message.token}`, { method: 'POST', body: new URLSearchParams({ by: 'Danielle', send: 'test', body: 'CLEANING ADDED: edited text' }) });
    const html = await r.text();
    assert.match(html, /Test sent only to Danielle \(\+15550000002\)/);
    assert.match(html, /CLEANING ADDED: edited text/);
    const sent = outbox();
    assert.equal(sent.length, 1);
    assert.equal(sent[0].channel, 'sms');
    assert.equal(sent[0].to_addr, '+15550000002');
    assert.match(sent[0].body, /^\[TEST, only you got this\] CLEANING ADDED: edited text/);
    const gm = app.db.prepare('SELECT * FROM group_messages WHERE token = ?').get(message.token);
    assert.equal(gm.status, 'pending');
    assert.equal(gm.body, 'CLEANING ADDED: edited text');
  } finally { app.stop(); }
});

test('Waiting on you drops proposals already covered by a confirmed cleaning (manual or approved)', async () => {
  const { app, sync, outbox, clearOutbox } = setup();
  await new Promise(r => app.server.listen(0, r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const auth = { Authorization: 'Basic ' + Buffer.from('x:pw').toString('base64') };
  try {
    await sync([['s1', '2026-11-05', '2026-11-08'], ['s2', '2026-11-12', '2026-11-15'], ['s3', '2026-11-20', '2026-11-22']]);
    const [p1, p2, p3] = app.db.prepare('SELECT * FROM cleanings ORDER BY date').all();
    assert.deepEqual([p1.date, p2.date, p3.date], ['2026-11-08', '2026-11-15', '2026-11-22']);
    clearOutbox();
    const ins = (date, status, source) => app.db.prepare(`INSERT INTO cleanings (source, date, status, sequence, created_at, updated_at) VALUES (?, ?, ?, 0, 'x', 'x')`).run(source, date, status);
    ins('2026-11-10', 'approved', 'manual');            // hand-added inside the 8th-12th turnover
    ins('2026-11-17', 'approved', 'airbnb');            // an approved cleaning inside the 15th-20th turnover
    ins('2026-11-13', 'approved', 'manual');            // mid-stay: covers nothing

    const inbox = await (await fetch(base + '/inbox', { headers: auth })).text();
    assert.equal(app.service.get(p1.id).status, 'cancelled');
    assert.equal(app.service.get(p2.id).status, 'cancelled');
    assert.equal(app.service.get(p3.id).status, 'awaiting_approval', 'nothing covers the turnover after the 22nd');
    assert.equal((inbox.match(/Needs approval/g) || []).length, 1);
    assert.equal(outbox().length, 0, 'nothing is texted');
    const ev = app.db.prepare("SELECT detail FROM events WHERE cleaning_id = ? AND stage = 'Cancelled'").get(p1.id);
    assert.match(ev.detail, /Tue, Nov 10 cleaning already covers this turnover/);
  } finally { app.stop(); }
});

test('Undo a skipped group text and a "not needed" cleaning', async () => {
  const { app, sync, outbox, clearOutbox } = setup();
  await new Promise(r => app.server.listen(0, r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const auth = { Authorization: 'Basic ' + Buffer.from('x:pw').toString('base64') };
  try {
    const { message } = await app.service.addManual('2026-11-23', '', 'Mark');
    clearOutbox();
    const done = await (await fetch(`${base}/g/${message.token}`, { method: 'POST', body: new URLSearchParams({ by: 'Mark', send: '0' }) })).text();
    assert.match(done, /Undo, bring the message back/);
    let inbox = await (await fetch(base + '/inbox', { headers: auth })).text();
    assert.match(inbox, /Recently cleared[\s\S]*Text not sent/);

    const r = await fetch(`${base}/g/${message.token}`, { method: 'POST', body: new URLSearchParams({ by: 'Mark', send: 'undo' }), redirect: 'manual' });
    assert.equal(r.status, 303);
    assert.equal(app.db.prepare('SELECT status FROM group_messages WHERE token = ?').get(message.token).status, 'pending');
    inbox = await (await fetch(base + '/inbox', { headers: auth })).text();
    assert.match(inbox, /Text the group\?/);
    assert.doesNotMatch(inbox, /Recently cleared/);
    assert.equal(outbox().length, 0, 'undo never texts anyone');

    // A newer draft blocks bringing back an older one.
    await app.service.decideGroupMessage(message.token, false, 'Mark');
    await app.service.customGroupMessage(app.db.prepare('SELECT cleaning_id FROM group_messages WHERE token = ?').get(message.token).cleaning_id, 'Bring the spare key', 'Mark');
    assert.match(app.service.undoSkip(message.token, 'Mark').error, /newer message/);

    // Not needed -> restore
    await sync([['s1', '2026-12-05', '2026-12-08']]);
    const p = app.db.prepare("SELECT * FROM cleanings WHERE status='awaiting_approval'").get();
    await app.service.decline(p.approval_token, 'Mark');
    const rs = await fetch(`${base}/cleanings/${p.id}/restore`, { method: 'POST', headers: auth, redirect: 'manual' });
    assert.match(rs.headers.get('location'), new RegExp(`review=${p.id}`));
    assert.equal(app.service.get(p.id).status, 'awaiting_approval');
  } finally { app.stop(); }
});

test('Group text dialog: decide later keeps it pending; test and send come back to the calendar', async () => {
  const { app, outbox, clearOutbox } = setup();
  await new Promise(r => app.server.listen(0, r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const auth = { Authorization: 'Basic ' + Buffer.from('x:pw').toString('base64') };
  const post = (tok, fields) => fetch(`${base}/g/${tok}`, { method: 'POST', headers: auth, body: new URLSearchParams({ ui: 'dialog', by: 'Mark', ...fields }), redirect: 'manual' });
  try {
    const add = await fetch(base + '/cleanings', { method: 'POST', headers: auth, body: new URLSearchParams({ date: '2026-11-23', arranged: '0' }), redirect: 'manual' });
    const loc = add.headers.get('location');
    const tok = loc.match(/msg=([\w-]+)/)[1];
    // "Decide later" is just closing the dialog: still pending, still in Waiting on you.
    assert.equal(app.db.prepare('SELECT status FROM group_messages WHERE token = ?').get(tok).status, 'pending');
    assert.match(await (await fetch(base + '/inbox', { headers: auth })).text(), new RegExp(`href="/\\?month=2026-11&msg=${tok}">Decide<`));
    clearOutbox();
    let r = await post(tok, { send: 'test' });
    assert.match(decodeURIComponent(r.headers.get('location')), /msg=.*&msgnote=Test sent only to Mark/);
    assert.match(await (await fetch(base + r.headers.get('location'), { headers: auth })).text(), /<dialog id="msg-dialog">[\s\S]*Test sent only to Mark/);
    r = await post(tok, { send: '1' });
    assert.match(decodeURIComponent(r.headers.get('location')), /^\/\?month=2026-11&flash=Sent to the group text\./);
    assert.equal(outbox().filter(o => o.channel === 'sms' && /New cleaning request/.test(o.body) && !/TEST/.test(o.body)).length, 3);
    const after = await (await fetch(`${base}/?month=2026-11&msg=${tok}`, { headers: auth })).text();
    assert.doesNotMatch(after, /<dialog id="msg-dialog">/);
    assert.match(after, /already sent/);
  } finally { app.stop(); }
});

test('Cleaning states: proposed -> asked after texting -> confirmed; arranged is confirmed; move resets', async () => {
  const { app, sync } = setup();
  await new Promise(r => app.server.listen(0, r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const auth = { Authorization: 'Basic ' + Buffer.from('x:pw').toString('base64') };
  const T = '2026-11-02';
  const state = (id) => cleaningState(app.service.get(id), T);
  try {
    await sync([['s1', '2026-11-05', '2026-11-08'], ['s2', '2026-11-12', '2026-11-15']]);
    const [p1, p2] = app.db.prepare('SELECT * FROM cleanings ORDER BY date').all();
    assert.equal(state(p1.id), 'proposed');

    // Approve and text: asked, waiting on the cleaner; shows in Waiting on you.
    const r = await app.service.approveProposal(p1.id, 'Mark', {});
    assert.equal(state(p1.id), 'proposed', 'approved but the text is still a draft');
    await app.service.decideGroupMessage(r.message.token, true, 'Mark');
    assert.equal(state(p1.id), 'asked');
    let inbox = await (await fetch(base + '/inbox', { headers: auth })).text();
    assert.match(inbox, /Waiting on Rosa<\/span> Texted to the group/);
    const cal = await (await fetch(base + '/?month=2026-11', { headers: auth })).text();
    assert.match(cal, new RegExp(`class="chip cs-asked" draggable="true" data-id="${p1.id}"[^>]*><span class="l-long">Asked<`));

    // Mark says Rosa confirmed.
    const c = await fetch(`${base}/cleanings/${p1.id}/confirm`, { method: 'POST', headers: auth, body: new URLSearchParams({ back: 'inbox' }), redirect: 'manual' });
    assert.equal(c.headers.get('location'), '/inbox');
    assert.equal(state(p1.id), 'confirmed');
    assert.ok(app.service.stageOf(app.service.get(p1.id)).find(s => s.name === 'Cleaner confirmed').done);
    inbox = await (await fetch(base + '/inbox', { headers: auth })).text();
    assert.doesNotMatch(inbox, /Waiting on Rosa/);

    // Moving it means the cleaner has to OK the new day.
    await app.service.move(p1.id, '2026-11-09', 'Mark');
    assert.equal(state(p1.id), 'proposed', 'moved, new date not sent yet');

    // Arranged directly: confirmed straight away.
    await app.service.approveProposal(p2.id, 'Mark', { alreadyArranged: true });
    assert.equal(state(p2.id), 'confirmed');
    const { cleaning } = await app.service.addManual('2026-11-25', '', 'Mark', { alreadyArranged: true });
    assert.equal(state(cleaning.id), 'confirmed');
    // Can't confirm a date the cleaner hasn't been texted.
    assert.match(app.service.confirmByCleaner(p1.id, 'Mark').error, /hasn't been texted/);
  } finally { app.stop(); }
});

test('Live texting with SMS_ONLY_TO: only Mark gets real texts; test-text button reports delivery or the Twilio problem', async () => {
  const calls = [];
  let fail = null;
  const fetchImpl = async (url, opts = {}) => {
    calls.push({ url, body: opts.body ? String(opts.body) : null });
    const json = (o, status = 200) => ({ ok: status < 300, status, json: async () => o, text: async () => JSON.stringify(o) });
    if (url.endsWith('/Messages.json')) return json({ sid: 'SM' + calls.length, status: 'queued' }, 201);
    if (/\/Messages\/SM\d+\.json$/.test(url)) return json(fail ? { status: 'undelivered', error_code: fail } : { status: 'delivered', error_code: null });
    return json({}, 404);
  };
  const config = loadConfig({ DOTENV: '0', DB_FILE: ':memory:', DRY_RUN: '0', ADMIN_PASSWORD: 'pw', TWILIO_ACCOUNT_SID: 'ACtest', TWILIO_AUTH_TOKEN: 'tok', TWILIO_FROM: '+15550009999',
    APPROVERS: 'Mark:+12076512735:,Danielle:+18319150656:', CLEANER: 'Jenn:+19734193202', SMS_ONLY_TO: '207-651-2735', BASE_URL: 'http://test' });
  const app = createApp(config, { fetchImpl, testPollMs: 1 });
  await new Promise(r => app.server.listen(0, r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const auth = { Authorization: 'Basic ' + Buffer.from('x:pw').toString('base64'), Cookie: 'who=Mark' };
  try {
    const { message } = await app.service.addManual('2026-11-20', '', 'Mark');
    await app.service.decideGroupMessage(message.token, true, 'Mark');
    const out = app.db.prepare("SELECT to_addr, status FROM outbox WHERE channel='sms' ORDER BY id").all().map(o => ({ ...o }));
    assert.deepEqual(out, [
      { to_addr: '+12076512735', status: 'sent' },
      { to_addr: '+18319150656', status: 'held' },
      { to_addr: '+19734193202', status: 'held' },
    ]);
    assert.equal(calls.filter(c => c.url.endsWith('/Messages.json')).length, 1, 'only one real Twilio send');
    assert.match(calls[0].body, /To=%2B12076512735/);

    const more = await (await fetch(base + '/more', { headers: auth })).text();
    assert.match(more, /Live, safety switch on\.<\/b> Real texts go only to \(207\) 651-2735/);
    assert.match(more, /http:\/\/test\/twilio\/sms/);

    let r = await fetch(base + '/texting/test', { method: 'POST', headers: auth, redirect: 'manual' });
    assert.match(decodeURIComponent(r.headers.get('location')), /Delivered to \+12076512735\. Texting works\./);
    fail = 30034;
    r = await fetch(base + '/texting/test', { method: 'POST', headers: auth, redirect: 'manual' });
    assert.match(decodeURIComponent(r.headers.get('location')), /approved A2P 10DLC campaign \(30034\)/);
  } finally { app.stop(); }
});

test('Public SMS info, privacy and terms pages need no login and cover what carriers check', async () => {
  const { app } = setup();
  await new Promise(r => app.server.listen(0, r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  try {
    const sms = await fetch(base + '/sms'); assert.equal(sms.status, 200);
    assert.match(await sms.text(), /How people opt in[\s\S]*STOP[\s\S]*HELP/);
    const priv = await (await fetch(base + '/privacy')).text();
    assert.match(priv, /do not sell, rent or share mobile phone numbers or SMS opt-in information with third parties/);
    const terms = await (await fetch(base + '/terms')).text();
    assert.match(terms, /Message and data rates may apply/);
    assert.match(terms, /Message frequency varies/);
    assert.match(terms, /Reply <b>STOP<\/b>/);
    assert.equal((await fetch(base + '/sms-terms')).status, 200);
    assert.match(await (await fetch(base + '/sms')).text(), /one way to opt in: the form at <a href="\/join">[\s\S]*optional and separate[\s\S]*not ticked in advance and not required[\s\S]*I agree to receive automated text messages/);
  } finally { app.stop(); }
});

test('Public sign-up form: text consent is optional and unticked; group members who tick it get the confirmation text, strangers are only recorded', async () => {
  const { app, outbox, clearOutbox } = setup();
  await new Promise(r => app.server.listen(0, r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const auth = { Authorization: 'Basic ' + Buffer.from('x:pw').toString('base64'), Cookie: 'who=Mark' };
  const join = (data) => fetch(base + '/join', { method: 'POST', body: new URLSearchParams(data) });
  try {
    const form = await (await fetch(base + '/join')).text();
    assert.match(form, /<input type="checkbox" name="consent" value="yes" style/);
    assert.doesNotMatch(form, /name="consent"[^>]*required/);
    assert.match(form, /Text messages \(optional\)[\s\S]*You can join the schedule without them/);
    assert.doesNotMatch(form, /name="consent"[^>]*checked/);
    assert.match(form, /Message and data rates may apply\. Reply STOP to opt out/);
    clearOutbox();
    // Without the box: joined, but never texted, now or later.
    const no = await join({ name: 'Rosa', phone: '555-000-0003' });
    assert.equal(no.status, 200);
    assert.match(await no.text(), /You won(&#39;|')t get any texts/);
    assert.equal(outbox().length, 0);
    assert.match(await (await fetch(base + '/more', { headers: auth })).text(), /Rosa<\/b>[\s\S]*said no to texts/);
    await app.notifier.sms('+15550000003', 'hello');
    assert.equal(outbox()[0].status, 'held');
    assert.match(outbox()[0].error, /without agreeing to texts/);
    clearOutbox();
    // A group member signs up: recorded, and the confirmation text goes out.
    const ok = await join({ name: 'Rosa', phone: '(555) 000-0003', consent: 'yes' });
    assert.equal(ok.status, 200);
    // In test mode nothing really goes out, so the page doesn't promise a text.
    assert.match(await ok.text(), /couldn(&#39;|')t be sent just now/);
    assert.equal(outbox().length, 1);
    assert.equal(outbox()[0].to_addr, '+15550000003');
    assert.match(outbox()[0].body, /you're signed up for cleaning schedule texts.*Reply HELP for help, STOP to opt out\./);
    assert.match(await (await fetch(base + '/more', { headers: auth })).text(), /Rosa<\/b>[\s\S]*Signed up on the form [A-Z][a-z]{2} \d+, \d{4}/);
    // A stranger is recorded but never texted.
    const other = await join({ name: 'Someone', phone: '+1 212 555 0199', consent: 'yes' });
    assert.match(await other.text(), /once the owners add you/);
    assert.equal(outbox().length, 1);
    assert.ok(app.db.prepare("SELECT 1 FROM meta WHERE key = 'consent:2125550199'").get());
  } finally { app.stop(); }
});

test('Sign-up when live: confirmation text goes out, owners get told, and a carrier block shows up on Messages sent', async () => {
  const config = loadConfig({ DOTENV: '0', DB_FILE: ':memory:', DRY_RUN: '0', TWILIO_ACCOUNT_SID: 'AC1', TWILIO_AUTH_TOKEN: 't', TWILIO_FROM: '+15559990000',
    APPROVERS: 'Mark:+12075550000:,Danielle:+18315550000:', CLEANER: 'Jenn:', SMS_ONLY_TO: '+12075550000', BASE_URL: 'http://test' });
  const twilio = [];
  const fetchImpl = async (url, opts = {}) => {
    if (opts.method === 'POST') { twilio.push(Object.fromEntries(new URLSearchParams(String(opts.body)))); return new Response(JSON.stringify({ sid: 'SM' + twilio.length, status: 'queued' }), { status: 201 }); }
    return new Response(JSON.stringify({ sid: 'SM1', status: 'undelivered', error_code: 30034 }), { status: 200 });
  };
  const pushes = [];
  const push = { send: async (m) => { pushes.push(m); return []; } };
  const app = createApp(config, { fetchImpl, push, deliveryChecks: [5] });
  await new Promise(r => app.server.listen(0, r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const join = (data) => fetch(base + '/join', { method: 'POST', body: new URLSearchParams(data) });
  const outbox = () => app.db.prepare('SELECT * FROM outbox ORDER BY id').all();
  try {
    const ok = await join({ name: 'Mark', phone: '207-555-0000', consent: 'yes' });
    assert.match(await ok.text(), /confirmation text is on its way/);
    assert.equal(twilio.length, 1);
    assert.equal(twilio[0].To, '+12075550000');
    assert.match(twilio[0].Body, /STOP to opt out/);
    assert.match(pushes[0].title, /Mark signed up/);
    assert.match(pushes[0].body, /Confirmation text sent/);
    // Twilio accepted it, then the carrier blocked it: the list and the owners' phones say why.
    await new Promise(r => setTimeout(r, 60));
    assert.equal(outbox()[0].status, 'undelivered');
    assert.match(outbox()[0].error, /30034.*Sender Pool/);
    assert.match(pushes[1].title, /did not go through/);
    assert.match(pushes[1].body, /Text to Mark: carriers blocked it/);

    // Danielle isn't on the safety switch yet: page doesn't promise a text, owners hear why.
    const held = await join({ name: 'Danielle', phone: '831-555-0000', consent: 'yes' });
    assert.match(await held.text(), /couldn(&#39;|')t be sent just now/);
    assert.equal(twilio.length, 1);
    assert.match(pushes.at(-1).body, /isn't in SMS_ONLY_TO/);
    // Someone not on the list: recorded, not texted, owners told.
    await join({ name: 'Pat', phone: '212-555-0199', consent: 'yes' });
    assert.match(pushes.at(-1).body, /isn't in APPROVERS or CLEANER/);
  } finally { app.stop(); }
});

test('Jenn texting back "yes" confirms the cleaning she was asked about', async () => {
  const config = loadConfig({ DOTENV: '0', DB_FILE: ':memory:', DRY_RUN: '1',
    APPROVERS: 'Mark:+12075550000:', CLEANER: 'Jenn:+19735550000', CLEANING_FEE: '0' });
  const app = createApp(config);
  await new Promise(r => app.server.listen(0, r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const reply = (from, body) => fetch(base + '/twilio/sms', { method: 'POST', body: new URLSearchParams({ From: from, Body: body }) });
  const state = (id) => cleaningState(app.service.get(id), '2026-01-01');
  try {
    const ask = async (date) => {
      const { cleaning, message } = await app.service.addManual(date, null, 'Mark');
      await app.service.decideGroupMessage(message.token, true, 'Mark');
      return cleaning.id;
    };
    const a = await ask('2099-01-10');
    // Owners saying yes, or Jenn saying no, changes nothing.
    await reply('+12075550000', 'Yes');
    await reply('+19735550000', "Sorry, can't that day");
    await reply('+19735550000', 'Yes? which day');
    assert.equal(state(a), 'asked');
    await reply('+19735550000', 'Yes! See you then');
    assert.equal(state(a), 'confirmed');
    assert.match(app.db.prepare("SELECT detail FROM events WHERE cleaning_id = ? AND stage = 'Cleaner confirmed'").get(a).detail, /Jenn replied "Yes! See you then"/);

    // Two open asks: a bare yes is ambiguous, a date picks one, "both" takes all.
    const b = await ask('2099-02-03');
    const c = await ask('2099-02-21');
    await reply('+19735550000', 'Sounds good');
    assert.deepEqual([state(b), state(c)], ['asked', 'asked']);
    await reply('+19735550000', 'Yes for Feb 21');
    assert.deepEqual([state(b), state(c)], ['asked', 'confirmed']);
    const d = await ask('2099-03-05');
    await reply('+19735550000', '👍 both work');
    assert.deepEqual([state(b), state(d)], ['confirmed', 'confirmed']);
    // Its own text still lands in Notes.
    assert.ok(app.db.prepare("SELECT 1 FROM notes WHERE body = 'Yes for Feb 21'").get());
  } finally { app.stop(); }
});

test('Sign-in page: remember this device keeps a signed cookie; wrong tries are limited; password change signs out', async () => {
  const mk = (pw) => createApp(loadConfig({ DOTENV: '0', DB_FILE: ':memory:', DRY_RUN: '1', ADMIN_PASSWORD: pw, APPROVERS: 'Mark:+12075550000:', CLEANER: 'Jenn:', BASE_URL: 'https://app.example' }));
  const app = mk('slalom');
  await new Promise(r => app.server.listen(0, r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const login = (password, extra = {}) => fetch(base + '/login', { method: 'POST', redirect: 'manual', body: new URLSearchParams({ password, ...extra }) });
  try {
    const go = await fetch(base + '/stays?x=1', { redirect: 'manual' });
    assert.equal(go.headers.get('location'), '/login?next=%2Fstays%3Fx%3D1');
    const page = await (await fetch(base + '/login?next=/stays')).text();
    assert.match(page, /name="remember" value="1" checked/);

    assert.equal((await login('nope')).status, 401);
    const ok = await login('slalom', { remember: '1', next: '/stays' });
    assert.equal(ok.status, 303);
    assert.equal(ok.headers.get('location'), '/stays');
    const set = ok.headers.get('set-cookie');
    assert.match(set, /cl_session=\d+\.[\w-]+; Path=\/; HttpOnly; SameSite=Lax; Secure; Max-Age=31536000/);
    const jar = { cookie: set.split(';')[0] };
    assert.equal((await fetch(base + '/stays', { headers: jar })).status, 200);
    // Without "remember", the cookie ends with the browser session.
    assert.doesNotMatch((await login('slalom')).headers.get('set-cookie'), /Max-Age/);
    // Open redirects are refused.
    assert.equal((await login('slalom', { next: '//evil.example' })).headers.get('location'), '/');
    // Tampered or old-password cookies don't work.
    const [exp] = jar.cookie.split('=')[1].split('.');
    assert.equal((await fetch(base + '/stays', { headers: { cookie: `cl_session=${Number(exp) + 1}.${jar.cookie.split('.')[1]}` }, redirect: 'manual' })).status, 303);
    const other = mk('changed');
    await new Promise(r => other.server.listen(0, r));
    try {
      assert.equal((await fetch(`http://127.0.0.1:${other.server.address().port}/stays`, { headers: jar, redirect: 'manual' })).status, 303);
    } finally { other.stop(); }
    // Sign out clears the cookie.
    assert.match((await fetch(base + '/logout', { method: 'POST', redirect: 'manual' })).headers.get('set-cookie'), /cl_session=; .*Max-Age=0/);
    // Ten wrong tries lock out even the right password for a while.
    for (let i = 0; i < 10; i++) await login('guess' + i);
    assert.equal((await login('slalom')).status, 429);
  } finally { app.stop(); }
});

test('Calendar feed URL is letters and digits even when Render\'s token has "/" "+" "="', async () => {
  const token = 'oVtk/w9VQ+XUR0re5iu/AfWM=';
  const config = loadConfig({ DOTENV: '0', DB_FILE: ':memory:', DRY_RUN: '1', ADMIN_PASSWORD: 'pw', FEED_TOKEN: token, APPROVERS: 'Mark:+12075550000:', CLEANER: 'Jenn:' });
  assert.match(config.feedId, /^[0-9a-f]{32}$/);
  const app = createApp(config);
  await new Promise(r => app.server.listen(0, r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  try {
    const r = await fetch(`${base}/feed/${config.feedId}.ics`);
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /text\/calendar/);
    assert.match(await r.text(), /^BEGIN:VCALENDAR\r\n/);
    assert.equal((await fetch(`${base}/feed/${token}.ics`)).status, 200, 'old link still works');
    assert.equal((await fetch(`${base}/feed/${'0'.repeat(32)}.ics`)).status, 404);
    const more = await (await fetch(base + '/more', { headers: { Authorization: 'Basic ' + Buffer.from('x:pw').toString('base64') } })).text();
    assert.ok(more.includes(`/feed/${config.feedId}.ics`));
  } finally { app.stop(); }
});

test('Logo, app icons and manifest are served without a login', async () => {
  const app = createApp(loadConfig({ DOTENV: '0', DB_FILE: ':memory:', DRY_RUN: '1', ADMIN_PASSWORD: 'pw', APPROVERS: 'Mark:+12075550000:', CLEANER: 'Jenn:' }));
  await new Promise(r => app.server.listen(0, r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  try {
    for (const [path, type] of [['/icon.svg', 'image/svg+xml'], ['/apple-touch-icon.png', 'image/png'], ['/icon-512.png', 'image/png'], ['/manifest.webmanifest', 'application/manifest+json']]) {
      const r = await fetch(base + path);
      assert.equal(r.status, 200, path);
      assert.equal(r.headers.get('content-type'), type);
    }
    const login = await (await fetch(base + '/login')).text();
    assert.match(login, /rel="apple-touch-icon" href="\/apple-touch-icon.png"/);
    assert.match(login, /class="brand"><img src="\/icon.svg"/);
  } finally { app.stop(); }
});

test('Phone notifications: encrypted Web Push that a browser can decrypt, and a 9 AM reminder for unsettled cleanings in the next 7 days', async () => {
  const sent = [];
  const fetchImpl = async (url, opts) => { sent.push({ url, ...opts }); return { ok: true, status: 201 }; };
  const app = createApp(loadConfig({ DOTENV: '0', DB_FILE: ':memory:', DRY_RUN: '1', ADMIN_PASSWORD: 'pw', APPROVERS: 'Mark:+12075550000:', CLEANER: 'Jenn:', TIMEZONE: 'America/Los_Angeles', BASE_URL: 'https://app.example' }), { fetchImpl });
  await new Promise(r => app.server.listen(0, r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const auth = { Authorization: 'Basic ' + Buffer.from('x:pw').toString('base64') };
  try {
    assert.equal((await fetch(base + '/sw.js')).status, 200);
    // A "phone": its own key pair and auth secret, as a browser makes them.
    const ua = crypto.createECDH('prime256v1'); const uaPub = ua.generateKeys(); const authSecret = crypto.randomBytes(16);
    const sub = { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', keys: { p256dh: uaPub.toString('base64url'), auth: authSecret.toString('base64url') } };
    assert.equal((await fetch(base + '/push/subscribe', { method: 'POST', headers: auth, body: new URLSearchParams({ sub: JSON.stringify(sub) }) })).status, 200);
    const more = await (await fetch(base + '/more', { headers: auth })).text();
    assert.match(more, /Phone notifications[\s\S]*Turned on for Mark/);

    // Nothing unsettled: no alert. Then a stay arrives in 5 days with no cleaning, and one
    // cleaning is waiting on Jenn: the 9 AM run alerts once that day.
    const at9 = (d) => new Date(localToUtc(d, '09:05', 'America/Los_Angeles'));
    const today = '2030-03-10';
    assert.equal((await app.push.dailyReminder(new Date(localToUtc(today, '08:00', 'America/Los_Angeles')))).skipped, 'before 9 AM');
    const now = new Date().toISOString();
    const ins = app.db.prepare('INSERT INTO bookings (uid,check_in,check_out,status,first_seen,last_seen,guest_name) VALUES (?,?,?,?,?,?,?)');
    ins.run('a', '2030-03-05', '2030-03-11', 'active', now, now, 'Chen');
    ins.run('b', '2030-03-15', '2030-03-18', 'active', now, now, 'Lopez');
    ins.run('c', '2030-03-25', '2030-03-27', 'active', now, now, 'Far');
    const { message } = await app.service.addManual('2030-03-12', null, 'Mark');
    await app.service.decideGroupMessage(message.token, true, 'Mark');
    app.db.prepare("UPDATE cleanings SET date='2030-03-11', group_known_date='2030-03-11'").run();
    const r = await app.push.dailyReminder(at9(today));
    assert.deepEqual(r.items.map(i => i.text), ['Mon, Mar 11 cleaning waiting on Jenn']);
    assert.equal(sent.length, 1);
    assert.equal((await app.push.dailyReminder(at9(today))).skipped, 'already sent today');
    // Next day the cleaning has moved past Lopez's arrival (and beyond the 7-day window).
    app.db.prepare("UPDATE cleanings SET date='2030-03-20', group_known_date='2030-03-20'").run();
    const r2 = await app.push.dailyReminder(at9('2030-03-11'));
    assert.deepEqual(r2.items.map(i => i.text), ['Lopez arrives Fri, Mar 15 with no cleaning set']);

    // The request is what a push service expects, and the phone can decrypt it (RFC 8291).
    const req = sent[1];
    assert.equal(req.url, sub.endpoint);
    assert.equal(req.headers['Content-Encoding'], 'aes128gcm');
    const [, token, k] = req.headers.Authorization.match(/^vapid t=([^,]+), k=(.+)$/);
    const [h64, c64, s64] = token.split('.');
    assert.equal(JSON.parse(Buffer.from(c64, 'base64url')).aud, 'https://fcm.googleapis.com');
    const vpub = Buffer.from(k, 'base64url');
    const vkey = crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: vpub.subarray(1, 33).toString('base64url'), y: vpub.subarray(33).toString('base64url') }, format: 'jwk' });
    assert.ok(crypto.verify('sha256', Buffer.from(`${h64}.${c64}`), { key: vkey, dsaEncoding: 'ieee-p1363' }, Buffer.from(s64, 'base64url')));
    const body = req.body;
    const salt = body.subarray(0, 16), idlen = body[20], asPub = body.subarray(21, 21 + idlen), ct = body.subarray(21 + idlen);
    const hm = (key, d) => crypto.createHmac('sha256', key).update(d).digest();
    const ikm = hm(hm(authSecret, ua.computeSecret(asPub)), Buffer.concat([Buffer.from('WebPush: info\0'), uaPub, asPub, Buffer.from([1])]));
    const prk = hm(salt, ikm);
    const dec = crypto.createDecipheriv('aes-128-gcm', hm(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01')).subarray(0, 16), hm(prk, Buffer.from('Content-Encoding: nonce\0\x01')).subarray(0, 12));
    dec.setAuthTag(ct.subarray(-16));
    const plain = Buffer.concat([dec.update(ct.subarray(0, -16)), dec.final()]);
    assert.equal(plain[plain.length - 1], 2);
    const msg = JSON.parse(plain.subarray(0, -1));
    assert.equal(msg.title, 'Cleaning not set yet');
    assert.match(msg.body, /Lopez arrives/);
    assert.equal(msg.url, '/inbox');

    // A phone that unsubscribed (410) is dropped.
    sent.length = 0;
    const gone = createApp(loadConfig({ DOTENV: '0', DB_FILE: ':memory:', DRY_RUN: '1', APPROVERS: 'Mark:+12075550000:', CLEANER: 'Jenn:' }), { fetchImpl: async () => ({ ok: false, status: 410 }) });
    gone.push.subscribe(sub, 'Mark');
    await gone.push.send({ title: 't', body: 'b' });
    assert.equal(gone.push.subscriptions().length, 0);
    gone.stop();
  } finally { app.stop(); }
});

test('A new Airbnb booking sends a phone notification that opens its cleaning for approval', async () => {
  const pushes = [];
  const fakePush = { bookingNews: async (r) => pushes.push(r), dailyReminder: async () => ({}), subscriptions: () => [], unsettled: () => [], publicKey: () => 'k' };
  const config = loadConfig({ DOTENV: '0', DB_FILE: ':memory:', DRY_RUN: '1', APPROVERS: 'Mark:+15550000001:', CLEANER: 'Jenn:', TIMEZONE: 'America/Los_Angeles' });
  const app = createApp(config, { push: fakePush });
  const sync = (stays) => app.sync({ icalText: airbnb(stays), now: NOW });
  // First check ever: existing bookings are not news.
  await sync([['s1', '2026-11-05', '2026-11-08']]);
  assert.equal(pushes.length, 0);
  // A new reservation arrives.
  await sync([['s1', '2026-11-05', '2026-11-08'], ['s2', '2026-11-20', '2026-11-23']]);
  assert.equal(pushes.length, 1);
  assert.deepEqual(pushes[0].newBookings.map(n => [n.uid, n.cleaning.date, !!n.covered]), [['s2', '2026-11-23', false]]);
  // Nothing new: no push. Dates change: a push about the change.
  await sync([['s1', '2026-11-05', '2026-11-08'], ['s2', '2026-11-20', '2026-11-23']]);
  assert.equal(pushes.length, 1);
  await sync([['s1', '2026-11-05', '2026-11-08'], ['s2', '2026-11-20', '2026-11-24']]);
  assert.deepEqual(pushes[1].changed.map(n => [n.uid, n.cleaning.date]), [['s2', '2026-11-24']]);
  app.stop();

  // The real notification text and link.
  const sent = [];
  const real = createApp(config, { fetchImpl: async (url, o) => { sent.push(o); return { ok: true, status: 201 }; } });
  const ua = crypto.createECDH('prime256v1'); const uaPub = ua.generateKeys();
  real.push.subscribe({ endpoint: 'https://push.example/x', keys: { p256dh: uaPub.toString('base64url'), auth: crypto.randomBytes(16).toString('base64url') } }, 'Mark');
  await real.sync({ icalText: airbnb([['s1', '2026-11-05', '2026-11-08']]), now: NOW });
  const r = await real.sync({ icalText: airbnb([['s1', '2026-11-05', '2026-11-08'], ['s2', '2026-11-20', '2026-11-23']]), now: NOW });
  const [msg] = await real.push.bookingNews(r);
  real.stop();
  assert.equal(msg.title, 'New Airbnb booking');
  assert.equal(msg.body, 'Guest ···1234, Fri, Nov 20 to Mon, Nov 23. Cleaning proposed for Mon, Nov 23. Tap to approve and text Jenn.');
  assert.equal(msg.url, `/?month=2026-11&review=${r.newBookings[0].cleaning.id}`);
  sent.length = 1;
  assert.equal(sent.length, 1);
});

test('Cleaning steps are tappable: cleaned, price quoted, paid (with date and method), undo; yearly records and spreadsheet download', async () => {
  const app = createApp(loadConfig({ DOTENV: '0', DB_FILE: ':memory:', DRY_RUN: '1', ADMIN_PASSWORD: 'pw', APPROVERS: 'Mark:+12075550000:,Danielle:+18315550000:', CLEANER: 'Jenn:', CLEANING_FEE: '0', TIMEZONE: 'America/Los_Angeles' }));
  await new Promise(r => app.server.listen(0, r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const auth = { Authorization: 'Basic ' + Buffer.from('x:pw').toString('base64') };
  const post = (path, data) => fetch(base + path, { method: 'POST', headers: auth, body: new URLSearchParams(data), redirect: 'manual' });
  try {
    const { cleaning } = await app.service.addManual('2026-11-04', null, 'Mark', { alreadyArranged: true });
    const id = cleaning.id;
    const stages = () => Object.fromEntries(app.service.stageOf(app.service.get(id)).map(s => [s.name, s.done]));
    let page = await (await fetch(`${base}/cleanings/${id}`, { headers: auth })).text();
    assert.match(page, /<button type="button" class="stage tap " data-open="cleaned-dialog">Cleaned<\/button>/);
    assert.match(page, /data-open="quote-dialog">Price quoted</);

    // Cleaned, then undo, then cleaned again.
    assert.equal((await post(`/cleanings/${id}/cleaned`, { yes: '1' })).headers.get('location'), `/cleanings/${id}`);
    assert.equal(app.service.get(id).status, 'completed');
    assert.ok(stages().Cleaned);
    await post(`/cleanings/${id}/cleaned`, { yes: '0' });
    assert.equal(app.service.get(id).status, 'approved');
    assert.ok(!stages().Cleaned);
    await post(`/cleanings/${id}/cleaned`, { yes: '1' });

    // Price quoted.
    await post(`/cleanings/${id}/quote`, { amount: '145.50' });
    assert.equal(app.service.get(id).amount_cents, 14550);
    assert.ok(stages()['Payment requested']);
    page = await (await fetch(`${base}/cleanings/${id}`, { headers: auth })).text();
    assert.match(page, /Price quoted: <b>\$145\.50<\/b>, not paid yet/);

    // The paid dialog asks who paid, defaulting to whoever is signed in.
    assert.match(page, /Who paid<br><select name="paid_by"[^>]*><option selected>Mark<\/option><option >Danielle<\/option><\/select>/);
    // Paid on a chosen date by Zelle, by Danielle.
    await post(`/cleanings/${id}/paid`, { amount: '145.50', paid_on: '2026-11-05', method: 'Zelle', paid_by: 'Danielle' });
    let c = app.service.get(id);
    assert.equal(c.status, 'paid');
    assert.equal(c.paid_at.slice(0, 10), '2026-11-05');
    assert.equal(c.paid_method, 'Zelle');
    assert.equal(c.paid_by, 'Danielle');
    assert.match(await (await fetch(`${base}/cleanings/${id}`, { headers: auth })).text(), /Paid <b>\$145\.50<\/b> on Thu, Nov 5 by Danielle via Zelle\./);
    assert.ok(stages().Paid);
    // Undo and pay again.
    await post(`/cleanings/${id}/paid`, { undo: '1' });
    assert.equal(app.service.get(id).status, 'completed');
    assert.equal(app.service.get(id).paid_by, null);
    await post(`/cleanings/${id}/paid`, { amount: '145.50', paid_on: '2026-11-06', method: 'Venmo', paid_by: 'Mark' });

    // Paying straight from "not cleaned yet" with an amount does all three steps.
    const two = (await app.service.addManual('2026-11-20', null, 'Mark', { alreadyArranged: true })).cleaning.id;
    await post(`/cleanings/${two}/paid`, { amount: '120', paid_on: '2026-11-21', method: 'Cash' });
    c = app.service.get(two);
    assert.deepEqual([c.status, c.amount_cents], ['paid', 12000]);
    // A 2025 payment doesn't count in 2026.
    const old = (await app.service.addManual('2026-11-25', null, 'Mark', { alreadyArranged: true })).cleaning.id;
    await post(`/cleanings/${old}/paid`, { amount: '99', paid_on: '2025-12-30', method: 'Check' });

    const pay = await (await fetch(`${base}/payments?year=2026`, { headers: auth })).text();
    assert.match(pay, /2026 total paid to Jenn: <b>\$265\.50<\/b> for 2 cleanings/);
    assert.match(pay, /<option selected>2026<\/option><option >2025<\/option>/);
    const csv = await fetch(`${base}/payments.csv?year=2026`, { headers: auth });
    assert.match(csv.headers.get('content-disposition'), /cleaning-payments-2026\.csv/);
    const lines = (await csv.text()).trim().split('\r\n');
    assert.equal(lines[0], 'Paid on,Cleaning date,Paid to,Amount (USD),Paid by,Method,Property,Cleaning ID');
    assert.equal(lines[1], `"2026-11-06","2026-11-04","Jenn","145.50","Mark","Venmo","2072 Slalom Ct","${id}"`);
    assert.equal(lines[3], '"","","Total","265.50","","","",""');
  } finally { app.stop(); }
});

test('Airbnb cancellation: phone alert, and tapping it offers to text Jenn only if she was texted', async () => {
  const config = loadConfig({ DOTENV: '0', DB_FILE: ':memory:', DRY_RUN: '1', ADMIN_PASSWORD: 'pw', APPROVERS: 'Mark:+15550000001:', CLEANER: 'Jenn:', TIMEZONE: 'America/Los_Angeles' });
  const app = createApp(config, { fetchImpl: async () => ({ ok: true, status: 201 }) });
  const news = [];
  const orig = app.push.bookingNews;
  app.push.bookingNews = async (r) => { const out = await orig(r); news.push(...out); return out; };
  const sync = (stays) => app.sync({ icalText: airbnb(stays), now: NOW });
  const all = [['s1', '2026-11-05', '2026-11-08'], ['s2', '2026-11-12', '2026-11-15'], ['s3', '2026-11-20', '2026-11-22']];
  await sync(all);
  // s1's cleaning was texted to the group; s2's never was.
  const c1 = app.db.prepare("SELECT * FROM cleanings WHERE booking_uid='s1'").get();
  await app.service.approve(c1.approval_token, 'Mark');
  const groupBefore = app.db.prepare("SELECT COUNT(*) n FROM outbox WHERE channel='group' OR body LIKE 'CLEANING CANCELLED%'").get().n;

  await sync([all[2]]);
  assert.equal(news.length, 2);
  const [a, b] = news;
  assert.equal(a.title, 'Airbnb booking cancelled');
  assert.match(a.body, /^Guest ···1234, Thu, Nov 5 to Sun, Nov 8\. The Sun, Nov 8 cleaning is cancelled\. Tap to text Jenn that it's off\.$/);
  const token = a.url.match(/msg=([\w-]+)/)[1];
  assert.match(b.body, /Jenn hadn't been texted, so nothing to send\.$/);
  assert.doesNotMatch(b.url, /msg=/);
  assert.equal(app.service.get(c1.id).status, 'cancelled');
  // Nothing went to Jenn by itself; the link opens the usual dialog.
  assert.equal(app.db.prepare("SELECT COUNT(*) n FROM outbox WHERE channel='group' OR body LIKE 'CLEANING CANCELLED%'").get().n, groupBefore);
  await new Promise(r => app.server.listen(0, r));
  try {
    const html = await (await fetch(`http://127.0.0.1:${app.server.address().port}${a.url}`, { headers: { Authorization: 'Basic ' + Buffer.from('x:pw').toString('base64') } })).text();
    assert.match(html, /<dialog id="msg-dialog">[\s\S]*CLEANING CANCELLED: Sun, Nov 8/);
    assert.ok(html.includes(token));
  } finally { app.stop(); }
});

test('GROUP_MODE=phone: approving opens Messages with the group; forwarded notifications become notes and confirm', async () => {
  const config = loadConfig({ DOTENV: '0', DB_FILE: ':memory:', DRY_RUN: '1', ADMIN_PASSWORD: 'pw', FEED_TOKEN: 'feedtok',
    APPROVERS: 'Mark:+15550000001,Danielle:+15550000002', CLEANER: 'Jenn:+15550000003', GROUP_MODE: 'phone',
    PHONE_ALIASES: 'Danielle=Dani', BASE_URL: 'http://test', TIMEZONE: 'America/Los_Angeles' });
  const app = createApp(config);
  await new Promise(r => app.server.listen(0, r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  try {
    await app.sync({ icalText: airbnb([['s1', '2027-01-05', '2027-01-08']]), now: NOW });
    const c = app.db.prepare('SELECT * FROM cleanings').get();
    // Danielle approves from her text link: Messages should open to Mark + Jenn, not to herself.
    const r = await fetch(`${base}/a/${c.approval_token}`, { method: 'POST', body: new URLSearchParams({ by: 'Danielle' }), redirect: 'manual' });
    assert.equal(r.status, 303);
    const loc = r.headers.get('location');
    assert.match(loc, /^\/g\/[\w-]+\?by=Danielle$/);
    const page = await (await fetch(base + loc)).text();
    assert.match(page, /Share to the group/);
    assert.match(page, /New cleaning request/);
    const gtok = loc.match(/\/g\/([\w-]+)/)[1];
    const status = () => app.db.prepare('SELECT status FROM group_messages WHERE token = ?').get(gtok).status;
    assert.equal(status(), 'pending');                       // approving alone sends nothing
    // A plain "send" (a computer, or no script) is refused and the text keeps waiting.
    const plain = await fetch(`${base}/g/${gtok}`, { method: 'POST', body: new URLSearchParams({ by: 'Danielle', send: '1' }) });
    assert.equal(plain.status, 409);
    assert.equal(status(), 'pending');
    // Shared from a phone: now it counts.
    const shared = await (await fetch(`${base}/g/${gtok}`, { method: 'POST', body: new URLSearchParams({ by: 'Danielle', send: '1', shared: '1', js: '1' }) })).json();
    assert.equal(shared.status, 'sent');
    assert.equal(app.db.prepare("SELECT status FROM outbox WHERE channel='group'").get().status, 'on phone');
    // "Didn't go out? Send again" puts it back to waiting (signed in only).
    const auth2 = { Authorization: 'Basic ' + Buffer.from('x:pw').toString('base64') };
    assert.match(await (await fetch(`${base}/cleanings/${c.id}`, { headers: auth2 })).text(), /Didn't go out\? Send again/);
    await fetch(`${base}/g/${gtok}`, { method: 'POST', headers: auth2, body: new URLSearchParams({ by: 'Mark', send: 'unsend' }), redirect: 'manual' });
    assert.equal(status(), 'pending');
    await fetch(`${base}/g/${gtok}`, { method: 'POST', body: new URLSearchParams({ by: 'Danielle', send: '1', shared: '1', js: '1' }) });
    assert.equal(status(), 'sent');

    // Wrong key is refused.
    assert.equal((await fetch(`${base}/phone/inbound?key=nope`, { method: 'POST', body: 'text=yes' })).status, 403);
    const key = config.phone.key;
    // Two notification styles: sender in the title, or "Name: text" under the group name.
    const a = await (await fetch(`${base}/phone/inbound?key=${key}`, { method: 'POST', body: new URLSearchParams({ title: 'Jenn Patterson', text: 'Yes I can do it' }) })).json();
    assert.deepEqual([a.saved, a.author, a.confirmed], [true, 'Jenn', ['2027-01-08']]);
    const b = await (await fetch(`${base}/phone/inbound?key=${key}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'Slalom cleaning', text: 'Dani: out of paper towels' }) })).json();
    assert.deepEqual([b.saved, b.author], [true, 'Danielle']);
    // The same notification forwarded twice is saved once.
    const dup = await (await fetch(`${base}/phone/inbound?key=${key}`, { method: 'POST', body: new URLSearchParams({ title: 'Jenn Patterson', text: 'Yes I can do it' }) })).json();
    assert.equal(dup.reason, 'duplicate');
    assert.equal(app.db.prepare('SELECT COUNT(*) n FROM notes').get().n, 2);
    assert.ok(app.db.prepare('SELECT cleaner_confirmed_at FROM cleanings').get().cleaner_confirmed_at);
    const more = await (await fetch(base + '/more', { headers: { Authorization: 'Basic ' + Buffer.from('x:pw').toString('base64') } })).text();
    assert.match(more, /Group text \(through your phone\)/);
    assert.match(more, /\/phone\/inbound\?key=/);
  } finally { app.server.close(); app.stop?.(); }
});

test('Group payment texts: "done, $140" bills the cleaning, "paid" pays it, unclear ones are asked about', async () => {
  const { classifyPaymentText, amountIn } = await import('../src/textpay.js');
  assert.equal(amountIn('All done! $140'), 14000);
  assert.equal(amountIn('Finished, total is 165'), 16500);
  assert.equal(amountIn('done at 2:30'), null);
  assert.equal(classifyPaymentText('Will be done by 3', { fromCleaner: true }), null);
  assert.deepEqual(classifyPaymentText('All done! $140', { fromCleaner: true }), { kind: 'done', done: true, amount: 14000 });
  assert.equal(classifyPaymentText("I'll pay you tonight", { fromOwner: true }), null);
  assert.equal(classifyPaymentText('Did you get paid?', { fromOwner: true }), null);
  assert.deepEqual(classifyPaymentText('Paid! Sent on Venmo', { fromOwner: true }), { kind: 'paid', amount: null, method: 'Venmo' });

  const config = loadConfig({ DOTENV: '0', DB_FILE: ':memory:', DRY_RUN: '1', ADMIN_PASSWORD: 'pw', FEED_TOKEN: 'feedtok',
    APPROVERS: 'Mark:+15550000001,Danielle:+15550000002', CLEANER: 'Jenn:+15550000003', GROUP_MODE: 'phone', BASE_URL: 'http://test', TIMEZONE: 'America/Los_Angeles' });
  const app = createApp(config);
  // Two cleanings already done (in the past), no amounts yet.
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
  const minus = (n) => { const d = new Date(today + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() - n); return d.toISOString().slice(0, 10); };
  const mk = (date) => Number(app.db.prepare(`INSERT INTO cleanings (source, date, status, created_at, updated_at) VALUES ('manual', ?, 'approved', ?, ?)`).run(date, 'x', 'x').lastInsertRowid);
  const a = mk(minus(5)), b = mk(today);
  const say = (author, body) => app.textPay.handle(app.notes.add({ body, author, source: 'group' }));
  // Jenn texts today: the cleaning dated today is the one.
  let r = say('Jenn', 'All done! $140 for today');
  assert.equal(r.applied.id, b);
  assert.equal(app.service.get(b).status, 'completed');
  assert.equal(app.service.get(b).amount_cents, 14000);
  // Danielle: "paid $140" matches the one owed amount.
  r = say('Danielle', 'Paid $140 on Zelle, thanks Jenn!');
  assert.equal(r.applied[0].status, 'paid');
  assert.equal(app.service.get(b).paid_method, 'Zelle');
  assert.equal(app.service.get(b).paid_by, 'Danielle');
  // A "done" text with no cleaning on that day and two candidates: asked about.
  mk(minus(3));
  r = say('Jenn', 'Done, it was $150');
  assert.ok(r.pending);
  assert.equal(app.textPay.pending().length, 1);
  // A "done" text that names a coming cleaning's date ("Dec 4 cleaning is done") goes to it.
  const plus = (n) => minus(-n);
  const soon = mk(plus(7));
  const [, sm, sd] = plus(7).split('-').map(Number);
  const early = say('Jenn', `${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][sm - 1]} ${sd} cleaning is done`);
  assert.equal(early.applied?.id, soon);
  assert.equal(app.service.get(soon).status, 'completed');
  assert.equal(app.textPay.pending().length, 1);
  await new Promise(res => app.server.listen(0, res));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const auth = { Authorization: 'Basic ' + Buffer.from('x:pw').toString('base64') };
  try {
    const dash = await (await fetch(base + '/', { headers: auth })).text();
    assert.match(dash, /Which cleaning is Jenn talking about\?/);
    assert.match(dash, /Done, it was \$150/);
    const post = await fetch(`${base}/text-matches/${r.pending.id}`, { method: 'POST', headers: auth, body: new URLSearchParams({ cleaning_id: String(a), amount: '150' }), redirect: 'manual' });
    assert.equal(post.status, 303);
    assert.equal(app.service.get(a).amount_cents, 15000);
    assert.equal(app.textPay.pending().length, 0);
    // Any cleaning can be picked under "Another cleaning", e.g. one far ahead she misdated.
    const far = mk(plus(40));
    const odd = say('Danielle', 'Paid $95 on Venmo').pending;
    assert.ok(odd);
    const dlg = await (await fetch(base + '/', { headers: auth })).text();
    assert.match(dlg, new RegExp(`<option value="${far}">`));
    await fetch(`${base}/text-matches/${odd.id}`, { method: 'POST', headers: auth, body: new URLSearchParams({ cleaning_id: 'other', other_id: String(far), method: 'Venmo' }), redirect: 'manual' });
    assert.equal(app.service.get(far).status, 'paid');
    assert.equal(app.service.get(far).amount_cents, 9500);

    // Photos shared in from Messages: held, then saved to the picked cleaning, then a guest link.
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 1)]);
    const fd = new FormData();
    fd.append('photos', new Blob([jpeg], { type: 'image/jpeg' }), 'a.jpg');
    fd.append('photos', new Blob([Buffer.from('not a photo')], { type: 'image/jpeg' }), 'b.jpg');
    const shared = await fetch(base + '/share-photos', { method: 'POST', body: fd, redirect: 'manual' });
    assert.equal(shared.status, 303);
    const loc = shared.headers.get('location');
    assert.match(await (await fetch(base + loc, { headers: auth })).text(), /Save 1 photo/);
    assert.equal((await fetch(base + loc, { redirect: 'manual' })).status, 303);    // not signed in: sign in first
    await fetch(base + loc, { method: 'POST', headers: auth, body: new URLSearchParams({ cleaning_id: String(b) }), redirect: 'manual' });
    assert.equal(app.photos.list(b).length, 1);
    const page = await (await fetch(`${base}/cleanings/${b}`, { headers: auth })).text();
    const link = page.match(/"http:\/\/test(\/p\/[a-f0-9]{24})"/)[1];
    const guest = await (await fetch(base + link)).text();
    assert.match(guest, /ready for you|Freshly cleaned/);
    const img = await fetch(`${base}${link}/${app.photos.list(b)[0].id}`);
    assert.equal(img.headers.get('content-type'), 'image/jpeg');
    assert.equal((await fetch(`${base}/p/${'0'.repeat(24)}`)).status, 404);
  } finally { app.server.close(); app.stop?.(); }
});

test('Delete a hand-added cleaning completely; Airbnb cleanings cannot be deleted', async () => {
  const { app } = setup();
  await new Promise(r => app.server.listen(0, r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const auth = { Authorization: 'Basic ' + Buffer.from('x:pw').toString('base64') };
  try {
    const mk = (source) => Number(app.db.prepare(`INSERT INTO cleanings (source, date, status, booking_uid, created_at, updated_at) VALUES (?, '2027-02-10', 'approved', ?, 'x', 'x')`).run(source, source === 'airbnb' ? 'u1' : null).lastInsertRowid);
    const hand = mk('manual'), air = mk('airbnb');
    app.service.logEvent(hand, 'Approved', 'by Mark');
    const note = app.notes.add({ body: 'test note', author: 'Mark', cleaningId: hand });
    assert.match(await (await fetch(`${base}/cleanings/${hand}`, { headers: auth })).text(), /Delete cleaning/);
    assert.doesNotMatch(await (await fetch(`${base}/cleanings/${air}`, { headers: auth })).text(), /Delete cleaning/);
    const r = await fetch(`${base}/cleanings/${hand}/delete`, { method: 'POST', headers: auth, redirect: 'manual' });
    assert.match(decodeURIComponent(r.headers.get('location')), /Deleted the/);
    assert.equal(app.service.get(hand), undefined);
    assert.equal(app.db.prepare('SELECT COUNT(*) n FROM events WHERE cleaning_id = ?').get(hand).n, 0);
    assert.equal(app.db.prepare('SELECT cleaning_id FROM notes WHERE id = ?').get(note.id).cleaning_id, null);
    assert.equal(app.db.prepare("SELECT COUNT(*) n FROM outbox").get().n, 0);   // nothing texted
    await fetch(`${base}/cleanings/${air}/delete`, { method: 'POST', headers: auth, redirect: 'manual' });
    assert.ok(app.service.get(air));
  } finally { app.server.close(); app.stop?.(); }
});

test('Phone inbox: a notification carrying several lines saves each new line once', async () => {
  const config = loadConfig({ DOTENV: '0', DB_FILE: ':memory:', DRY_RUN: '1', ADMIN_PASSWORD: 'pw', FEED_TOKEN: 'feedtok',
    APPROVERS: 'Mark:+15550000001', CLEANER: 'Jen:+15550000003', GROUP_MODE: 'phone', PHONE_ALIASES: 'Jen=MC iPhone', BASE_URL: 'http://test', TIMEZONE: 'America/Los_Angeles' });
  const app = createApp(config);
  try {
    let r = app.phoneInbox.receive({ title: 'MC iPhone', text: 'yes I can do that one' });
    assert.equal(r.author, 'Jen');
    // The second text updates the same notification, which now holds both lines.
    r = app.phoneInbox.receive({ title: 'MC iPhone', text: 'yes I can do that one\nAll done! $10' });
    assert.equal(r.savedLines, 1);
    assert.deepEqual(app.db.prepare('SELECT body FROM notes ORDER BY id').all().map(n => n.body), ['yes I can do that one', 'All done! $10']);
    r = app.phoneInbox.receive({ title: 'MC iPhone', text: '2 new messages' });
    assert.equal(r.saved, false);
  } finally { app.stop?.(); }
});

test('A group text shared into the app by hand is handled like a forwarded one', async () => {
  const config = loadConfig({ DOTENV: '0', DB_FILE: ':memory:', DRY_RUN: '1', ADMIN_PASSWORD: 'pw', FEED_TOKEN: 'feedtok',
    APPROVERS: 'Mark:+15550000001', CLEANER: 'Jen:+15550000003', GROUP_MODE: 'phone', BASE_URL: 'http://test', TIMEZONE: 'America/Los_Angeles' });
  const app = createApp(config);
  await new Promise(r => app.server.listen(0, r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const auth = { Authorization: 'Basic ' + Buffer.from('x:pw').toString('base64') };
  try {
    const fd = new FormData(); fd.append('text', 'All done! $120');
    const r = await fetch(base + '/share-photos', { method: 'POST', body: fd, redirect: 'manual' });
    assert.match(r.headers.get('location'), /^\/share-text\?text=All%20done/);
    const page = await (await fetch(base + r.headers.get('location'), { headers: auth })).text();
    assert.match(page, /value="Jen" checked/);
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
    const id = Number(app.db.prepare(`INSERT INTO cleanings (source, date, status, created_at, updated_at) VALUES ('manual', ?, 'approved', 'x', 'x')`).run(today).lastInsertRowid);
    await fetch(base + '/share-text', { method: 'POST', headers: auth, body: new URLSearchParams({ body: 'All done! $120', author: 'Jen' }), redirect: 'manual' });
    assert.equal(app.service.get(id).amount_cents, 12000);
    assert.equal(app.db.prepare('SELECT author FROM notes').get().author, 'Jen');
  } finally { app.server.close(); app.stop?.(); }
});

test('A confirmed cleaning can be put back to waiting on the cleaner from its page', async () => {
  const { app } = setup();
  await new Promise(r => app.server.listen(0, r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const auth = { Authorization: 'Basic ' + Buffer.from('x:pw').toString('base64') };
  try {
    const id = Number(app.db.prepare(`INSERT INTO cleanings (source, date, status, group_known_date, cleaner_confirmed_at, created_at, updated_at) VALUES ('manual', '2027-03-10', 'approved', '2027-03-10', 'x', 'x', 'x')`).run().lastInsertRowid);
    const page = await (await fetch(`${base}/cleanings/${id}`, { headers: auth })).text();
    assert.match(page, /data-open="confirm-dialog">✓ Cleaner confirmed/);
    assert.match(page, /action="\/cleanings\/\d+\/unconfirm"/);
    await fetch(`${base}/cleanings/${id}/unconfirm`, { method: 'POST', headers: auth, redirect: 'manual' });
    assert.equal(app.service.get(id).cleaner_confirmed_at, null);
    assert.equal(app.db.prepare('SELECT COUNT(*) n FROM outbox').get().n, 0);
    assert.match(await (await fetch(`${base}/cleanings/${id}`, { headers: auth })).text(), /action="\/cleanings\/\d+\/confirm"/);
  } finally { app.server.close(); app.stop?.(); }
});

test('live screens: pages carry a fingerprint that changes only when the data does', async () => {
  const { app, sync } = setup();
  await new Promise(r => app.server.listen(0, r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const auth = { Authorization: 'Basic ' + Buffer.from('x:pw').toString('base64') };
  const live = async () => (await (await fetch(base + '/live', { headers: auth })).json()).v;
  try {
    assert.equal((await fetch(base + '/live', { headers: { accept: 'application/json' } })).status, 401);
    await sync([['s1', '2026-11-05', '2026-11-08']]);
    // Every signed-in page embeds the same fingerprint /live reports, so opening a page never
    // triggers a refresh by itself (a page that wrote on GET would refresh forever).
    for (const page of ['/?month=2026-11', '/inbox', '/stays', '/payments', '/more', '/todos', '/notes']) {
      const html = await (await fetch(base + page, { headers: auth })).text();
      const v = html.match(/const v0="([0-9a-f]{16})"/)?.[1];
      assert.ok(v, page);
      assert.equal(v, await live(), page);
    }
    const before = await live();
    // The Airbnb check finding the same stays again changes nothing on screen.
    await sync([['s1', '2026-11-05', '2026-11-08']]);
    assert.equal(await live(), before);
    // A new booking does.
    await sync([['s1', '2026-11-05', '2026-11-08'], ['s2', '2026-11-12', '2026-11-14']]);
    const afterBooking = await live();
    assert.notEqual(afterBooking, before);
    // So does approving a cleaning.
    const c = app.db.prepare("SELECT approval_token FROM cleanings WHERE status='awaiting_approval' ORDER BY date LIMIT 1").get();
    await app.service.approve(c.approval_token, 'Mark');
    assert.notEqual(await live(), afterBooking);
  } finally { app.server.close(); }
});

test('cleaner says no and offers another day: moved if it fits between stays, else left with a reason', async () => {
  const { app } = setup();
  const pushes = [];
  app.service.hooks.suggested = (r) => pushes.push(r);
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
  const plus = (n) => { const d = new Date(today + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  const book = (uid, a, b) => app.db.prepare("INSERT INTO bookings (uid, check_in, check_out, summary, status, first_seen, last_seen) VALUES (?,?,?,'Reserved','active','x','x')").run(uid, a, b);
  book('a', plus(7), plus(10));   // checks out day 10
  book('b', plus(14), plus(16));  // next guests arrive day 14
  const id = Number(app.db.prepare("INSERT INTO cleanings (source, date, status, group_known_date, created_at, updated_at) VALUES ('manual', ?, 'approved', ?, 'x', 'x')").run(plus(10), plus(10)).lastInsertRowid);
  const md = (d) => `${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][+d.slice(5, 7) - 1]} ${+d.slice(8)}`;
  // A yes is still a yes, and someone else's "no" does nothing.
  assert.equal(app.service.cleanerReply({ body: `Can't do ${md(plus(10))}, sorry`, author: 'Mark' }).suggestion, undefined);
  // She can't do day 10 and offers day 12: inside the turnover, so it moves and is confirmed.
  let r = app.service.cleanerReply({ body: `Sorry, I can't do ${md(plus(10))}. How about ${md(plus(12))}?`, author: 'Rosa' });
  assert.equal(r.suggestion.moved, true);
  let c = app.service.get(id);
  assert.equal(c.date, plus(12));
  assert.equal(c.group_known_date, plus(12));
  assert.ok(c.cleaner_confirmed_at);
  assert.equal(pushes.length, 1);
  // Day 15 is after the next guests arrive: not moved, and the reason is given.
  r = app.service.cleanerReply({ body: `Actually I can't that day, could do ${md(plus(15))}`, author: 'Rosa' });
  assert.equal(r.suggestion.moved, false);
  assert.match(r.suggestion.why, /next guests arrive/);
  assert.equal(app.service.get(id).date, plus(12));
  // Before the previous guests leave doesn't fit either.
  r = app.service.cleanerReply({ body: `No, can I come ${md(plus(9))} instead?`, author: 'Rosa' });
  assert.equal(r.suggestion.moved, false);
  assert.match(r.suggestion.why, /check out/);
  // Nothing was texted to the group.
  assert.equal(app.db.prepare("SELECT COUNT(*) n FROM outbox").get().n, 0);
  assert.equal(app.db.prepare("SELECT COUNT(*) n FROM group_messages WHERE status='pending'").get().n, 0);
  // Phones type a curly apostrophe: "can’t" is still can't, not "I can" (a yes).
  const id2 = Number(app.db.prepare("INSERT INTO cleanings (source, date, status, group_known_date, created_at, updated_at) VALUES ('manual', ?, 'approved', ?, 'x', 'x')").run(plus(16), plus(16)).lastInsertRowid);
  book('c', plus(20), plus(22));
  r = app.service.cleanerReply({ body: `I can’t do the ${+plus(16).slice(8)}th, how about the day after`, author: 'Rosa' });
  assert.deepEqual(r.confirmed, []);
  assert.equal(r.suggestion?.moved, true);
  assert.equal(app.service.get(id2).date, plus(17));
  // Friendly texts that happen to have "no"/"can't" and a day aren't suggestions.
  assert.equal(app.service.cleanerReply({ body: `No problem, see you ${md(plus(13))}!`, author: 'Rosa' }).suggestion, undefined);
  assert.equal(app.service.cleanerReply({ body: `Can't wait, ${md(plus(13))} it is`, author: 'Rosa' }).suggestion, undefined);
  // A "done" text with a date is not a suggestion.
  assert.equal(app.service.cleanerReply({ body: `${md(plus(12))} cleaning is done`, author: 'Rosa' }).suggestion, undefined);
});

test('cleaner offers another day: words ("the third"), "yes, the 3rd", and other cleanings on the calendar', async () => {
  const { app } = setup();
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
  const plus = (n) => { const d = new Date(today + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  const book = (uid, a, b) => app.db.prepare("INSERT INTO bookings (uid, check_in, check_out, summary, status, first_seen, last_seen) VALUES (?,?,?,'Reserved','active','x','x')").run(uid, a, b);
  const mk = (d, confirmed) => Number(app.db.prepare("INSERT INTO cleanings (source, date, status, group_known_date, cleaner_confirmed_at, created_at, updated_at) VALUES ('manual', ?, 'approved', ?, ?, 'x', 'x')").run(d, d, confirmed ? 'x' : null).lastInsertRowid);
  const ords = ['', 'first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth', 'eleventh', 'twelfth', 'thirteenth', 'fourteenth', 'fifteenth', 'sixteenth', 'seventeenth', 'eighteenth', 'nineteenth', 'twentieth'];
  const word = (d) => { const n = +d.slice(8); return n <= 20 ? ords[n] : n === 30 ? 'thirtieth' : `${n < 30 ? 'twenty' : 'thirty'}-${ords[n % 10]}`; };
  // Guests leave day 5, next arrive day 12. Two more confirmed cleanings later on.
  book('a', plus(2), plus(5)); book('b', plus(12), plus(14)); book('c', plus(30), plus(33));
  const id = mk(plus(6), false);
  mk(plus(14), true); mk(plus(33), true);
  const reply = (body) => app.service.cleanerReply({ body, author: 'Rosa' });
  // Ordinals in words, curly apostrophe, several cleanings on the calendar.
  let r = reply(`Sorry I can’t do the ${word(plus(6))} but can I do the day after?`);
  assert.equal(r.suggestion?.moved, true, JSON.stringify(r));
  assert.equal(app.service.get(id).date, plus(7));
  // "Yes, the Nth" naming another day that fits moves it (and confirms), instead of confirming the old day.
  app.db.prepare("UPDATE cleanings SET cleaner_confirmed_at = NULL WHERE id = ?").run(id);
  const n9 = +plus(9).slice(8), sfx = n9 % 10 === 1 && n9 !== 11 ? 'st' : n9 % 10 === 2 && n9 !== 12 ? 'nd' : n9 % 10 === 3 && n9 !== 13 ? 'rd' : 'th';
  r = reply(`Yes the ${n9}${sfx}`);
  assert.equal(app.service.get(id).date, plus(9), JSON.stringify(r));
  assert.ok(app.service.get(id).cleaner_confirmed_at);
  // A plain yes still just confirms.
  app.db.prepare("UPDATE cleanings SET cleaner_confirmed_at = NULL WHERE id = ?").run(id);
  r = reply('Yes!');
  assert.deepEqual(r.confirmed.map(c => c.id), [id]);
  assert.equal(app.service.get(id).date, plus(9));
});

test('"Let’s do the 3rd" moves the cleaning waiting on her answer, even with another cleaning in the same gap', async () => {
  const { app } = setup();
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
  const plus = (n) => { const d = new Date(today + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  const book = (uid, a, b) => app.db.prepare("INSERT INTO bookings (uid, check_in, check_out, summary, status, first_seen, last_seen) VALUES (?,?,?,'Reserved','active','x','x')").run(uid, a, b);
  const mk = (d, confirmed) => Number(app.db.prepare("INSERT INTO cleanings (source, date, status, group_known_date, cleaner_confirmed_at, created_at, updated_at) VALUES ('manual', ?, 'approved', ?, ?, 'x', 'x')").run(d, d, confirmed ? 'x' : null).lastInsertRowid);
  // Like Mark's calendar: guests leave day 4, next arrive day 8; a confirmed cleaning on day 5, a test one asked on day 7.
  book('john', plus(1), plus(4)); book('rishab', plus(8), plus(10));
  const real = mk(plus(5), true), asked = mk(plus(7), false);
  const n = +plus(6).slice(8), sfx = n % 10 === 1 && n !== 11 ? 'st' : n % 10 === 2 && n !== 12 ? 'nd' : n % 10 === 3 && n !== 13 ? 'rd' : 'th';
  const r = app.service.cleanerReply({ body: `Let’s do the ${n}${sfx}`, author: 'Rosa' });
  assert.equal(r.suggestion?.moved, true, JSON.stringify(r));
  assert.equal(app.service.get(asked).date, plus(6));
  assert.ok(app.service.get(asked).cleaner_confirmed_at);
  assert.equal(app.service.get(real).date, plus(5));
  assert.equal(app.db.prepare("SELECT COUNT(*) n FROM cleanings").get().n, 2);
  // A day named with nothing waiting on her is left alone (no surprise moves).
  assert.equal(app.service.cleanerReply({ body: `the ${n}${sfx} was nice`, author: 'Rosa' }).suggestion, undefined);
});

test('Messages system notices are not saved as texts', async () => {
  const { app } = setup();
  const r = app.phoneInbox.receive({ title: 'Messages', text: 'Messages is doing work in the background' });
  assert.equal(r.saved, false);
  assert.equal(app.db.prepare("SELECT COUNT(*) n FROM notes").get().n, 0);
});

// Jen's real texts from the group, Nov 2 to Nov 17, as the phone forwards them (title is her
// contact name; long texts arrive as several lines). Each one is replayed while a cleaning is
// waiting on her answer and a finished one has no amount yet, the moment a misread would hurt most.
test('Jen\'s real group texts: only the cleaning ones do anything', async () => {
  const JEN = [
    // [text, what should happen]
    ['Both dates are confirmed', 'confirm'],
    ['Great! 🙌', 'confirm'],
    ["I'm here", 'nothing'],
    ['Got it. Thanks', 'confirm'],
    ['There are no pillows on the bunkers in the closet.\n\nShould I add Pillows or no?', 'nothing'],
    ['👍', 'confirm'],
    ["Okay.  If it doesn't come by the time I'm done I'm working across the street tomorrow morning at 7:30am. I'll check again.", 'nothing'],
    ['What is the wifi here?', 'nothing'],
    ["I bought this amazing vacuum and mopping system.  But I need the wifi and password to get it going.\n\nMy new assistant 😆\n\nIt will do the floors while I'm cleaning.", 'nothing'],
    ["You're all set! 5.5hrs\n$275\n\n I cleaned from ceiling to floor.\n\nGarbage cans,  cabinets, refrigerator, freezer,  cabinets,  vanities, cobwebs, ceiling fans,  exhaust fans in bathrooms...\n\nNow it should be easy to turn over without deep cleaning.\n\nCan you close the garage door or do you want me to try and do it from inside?\n\nJen", 'done 275'],
    ["You're welcome!", 'nothing'],
    ["I'm coming to you tomorrow.  Is pinyin checking in the same day?\n\nI have PT from 10:49am to 11am.\n\nCan I Come after that?", 'nothing'],
    ["I'm here. Looks like only one bed was used.", 'nothing'],
    ["I'm done for today.  You are my second house.\n\nI'll be back tomorrow to finish.", 'nothing'],
    ['😊', 'nothing'],
    ["I'm back to finish", 'nothing'],
    ["They didn't do any dishes,  strip bed,  or take out garbage.\n\nIs that something you tell them to start before leaving?\n\nIf not then yes 5 stars.\n\nWe usually ask that they stay a loud of towels/ linens.  Fill and start the dishwasher.  And most importantly take the trash out to the bear box.\n\nI've encountered 3 beats this year and one racoon.  Some mice. Which is usual this time of year.  But I bear can mess the inside of a house really quick.\n\nOh yeah, and make sure the flu is shut on the fireplace.\n\nThey had 2 huge birds come down the chimney last year across the street from you 😆\n\n3hrs $150\n\nJen", 'done 150'],
    ["tomorrow.  I vacuumed the couch and strange\nSteam mopped.  I'll always do my best. And will do my best.\n\nI spent 2 days deep cleaning bathrooms.\n\nThis is the first time I've gotten a bad review.\n\nSorry.  We will make it right.  To the best of my ability.\n\nBut I was totally satisfied with the clean.\n\nI stand behind my work.\n\nHugs,\nJen", 'nothing'],
    ['I do. And I want us all to have a great experience.', 'nothing'],
    ["But I will always try harder.\n\nQuestion.  What do I do to maintain the sauna?\n\nThe garage could use a a good sweep .\n\nI'll be done with my clean on Christie at 2pm tomorrow.\n\nAnd I'm preparing for the storm coming in on Friday.\n\nPlease give me info on the complaint and I'll make sure it's almost good.", 'nothing'],
    ["Thank you.  I'm at a house around the corner.  I'll go straight there as soon as I'm done.", 'nothing'],
    ["I'm here.", 'nothing'],
    ["I'm so sorry this is happening.\n\nThis is the fixed pics of what she took pics of.\n\nLiterally blown out of proportion and photos blown up!\n\nSure. I missed some shampoo spilled on the shower wall.  The bathroom sinks are immaculate. And I did miss one of the door frames or of the 4 of  them.\n\nI'm going to call you.", 'nothing'],
    ['No worries', 'nothing'],
    ['If you could call me when you get a chance,  that would be great.\n\nSorry to bother you.\n\nJen', 'nothing'],
    ["Sure.  That's a great idea.\n\nI have PT for my knee at 10:40am at PT Revolution in the keys.\n\nI plan on going right after that.\n\nWe have a storm coming on Wed. Supposed to get 18 inches off snow at lake level and a few feet up at the top of heavenly.\n\nI'll get the cobweb tool from next door and work in the garage today.\n\nJen\n\nI'll text you when I arrive.\n\nJen", 'confirm'],
    ["I don't see any new kitchen sponges.\n\nI just ordered 50 across the street.  I'll bring a few over until you can order some.", 'nothing'],
    ["Okay.  Check out was good except she didn't start the laundry.\n\nEverything else was done.  I organized more cabinets in the kitchen and the linen closet again.", 'nothing'],
    ['3hr $150', 'done 150'],
    ['No worries.  Oh and I cleaned the garage floor but forgot to take a Pic 😆', 'nothing'],
    ['Thanks!', 'nothing'],
  ];
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
  const plus = (n) => { const d = new Date(today + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  const wrong = [];
  for (const [text, want] of JEN) {
    const config = loadConfig({ DOTENV: '0', DB_FILE: ':memory:', DRY_RUN: '1', ADMIN_PASSWORD: 'pw', FEED_TOKEN: 'feedtok', GROUP_MODE: 'phone',
      APPROVERS: 'Mark:+15550000001,Danielle:+15550000002', CLEANER: 'Jen:+15550000003', TIMEZONE: 'America/Los_Angeles' });
    const app = createApp(config);
    const book = (uid, a, b) => app.db.prepare("INSERT INTO bookings (uid, check_in, check_out, summary, status, first_seen, last_seen) VALUES (?,?,?,'Reserved','active','x','x')").run(uid, a, b);
    book('past', plus(-4), plus(-1)); book('soon', plus(3), plus(6)); book('later', plus(12), plus(15));
    const mk = (d, status) => Number(app.db.prepare("INSERT INTO cleanings (source, date, status, group_known_date, created_at, updated_at) VALUES ('manual', ?, ?, ?, 'x', 'x')").run(d, status, d).lastInsertRowid);
    const finished = mk(plus(-1), 'approved'), asked = mk(plus(6), 'approved'), asked2 = mk(plus(15), 'approved');
    app.phoneInbox.receive({ title: 'Jennifer Patterson', text });
    const f = app.service.get(finished), a = app.service.get(asked), a2 = app.service.get(asked2);
    const got = a.date !== plus(6) || a2.date !== plus(15) ? 'moved'
      : f.status !== 'approved' ? `done${f.amount_cents ? ' ' + f.amount_cents / 100 : ''}`
      : a.cleaner_confirmed_at || a2.cleaner_confirmed_at ? 'confirm' : 'nothing';
    // "Both dates" confirms both asks; any other confirm needs a single ask, so it confirms neither here.
    const expect = want === 'confirm' ? (/both/i.test(text) ? 'confirm' : 'nothing') : want;
    if (got !== expect) wrong.push(`${JSON.stringify(text.slice(0, 60))}: got ${got}, want ${expect}`);
    if (want === 'confirm' && !/both/i.test(text)) {
      // With just one cleaning waiting, a short yes confirms it.
      app.db.prepare('DELETE FROM cleanings WHERE id = ?').run(asked2);
      app.service.cleanerReply({ body: text.split('\n')[0], author: 'Jen' });
      if (!app.service.get(asked).cleaner_confirmed_at) wrong.push(`${JSON.stringify(text.slice(0, 60))}: one cleaning waiting, not confirmed`);
    }
  }
  assert.deepEqual(wrong, []);
});

test('a proposed cleaning can be approved from its own page, as well as from Waiting on you', async () => {
  const { app, sync } = setup();
  await sync([['s1', '2026-12-05', '2026-12-08'], ['s2', '2026-12-12', '2026-12-14']]);
  await new Promise(r => app.server.listen(0, r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const auth = { Authorization: 'Basic ' + Buffer.from('x:pw').toString('base64') };
  try {
    const [a, b] = app.db.prepare("SELECT * FROM cleanings WHERE status='awaiting_approval' ORDER BY date").all();
    const page = await (await fetch(`${base}/cleanings/${a.id}`, { headers: auth })).text();
    assert.match(page, /Approve this cleaning/);
    assert.match(page, /data-open="approve-dialog"/);
    // Already arranged: approved and confirmed, back on the same page, nothing texted.
    let r = await fetch(`${base}/cleanings`, { method: 'POST', headers: auth, redirect: 'manual',
      body: new URLSearchParams({ proposal: String(a.id), back: 'cleaning', arranged: '1', note: 'oven too' }) });
    assert.equal(r.status, 303);
    assert.match(r.headers.get('location'), new RegExp(`^/cleanings/${a.id}\\?flash=`));
    assert.equal(app.service.get(a.id).status, 'approved');
    assert.ok(app.service.get(a.id).cleaner_confirmed_at);
    assert.doesNotMatch(await (await fetch(`${base}${r.headers.get('location')}`, { headers: auth })).text(), /Approve this cleaning/);
    // Text the group: approved, and the drafted group text opens for a decision.
    r = await fetch(`${base}/cleanings`, { method: 'POST', headers: auth, redirect: 'manual',
      body: new URLSearchParams({ proposal: String(b.id), back: 'cleaning', arranged: '0' }) });
    assert.equal(app.service.get(b.id).status, 'approved');
    assert.match(r.headers.get('location'), /msg=/);
  } finally { app.server.close(); }
});

test('Jen answers each request with "Confirmed": each one books the request it follows', async () => {
  const config = loadConfig({ DOTENV: '0', DB_FILE: ':memory:', DRY_RUN: '1', ADMIN_PASSWORD: 'pw', FEED_TOKEN: 'feedtok', GROUP_MODE: 'phone',
    APPROVERS: 'Mark:+15550000001,Danielle:+15550000002', CLEANER: 'Jen:+15550000003', TIMEZONE: 'America/Los_Angeles' });
  let now = Date.now();
  const app = createApp(config, { clock: () => now });
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
  const plus = (n) => { const d = new Date(today + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  // Three requests texted to the group one after another (like Jan 4, Jan 10, Jan 18), each answered "Confirmed".
  const ids = [];
  const ask = (d, at) => {
    const id = Number(app.db.prepare("INSERT INTO cleanings (source, date, status, group_known_date, created_at, updated_at) VALUES ('manual', ?, 'approved', ?, 'x', 'x')").run(d, d).lastInsertRowid);
    app.db.prepare("INSERT INTO group_messages (cleaning_id, kind, body, status, token, decided_by, decided_at, created_at) VALUES (?, 'added', 'x', 'sent', ?, 'Mark', ?, ?)").run(id, 't' + id, at, at);
    ids.push(id);
    return id;
  };
  const say = (text) => app.phoneInbox.receive({ title: 'Slalom Cleaning (D and Jen): Jennifer Patterson', text });
  ask(plus(38), '2026-11-27T17:47:00Z');
  ask(plus(44), '2026-11-27T17:52:00Z');
  say('Confirmed');   // answers the latest request texted
  assert.ok(app.service.get(ids[1]).cleaner_confirmed_at);
  assert.equal(app.service.get(ids[0]).cleaner_confirmed_at, null);
  ask(plus(52), '2026-11-27T17:54:00Z');
  // The same word again a couple of minutes later is a new answer, not a repeat.
  now += 2 * 60e3;
  say('Confirmed');
  assert.ok(app.service.get(ids[2]).cleaner_confirmed_at, 'second Confirmed books the newest request');
  // A notification that grew to show both texts doesn't count the first one twice.
  const before = app.db.prepare("SELECT COUNT(*) n FROM events WHERE stage='Cleaner confirmed'").get().n;
  now += 2 * 60e3;
  say('Confirmed\nConfirmed');
  assert.equal(app.db.prepare("SELECT COUNT(*) n FROM events WHERE stage='Cleaner confirmed'").get().n, before + 1);
  assert.ok(app.service.get(ids[0]).cleaner_confirmed_at, 'the remaining request');
});

test('Airbnb moves the next arrival: the cleaning before it is checked and Jen can get a heads-up', async () => {
  const { app, outbox, clearOutbox, sync } = setup();
  try {
    await sync([['s1', '2026-11-05', '2026-11-08'], ['s2', '2026-11-12', '2026-11-15']]);
    const c = app.db.prepare("SELECT * FROM cleanings WHERE date = '2026-11-08'").get();
    const { message } = await app.service.approveProposal(c.id, 'Mark');
    await app.service.decideGroupMessage(message.token, true, 'Mark');
    clearOutbox();
    // Next guests now arrive the day of the cleaning: still fits, a heads-up is drafted and Mark is asked.
    let r = await sync([['s1', '2026-11-05', '2026-11-08'], ['s2', '2026-11-08', '2026-11-15']]);
    assert.deepEqual(r.arrivals.map(a => [a.cleaning.id, a.from, a.to, a.fits]), [[c.id, '2026-11-12', '2026-11-08', true]]);
    assert.match(r.arrivals[0].message.body, /HEADS UP for the .*Nov 8.* cleaning.*arrive \d+ PM the same day/);
    assert.equal(r.arrivals[0].message.status, 'pending');
    assert.ok(outbox().some(m => /should I tell the group text/.test(m.body)));
    assert.equal(app.db.prepare("SELECT COUNT(*) n FROM group_messages WHERE status='sent'").get().n, 1, 'nothing sent to the group');
    // Arrival before the cleaning: it doesn't fit, Mark is warned.
    clearOutbox();
    r = await sync([['s1', '2026-11-05', '2026-11-08'], ['s2', '2026-11-07', '2026-11-15']]);
    assert.equal(r.arrivals[0].fits, false);
    assert.ok(outbox().some(m => /before the .*Nov 8.* cleaning. Pick a new day/.test(m.body)));
    assert.match(app.db.prepare("SELECT detail FROM events WHERE cleaning_id = ? AND stage = 'Next arrival changed' ORDER BY id DESC").get(c.id).detail, /before this cleaning/);
    // A later arrival only drafts the heads-up, without texting Mark.
    clearOutbox();
    r = await sync([['s1', '2026-11-05', '2026-11-08'], ['s2', '2026-11-13', '2026-11-15']]);
    assert.equal(r.arrivals[0].fits, true);
    assert.equal(outbox().length, 0);
    // A cleaning moved by hand that the extended stay now runs over: warned, not moved.
    await app.service.move(c.id, '2026-11-10', 'Mark');
    clearOutbox();
    r = await sync([['s1', '2026-11-05', '2026-11-11'], ['s2', '2026-11-13', '2026-11-15']]);
    assert.deepEqual(r.clashes.map(x => x.cleaning.id), [c.id]);
    assert.equal(app.service.get(c.id).date, '2026-11-10');
    assert.ok(outbox().some(m => /falls during their stay/.test(m.body)));
  } finally { app.stop(); }
});

test("Jen's private link shows only the cleanings she was texted, with no login", async () => {
  const { app, sync } = setup();
  await new Promise(r => app.server.listen(0, r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const auth = { Authorization: 'Basic ' + Buffer.from('x:pw').toString('base64') };
  try {
    await sync([['s1', '2026-11-05', '2026-11-08', 'Smith family'], ['s2', '2026-11-12', '2026-11-15']]);
    const sent = app.db.prepare("SELECT * FROM cleanings WHERE date = '2026-11-08'").get();
    const { message } = await app.service.approveProposal(sent.id, 'Mark');
    await app.service.decideGroupMessage(message.token, true, 'Mark');
    // Nov 15 is still only proposed: Jen shouldn't see it.
    const key = cleanerKey(app.db);
    // The page is served even if "today" is after these dates; use a far-future pair too.
    const late = await app.service.addManual('2099-03-05', null, 'Mark');
    await app.service.decideGroupMessage(late.message.token, true, 'Mark');
    let res = await fetch(`${base}/c/${key}`);
    assert.equal(res.status, 200);
    let page = await res.text();
    assert.match(page, /Thu, Mar 5/);
    assert.match(page, /Waiting for your reply/);
    assert.doesNotMatch(page, /Nov 15/);
    assert.doesNotMatch(page, /Smith|\$|120/);
    res = await fetch(`${base}/c/${key}.ics`);
    const ics = await res.text();
    assert.match(ics, /BEGIN:VCALENDAR/);
    assert.match(ics, /SUMMARY:Cleaning · 2072 Slalom Ct \(not confirmed yet\)/);
    assert.equal((await fetch(`${base}/c/wrongkey`)).status, 404);
    // More shows the link to copy; making a new one turns the old one off.
    const more = await (await fetch(`${base}/more`, { headers: auth })).text();
    assert.ok(more.includes(`/c/${key}`));
    assert.match(more, /Copy link/);
    await fetch(`${base}/cleaner-link/reset`, { method: 'POST', headers: auth, redirect: 'manual' });
    assert.equal((await fetch(`${base}/c/${key}`)).status, 404);
    assert.equal((await fetch(`${base}/c/${cleanerKey(app.db)}`)).status, 200);
  } finally { app.stop(); }
});

test('A stay 2 weeks out with no approved cleaning: one push and one text to Mark and Danielle', async () => {
  const { app, outbox, clearOutbox } = setup();
  try {
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
    const plus = (n) => { const d = new Date(today + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
    const at = new Date(plus(0) + 'T20:00:00Z');   // noon Pacific today
    await app.sync({ icalText: airbnb([['a', plus(3), plus(6)], ['b', plus(10), plus(12)], ['c', plus(20), plus(22)]]), now: at });
    clearOutbox();
    // a->b turnover (b arrives in 10 days) has only a proposed cleaning: alert. c is 20 days out: not yet.
    let r = await app.missingCleaningAlert(at);
    assert.deepEqual(r.alerted, ['b']);
    const texts = outbox().filter(m => m.channel === 'sms' && /Cleaning heads-up/.test(m.body));
    assert.equal(texts.length, 2, 'Mark and Danielle');
    assert.match(texts[0].body, /arrives .* \(10 days away\)\. The .* cleaning still needs your OK\./);
    // Only once per stay.
    r = await app.missingCleaningAlert(at);
    assert.deepEqual(r.alerted, []);
    // Once approved, a later stay is judged on its own; approving b's turnover clears it.
    const c = app.db.prepare('SELECT * FROM cleanings WHERE date = ?').get(plus(6));
    await app.service.approveProposal(c.id, 'Mark', { alreadyArranged: true });
    assert.equal(app.service.missingApproved(today).length, 0);
  } finally { app.stop(); }
});

test('Guest messages tab fills in check-in and check-out messages for each stay', async () => {
  const { app: plain } = setup(); plain.stop();
  const app = createApp(plain.config ?? loadConfig({ DOTENV: '0', DB_FILE: ':memory:', DRY_RUN: '1', ADMIN_PASSWORD: 'pw', FEED_TOKEN: 'feedtok', CLEANING_FEE: '120',
    APPROVERS: 'Mark:+15550000001:mark@example.com,Danielle:+15550000002:', CLEANER: 'Rosa:+15550000003', BASE_URL: 'http://test', TIMEZONE: 'America/Los_Angeles' }),
    { weatherFetch: async () => { throw new Error('offline'); } });
  await new Promise(r => app.server.listen(0, r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const auth = { Authorization: 'Basic ' + Buffer.from('x:pw').toString('base64') };
  try {
    // A stay starting next Tuesday, checking out the Sunday after.
    const t = new Date(new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' }) + 'T12:00:00Z');
    t.setUTCDate(t.getUTCDate() + ((2 - t.getUTCDay() + 7) % 7 || 7));
    const inD = t.toISOString().slice(0, 10); t.setUTCDate(t.getUTCDate() + 5); const outD = t.toISOString().slice(0, 10);
    const long = (d) => { const x = new Date(d + 'T12:00:00Z'), n = x.getUTCDate(); return `${x.toLocaleDateString('en-US', { month: 'long', timeZone: 'UTC' })} ${n}${n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] || 'th'}`; };
    await app.sync({ icalText: airbnb([['s1', inD, outD]]), now: new Date() });
    app.db.prepare("UPDATE bookings SET guest_name = 'John and Donna' WHERE uid = 's1'").run();
    let page = await (await fetch(`${base}/guest-messages`, { headers: auth })).text();
    assert.match(page, /Hey John and Donna, welcome/);
    assert.ok(page.includes(`after 4:00 PM today, Tuesday ${long(inD)}`));
    assert.ok(page.includes(`For checkout by 11:00 AM on Sunday ${long(outD)}`));
    assert.match(page, /The code is \{lockbox code\}/, 'not filled in until saved');
    assert.match(page, /Fill in Wifi name, Wifi password, Lockbox code/);
    await fetch(`${base}/guest-messages`, { method: 'POST', headers: auth, redirect: 'manual',
      body: new URLSearchParams({ 'wifi name': 'River', 'wifi password': 'pw123', 'lockbox code': '4321' }) });
    page = await (await fetch(`${base}/guest-messages`, { headers: auth })).text();
    assert.match(page, /Wifi: River \/ Password: pw123/);
    assert.match(page, /The code is 4321\./);
    assert.doesNotMatch(page, /Fill in/);
    assert.match(page, /Guest messages/);
  } finally { app.stop(); }
});


test('Guest messages are personalized: weather, snow, holiday, same-day turnover; alerts at 9 AM and 6 PM', async () => {
  const { app } = setup();
  try {
    const config = { checkinTime: '13:00', checkoutTime: '11:00', timezone: 'America/Los_Angeles' };
    app.db.prepare("INSERT INTO bookings (uid,check_in,check_out,status,first_seen,last_seen,guest_name) VALUES ('t','2026-11-24','2026-11-29','active','x','x','John and Donna'),('n','2026-11-29','2026-12-02','active','x','x',NULL),('j','2027-07-10','2027-07-12','active','x','x','Sam')").run();
    const s = guestSettings(app.db);
    const days = { '2026-11-24': { code: 0, hi: 45, lo: 20, snow: 0 }, '2026-11-26': { code: 73, hi: 30, lo: 15, snow: 6.2 }, '2026-11-29': { code: 71, hi: 31, lo: 18, snow: 2 } };
    const b = app.db.prepare("SELECT * FROM bookings WHERE uid='t'").get();
    const msgIn = fillMessage(s.checkin, { booking: b, config, details: { ...s.details, 'lockbox code': '1111' }, db: app.db, days, snow: s.snow });
    assert.match(msgIn, /host you in Tahoe over the Thanksgiving holiday!/);
    assert.match(msgIn, /check in anytime after 1:00 PM today, Tuesday November 24th\./);
    assert.match(msgIn, /Weather: Tuesday looks sunny, with a high around 45°F and a low near 20°F\. Snow is in the forecast Thursday \(about 6 inches\), so plan for chains or 4WD\./);
    assert.doesNotMatch(msgIn, /Sunday \(/, 'checkout day is not a stay day for the arrival line');
    assert.match(msgIn, /\nSnow: If more than 4 inches/);
    assert.match(msgIn, /The code is 1111\./);
    assert.doesNotMatch(msgIn, /\n\n\n/);
    const msgOut = fillMessage(s.checkout, { booking: b, config, details: s.details, db: app.db, days, snow: s.snow });
    assert.match(msgOut, /Snow is forecast for Sunday \(about 2 inches\), so please leave extra time/);
    assert.match(msgOut, /Our next guests arrive later that day, so we really appreciate you being out by 11:00 AM\./);
    assert.match(msgOut, /For checkout by 11:00 AM on Sunday November 29th,/);
    // A July stay with no forecast: Fourth of July only if it overlaps (it doesn't), no snow, no weather.
    const j = app.db.prepare("SELECT * FROM bookings WHERE uid='j'").get();
    const summer = fillMessage(s.checkin, { booking: j, config, details: s.details, db: app.db, days: null, snow: s.snow });
    assert.match(summer, /host you in Tahoe! I hope/);
    assert.doesNotMatch(summer, /Snow:|Weather:/);

    // Alerts: 9 AM arrival day for check-in, 6 PM the night before for check-out, once each.
    const cfg = { ...config };
    const at = (iso) => new Date(iso);
    assert.deepEqual(dueGuestAlerts(app.db, cfg, at('2026-11-24T16:30:00Z')).map(a => a.which + a.booking.uid), []);            // 8:30 AM
    assert.deepEqual(dueGuestAlerts(app.db, cfg, at('2026-11-24T17:05:00Z')).map(a => a.which + a.booking.uid), ['int']);       // 9:05 AM
    assert.deepEqual(dueGuestAlerts(app.db, cfg, at('2026-11-29T01:30:00Z')).map(a => a.which + a.booking.uid), []);            // Nov 28 5:30 PM
    assert.deepEqual(dueGuestAlerts(app.db, cfg, at('2026-11-29T02:10:00Z')).map(a => a.which + a.booking.uid), ['outt']);      // Nov 28 6:10 PM
    const r = await app.guestMessageAlerts(at('2026-11-24T17:05:00Z'));
    assert.deepEqual(r.sent, ['in:t']);
    assert.equal((await app.guestMessageAlerts(at('2026-11-24T17:35:00Z'))).sent.length, 0);
  } finally { app.stop(); }
});
