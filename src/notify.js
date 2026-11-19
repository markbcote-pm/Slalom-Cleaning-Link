// Outgoing texts and emails. Everything is written to the outbox table, so every
// message the app ever sent (or would have sent, in dry-run mode) can be reviewed.

// Plain-English hints for the Twilio errors people hit when first setting up.
export function twilioHint(err = '') {
  const code = (String(err).match(/(?:"code"\s*:\s*|code )(\d{5})/) || [])[1];
  const hints = {
    20003: 'the Account SID or Auth Token is wrong (20003).',
    21211: 'the phone number is not valid (21211).',
    21606: 'TWILIO_FROM is not a number on your Twilio account that can send texts (21606).',
    21608: 'a trial Twilio account can only text numbers you have verified in Twilio (21608). Verify your number under Phone Numbers > Verified Caller IDs, or upgrade the account.',
    21610: 'that number replied STOP. Text START to the Twilio number to opt back in (21610).',
    30032: 'the toll-free number has not been verified yet (30032). Finish toll-free verification in the Twilio console.',
    30034: 'carriers blocked it because the sending number is not linked to an approved A2P 10DLC campaign (30034). In Twilio, open Messaging > Services, open the service your campaign is on, and add the TWILIO_FROM number under Sender Pool.',
    30007: 'the carrier filtered it as spam (30007).',
    30003: 'the phone was unreachable (30003).',
    30005: 'the number does not exist (30005).',
    30006: 'the number cannot receive texts, e.g. a landline (30006).',
  };
  return hints[code] || String(err || 'unknown error').slice(0, 200);
}

const PENDING = ['queued', 'accepted', 'scheduled', 'sending'];

// onProblem({ to, body, status, error }) is called when a text fails, now or after the carrier reports back.
// deliveryChecks: how long to wait (ms) before each look at Twilio's delivery status of a sent text.
export function createNotifier(db, config, { fetchImpl = globalThis.fetch, onProblem = () => {}, deliveryChecks = [5e3, 20e3, 60e3, 180e3] } = {}) {
  const log = (channel, to, subject, body, status, error = null) =>
    db.prepare('INSERT INTO outbox (channel, to_addr, subject, body, status, error, at) VALUES (?,?,?,?,?,?,?)')
      .run(channel, to, subject, body, status, error, new Date().toISOString()).lastInsertRowid;
  const problem = (p) => { try { Promise.resolve(onProblem(p)).catch(() => {}); } catch {} };

  const twilioAuth = () => 'Basic ' + Buffer.from(`${config.twilio.sid}:${config.twilio.token}`).toString('base64');

  async function post(url, params, headers) {
    const res = await fetchImpl(url, { method: 'POST', headers, body: params });
    if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
    return res.json();
  }

  const allowed = (to) => !config.smsOnlyTo?.length || config.smsOnlyTo.includes(String(to).replace(/\D/g, '').slice(-10));

  async function sms(to, body) {
    if (!to) return;
    if (config.dryRun) return log('sms', to, null, body, 'dry_run');
    if (!allowed(to)) return log('sms', to, null, body, 'held', 'Not sent: only SMS_ONLY_TO numbers get texts while testing');
    try {
      const r = await post(`https://api.twilio.com/2010-04-01/Accounts/${config.twilio.sid}/Messages.json`,
        new URLSearchParams({ To: to, From: config.twilio.from, Body: body }),
        { Authorization: twilioAuth(), 'Content-Type': 'application/x-www-form-urlencoded' });
      const id = log('sms', to, null, body, 'sent', r?.sid ? `sid ${r.sid}` : null);
      if (r?.sid) trackDelivery(id, r.sid, to, body);
      return r;
    } catch (e) {
      log('sms', to, null, body, 'failed', e.message);
      problem({ to, body, status: 'failed', error: twilioHint(e.message) });
    }
  }

  // Twilio accepting a text doesn't mean it arrived: carriers can still block it (e.g. 30034).
  // Look again in the background and record the final result on the "Messages sent" list.
  function trackDelivery(id, sid, to, body) {
    let i = 0;
    const next = () => {
      if (i >= deliveryChecks.length) return;
      const t = setTimeout(async () => {
        i++;
        let st;
        try { st = await smsStatus(sid); } catch { return next(); }
        if (PENDING.includes(st.status) || (st.status === 'sent' && !st.error_code)) return next();
        const error = st.error_code ? `sid ${sid} · ${twilioHint(`code ${st.error_code}`)}` : `sid ${sid}`;
        try { db.prepare('UPDATE outbox SET status = ?, error = ? WHERE id = ?').run(st.status, error, id); } catch { return; }
        if (st.error_code || ['failed', 'undelivered'].includes(st.status)) problem({ to, body, status: st.status, error: twilioHint(`code ${st.error_code}`) });
      }, deliveryChecks[i]);
      t.unref?.();
    };
    next();
  }

  // Look up what happened to a sent text (Twilio reports carrier failures after the fact).
  async function smsStatus(sid) {
    const res = await fetchImpl(`https://api.twilio.com/2010-04-01/Accounts/${config.twilio.sid}/Messages/${sid}.json`, { headers: { Authorization: twilioAuth() } });
    if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
    return res.json();
  }

  async function email(to, subject, body) {
    if (!to) return;
    if (config.dryRun || !config.resend.key) return log('email', to, subject, body, 'dry_run');
    try {
      await post('https://api.resend.com/emails',
        JSON.stringify({ from: config.resend.from, to: [to], subject, text: body }),
        { Authorization: `Bearer ${config.resend.key}`, 'Content-Type': 'application/json' });
      log('email', to, subject, body, 'sent');
    } catch (e) { log('email', to, subject, body, 'failed', e.message); }
  }

  // Message the shared thread with Mark, Danielle and the cleaner.
  async function group(body) {
    if (config.groupMode === 'conversation' && config.twilio.conversationSid) {
      if (config.dryRun) return log('group', 'conversation', null, body, 'dry_run');
      if (config.smsOnlyTo?.length) return log('group', 'conversation', null, body, 'held', 'Group thread is off while SMS_ONLY_TO is set');
      try {
        await post(`https://conversations.twilio.com/v1/Conversations/${config.twilio.conversationSid}/Messages`,
          new URLSearchParams({ Author: 'cleaning-link', Body: body }),
          { Authorization: twilioAuth(), 'Content-Type': 'application/x-www-form-urlencoded' });
        log('group', 'conversation', null, body, 'sent');
      } catch (e) { log('group', 'conversation', null, body, 'failed', e.message); }
      return;
    }
    for (const p of config.groupMembers) await sms(p.phone, body);
  }

  // Ask Mark and Danielle something (by text and, if set, email).
  async function approvers(subject, body) {
    for (const p of config.approvers) {
      await sms(p.phone, body(p));
      await email(p.email, subject, body(p));
    }
  }

  return { sms, smsStatus, email, group, approvers };
}
