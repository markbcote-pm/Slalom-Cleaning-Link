// Small iCalendar reader/writer: enough for Airbnb's export feed and a subscribable feed.

function unfold(text) {
  return text.replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '');
}

function unescapeText(v) {
  return v.replace(/\\n/gi, '\n').replace(/\\([,;\\])/g, '$1');
}

function toDate(value) {
  // DTSTART;VALUE=DATE:20261108  or 20261108T150000Z
  const m = value.match(/^(\d{4})(\d{2})(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

export function parseIcal(text) {
  const events = [];
  let cur = null;
  for (const line of unfold(text).split('\n')) {
    if (line === 'BEGIN:VEVENT') { cur = {}; continue; }
    if (line === 'END:VEVENT') { if (cur) events.push(cur); cur = null; continue; }
    if (!cur) continue;
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const name = line.slice(0, idx).split(';')[0].toUpperCase();
    const value = line.slice(idx + 1);
    if (name === 'UID') cur.uid = value.trim();
    else if (name === 'DTSTART') cur.start = toDate(value);
    else if (name === 'DTEND') cur.end = toDate(value);
    else if (name === 'SUMMARY') cur.summary = unescapeText(value);
    else if (name === 'DESCRIPTION') cur.description = unescapeText(value);
  }
  return events;
}

// Airbnb exports guest stays as "Reserved" and owner blocks as "Airbnb (Not available)".
export function isReservation(ev) {
  if (!ev.uid || !ev.start || !ev.end) return false;
  const s = (ev.summary || '').toLowerCase();
  return !s.includes('not available') && !s.includes('blocked');
}

function esc(v) {
  return String(v).replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/([,;])/g, '\\$1');
}

function fold(line) {
  const out = [];
  while (line.length > 74) { out.push(line.slice(0, 74)); line = ' ' + line.slice(74); }
  out.push(line);
  return out.join('\r\n');
}

function stamp(d) {
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

export function buildIcal({ name, events }) {
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Slalom Cleaning Link//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    `X-WR-CALNAME:${esc(name)}`, 'REFRESH-INTERVAL;VALUE=DURATION:PT1H', 'X-PUBLISHED-TTL:PT1H',
  ];
  const now = stamp(new Date());
  for (const ev of events) {
    lines.push('BEGIN:VEVENT', `UID:${ev.uid}`, `DTSTAMP:${now}`,
      `DTSTART:${stamp(ev.start)}`, `DTEND:${stamp(ev.end)}`,
      `SUMMARY:${esc(ev.summary)}`, `DESCRIPTION:${esc(ev.description || '')}`,
      ...(ev.color ? [`COLOR:${ev.color}`] : []), ...(ev.categories ? [`CATEGORIES:${esc(ev.categories)}`] : []),
      `SEQUENCE:${ev.sequence || 0}`, 'END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.map(fold).join('\r\n') + '\r\n';
}
