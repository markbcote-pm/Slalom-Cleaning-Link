// Outgoing texts and emails. Everything is written to the outbox table, so every
// message the app ever sent (or would have sent, in dry-run mode) can be reviewed.

export function createNotifier(db, config, { fetchImpl = globalThis.fetch } = {}) {
  const log = (channel, to, subject, body, status, error = null) =>
    db.prepare('INSERT INTO outbox (channel, to_addr, subject, body, status, error, at) VALUES (?,?,?,?,?,?,?)')
      .run(channel, to, subject, body, status, error, new Date().toISOString());

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
      log('sms', to, null, body, 'sent', r?.sid ? `sid ${r.sid}` : null);
      return r;
    } catch (e) { log('sms', to, null, body, 'failed', e.message); }
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
