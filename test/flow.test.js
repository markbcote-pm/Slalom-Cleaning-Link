import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';
import { createApp } from '../src/server.js';
import { parseIcal } from '../src/ical.js';
import { localToUtc } from '../src/dates.js';
import { cleaningFeed } from '../src/feed.js';
import { cleaningWindows, guestLabel, cleaningState } from '../src/views.js';

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
    assert.match(cal, /class="day\s+review" data-date="2026-11-08"/);
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
    assert.match(decodeURIComponent(r.headers.get('location')), /A2P 10DLC registration \(30034\)/);
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
    assert.match(await (await fetch(base + '/sms')).text(), /reads this script word for word[\s\S]*Do you agree\?/);
  } finally { app.stop(); }
});

test('Recording consent stores the date and sends the sign-up confirmation text', async () => {
  const { app, outbox, clearOutbox } = setup();
  await new Promise(r => app.server.listen(0, r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const auth = { Authorization: 'Basic ' + Buffer.from('x:pw').toString('base64'), Cookie: 'who=Mark' };
  try {
    clearOutbox();
    const r = await fetch(base + '/texting/consent', { method: 'POST', headers: auth, body: new URLSearchParams({ phone: '+15550000003' }), redirect: 'manual' });
    assert.match(decodeURIComponent(r.headers.get('location')), /Consent recorded for Rosa/);
    assert.match(outbox()[0].body, /you're signed up for cleaning schedule texts.*Reply HELP for help, STOP to opt out\./);
    assert.match(await (await fetch(base + '/more', { headers: auth })).text(), /Rosa<\/b>[\s\S]*Agreed [A-Z][a-z]{2} \d+, \d{4}, recorded by Mark/);
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
