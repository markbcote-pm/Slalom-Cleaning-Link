// Live screens: every signed-in page carries a fingerprint of the data it was built from,
// and checks /live every few seconds. When the fingerprint changes (a forwarded text
// confirmed a cleaning, a payment came in, Airbnb added a stay, the other person approved
// something), the page refreshes itself. It waits while someone is typing or a dialog is
// open, and shows a small "Refresh" bar instead.
import crypto from 'node:crypto';

// Everything a screen shows. Bookings leave out last_seen, which the Airbnb check touches
// every 30 minutes even when nothing changed. Logs that only grow use their newest id.
const PARTS = [
  "SELECT uid, check_in, check_out, summary, description, status FROM bookings ORDER BY uid",
  'SELECT id, status, date, updated_at FROM cleanings ORDER BY id',
  'SELECT id, status FROM group_messages ORDER BY id',
  'SELECT id, cleaning_id, booking_uid, tags, followup FROM notes ORDER BY id',
  'SELECT id, status, title, cleaning_id FROM todos ORDER BY id',
  'SELECT id, status FROM text_matches ORDER BY id',
  'SELECT id, cleaning_id FROM photos ORDER BY id',
  'SELECT * FROM money ORDER BY id',
  'SELECT COUNT(*) n, MAX(id) m FROM events',
  'SELECT COUNT(*) n, MAX(id) m FROM outbox',
  "SELECT COUNT(*) n FROM receipts",
  "SELECT key, value FROM meta WHERE key = 'phone:last' OR key LIKE 'consent:%' ORDER BY key",
];

export function liveStamp(db) {
  const hash = crypto.createHash('sha1');
  for (const q of PARTS) {
    try { hash.update(JSON.stringify(db.prepare(q).all())); } catch { hash.update('-'); }
  }
  return hash.digest('hex').slice(0, 16);
}

// One-shot query params (a flash note, a dialog to open) are dropped when the page refreshes,
// so a refresh doesn't show the same note again or reopen a dialog that was closed.
export const LIVE_JS = (stamp) => `<script>{const v0=${JSON.stringify(stamp)};let busy=false,dirty=false,bar=null;
document.addEventListener('input',e=>{if(e.target.closest&&e.target.closest('form'))dirty=true;},true);
const blocked=()=>dirty||document.querySelector('dialog[open]')||(document.activeElement&&/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName));
function go(){const u=new URL(location.href);['flash','shared','msgnote','review'].forEach(k=>u.searchParams.delete(k));const to=u.pathname+u.search;
try{sessionStorage.setItem('live:y',JSON.stringify([to,scrollY]));}catch(e){}location.replace(to+u.hash);}
function show(){if(bar)return;bar=document.createElement('div');bar.className='live-bar noprint';bar.innerHTML='<span style="white-space:nowrap">Something changed.</span><button type="button">Refresh</button>';bar.querySelector('button').onclick=go;document.body.appendChild(bar);}
async function check(){if(busy||document.hidden||bar)return;busy=true;try{const r=await fetch('/live',{headers:{accept:'application/json'},cache:'no-store'});
if(r.ok){const j=await r.json();if(j.v&&j.v!==v0){if(blocked())show();else go();}}}catch(e){}finally{busy=false;}}
try{const s=JSON.parse(sessionStorage.getItem('live:y')||'null');sessionStorage.removeItem('live:y');if(s&&s[0]===location.pathname+location.search)addEventListener('load',()=>scrollTo(0,s[1]));}catch(e){}
setInterval(check,6000);document.addEventListener('visibilitychange',()=>{if(!document.hidden)check();});addEventListener('pageshow',e=>{if(e.persisted)check();});}</script>`;
