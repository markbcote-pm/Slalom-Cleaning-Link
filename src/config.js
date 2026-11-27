import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// Minimal .env loader so the app has no dependencies.
function loadEnvFile(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

function parsePeople(str) {
  return (str || '').split(',').map(s => s.trim()).filter(Boolean).map(s => {
    const [name, phone, email] = s.split(':').map(x => (x || '').trim());
    return { name, phone: phone || null, email: email || null };
  });
}

export function loadConfig(overrides = {}) {
  if (overrides.DOTENV !== '0') loadEnvFile(path.resolve(process.cwd(), '.env'));
  const e = { ...process.env, ...overrides };
  const approvers = parsePeople(e.APPROVERS);
  const cleaner = parsePeople(e.CLEANER)[0] || null;
  return {
    port: Number(e.PORT || 3000),
    baseUrl: (e.BASE_URL || 'http://localhost:3000').replace(/\/$/, ''),
    dataDir: e.DATA_DIR || './data',
    dbFile: e.DB_FILE || null,
    timezone: e.TIMEZONE || 'America/Los_Angeles',
    // 'the rental' was the old placeholder; the address is what goes in texts to the cleaner.
    propertyName: (e.PROPERTY_NAME && e.PROPERTY_NAME !== 'the rental') ? e.PROPERTY_NAME : '2072 Slalom Ct',
    airbnbIcalUrl: e.AIRBNB_ICAL_URL || '',
    syncMinutes: Number(e.SYNC_MINUTES || 30),
    checkoutTime: e.CHECKOUT_TIME || '11:00',
    checkinTime: e.CHECKIN_TIME || '16:00',
    weatherLat: e.WEATHER_LAT ? Number(e.WEATHER_LAT) : 38.93,   // South Lake Tahoe
    weatherLon: e.WEATHER_LON ? Number(e.WEATHER_LON) : -119.98,
    cleaningFeeCents: Math.round(Number(e.CLEANING_FEE || 0) * 100),
    adminPassword: e.ADMIN_PASSWORD || '',
    feedToken: e.FEED_TOKEN || '',
    // Render's generated FEED_TOKEN can contain "/", "+" and "=", which break calendar apps.
    // The URL uses a letters-and-digits id derived from it instead.
    feedId: e.FEED_TOKEN ? crypto.createHash('sha256').update(e.FEED_TOKEN).digest('hex').slice(0, 32) : '',
    approvers,
    cleaner,
    groupMembers: [...approvers, ...(cleaner ? [cleaner] : [])],
    dryRun: e.DRY_RUN !== '0' || !e.TWILIO_ACCOUNT_SID,
    twilio: { sid: e.TWILIO_ACCOUNT_SID, token: e.TWILIO_AUTH_TOKEN, from: e.TWILIO_FROM, conversationSid: e.TWILIO_CONVERSATION_SID },
    // 'individual' (Twilio, one text per person), 'conversation' (Twilio group MMS) or
    // 'phone' (our own group text: Messages opens ready to send, replies forwarded by the phone).
    groupMode: e.GROUP_MODE || 'individual',
    phone: {
      // Secret in the address the phone forwards group texts to. Set PHONE_KEY, or it's derived from FEED_TOKEN.
      key: e.PHONE_KEY || (e.FEED_TOKEN ? crypto.createHash('sha256').update('phone:' + e.FEED_TOKEN).digest('hex').slice(0, 24) : ''),
      // Between numbers in the sms: link. Google Messages takes ","; set ";" if your app wants that.
      separator: e.PHONE_SMS_SEPARATOR || ',',
      // Other names your phone's contacts use, e.g. "Jenn=Jennifer|Jenn P,Danielle=Dani"
      aliases: Object.fromEntries((e.PHONE_ALIASES || '').split(',').map(x => x.split('=')).filter(x => x.length === 2)
        .map(([k, v]) => [k.trim().toLowerCase(), v.split('|').map(s => s.trim()).filter(Boolean)])),
    },
    // Safety switch while testing: when set, real texts go only to these numbers and
    // everything else is logged as "held". Comma separated, e.g. +12076512735
    smsOnlyTo: (e.SMS_ONLY_TO || '').split(',').map(x => x.replace(/\D/g, '').slice(-10)).filter(x => x.length === 10),
    resend: { key: e.RESEND_API_KEY, from: e.EMAIL_FROM },
    // Shown on the public /sms, /privacy and /terms pages as the support contact (optional).
    supportEmail: e.SUPPORT_EMAIL || '',
    // The registered A2P brand (for a Sole Proprietor brand, the owner's legal name), named on the public pages.
    brandName: e.BRAND_NAME || '',
  };
}
