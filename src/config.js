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
    cleaningFeeCents: Math.round(Number(e.CLEANING_FEE || 0) * 100),
    adminPassword: e.ADMIN_PASSWORD || '',
    feedToken: e.FEED_TOKEN || '',
    approvers,
    cleaner,
    groupMembers: [...approvers, ...(cleaner ? [cleaner] : [])],
    dryRun: e.DRY_RUN !== '0' || !e.TWILIO_ACCOUNT_SID,
    twilio: { sid: e.TWILIO_ACCOUNT_SID, token: e.TWILIO_AUTH_TOKEN, from: e.TWILIO_FROM, conversationSid: e.TWILIO_CONVERSATION_SID },
    groupMode: e.GROUP_MODE || 'individual',
    resend: { key: e.RESEND_API_KEY, from: e.EMAIL_FROM },
  };
}
