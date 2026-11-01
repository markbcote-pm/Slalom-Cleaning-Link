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
    assert.match(html, /Waiting on you/);
    assert.match(html, /class="bar stay-bar cont-r" style="grid-column:10\/15"[^>]*>Guest ···1234</, 'Thu 5th 1 PM to Sun 8th 11 AM spans weeks: first week from Thu afternoon');
    assert.match(html, /class="bar stay-bar cont-l" style="grid-column:1\/2"/, 'continues into Sunday morning');
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
  assert.deepEqual(w, [
    { from: '2026-11-05', to: '2026-11-05', days: 1 },  // same-day turnover
    { from: '2026-11-08', to: '2026-11-10', days: 3 },  // Sun 11 AM to Tue 1 PM: Sun, Mon, Tue
    { from: '2026-11-12', to: null, days: null },
  ]);
  assert.equal(guestLabel({ description: 'Phone Number (Last 4 Digits): 9876' }), 'Guest ···9876');
  assert.equal(guestLabel({ guest_name: 'Lee', description: '' }), 'Lee');
});
