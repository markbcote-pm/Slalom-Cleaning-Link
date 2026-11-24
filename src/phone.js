// GROUP_MODE=phone: the shared group text lives on our own phones, not on Twilio.
//
// Sending: the app can't post into a carrier group text (MMS or RCS) by itself, so when a
// message is approved it opens the phone's Messages app with the group's numbers and the
// words already filled in. The person who approved taps Send, and it lands in the existing
// thread from their own number. Every group text already needs an OK, so that tap is the OK.
//
// Reading: an automation app on Mark's phone (MacroDroid or Tasker) forwards each Messages
// notification from the group to POST /phone/inbound?key=PHONE_KEY. Those become notes, and
// the cleaner's "yes" confirms a cleaning, exactly like texts that came in through Twilio.

const digits = (s) => String(s || '').replace(/\D/g, '').slice(-10);

// sms: link that opens the group conversation with `body` typed in. The sender's own
// number is left out, since you can't be a recipient of your own text.
export function groupSmsLink(config, senderName, body = '') {
  const me = config.approvers.find(a => a.name === senderName);
  const nums = config.groupMembers.filter(p => p.phone && (!me?.phone || digits(p.phone) !== digits(me.phone)))
    .map(p => p.phone.replace(/[^\d+]/g, ''));
  return `sms:${nums.join(config.phone.separator)}${body ? `?body=${encodeURIComponent(body)}` : ''}`;
}

// Everyone who can show up as a sender, with the names their phone contacts might use.
function people(config) {
  return config.groupMembers.map(p => ({ ...p, names: [p.name, ...(config.phone.aliases[p.name.toLowerCase()] || [])].map(n => n.toLowerCase()) }));
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// "Jenn" matches "Jenn", "Jenn Patterson" and "Jenn 🧹", but not "Jennifer".
const hasName = (text, name) => new RegExp(`(^|[^\\p{L}])${escapeRe(name)}($|[^\\p{L}])`, 'iu').test(text);

function whoIs(config, label) {
  if (!label) return null;
  if (digits(label).length === 10) return people(config).find(p => p.phone && digits(p.phone) === digits(label)) || null;
  const hits = people(config).filter(p => p.names.some(n => hasName(label, n)));
  return hits.length === 1 ? hits[0] : null;
}

// Turn a forwarded notification into { author, phone, body }. Messages apps show group texts
// either as title "Jenn Patterson" / text "yes", or title "<group name>" / text "Jenn: yes".
export function parseNotification(config, { title = '', text = '', from = '' }) {
  title = String(title || '').trim();
  text = String(text || '').trim();
  if (!text) return null;
  let person = whoIs(config, from);
  let body = text;
  const prefix = text.match(/^([^:\n]{1,40}):\s+([\s\S]+)$/);
  if (!person && prefix && whoIs(config, prefix[1])) { person = whoIs(config, prefix[1]); body = prefix[2]; }
  else if (prefix && person && whoIs(config, prefix[1]) === person) body = prefix[2];
  if (!person) person = whoIs(config, title);
  return { author: person?.name || (title || 'Group text'), phone: person?.phone || null, body: body.trim(), known: !!person };
}

// Notifications get re-posted (another message arrives, the phone reconnects), so the same
// text can be forwarded twice. Skip a repeat of the same words from the same person.
export function createPhoneInbox({ db, config, notes, service }) {
  const recent = new Map();
  function receive(fields) {
    const n = parseNotification(config, fields);
    remember(fields, n);
    if (!n || !n.body) return { saved: false, reason: 'empty' };
    const key = `${n.author}|${n.body}`.toLowerCase();
    const now = Date.now();
    for (const [k, t] of recent) if (now - t > 30 * 60e3) recent.delete(k);
    if (recent.has(key)) return { saved: false, reason: 'duplicate', author: n.author };
    recent.set(key, now);
    const note = notes.add({ body: n.body, author: n.author, phone: n.phone, source: 'group' });
    const r = note ? service.cleanerReply({ body: n.body, phone: n.phone, author: n.author }) : { confirmed: [] };
    return { saved: !!note, author: n.author, known: n.known, confirmed: r.confirmed.map(c => c.date) };
  }
  // The last few raw notifications, shown on the More tab so setup problems are easy to see.
  function remember(fields, n) {
    const list = lastReceived();
    list.unshift({ at: new Date().toISOString(), title: String(fields.title || '').slice(0, 80), text: String(fields.text || '').slice(0, 160), author: n?.author || null, known: !!n?.known });
    db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run('phone:last', JSON.stringify(list.slice(0, 5)));
  }
  function lastReceived() {
    try { return JSON.parse(db.prepare('SELECT value FROM meta WHERE key = ?').get('phone:last')?.value || '[]'); } catch { return []; }
  }
  return { receive, lastReceived };
}

// Pull title/text/from out of whatever the automation app sent (form, JSON or query string).
export function inboundFields(params, json) {
  const pick = (...keys) => { for (const k of keys) { const v = json?.[k] ?? params.get(k); if (v) return String(v); } return ''; };
  return { title: pick('title', 'notification_title', 'conversation'), text: pick('text', 'message', 'body', 'notification', 'notification_text'), from: pick('from', 'sender', 'phone') };
}
