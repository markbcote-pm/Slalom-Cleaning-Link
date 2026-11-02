import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';
import { createApp } from '../src/server.js';
import { parseIcal } from '../src/ical.js';
import { localToUtc } from '../src/dates.js';
import { cleaningFeed } from '../src/feed.js';
import { cleaningWindows, guestLabel } from '../src/views.js';

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

  // nothing on the calendar yet
  assert.doesNotMatch(cleaningFeed({ db: app.db, config, service: app.service }), /BEGIN:VEVENT/);

  clearOutbox();
  const res = await app.service.approve(t, 'Danielle');
  assert.equal(res.cleaning.status, 'approved');
  const g = outbox();
  assert.deepEqual(g.map(m => m.to_addr), ['+15550000001', '+15550000002', '+15550000003']);
  assert.match(g[0].body, /^CLEANING CONFIRMED: Sun, Nov 8/);

  // second approval of same link is harmless
  const again = await app.service.approve(t, 'Mark');
  assert.ok(again.error || again.already);

  const ics = cleaningFeed({ db: app.db, config, service: app.service });
  assert.equal((ics.match(/BEGIN:VEVENT/g) || []).length, 1);
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
  // cancelled cleanings leave the calendar
  assert.doesNotMatch(cleaningFeed({ db: app.db, config, service: app.service }), /BEGIN:VEVENT/);
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
  assert.deepEqual(app.service.stageOf(app.service.get(c.id)).map(s => s.done), [true, true, true, false, true, true, true]);
});

test('HTTP: dashboard needs password, feed needs token, approval page works, drag-move returns redirect', async () => {
  const { app, sync } = setup();
  await new Promise(r => app.server.listen(0, r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const auth = { Authorization: 'Basic ' + Buffer.from('x:pw').toString('base64') };
  try {
    assert.equal((await fetch(base + '/')).status, 401);
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
    assert.match(html, /class="chip awaiting_approval" draggable="true" data-id="\d+" style="grid-column:1\/span 2"/);
    assert.match(html, /Open, no next booking yet/);

    await fetch(`${base}/bookings/name`, { method: 'POST', headers: auth, body: new URLSearchParams({ uid: 's1', name: 'Smith family' }), redirect: 'manual' });
    assert.match(await (await fetch(base + '/?month=2026-11', { headers: auth })).text(), /stay-bar[^"]*" style="grid-column:10\/15"[^>]*>Smith family</);

    const c = app.db.prepare('SELECT * FROM cleanings').get();
    const page = await (await fetch(`${base}/a/${c.approval_token}?by=Danielle`)).text();
    assert.match(page, /<option selected>Danielle<\/option>/);
    const post = await fetch(`${base}/a/${c.approval_token}`, { method: 'POST', body: new URLSearchParams({ by: 'Danielle', action: 'approve' }) });
    assert.match(await post.text(), /Approved by Danielle/);

    const mv = await fetch(`${base}/cleanings/${c.id}/move`, { method: 'POST', headers: { ...auth, Accept: 'application/json' }, body: new URLSearchParams({ date: '2026-11-09' }) });
    const { redirect } = await mv.json();
    assert.match(redirect, /^\/g\//);
    const decide = await (await fetch(base + redirect, { headers: auth })).text();
    assert.match(decide, /Text the group about this change/);
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
    { date: '2026-11-07', status: 'approved' },          // covers b
    { date: '2026-11-10', status: 'awaiting_approval' },  // proposed for c
    { date: '2026-11-13', status: 'cancelled' },          // doesn't count for d
  ];
  assert.deepEqual(stayReadiness(bookings, cleanings, '2026-11-02'), { old: 'past', a: 'missing', b: 'ready', c: 'pending', d: 'missing' });
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
