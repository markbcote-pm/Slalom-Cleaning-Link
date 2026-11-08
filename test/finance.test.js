import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { loadConfig } from '../src/config.js';
import { createApp } from '../src/server.js';
import { parseCents, parseCsv, parseMultipart, sniff, zip } from '../src/finance.js';

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 7)]);
const PDF = Buffer.from('%PDF-1.4\n% receipt\n');

test('money and file helpers', () => {
  assert.equal(parseCents('$1,234.56'), 123456);
  assert.equal(parseCents('-20'), -2000);
  assert.equal(parseCents('(20.5)'), -2050);
  assert.equal(parseCents('12.345'), null);
  assert.equal(parseCents('abc'), null);
  assert.deepEqual(parseCsv('a,"b, c","d ""q"""\r\n1,"two\nlines",3\n'), [['a', 'b, c', 'd "q"'], ['1', 'two\nlines', '3']]);
  assert.deepEqual(sniff(JPEG), ['image/jpeg', 'jpg']);
  assert.deepEqual(sniff(PDF), ['application/pdf', 'pdf']);
  assert.equal(sniff(Buffer.from('<html>')), null);
  const body = Buffer.from('--XX\r\nContent-Disposition: form-data; name="amount"\r\n\r\n12.50\r\n--XX\r\nContent-Disposition: form-data; name="receipt"; filename="a.jpg"\r\nContent-Type: image/jpeg\r\n\r\n');
  const form = parseMultipart(Buffer.concat([body, JPEG, Buffer.from('\r\n--XX--\r\n')]), 'multipart/form-data; boundary=XX');
  assert.equal(form.get('amount'), '12.50');
  assert.equal(form.files.length, 1);
  assert.ok(form.files[0].data.equals(JPEG));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-zip-'));
  fs.writeFileSync(path.join(dir, 't.zip'), zip([{ name: 'x/a.txt', data: Buffer.from('hello') }, { name: 'x/b.jpg', data: JPEG }]));
  assert.match(execFileSync('unzip', ['-t', path.join(dir, 't.zip')]).toString(), /No errors detected/);
});

test('Rental as a business: expenses with receipt photos, income per stay, Airbnb import, year summary and CPA package', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-fin-'));
  const app = createApp(loadConfig({ DOTENV: '0', DB_FILE: ':memory:', DATA_DIR: dir, DRY_RUN: '1', ADMIN_PASSWORD: 'pw',
    APPROVERS: 'Mark:+12075550000:,Danielle:+18315550000:', CLEANER: 'Jenn:', CLEANING_FEE: '0', TIMEZONE: 'America/Los_Angeles' }));
  await new Promise(r => app.server.listen(0, r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const auth = { Authorization: 'Basic ' + Buffer.from('x:pw').toString('base64'), Cookie: 'who=Danielle' };
  const send = (p, body) => fetch(base + p, { method: 'POST', headers: auth, body: body instanceof FormData ? body : new URLSearchParams(body), redirect: 'manual' });
  const flash = (r) => decodeURIComponent(new URL(r.headers.get('location'), base).searchParams.get('flash') || '');
  const stay = (uid, inn, out, code, source = 'airbnb') => app.db.prepare(`INSERT INTO bookings (uid, check_in, check_out, summary, description, status, first_seen, last_seen, source)
    VALUES (?, ?, ?, 'Reserved', ?, 'active', '2026-01-01', '2026-01-01', ?)`).run(uid, inn, out, code ? `Reservation URL: https://www.airbnb.com/hosting/reservations/details/${code}\nPhone Number (Last 4 Digits): 1234` : null, source);
  try {
    stay('a@airbnb', '2026-03-01', '2026-03-04', 'HMAAAA1111');
    stay('b@airbnb', '2026-04-10', '2026-04-12', 'HMBBBB2222');
    stay('p@personal', '2026-05-01', '2026-05-03', null, 'personal');

    // The add-expense page offers the camera and the photo library.
    const form = await (await fetch(base + '/money/new?kind=expense', { headers: auth })).text();
    assert.match(form, /accept="image\/\*" capture="environment"/);
    assert.match(form, /accept="image\/\*,application\/pdf" multiple/);
    assert.match(form, /<option selected>Danielle<\/option>/);

    // An expense with a photo receipt. A file that isn't a photo or PDF is refused.
    const fd = new FormData();
    for (const [k, v] of Object.entries({ kind: 'expense', amount: '45.10', date: '2026-03-05', category: 'supplies', party: 'Home Depot', paid_by: 'Danielle', method: 'Card' })) fd.append(k, v);
    fd.append('receipt', new Blob([JPEG], { type: 'image/jpeg' }), 'IMG_0001.jpg');
    fd.append('receipt', new Blob(['<script>'], { type: 'text/html' }), 'evil.html');
    let r = await send('/money/new', fd);
    assert.equal(r.status, 303);
    assert.equal(flash(r), "Saved $45.10 for supplies with 1 receipt. 1 file wasn't a photo or PDF and was skipped.");
    const exp = app.db.prepare("SELECT * FROM money WHERE party = 'Home Depot'").get();
    assert.deepEqual([exp.kind, exp.amount_cents, exp.category, exp.paid_by, exp.created_by], ['expense', 4510, 'supplies', 'Danielle', 'Danielle']);
    const rec = app.db.prepare('SELECT * FROM receipts WHERE money_id = ?').get(exp.id);
    assert.ok(fs.readFileSync(path.join(dir, 'receipts', rec.file)).equals(JPEG));
    r = await fetch(`${base}/receipts/${rec.id}`, { headers: auth });
    assert.equal(r.headers.get('content-type'), 'image/jpeg');
    assert.ok(Buffer.from(await r.arrayBuffer()).equals(JPEG));
    assert.notEqual((await fetch(`${base}/receipts/${rec.id}`, { redirect: 'manual' })).status, 200);

    // Missing category: the form comes back with the message and what was typed.
    r = await send('/money/new', { kind: 'expense', amount: '12', date: '2026-03-05', category: '', party: 'Costco' });
    assert.equal(r.status, 400);
    assert.match(await r.text(), /Pick a category[\s\S]*value="Costco"/);

    // Income typed in by hand for the first stay.
    r = await send('/money/new', { kind: 'income', amount: '300', fee: '30', date: '2026-03-02', category: 'rent', stay: 'a@airbnb', party: 'Airbnb' });
    assert.equal(flash(r), 'Saved $300.00 of income.');

    // Airbnb's transaction history: replaces the typed-in amount, adds the rest, fills guest names.
    const csv = ['Date,Type,Confirmation code,Start date,Nights,Guest,Listing,Details,Reference code,Currency,Amount,Paid out,Service fee,Gross earnings',
      '03/02/2026,Reservation,HMAAAA1111,03/01/2026,3,Ann Lee,Slalom,,,USD,"1,164.00",,36.00,"1,200.00"',
      '03/02/2026,Payout,,,,,,Transfer to bank,,USD,,"1,164.00",,',
      '04/11/2026,Reservation,HMBBBB2222,04/10/2026,2,Bob Ray,Slalom,,,USD,485.00,,15.00,500.00',
      '06/01/2026,Resolution Payout,HMBBBB2222,04/10/2026,,Bob Ray,Slalom,Broken lamp,,USD,80.00,,,',
      '07/01/2026,Reservation,HMZZZZ9999,07/01/2026,1,Cy Doe,Slalom,,,USD,100.00,,3.00,103.00'].join('\n');
    const up = () => { const f = new FormData(); f.append('csv', new Blob([csv], { type: 'text/csv' }), 'airbnb.csv'); return send('/payments/import', f); };
    r = await up();
    assert.equal(flash(r), "Imported from Airbnb: 3 new, 1 replaced your typed-in amounts, 0 already here. Added 2 guest names. 1 reservation didn't match a stay on the calendar and is listed under Other income.");
    assert.equal(app.db.prepare("SELECT guest_name FROM bookings WHERE uid='a@airbnb'").get().guest_name, 'Ann Lee');
    assert.deepEqual(app.db.prepare("SELECT amount_cents, fee_cents, source FROM money WHERE booking_uid='a@airbnb'").all().map(x => ({ ...x })), [{ amount_cents: 116400, fee_cents: 3600, source: 'airbnb_csv' }]);
    assert.equal(app.db.prepare("SELECT category FROM money WHERE note LIKE 'Resolution Payout%'").get().category, 'other_income');
    r = await up();
    assert.match(flash(r), /0 new, 0 replaced your typed-in amounts, 4 already here/);
    const bad = new FormData(); bad.append('csv', new Blob(['name,phone\nx,y'], { type: 'text/csv' }), 'x.csv');
    assert.match(flash(await send('/payments/import', bad)), /doesn't look like Airbnb's transaction history/);

    // Jenn's payment counts as a cleaning expense, with a Venmo screenshot (PDF here) on the cleaning.
    const { cleaning } = await app.service.addManual('2026-03-04', null, 'Mark', { alreadyArranged: true });
    app.service.markCleaned(cleaning.id, 'Mark');
    app.service.recordPaymentRequest(cleaning.id, '150', 'Mark');
    app.service.markPaid([cleaning.id], 'Venmo', 'Mark', '2026-03-06', 'Mark');
    const cf = new FormData(); cf.append('receipt', new Blob([PDF], { type: 'application/pdf' }), 'venmo.pdf');
    r = await send(`/cleanings/${cleaning.id}/receipt`, cf);
    assert.equal(r.headers.get('location'), `/cleanings/${cleaning.id}`);
    assert.match(await (await fetch(`${base}/cleanings/${cleaning.id}`, { headers: auth })).text(), /Payment receipts[\s\S]*<span class="thumb pdf">PDF<\/span>/);

    // The year adds up: income before Airbnb's fees, fees as an expense, cleaner payments, receipts.
    const Y = app.fin.year('2026');
    assert.equal(Y.gross, 120000 + 50000 + 8000 + 10300);
    assert.equal(Y.fees, 3600 + 1500 + 300);
    assert.deepEqual([Y.byCat.supplies, Y.byCat.cleaning, Y.byCat.platform], [4510, 15000, 5400]);
    assert.equal(Y.spent, 4510 + 15000 + 5400);
    assert.equal(Y.net, 188300 - 24910);
    assert.deepEqual([Y.rentedNights, Y.personalNights, Y.missing.length], [5, 2, 0]);

    const page = await (await fetch(`${base}/payments?year=2026`, { headers: auth })).text();
    assert.match(page, /<span>Income<\/span><b>\$1,883\.00<\/b>/);
    assert.match(page, /<span>Expenses<\/span><b>\$249\.10<\/b>/);
    assert.match(page, /<span>Profit<\/span><b>\$1,633\.90<\/b>/);
    assert.match(page, /5 nights rented · 2 nights your own use · 2 stays/);
    assert.match(page, /<b>Ann Lee<\/b>[\s\S]*\$1,164\.00<div class="sub">\+ \$36\.00 Airbnb fee/);
    assert.match(page, /2026 total paid to Jenn: <b>\$150\.00<\/b> for 1 cleaning/);

    // A past stay with nothing entered shows up as missing, with a button to add it.
    stay('c@airbnb', '2026-08-01', '2026-08-03', 'HMCCCC3333');
    assert.match(await (await fetch(`${base}/payments?year=2026`, { headers: auth })).text(), /1 stay with no income entered yet[\s\S]*href="\/money\/new\?kind=income&stay=c%40airbnb">Add amount/);

    // The spreadsheet and the package for the CPA.
    const ledger = await (await fetch(`${base}/payments/ledger.csv?year=2026`, { headers: auth })).text();
    const lines = ledger.split('\r\n');
    assert.equal(lines[0], '"Date","Type","Category","Schedule E line","From / paid to","Stay","Gross amount","Airbnb fee","Net amount","Paid by","Method","Note","Receipts"');
    assert.ok(lines.includes(`"2026-03-05","Expense","Supplies","15 Supplies","Home Depot","","45.10","","45.10","Danielle","Card","","receipts/2026-03-05_Home-Depot_45.10_${rec.id}.jpg"`));
    assert.ok(lines.some(l => l.startsWith('"2026-03-02","Income","Rental income","3 Rents received","Airbnb","Ann Lee, Sun, Mar 1 to Wed, Mar 4","1200.00","36.00","1164.00"')));
    assert.ok(lines.includes('"","","Net profit","","","","1633.90"'));
    const zr = await fetch(`${base}/payments/package.zip?year=2026`, { headers: auth });
    assert.equal(zr.headers.get('content-type'), 'application/zip');
    fs.writeFileSync(path.join(dir, 'p.zip'), Buffer.from(await zr.arrayBuffer()));
    const listing = execFileSync('unzip', ['-l', path.join(dir, 'p.zip')]).toString();
    for (const f of ['2072-Slalom-Ct-2026/summary.html', '2072-Slalom-Ct-2026/income-and-expenses.csv', '2072-Slalom-Ct-2026/cleaner-payments.csv',
      `2072-Slalom-Ct-2026/receipts/2026-03-05_Home-Depot_45.10_${rec.id}.jpg`, '2072-Slalom-Ct-2026/receipts/2026-03-06_Jenn_150.00_']) assert.ok(listing.includes(f), f);
    assert.match(execFileSync('unzip', ['-t', path.join(dir, 'p.zip')]).toString(), /No errors detected/);
    assert.match(execFileSync('unzip', ['-p', path.join(dir, 'p.zip'), '2072-Slalom-Ct-2026/summary.html']).toString(), /href="receipts\/2026-03-05_Home-Depot_45\.10_\d+\.jpg"/);

    // Editing keeps the receipt; deleting the expense removes its receipt file too.
    r = await send(`/money/${exp.id}`, { amount: '46.10', date: '2026-03-05', category: 'repairs', party: 'Home Depot', paid_by: 'Mark' });
    assert.equal(flash(r), 'Saved.');
    assert.deepEqual([app.fin.get(exp.id).amount_cents, app.fin.get(exp.id).category, app.fin.receiptsFor(exp.id).length], [4610, 'repairs', 1]);
    await send(`/money/${exp.id}/delete`, {});
    assert.equal(app.fin.get(exp.id), undefined);
    assert.ok(!fs.existsSync(path.join(dir, 'receipts', rec.file)));
  } finally { app.stop(); }
});
