import { cleanerKey } from './cleanerview.js';
import { prettyDate, prettyTime, addDays, todayIn } from './dates.js';
import { liveStamp, LIVE_JS } from './live.js';

export const h = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (cents) => `$${((cents || 0) / 100).toFixed(2)}`;
// Dollars with thousands separators, for the business pages. Negative shows as -$12.00.
export const usd = (cents) => `${cents < 0 ? '-' : ''}$${(Math.abs(cents || 0) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// Receipt thumbnails. Photos show as small images, PDFs as a PDF tile; tapping opens the full file.
export function receiptStrip(receipts, { deletable = false, back = '/payments' } = {}) {
  if (!receipts.length) return '';
  return `<div class="receipts">${receipts.map(r => `<div class="receipt"><a href="/receipts/${r.id}" target="_blank" rel="noopener" title="${h(r.name || 'Receipt')}">${r.mime === 'application/pdf' ? '<span class="thumb pdf">PDF</span>' : r.mime === 'image/heic' ? '<span class="thumb pdf">HEIC</span>' : `<img class="thumb" src="/receipts/${r.id}" alt="Receipt" loading="lazy">`}</a>${deletable ? `<form method="post" action="/receipts/${r.id}/delete" onsubmit="return confirm('Delete this receipt?')"><input type="hidden" name="next" value="${h(back)}"><button class="x" aria-label="Delete receipt">&times;</button></form>` : ''}</div>`).join('')}</div>`;
}

// Two ways to add receipts on a phone: open the camera, or pick photos/PDFs already saved.
export const receiptInputs = (label = 'Receipts') => `<div class="upload"><div class="muted" style="font-size:14px">${h(label)}</div><div class="row">
<label class="btn ghost">Take a photo<input type="file" name="receipt" accept="image/*" capture="environment" hidden></label>
<label class="btn ghost">Choose photos or PDFs<input type="file" name="receipt" accept="image/*,application/pdf" multiple hidden></label></div>
<div class="muted upl-list" style="font-size:13px"></div></div>`;

// Shrinks big phone photos before upload (about 2000px, JPEG) and sends the form with fetch.
export const UPLOAD_JS = `<script>
(function(){
  async function shrink(f){
    if(!/^image\\/(jpeg|png|webp)$/.test(f.type) || f.size < 1200000 || !window.createImageBitmap) return f;
    try{ const b = await createImageBitmap(f, {imageOrientation:'from-image'});
      const s = Math.min(1, 2000/Math.max(b.width, b.height)), c = document.createElement('canvas');
      c.width = Math.round(b.width*s); c.height = Math.round(b.height*s); c.getContext('2d').drawImage(b, 0, 0, c.width, c.height);
      const out = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.82));
      return out && out.size < f.size ? new File([out], f.name.replace(/\\.[^.]+$/, '') + '.jpg', {type:'image/jpeg'}) : f;
    }catch(e){ return f; }
  }
  document.querySelectorAll('form[data-upload]').forEach(form => {
    const list = form.querySelector('.upl-list');
    const picked = () => [...form.querySelectorAll('input[type=file]')].flatMap(i => [...i.files]);
    form.querySelectorAll('input[type=file]').forEach(i => i.addEventListener('change', () => {
      const n = picked().length; if (list) list.textContent = n ? n + ' file' + (n === 1 ? '' : 's') + ' ready: ' + picked().map(f => f.name).join(', ') : '';
      if (form.dataset.autosubmit !== undefined && n) form.requestSubmit();
    }));
    form.addEventListener('submit', async e => {
      e.preventDefault();
      const btn = form.querySelector('button[type=submit],button:not([type])'); if (btn) { btn.disabled = true; btn.dataset.label = btn.textContent; btn.textContent = 'Saving...'; }
      const fd = new FormData();
      for (const [k, v] of new FormData(form)) { if (v instanceof File) { if (v.size) fd.append(k, await shrink(v), v.name); } else fd.append(k, v); }
      try { const r = await fetch(form.action, {method:'POST', body:fd});
        if (r.ok && r.redirected) { location.href = r.url; return; }
        const t = await r.text(); alert(r.ok ? 'Saved.' : (t.replace(/<[^>]+>/g, ' ').trim().slice(0, 300) || 'Could not save.')); if (r.ok) location.reload();
      } catch (err) { alert('Could not save. Check your connection and try again.'); }
      if (btn) { btn.disabled = false; btn.textContent = btn.dataset.label; }
    });
  });
})();
</script>`;

const CSS = `
:root{--bg:#f7f6f3;--card:#fff;--ink:#1d1d1b;--muted:#6b6a66;--line:#e4e2dc;--accent:#2f6f5e;--accent-ink:#fff;--warn:#a5551b;--chip:#e3f0ec;--chip-ink:#1f4f42;--pending:#fbefd9;--pending-ink:#7a4a10;--stay:#3d5a80;--stay-ink:#fff;--win:#eef6f2;--win-ink:#2f6f5e;--win-line:#8fbfae;--tight:#b3412e;--tight-ring:#ffb199;--s-pending:#a16207;--s-missing:#d9480f;--s-past:#8a939e;--w-missing:#fff0e6;--w-missing-ink:#a8360a;--out:#efeee9;--c-prop:#fdf3e1;--c-prop-ink:#7a4a10;--c-prop-line:#c8912f;--c-asked:#ece7fc;--c-asked-ink:#4a3593;--c-asked-line:#8d78d9;--c-ok:#2f6f5e;--c-ok-ink:#fff;--c-past:#efeee9;--c-past-ink:#8a8780;--c-past-line:#d9d7d0}
@media (prefers-color-scheme:dark){:root{--bg:#141413;--card:#1e1e1c;--ink:#ecebe6;--muted:#a3a19a;--line:#33322f;--accent:#5fb39a;--accent-ink:#0f1f1a;--warn:#e19a62;--chip:#1f3a32;--chip-ink:#bfe6d9;--pending:#3a2c16;--pending-ink:#f2cf96;--stay:#5b7db0;--stay-ink:#fff;--win:#17302a;--win-ink:#9fd6c3;--win-line:#3f7a69;--tight:#d0604b;--tight-ring:#ffb199;--s-pending:#b7791f;--s-missing:#e8590c;--s-past:#4b5563;--w-missing:#3b1d0e;--w-missing-ink:#ffb48a;--out:#181817;--c-prop:#3a2c16;--c-prop-ink:#f2cf96;--c-prop-line:#b7791f;--c-asked:#2b2448;--c-asked-ink:#d4c9ff;--c-asked-line:#7563cc;--c-ok:#3f8f78;--c-ok-ink:#fff;--c-past:#262624;--c-past-ink:#8f8d86;--c-past-line:#3a3a37}}
*{box-sizing:border-box}
.pick{display:flex;gap:10px;align-items:flex-start;padding:8px 0;border-bottom:1px solid var(--line)}.pick input{margin-top:4px}
.gallery{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:8px}.gallery img{width:100%;aspect-ratio:4/3;object-fit:cover;border-radius:8px;display:block}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.45 system-ui,-apple-system,Segoe UI,sans-serif}
main{max-width:980px;margin:0 auto;padding:16px}h1{font-size:22px;margin:8px 0 4px}h2{font-size:17px;margin:0 0 10px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px;margin:14px 0}
.muted{color:var(--muted)}.warn{color:var(--tight)}.missing-text{color:var(--s-missing);font-weight:600}.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
button,.btn{background:var(--accent);color:var(--accent-ink);border:0;border-radius:8px;padding:8px 12px;font:inherit;cursor:pointer;text-decoration:none;display:inline-block}
button.ghost{background:transparent;color:var(--ink);border:1px solid var(--line)}button.danger{background:transparent;color:var(--warn);border:1px solid var(--line)}
input,textarea,select{font:inherit;padding:7px 9px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--ink)}textarea{width:100%;min-height:130px}
table{width:100%;border-collapse:collapse}td,th{padding:8px 6px;border-top:1px solid var(--line);text-align:left;vertical-align:top}th{font-weight:600;color:var(--muted);font-size:13px}
.stages{display:flex;gap:4px;flex-wrap:wrap}.stage{font-size:12px;padding:2px 7px;border-radius:99px;border:1px solid var(--line);color:var(--muted)}.stage.done{background:var(--chip);color:var(--chip-ink);border-color:transparent}
.stage.tap{cursor:pointer;font:inherit;font-size:13px;padding:5px 11px;background:var(--card);color:var(--ink);border:1.5px solid var(--accent)}.stage.tap.done{background:var(--accent);color:var(--accent-ink);border-color:var(--accent)}
.pill{font-size:12px;padding:2px 8px;border-radius:99px;background:var(--pending);color:var(--pending-ink)}.pill.asked{background:var(--c-asked);color:var(--c-asked-ink)}
.dows{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));font-size:12px;color:var(--muted);text-align:center;margin-bottom:4px}
.cal{display:flex;flex-direction:column;gap:4px}
.week{display:grid;grid-template-columns:repeat(14,minmax(0,1fr));grid-template-rows:22px 24px 24px 26px;column-gap:0;row-gap:3px;position:relative}
.day{cursor:pointer;grid-row:1/-1;min-width:0;border:1px solid var(--line);border-radius:8px;padding:2px 5px;font-size:12px;margin:0 2px}.day.out{background:var(--out);color:var(--muted)}.day.out b{font-weight:500}.day:hover{background:var(--win)}.day[data-past]{cursor:default}.day[data-past]:hover{background:none}.day.today{border-color:var(--accent);border-width:2px}.day.over{outline:2px dashed var(--accent)}.day.review{background:var(--pending);border:2px solid var(--s-pending);animation:pulse 1.2s ease-in-out 3}@keyframes pulse{50%{box-shadow:0 0 0 6px rgba(161,98,7,.25)}}.danger-text{color:var(--warn)}.save-state{font-size:12px;min-width:60px}
.bar{pointer-events:none;min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;font-size:12px;line-height:22px;padding:0 6px;border-radius:11px;z-index:1}
.stay-bar{grid-row:2;background:var(--stay);color:#fff;font-weight:600}.stay-bar.pending{background:var(--s-pending)}.stay-bar.missing{background:var(--s-missing)}.stay-bar.past{background:var(--s-past)}.stay-bar.personal{background-image:repeating-linear-gradient(135deg,rgba(255,255,255,.18) 0 6px,transparent 6px 12px)}.stay-bar.flagged{box-shadow:inset 0 0 0 2px #ffd43b}.stay-bar.cont-l{border-top-left-radius:0;border-bottom-left-radius:0}.stay-bar.cont-r{border-top-right-radius:0;border-bottom-right-radius:0}
.win-bar{grid-row:3;background:var(--win);color:var(--win-ink);border:1px dashed var(--win-line);line-height:20px;font-size:11px}
.win-bar.open,.win-bar.past{background:transparent;color:var(--muted);border-color:var(--line)}
.win-bar.pending{background:var(--pending);color:var(--pending-ink);border-color:var(--s-pending)}
.win-bar.missing{background:var(--w-missing);color:var(--w-missing-ink);border:1px solid var(--s-missing);font-weight:600}
.win-bar.tight{color:#fff;border:0;margin:0 4px;text-align:center;font-weight:600;background:var(--accent)}.win-bar.tight.pending{background:var(--s-pending)}.win-bar.tight.missing{background:var(--s-missing)}
.chip{grid-row:4;z-index:2;margin:0 4px;padding:2px 5px;border-radius:6px;background:var(--chip);color:var(--chip-ink);cursor:grab;font-size:12px;font-weight:600;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;border:1px solid var(--accent)}
.chip.cs-proposed{background:var(--c-prop);color:var(--c-prop-ink);border:1.5px dashed var(--c-prop-line)}
.chip.cs-asked{background:var(--c-asked);color:var(--c-asked-ink);border-color:var(--c-asked-line)}
.chip.cs-confirmed{background:var(--c-ok);color:var(--c-ok-ink);border-color:var(--c-ok)}
.chip.cs-past{background:var(--c-past);color:var(--c-past-ink);border-color:var(--c-past-line);font-weight:500;cursor:pointer}
.legend i.chip{width:22px;height:12px;border-radius:4px}
.l-short{display:none}@media (max-width:640px){.chip .l-long{display:none}.chip .l-short{display:inline}.chip{text-align:center}}
.state-banner{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-top:10px}.chip.static{cursor:default;display:inline-block;padding:2px 8px}
body.dragging .bar,body.dragging .chip{pointer-events:none}
.monthnav{display:flex;align-items:center;justify-content:space-between;gap:8px;margin:0 0 10px}.monthtitle{text-align:center;flex:1;min-width:0}.monthtitle h2{margin:0;font-size:22px}.monthtitle span{font-size:12px}.btn.ghost{background:none;color:var(--accent);border:1px solid var(--line);white-space:nowrap}.btn.ghost:hover{background:var(--win)}
.legend{display:flex;flex-wrap:wrap;gap:6px 14px;font-size:12px;color:var(--muted);margin:0 0 6px;align-items:center}.legend b{color:var(--ink)}.legend span{display:flex;align-items:center;gap:6px}.legend i{display:inline-block;width:22px;height:12px;padding:0;margin:0;line-height:0}
@media (max-width:640px){.cal-help{font-size:13px}.bar{font-size:10px;padding:0 3px}.chip{font-size:10px;margin:0 1px;padding:2px 2px}.day{margin:0 1px;padding:1px 3px}.hide-sm{display:none}}
.scroll{overflow-x:auto}
.topbar{display:flex;justify-content:space-between;align-items:center;gap:8px}.topbar h1{display:inline;margin:0 8px 0 0}.test-badge{text-decoration:none;font-size:12px;padding:2px 8px;border-radius:99px;background:var(--pending);color:var(--pending-ink);vertical-align:middle}
.toolbar{display:flex;justify-content:space-between;align-items:center;gap:8px;margin-top:10px;font-size:13px}button.small{padding:5px 10px;font-size:13px}
.brand,.topbar h1.brand{display:inline-flex;align-items:center;gap:8px;vertical-align:middle}.brand img{border-radius:22%;flex:none}
[hidden]{display:none!important}
.flash{margin-top:10px;padding:8px 12px;border-radius:8px;background:var(--chip);color:var(--chip-ink);font-size:14px}.alerts{display:flex;flex-wrap:wrap;gap:4px 16px;margin-top:8px;font-size:14px}
.card:has(#cal){margin-top:10px}
.tabs{display:flex;gap:2px;margin:10px 0 0;border-bottom:1px solid var(--line);overflow-x:auto;scrollbar-width:none;white-space:nowrap}.tab{padding:8px 12px;white-space:nowrap;color:var(--muted);text-decoration:none;border-bottom:2px solid transparent;margin-bottom:-1px}.tab.on{color:var(--ink);border-color:var(--accent);font-weight:600}
.count{background:var(--tight);color:#fff;border-radius:99px;padding:0 7px;font-size:12px}
.notes,.todos{list-style:none;margin:0;padding:0}.note{border-top:1px solid var(--line);padding:10px 0}.note-body{margin:4px 0;white-space:pre-wrap}
.tag{font-size:12px;padding:2px 8px;border-radius:99px}.tag.supplies{background:var(--pending);color:var(--pending-ink)}.tag.condition{background:var(--tight);color:#fff}
.todo{display:flex;gap:10px;align-items:flex-start;border-top:1px solid var(--line);padding:10px 0}.todo.done>div{opacity:.6;text-decoration:line-through}
.check{width:24px;height:24px;padding:0;border-radius:6px;background:transparent;border:2px solid var(--accent);color:var(--accent);font-weight:700;line-height:1}
details summary{cursor:pointer;font-size:13px}label{font-size:14px}
.chip small{font-weight:400}
dialog{border:1px solid var(--line);border-radius:12px;background:var(--card);color:var(--ink);padding:18px;width:min(440px,calc(100vw - 32px))}dialog::backdrop{background:rgba(0,0,0,.4)}
.personal-add{margin-top:14px;border-top:1px solid var(--line);padding-top:10px}.personal-add summary{font-weight:600}
.dialog-actions{display:flex;flex-direction:column;gap:8px;margin-top:12px}code{word-break:break-all}
.kpis{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;margin:6px 0 4px}.kpi{border:1px solid var(--line);border-radius:10px;padding:10px 12px;min-width:0}.kpi span{font-size:13px;color:var(--muted)}.kpi b{display:block;font-size:22px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.kpi.good b{color:var(--accent)}.kpi.bad b{color:var(--tight)}
@media (max-width:480px){.kpi{padding:8px}.kpi b{font-size:17px}}
.num{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}tr.total td{font-weight:700}.sub{font-size:13px;color:var(--muted)}
.receipts{display:flex;flex-wrap:wrap;gap:6px;margin-top:4px}.receipt{position:relative}.thumb{width:44px;height:44px;object-fit:cover;border-radius:6px;border:1px solid var(--line);display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;color:var(--muted);background:var(--bg);text-decoration:none}
.receipt .x{position:absolute;top:-7px;right:-7px;width:20px;height:20px;padding:0;border-radius:99px;background:var(--tight);color:#fff;font-size:14px;line-height:1}
.upload{margin:10px 0}.upload .btn{font-size:14px}.form-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}.form-grid label{display:flex;flex-direction:column;gap:3px}.form-grid .wide{grid-column:1/-1}.form-grid input,.form-grid select{width:100%}
@media (max-width:480px){.form-grid{grid-template-columns:1fr}}
.tag.none{background:var(--w-missing);color:var(--w-missing-ink)}.h3{font-size:15px;margin:16px 0 6px}
@media print{.live-bar,.tabs,.topbar,.noprint{display:none!important}.card{border:0;padding:0}body{background:#fff;color:#000}}
.live-bar{position:fixed;left:50%;bottom:16px;transform:translateX(-50%);background:var(--ink);color:var(--bg,#fff);padding:8px 10px 8px 14px;border-radius:999px;box-shadow:0 4px 16px rgba(0,0,0,.2);display:flex;gap:10px;align-items:center;z-index:50;font-size:14px;max-width:calc(100% - 32px)}.live-bar button{padding:4px 12px}
`;

export function layout(title, body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${h(title)}</title><link rel="icon" href="/icon.svg" type="image/svg+xml"><link rel="apple-touch-icon" href="/apple-touch-icon.png">
<link rel="manifest" href="/manifest.webmanifest"><meta name="theme-color" content="#2f6f5e"><meta name="apple-mobile-web-app-title" content="Cleaning"><meta name="apple-mobile-web-app-capable" content="yes"><style>${CSS}</style></head><body><main>${body}</main></body></html>`;
}

export function messagePage(title, text, extra = '') {
  return layout(title, `<div class="card"><h1>${h(title)}</h1><p>${h(text)}</p>${extra}</div>`);
}

// GROUP_MODE=phone sends through the phone's Share menu, not an sms: link. A named group
// (an RCS chat) can't be opened by a link, which only finds or makes a plain group by its
// numbers. The Share menu lists recent conversations, named groups included, so you pick
// yours and the text lands in it, ready to send.
// Only a phone can do this: on a computer the button is switched off and the text keeps
// waiting, so nothing is marked "sent" that never reached the group.
// shareText(text) resolves 'shared', 'cancelled', 'desktop', 'unavailable' or 'failed'.
const SHARE_JS = `const isPhone=()=>!!(navigator.userAgentData&&navigator.userAgentData.mobile)||/Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
async function shareText(text){
  if(!isPhone())return 'desktop';
  if(!navigator.share)return 'unavailable';
  try{await navigator.share({text});return 'shared';}catch(e){return e&&e.name==='AbortError'?'cancelled':'failed';}
}
const shareProblem={desktop:'Group texts go out from your phone. This one stays under Waiting on you: open Cleaning on your phone and tap Share to the group there.',
  unavailable:"This browser has no Share menu. Open Cleaning from your phone's home screen (Chrome) and try again.",failed:'Could not open the Share menu. Try again.',cancelled:'Not shared. It is still waiting.'};
function phoneOnly(btn,note){if(isPhone())return;btn.disabled=true;btn.textContent='Share from your phone';if(note)note.textContent=shareProblem.desktop;}
// Shares the form's text; only when the Share menu really went through is it recorded as sent.
function wireShare(form,btn,note,done){phoneOnly(btn,note);btn.addEventListener('click',async(e)=>{e.preventDefault();
  const b=new URLSearchParams(new FormData(form));b.set('send','1');b.set('js','1');b.set('shared','1');
  const r=await shareText(b.get('body')||'');if(r!=='shared'){if(note)note.textContent=shareProblem[r];return;}
  try{await fetch(form.action||location.href,{method:'POST',body:b,credentials:'same-origin'});}catch(err){}
  done();});}`;

export function loginPage({ next = '/', error = '', remember = true } = {}) {
  return layout('Sign in', `<div class="card" style="max-width:380px;margin:12vh auto 0"><h1 class="brand"><img src="/icon.svg" alt="" width="36" height="36">Cleaning Link</h1>
${error ? `<p class="flash">${h(error)}</p>` : ''}
<form method="post" action="/login"><input type="hidden" name="next" value="${h(next)}">
<label>Password<br><input type="password" name="password" autocomplete="current-password" autofocus required style="width:100%"></label>
<p><label><input type="checkbox" name="remember" value="1" ${remember ? 'checked' : ''}> Remember this device</label></p>
<button style="width:100%">Sign in</button></form>
<p class="muted">With "Remember this device" on, you stay signed in on this phone or computer for a year. Changing the password signs every device out.</p></div>`);
}

export function approvalPage(c, describe, token, by, approvers) {
  if (c.status !== 'awaiting_approval') {
    return messagePage('Already handled', `This cleaning is ${c.status.replace('_', ' ')}${c.approved_by ? ` (by ${c.approved_by})` : ''}.`);
  }
  const who = approvers.map(a => `<option ${a.name === by ? 'selected' : ''}>${h(a.name)}</option>`).join('');
  return layout('Approve cleaning', `<div class="card"><h1>Approve this cleaning?</h1><p>${h(describe(c))}</p>
<p class="muted">Approving texts the group thread with the cleaner right away.</p>
<form method="post" class="row"><select name="by">${who}</select>
<button name="action" value="approve">Approve and text the group</button><button class="danger" name="action" value="decline">Decline</button></form></div>`);
}

export function groupDecisionPage(m, c, by, approvers, guestsStaying = false, flash = '', phoneMode = false) {
  if (m.status !== 'pending') {
    return messagePage('Already decided', m.status === 'sent' ? `This was sent to the group${m.decided_by ? ` by ${m.decided_by}` : ''}.` : `This was ${m.status}.`, '<p><a class="btn" href="/">Back to dashboard</a></p>');
  }
  const who = approvers.map(a => `<option ${a.name === by ? 'selected' : ''}>${h(a.name)}</option>`).join('');
  return layout('Text the group?', `<div class="card"><h1>Text the group about this change?</h1>
<p class="muted">Cleaning on ${h(prettyDate(c.date))} is now <b>${h(c.status.replace('_', ' '))}</b>. Your cleaner treats the group text as the source of truth, so nothing goes out unless you say so.</p>
${guestsStaying ? `<p class="pill" style="display:inline-block">Heads up: guests are staying at the house on ${h(prettyDate(c.date))}.</p>` : ''}
${flash ? `<div class="flash">${h(flash)}</div>` : ''}
<form method="post"><textarea name="body">${h(m.body)}</textarea>
<div class="row" style="margin-top:10px"><select name="by" aria-label="Who is deciding">${who}</select>
${phoneMode ? '<button name="send" value="1" id="share-send">Share to the group</button>' : '<button name="send" value="1">Send to group</button><button class="ghost" name="send" value="test">Send me a test</button>'}<button class="ghost" name="send" value="0">Don't send</button><a class="btn ghost" href="/inbox">Decide later</a></div></form>
<p class="muted" style="margin-bottom:0" id="share-note">${phoneMode ? 'Your Share menu opens: pick your group (in Messages), then tap Send there.' : '"Send me a test" texts this message only to the person picked above, so you can see how it reads. The group gets nothing until you press "Send to group."'}</p></div>
${phoneMode ? `<script>{${SHARE_JS}wireShare(document.querySelector('form'),document.getElementById('share-send'),document.getElementById('share-note'),()=>{location.href=location.pathname+'?shared=1';});}</script>` : ''}`);
}

// Airbnb's export has no guest names, only the last 4 digits of the guest's phone.
// Mark or Danielle can type a name on the dashboard; until then we show the digits.
export function guestLabel(b) {
  if (b.guest_name) return b.guest_name;
  const last4 = (b.description || '').match(/Last 4 Digits\)?:\s*(\d{4})/i);
  return last4 ? `Guest ···${last4[1]}` : 'Guest';
}

const daysBetween = (a, b) => Math.round((new Date(b + 'T12:00:00Z') - new Date(a + 'T12:00:00Z')) / 864e5);

// Open windows for cleaning: from one checkout (11 AM) to the next check-in (1 PM).
export function cleaningWindows(bookings) {
  const sorted = [...bookings].sort((a, b) => a.check_in.localeCompare(b.check_in));
  return sorted.map((b, i) => {
    const next = sorted.slice(i + 1).find(n => n.check_in >= b.check_out) || null;
    return { from: b.check_out, to: next ? next.check_in : null, days: next ? daysBetween(b.check_out, next.check_in) + 1 : null, nextUid: next ? next.uid : null };
  });
}

// Is the house going to be cleaned before these guests arrive?
//   ready   - a confirmed cleaning sits between the previous checkout and this check-in
//   pending - a cleaning is proposed but still waiting for approval
//   missing - nothing scheduled in that gap
//   past    - the stay is over (shown greyed out)
// Stays that have already started, or have no stay before them, count as ready.
// Where a cleaning stands with the cleaner, for the calendar colors:
//   proposed  - not sent to the cleaner yet (waiting for your OK, or approved but not texted)
//   asked     - texted to the group, waiting for the cleaner to say yes
//   confirmed - the cleaner said yes, or you arranged it with her directly
//   past      - the day has gone by (or it's done/paid)
export function cleaningState(c, today) {
  if (['completed', 'paid'].includes(c.status) || c.date < today) return 'past';
  if (c.status === 'awaiting_approval') return 'proposed';
  if (c.group_known_date !== c.date) return 'proposed';
  return c.cleaner_confirmed_at ? 'confirmed' : 'asked';
}

export const CHIP_LABEL = { proposed: 'Needs OK', unsent: 'Not sent', asked: 'Asked', confirmed: '✓ Booked', past: 'Done' };
const CHIP_SHORT = { proposed: 'OK?', unsent: 'Draft', asked: 'Asked', confirmed: '✓', past: 'Done' };
const chipKey = (c, st) => st === 'proposed' && c.status !== 'awaiting_approval' ? 'unsent' : st;
const chipLabel = (c, st) => CHIP_LABEL[chipKey(c, st)];
// Full label on wide screens, a short one on phones where a day is ~50px wide.
const chipText = (c, st) => `<span class="l-long">${CHIP_LABEL[chipKey(c, st)]}</span><span class="l-short">${CHIP_SHORT[chipKey(c, st)]}</span>`;

export function stayReadiness(bookings, cleanings, today) {
  const live = cleanings.filter(c => !['cancelled', 'declined'].includes(c.status));
  const out = {};
  for (const b of bookings) {
    if (b.check_out < today) { out[b.uid] = 'past'; continue; }
    if (b.check_in < today) { out[b.uid] = 'ready'; continue; }
    const prev = bookings.filter(p => p.uid !== b.uid && p.check_out <= b.check_in).sort((x, y) => y.check_out.localeCompare(x.check_out))[0];
    if (!prev) { out[b.uid] = 'ready'; continue; }
    const inGap = live.filter(c => c.date >= prev.check_out && c.date <= b.check_in);
    out[b.uid] = inGap.some(c => ['confirmed', 'past'].includes(cleaningState(c, today))) ? 'ready' : inGap.length ? 'pending' : 'missing';
    // Your own stays don't raise the alarm if the house wasn't cleaned before you arrive.
    if (b.source === 'personal' && out[b.uid] === 'missing') out[b.uid] = 'ready';
  }
  return out;
}

const READINESS_NOTE = { ready: 'Cleaning confirmed before check-in', pending: 'Cleaning planned but not confirmed with the cleaner yet', missing: 'No cleaning scheduled before check-in', past: 'Past stay' };

function calendar(month, cleanings, bookings, tz, config, extras = { counts: {}, flagged: new Set() }) {
  const [y, m] = month.split('-').map(Number);
  const first = `${month}-01`;
  const gridStart = addDays(first, -new Date(first + 'T12:00:00Z').getUTCDay());
  const today = todayIn(tz);
  const prev = new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 7);
  const next = new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 7);
  const label = new Date(first + 'T12:00:00Z').toLocaleDateString('en-US', { timeZone: 'UTC', month: 'long', year: 'numeric' });
  const windows = cleaningWindows(bookings);
  const live = cleanings.filter(c => !['cancelled', 'declined'].includes(c.status));
  const ready = stayReadiness(bookings, cleanings, today);
  const weeks = [];

  // Each week is a 14-column grid (two half-days per day), so a stay can start at the
  // check-in afternoon and end at the checkout morning, and the open window sits between.
  for (let w = 0; w < 6; w++) {
    const ws = addDays(gridStart, w * 7);
    const we = addDays(ws, 6);
    if (w === 5 && ws.slice(0, 7) !== month) break;
    const idx = (d) => daysBetween(ws, d);
    // half-column grid line for the middle of day d (clipped to this week)
    const mid = (d, edge) => { const i = idx(d); return i < 0 ? 1 : i > 6 ? 15 : 2 * i + 2 + (edge || 0); };
    let html = '';
    for (let i = 0; i < 7; i++) {
      const d = addDays(ws, i);
      const staying = bookings.some(b => b.check_in < d && d < b.check_out);
      const turnover = bookings.some(b => b.check_out === d) && bookings.some(b => b.check_in === d);
      const booked = live.filter(c => c.date === d).length;
      html += `<div class="day ${d.slice(0, 7) !== month ? 'out' : ''} ${d === today ? 'today' : ''} ${extras.review?.date === d ? 'review' : ''}" data-date="${d}" data-label="${h(prettyDate(d))}"${staying ? ' data-staying="1"' : ''}${turnover ? ' data-turnover="1"' : ''}${booked ? ` data-booked="${booked}"` : ''}${d < today ? ' data-past="1"' : ''} style="grid-column:${2 * i + 1}/span 2" role="button" tabindex="0" aria-label="Add a cleaning on ${h(prettyDate(d))}"><b>${d.slice(8) === '01' || (d.slice(0, 7) !== month && d === ws) ? `${new Date(d + 'T12:00:00Z').toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short' })} ` : ''}${Number(d.slice(8))}</b></div>`;
    }
    for (const b of bookings) {
      if (b.check_out < ws || b.check_in > we) continue;
      const s = mid(b.check_in), e = mid(b.check_out);
      if (e <= s) continue;
      const cut = `${b.check_in < ws ? ' cont-l' : ''}${b.check_out > we ? ' cont-r' : ''}`;
      const nights = daysBetween(b.check_in, b.check_out);
      const flag = extras.flagged.has(b.uid);
      const st = ready[b.uid] || 'ready';
      html += `<div class="bar stay-bar ${st}${b.source === 'personal' ? ' personal' : ''}${cut}${flag ? ' flagged' : ''}" style="grid-column:${s}/${e}" title="${h(guestLabel(b))}: ${h(prettyDate(b.check_in))} to ${h(prettyDate(b.check_out))}, ${nights} night${nights === 1 ? '' : 's'}. ${READINESS_NOTE[st]}${flag ? '. Has notes to raise with Airbnb' : ''}">${flag ? '⚠ ' : ''}${st === 'missing' ? '! ' : ''}${b.source === 'personal' ? '⌂ ' : ''}${h(guestLabel(b))}</div>`;
    }
    for (const win of windows) {
      const end = win.to || addDays(we, 1);
      if (end < ws || win.from > we) continue;
      let s = mid(win.from), e = mid(end);
      const sameDay = win.to && win.to === win.from;
      if (sameDay) { s = mid(win.from) - 1; e = s + 2; }
      if (e <= s) continue;
      const st = win.nextUid ? (ready[win.nextUid] || 'ready') : 'open';
      const status = { ready: 'cleaning booked', pending: 'not confirmed yet', missing: 'no cleaning yet', past: '' }[st] || '';
      const text = sameDay ? `Same-day turnover: ${prettyTime(config.checkoutTime)} to ${prettyTime(config.checkinTime)}${status ? `, ${status}` : ''}`
        : win.to ? `${win.days} days to clean${status ? ` · ${status}` : ''}` : 'Open, no next booking yet';
      const showText = win.from >= ws || ws === gridStart; // label once, where the window starts
      html += `<div class="bar win-bar ${st}${sameDay ? ' tight' : ''}" style="grid-column:${s}/${e}" title="${h(text)}">${sameDay ? 'Same day' : showText ? h(text) : ''}</div>`;
    }
    for (const c of live) {
      const i = idx(c.date);
      if (i < 0 || i > 6) continue;
      const st = cleaningState(c, today);
      const tip = { proposed: c.status === 'awaiting_approval' ? 'Proposed, waiting for your OK' : 'Approved, not sent to the cleaner yet', asked: 'Texted to the group, waiting for the cleaner to confirm', confirmed: 'Confirmed with the cleaner', past: 'Past cleaning' }[st];
      html += `<span class="chip cs-${st}" draggable="${st === 'past' ? 'false' : 'true'}" data-id="${c.id}" style="grid-column:${2 * i + 1}/span 2" title="${h(tip)}. Click to open${st === 'past' ? '' : ', drag to move'}.">${chipText(c, st)}${extras.counts[c.id] ? ` <small>✎${extras.counts[c.id]}</small>` : ''}</span>`;
    }
    weeks.push(`<div class="week">${html}</div>`);
  }

  const short = (ym) => new Date(ym + '-01T12:00:00Z').toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short' });
  const thisMonth = today.slice(0, 7);
  const rel = month === thisMonth ? 'This month' : month < thisMonth ? 'Past month' : 'Upcoming';
  return `<div class="monthnav">
<a class="btn ghost" href="/?month=${prev}" aria-label="Previous month">&lsaquo; ${short(prev)}</a>
<div class="monthtitle"><h2>${label}</h2><span class="muted">${rel}${month !== thisMonth ? ` · <a href="/?month=${thisMonth}">Back to today</a>` : ''}</span></div>
<a class="btn ghost" href="/?month=${next}" aria-label="Next month">${short(next)} &rsaquo;</a></div>
<div class="legend"><b>Stays:</b><span><i class="bar stay-bar ready"></i>Cleaning confirmed before check-in</span><span><i class="bar stay-bar pending"></i>Cleaning not confirmed yet</span><span><i class="bar stay-bar missing"></i>No cleaning before check-in</span><span><i class="bar stay-bar past"></i>Past</span><span><i class="bar stay-bar ready personal"></i>⌂ Personal stay</span></div>
<div class="legend"><b>Cleanings:</b><span><i class="chip cs-proposed"></i>Not sent to ${h(config.cleaner?.name || 'cleaner')} yet</span><span><i class="chip cs-asked"></i>Texted, waiting on ${h(config.cleaner?.name || 'cleaner')}</span><span><i class="chip cs-confirmed"></i>Confirmed</span><span><i class="chip cs-past"></i>Past</span><span>✎ notes · ⚠ raise with Airbnb</span></div>
<div class="dows">${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map(d => `<div>${d}</div>`).join('')}</div>
<div class="cal" id="cal">${weeks.join('')}</div>
<p class="muted cal-help">Stays run from ${prettyTime(config.checkinTime)} check-in to ${prettyTime(config.checkoutTime)} checkout. Tap a day to add a cleaning. Tap a cleaning to open it, or drag it to another day to move it. You'll be asked before anything is texted to the group.</p>
<dialog id="add-dialog"><form method="post" action="/cleanings">
<h2 id="add-title">Add a cleaning</h2><input type="hidden" name="date" id="add-date"><input type="hidden" name="proposal" id="add-proposal">
<p id="add-about" class="muted" hidden></p>
<p id="add-warn" class="warn" hidden></p>
<label for="add-note" class="muted">Note (optional)</label><textarea name="note" id="add-note" maxlength="300" placeholder="e.g. deep clean the oven" style="min-height:70px"></textarea>
<div class="dialog-actions"><button name="arranged" value="1" id="add-arranged">Schedule, already arranged with ${h(config.cleaner?.name || 'the cleaner')}</button>
<button class="ghost" name="arranged" value="0" id="add-text">Schedule and text the group</button>
<button class="ghost danger-text" name="action" value="decline" id="add-decline" hidden formnovalidate onclick="return confirm('Decline this cleaning? Nothing is texted.')">Not needed</button>
<button class="ghost" type="button" id="add-cancel">Cancel</button></div>
<p class="muted" style="margin-bottom:0">"Already arranged" adds it without texting anyone. "Text the group" shows you the message before it goes out.<span id="add-other" hidden> To use a different day, close this and tap that day instead.</span></p></form>
<details class="personal-add" id="personal-add"><summary>Or add a personal stay starting this day</summary>
<form method="post" action="/personal" class="row" style="margin-top:8px"><input type="hidden" name="check_in" id="ps-in">
<label class="muted">Leaving <input type="date" name="check_out" id="ps-out" required></label>
<input name="name" placeholder="Who's staying (optional)" style="flex:1;min-width:150px"><button>Add personal stay</button></form>
<p class="muted" style="margin-bottom:0">A cleaning is proposed for the day you leave, unless one is already scheduled.</p></details></dialog>
<script>
const dlg=document.getElementById('add-dialog');
function openAdd(d){if(d.dataset.past)return;document.getElementById('add-date').value=d.dataset.date;
document.getElementById('ps-in').value=d.dataset.date;const o=document.getElementById('ps-out');o.min=d.dataset.date;const nx=new Date(d.dataset.date+'T12:00:00Z');nx.setUTCDate(nx.getUTCDate()+2);o.value=nx.toISOString().slice(0,10);document.getElementById('add-title').textContent='Add a cleaning on '+d.dataset.label;
const w=[];if(d.dataset.staying)w.push('Guests are staying that day.');if(d.dataset.turnover)w.push('Same-day turnover: the window is ${prettyTime(config.checkoutTime)} to ${prettyTime(config.checkinTime)}.');if(d.dataset.booked)w.push('There is already a cleaning that day.');
const el=document.getElementById('add-warn');el.textContent=w.join(' ');el.hidden=!w.length;document.getElementById('add-note').value='';const rv=review&&review.date===d.dataset.date?review:null;if(rv)el.hidden=true;setReview(rv);dlg.showModal();}
const cleanerName=${JSON.stringify(config.cleaner?.name || 'the cleaner').replace(/</g, '\\u003c')};
function setReview(r){const $=(i)=>document.getElementById(i);$('add-proposal').value=r?r.id:'';$('add-decline').hidden=!r;$('add-other').hidden=!r;$('add-about').hidden=!r;$('add-about').textContent=r?r.about:'';
$('add-arranged').textContent=(r?'Approve':'Schedule')+', already arranged with '+cleanerName;$('add-text').textContent=(r?'Approve':'Schedule')+' and text the group';$('personal-add').hidden=!!r;
if(r){$('add-title').textContent='Approve the cleaning on '+r.label;$('add-note').value=r.note;}}
const review=${JSON.stringify(extras.review || null).replace(/</g, '\\u003c')};
if(review){const d=document.querySelector('.day[data-date="'+review.date+'"]');if(d){d.scrollIntoView({block:'center'});setTimeout(()=>openAdd(d),350);}}
document.getElementById('add-cancel').addEventListener('click',()=>dlg.close());
dlg.addEventListener('click',e=>{if(e.target===dlg)dlg.close();});
document.querySelectorAll('.day').forEach(d=>{d.addEventListener('click',()=>openAdd(d));d.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();openAdd(d);}});});
let dragId=null;document.querySelectorAll('.chip[data-id]').forEach(c=>{c.addEventListener('click',()=>location.href='/cleanings/'+c.dataset.id);c.addEventListener('dragstart',e=>{dragId=c.dataset.id;e.dataTransfer.setData('text/plain',dragId);document.body.classList.add('dragging')});c.addEventListener('dragend',()=>document.body.classList.remove('dragging'))});
document.querySelectorAll('.day').forEach(d=>{d.addEventListener('dragover',e=>{e.preventDefault();d.classList.add('over')});
d.addEventListener('dragleave',()=>d.classList.remove('over'));
d.addEventListener('drop',async e=>{e.preventDefault();d.classList.remove('over');const id=e.dataTransfer.getData('text/plain')||dragId;if(!id)return;
const r=await fetch('/cleanings/'+id+'/move',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded','Accept':'application/json'},body:'date='+d.dataset.date});
const j=await r.json();location.href=j.redirect||'/?month=${month}'})});
{let sx=null,sy=0;const cal=document.getElementById('cal');cal.addEventListener('touchstart',e=>{sx=e.touches[0].clientX;sy=e.touches[0].clientY},{passive:true});cal.addEventListener('touchend',e=>{if(sx===null)return;const dx=e.changedTouches[0].clientX-sx,dy=e.changedTouches[0].clientY-sy;sx=null;if(Math.abs(dx)>70&&Math.abs(dx)>2*Math.abs(dy))location.href='/?month='+(dx<0?'${next}':'${prev}')})}
</script>`;
}

function reviewFor(service, id) {
  const c = id && service.get(id);
  if (!c || c.status !== 'awaiting_approval') return null;
  return { id: c.id, date: c.date, label: prettyDate(c.date), about: service.describe(c), note: c.note || '' };
}

function calendarExtras(db) {
  const counts = Object.fromEntries(db.prepare('SELECT cleaning_id, COUNT(*) n FROM notes WHERE cleaning_id IS NOT NULL GROUP BY cleaning_id').all().map(r => [r.cleaning_id, r.n]));
  const flagged = new Set(db.prepare("SELECT DISTINCT booking_uid FROM notes WHERE followup='open' AND booking_uid IS NOT NULL").all().map(r => r.booking_uid));
  return { counts, flagged };
}

export function header({ config, db, who, active }) {
  const whoSel = config.approvers.map(a => `<option ${a.name === who ? 'selected' : ''}>${h(a.name)}</option>`).join('');
  const openTodos = db.prepare("SELECT COUNT(*) n FROM todos WHERE status='open'").get().n
    + db.prepare("SELECT COUNT(*) n FROM notes WHERE followup='open'").get().n;
  const waiting = db.prepare("SELECT COUNT(*) n FROM group_messages WHERE status='pending'").get().n
    + db.prepare("SELECT COUNT(*) n FROM cleanings WHERE status='awaiting_approval'").get().n
    + db.prepare("SELECT COUNT(*) n FROM cleanings WHERE status='approved' AND group_known_date = date AND cleaner_confirmed_at IS NULL AND date >= ?").get(todayIn(config.timezone)).n;
  const badge = (n) => n ? ` <span class="count">${n}</span>` : '';
  const tab = (key, href, label) => `<a class="tab ${active === key ? 'on' : ''}" href="${href}">${label}</a>`;
  return `<div class="topbar"><div><h1 class="brand"><img src="/icon.svg" alt="" width="28" height="28">Cleaning Link</h1>${config.dryRun ? '<a class="test-badge" href="/more#texting">Test mode</a>' : config.smsOnlyTo?.length ? '<a class="test-badge" href="/more#texting">Texts: safety switch on</a>' : ''}</div>
<form method="post" action="/who" class="row"><label class="muted hide-sm">You are</label><select name="name" onchange="this.form.submit()" aria-label="You are">${whoSel}</select></form></div>
${LIVE_JS(liveStamp(db))}<nav class="tabs">${tab('calendar', '/', 'Calendar')}${tab('inbox', '/inbox', `Waiting on you${badge(waiting)}`)}${tab('stays', '/stays', 'Stays')}${tab('todos', '/todos', `To-do${badge(openTodos)}`)}${tab('notes', '/notes', 'Notes')}${tab('payments', '/payments', 'Payments')}${tab('more', '/more', 'More')}</nav>`;
}

const TAG_LABEL = { supplies: 'Supplies', condition: 'Condition / damage' };
const tagPills = (tags) => (tags || '').split(',').filter(Boolean).map(t => `<span class="tag ${t}">${TAG_LABEL[t] || h(t)}</span>`).join(' ');
const when = (iso, tz) => new Date(iso).toLocaleString('en-US', { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

function noteItem(n, { config, cleanings, showCleaning = true }) {
  const opts = ['<option value="">Not tied to a cleaning</option>', ...cleanings.map(c => `<option value="${c.id}" ${c.id === n.cleaning_id ? 'selected' : ''}>Cleaning ${h(prettyDate(c.date))}</option>`)].join('');
  const tags = (n.tags || '').split(',');
  const cleaning = cleanings.find(c => c.id === n.cleaning_id);
  return `<li class="note"><div class="row" style="justify-content:space-between"><div><b>${h(n.author)}</b> <span class="muted">${h(when(n.at, config.timezone))}${n.source === 'manual' ? ' · added by hand' : ''}</span></div><div>${tagPills(n.tags)}</div></div>
<div class="note-body">${h(n.body)}</div>
${showCleaning && cleaning ? `<div class="muted">About the <a href="/cleanings/${cleaning.id}">${h(prettyDate(cleaning.date))} cleaning</a></div>` : ''}
<details><summary class="muted">Change</summary><form method="post" action="/notes/${n.id}" class="row" style="margin-top:6px">
<select name="cleaning_id">${opts}</select>
<label><input type="checkbox" name="tag" value="supplies" ${tags.includes('supplies') ? 'checked' : ''}> Supplies to-do</label>
<label><input type="checkbox" name="tag" value="condition" ${tags.includes('condition') ? 'checked' : ''}> Airbnb follow-up</label>
<button class="ghost">Save</button></form></details></li>`;
}

function addNoteForm(config, cleanings, cleaningId = null) {
  const people = config.groupMembers.map(p => `<option>${h(p.name)}</option>`).join('');
  const opts = ['<option value="">Pick automatically from the time</option>', ...cleanings.map(c => `<option value="${c.id}" ${c.id === cleaningId ? 'selected' : ''}>Cleaning ${h(prettyDate(c.date))}</option>`)].join('');
  return `<form method="post" action="/notes"><textarea name="body" placeholder="Paste or type a text from the group thread" required></textarea>
<div class="row" style="margin-top:8px"><select name="author">${people}</select><input type="datetime-local" name="at" title="When it was sent (leave blank for now)">
<select name="cleaning_id">${opts}</select><button>Add note</button></div>
<p class="muted">Leave the time blank for now. Notes from the cleaner about missing supplies become to-dos, and notes about damage or mess are flagged for Airbnb follow-up. You can change either afterwards.</p></form>`;
}

const pickable = (db) => db.prepare("SELECT * FROM cleanings WHERE status NOT IN ('cancelled','declined') ORDER BY date DESC LIMIT 60").all();

export function notesPage({ config, db, who }) {
  const notes = db.prepare('SELECT * FROM notes ORDER BY at DESC LIMIT 200').all();
  const cleanings = pickable(db);
  return layout('Notes', `${header({ config, db, who, active: 'notes' })}
<div class="card"><h2>Add a note</h2>${addNoteForm(config, cleanings)}</div>
<div class="card"><h2>All notes</h2><p class="muted">${config.groupMode === 'phone' ? 'Texts in your group thread are saved here automatically when Mark\'s phone forwards them (messages you send yourself aren\'t, so add those by hand if they matter).' : config.groupMode === 'conversation' ? 'Texts in the group thread are saved here automatically.' : 'Texts sent to the app\'s number are saved here automatically.'} Each one is tied to the cleaning it's about and the stay before it.</p>
${notes.length ? `<ul class="notes">${notes.map(n => noteItem(n, { config, cleanings })).join('')}</ul>` : '<p class="muted">No notes yet.</p>'}</div>`);
}

export function todosPage({ config, db, who }) {
  const open = db.prepare("SELECT t.*, c.date FROM todos t LEFT JOIN cleanings c ON c.id = t.cleaning_id WHERE t.status='open' ORDER BY t.created_at").all();
  const done = db.prepare("SELECT * FROM todos WHERE status='done' ORDER BY done_at DESC LIMIT 15").all();
  const follow = db.prepare("SELECT n.*, b.check_in, b.check_out, b.guest_name, b.description FROM notes n LEFT JOIN bookings b ON b.uid = n.booking_uid WHERE n.followup IS NOT NULL ORDER BY n.followup = 'done', n.at DESC LIMIT 50").all();
  const todoRow = (t) => `<li class="todo ${t.status}"><form method="post" action="/todos/${t.id}"><input type="hidden" name="done" value="${t.status === 'open' ? 1 : 0}">
<button class="check" title="${t.status === 'open' ? 'Mark done' : 'Reopen'}">${t.status === 'open' ? '' : '✓'}</button></form>
<div><div>${h(t.title)}</div><div class="muted">${t.note_id ? 'From a text' : `Added${t.created_by ? ` by ${h(t.created_by)}` : ''}`}${t.date ? ` · <a href="/cleanings/${t.cleaning_id}">${h(prettyDate(t.date))} cleaning</a>` : ''}${t.done_by ? ` · done by ${h(t.done_by)}` : ''}</div></div></li>`;
  const followRow = (n) => {
    const stay = n.check_in ? `${h(n.guest_name || guestLabel(n))}, ${h(prettyDate(n.check_in))} to ${h(prettyDate(n.check_out))}` : 'Stay not known';
    const url = (n.description || '').match(/https:\/\/www\.airbnb\.[^\s]+/)?.[0];
    return `<li class="todo ${n.followup === 'done' ? 'done' : 'open'}"><form method="post" action="/notes/${n.id}/followup"><input type="hidden" name="status" value="${n.followup === 'open' ? 'done' : 'open'}">
<button class="check" title="${n.followup === 'open' ? 'Mark followed up' : 'Reopen'}">${n.followup === 'open' ? '' : '✓'}</button></form>
<div><div>${h(n.body)}</div><div class="muted">${h(n.author)}, ${h(when(n.at, config.timezone))} · Stay: ${stay}${url ? ` · <a href="${h(url)}" target="_blank" rel="noopener">Open reservation on Airbnb</a>` : ''}</div></div></li>`;
  };
  return layout('To-do', `${header({ config, db, who, active: 'todos' })}
<div class="card"><h2>To-do</h2>
${open.length ? `<ul class="todos">${open.map(todoRow).join('')}</ul>` : '<p class="muted">Nothing to do.</p>'}
<form method="post" action="/todos" class="row" style="margin-top:10px"><input name="title" placeholder="Add a to-do, e.g. buy 6 hand towels" required style="flex:1;min-width:200px"><button>Add</button></form></div>
<div class="card"><h2>Raise with Airbnb</h2><p class="muted">Notes about damage, mess or anything unusual, tied to the stay they happened after.</p>
${follow.length ? `<ul class="todos">${follow.map(followRow).join('')}</ul>` : '<p class="muted">Nothing flagged.</p>'}</div>
${done.length ? `<div class="card"><h2>Done recently</h2><ul class="todos">${done.map(todoRow).join('')}</ul></div>` : ''}`);
}

function stateBanner(c, config) {
  if (['cancelled', 'declined'].includes(c.status)) return '';
  const st = cleaningState(c, todayIn(config.timezone));
  const cleaner = h(config.cleaner?.name || 'the cleaner');
  const text = {
    proposed: c.status === 'awaiting_approval' ? 'Proposed, waiting for your OK.' : `Approved, but not sent to ${cleaner} yet.`,
    asked: `Texted to the group. Waiting for ${cleaner} to confirm.`,
    confirmed: `Confirmed with ${cleaner}.`,
    past: 'This cleaning is in the past.',
  }[st];
  const btn = st === 'asked' ? `<form method="post" action="/cleanings/${c.id}/confirm"><button>${cleaner} confirmed</button></form>`
    : st === 'confirmed' && c.group_known_date === c.date ? `<form method="post" action="/cleanings/${c.id}/unconfirm"><button class="ghost small">Undo confirmed</button></form>` : '';
  return `<div class="state-banner"><span class="chip cs-${st} static">${chipLabel(c, st)}</span><span>${text}</span>${btn}</div>`;
}


// The step pills on a cleaning. Cleaned, price quoted and paid can be tapped to record them.
const STEP_LABEL = { 'Payment requested': 'Price quoted' };
function stepPills(c, service, config, who) {
  const live = !['cancelled', 'declined', 'awaiting_approval'].includes(c.status);
  const tap = { Approved: c.status === 'awaiting_approval' ? 'approve-dialog' : null, 'Cleaner confirmed': live && (c.group_known_date === c.date || c.cleaner_confirmed_at) && !['completed', 'paid'].includes(c.status) ? 'confirm-dialog' : null,
    Cleaned: live ? 'cleaned-dialog' : null, 'Payment requested': live ? 'quote-dialog' : null, Paid: live ? 'paid-dialog' : null };
  const pills = service.stageOf(c).map(s => {
    const label = h(STEP_LABEL[s.name] || s.name);
    return tap[s.name] ? `<button type="button" class="stage tap ${s.done ? 'done' : ''}" data-open="${tap[s.name]}">${s.done ? '✓ ' : ''}${label}</button>`
      : `<span class="stage ${s.done ? 'done' : ''}">${label}</span>`;
  }).join('');
  const cleaner = h(config.cleaner?.name || 'the cleaner');
  const today = todayIn(config.timezone);
  const done = ['completed', 'paid'].includes(c.status);
  const dollars = c.amount_cents != null ? (c.amount_cents / 100).toFixed(2) : '';
  const methods = ['Venmo', 'Zelle', 'Cash', 'Check', 'Other'].map(m => `<option ${m === c.paid_method ? 'selected' : ''}>${m}</option>`).join('');
  const close = '<button type="button" class="ghost" data-close>Cancel</button>';
  // A proposal waiting for an OK can be approved right here, same as from Waiting on you.
  const approve = c.status === 'awaiting_approval' ? `<div class="row" style="margin-top:10px"><button type="button" data-open="approve-dialog">Approve this cleaning</button></div>
<dialog id="approve-dialog"><form method="post" action="/cleanings"><input type="hidden" name="proposal" value="${c.id}"><input type="hidden" name="back" value="cleaning">
<h2>Approve the cleaning on ${h(prettyDate(c.date))}?</h2>
<label for="approve-note" class="muted">Note (optional)</label><textarea name="note" id="approve-note" maxlength="300" placeholder="e.g. deep clean the oven" style="min-height:70px">${h(c.note || '')}</textarea>
<div class="dialog-actions"><button name="arranged" value="1">Approve, already arranged with ${cleaner}</button>
<button class="ghost" name="arranged" value="0">Approve and text the group</button>
<button class="ghost danger-text" name="action" value="decline" formnovalidate onclick="return confirm('Mark this cleaning not needed? Nothing is texted.')">Not needed</button>${close}</div>
<p class="muted" style="margin-bottom:0">"Already arranged" approves it without texting anyone. "Text the group" shows you the message before it goes out.</p></form></dialog>` : '';
  return `<div class="stages">${pills}</div>${live ? '<p class="muted" style="font-size:12px;margin:4px 0 0">Tap a step to mark it done.</p>' : ''}${approve}
${c.cleaner_confirmed_at
  ? `<dialog id="confirm-dialog"><form method="post" action="/cleanings/${c.id}/unconfirm"><h2>Undo ${cleaner}'s confirmation?</h2><p>${h(prettyDate(c.date))} goes back to waiting on ${cleaner}. Nothing is texted to the group.</p>
<div class="dialog-actions"><button class="danger">Yes, not confirmed</button>${close}</div></form></dialog>`
  : `<dialog id="confirm-dialog"><form method="post" action="/cleanings/${c.id}/confirm"><h2>${cleaner} confirmed?</h2><p>Mark that ${cleaner} said yes to ${h(prettyDate(c.date))}.</p>
<div class="dialog-actions"><button>Yes, ${cleaner} confirmed</button>${close}</div></form></dialog>`}
<dialog id="cleaned-dialog"><form method="post" action="/cleanings/${c.id}/cleaned"><h2>${done ? 'Cleaned' : 'Mark as cleaned?'}</h2>
<p>${done ? `${h(prettyDate(c.date))} is marked as cleaned.` : `Mark the ${h(prettyDate(c.date))} cleaning as done.`}${c.date > today && !done ? ' <span class="warn">This date is still ahead.</span>' : ''}</p>
<div class="dialog-actions">${done ? (c.status === 'paid' ? '<p class="muted">Already paid, so this can\'t be undone here. Undo the payment first.</p>' : '<button name="yes" value="0" class="ghost">Not cleaned yet (undo)</button>') : '<button name="yes" value="1">Yes, it\'s cleaned</button>'}${close}</div></form></dialog>
<dialog id="quote-dialog"><form method="post" action="/cleanings/${c.id}/quote"><h2>Price quoted</h2><p>What ${cleaner} is charging for this cleaning.</p>
${c.status === 'paid' ? `<p><b>${money(c.amount_cents)}</b>, already paid.</p><div class="dialog-actions">${close}</div>` : `<label class="muted">Amount ($)<br><input name="amount" type="number" min="1" step="0.01" inputmode="decimal" value="${dollars}" required style="width:100%"></label>
${!done ? '<p class="muted">Saving a price also marks the cleaning as cleaned.</p>' : ''}<div class="dialog-actions"><button>Save price</button>${close}</div>`}</form></dialog>
<dialog id="paid-dialog"><form method="post" action="/cleanings/${c.id}/paid"><h2>${c.status === 'paid' ? 'Paid' : 'Mark as paid'}</h2>
${c.status === 'paid' ? `<p><b>${money(c.amount_cents)}</b> paid ${h(prettyDate(c.paid_at.slice(0, 10)))}${c.paid_by ? ` by ${h(c.paid_by)}` : ''}${c.paid_method ? ` via ${h(c.paid_method)}` : ''}.</p><div class="dialog-actions"><button name="undo" value="1" class="ghost">Undo payment</button>${close}</div>`
    : `<label class="muted">Amount ($)<br><input name="amount" type="number" min="1" step="0.01" inputmode="decimal" value="${dollars}" required style="width:100%"></label>
<label class="muted">Date paid<br><input name="paid_on" type="date" value="${today}" max="${today}" required style="width:100%"></label>
<label class="muted">Who paid<br><select name="paid_by" style="width:100%">${payerOptions(config, who)}</select></label>
<label class="muted">How<br><select name="method" style="width:100%">${methods}</select></label>
<div class="dialog-actions"><button>Mark paid</button>${close}</div>`}</form></dialog>
<script>
document.querySelectorAll('[data-open]').forEach(b => b.addEventListener('click', () => document.getElementById(b.dataset.open).showModal()));
document.querySelectorAll('dialog [data-close]').forEach(b => b.addEventListener('click', () => b.closest('dialog').close()));
</script>`;
}

function paymentRow(c, config) {
  if (c.amount_cents == null && c.status !== 'paid') return '';
  return `<p style="margin:8px 0 0">${c.status === 'paid'
    ? `Paid <b>${money(c.amount_cents)}</b> on ${h(prettyDate(c.paid_at.slice(0, 10)))}${c.paid_by ? ` by ${h(c.paid_by)}` : ''}${c.paid_method ? ` via ${h(c.paid_method)}` : ''}.`
    : `Price quoted: <b>${money(c.amount_cents)}</b>, not paid yet.`}</p>`;
}

export function cleaningPage({ config, db, who, service, id, receipts = [], photos = [], photosLink = '', flash = '' }) {
  const c = service.get(id);
  if (!c) return null;
  const stay = db.prepare("SELECT * FROM bookings WHERE status='active' AND check_out <= ? ORDER BY check_out DESC LIMIT 1").get(c.date);
  const nextStay = db.prepare("SELECT * FROM bookings WHERE status='active' AND check_in >= ? ORDER BY check_in LIMIT 1").get(c.date);
  const notes = db.prepare('SELECT * FROM notes WHERE cleaning_id = ? ORDER BY at').all(id);
  const todos = db.prepare('SELECT * FROM todos WHERE cleaning_id = ? ORDER BY created_at').all(id);
  const events = db.prepare("SELECT * FROM events WHERE cleaning_id = ? AND stage != 'Note' ORDER BY at").all(id);
  const cleanings = pickable(db);
  const groupMsgs = db.prepare('SELECT * FROM group_messages WHERE cleaning_id = ? ORDER BY id').all(id);
  const latestId = groupMsgs.filter(g => g.status !== 'superseded').reduce((a, g) => Math.max(a, g.id), 0);
  const stayText = (b) => b ? `${h(guestLabel(b))}, ${h(prettyDate(b.check_in))} to ${h(prettyDate(b.check_out))}` : 'None';
  return layout(`Cleaning ${prettyDate(c.date)}`, `${header({ config, db, who, active: 'calendar' })}
${flash ? `<div class="flash">${h(flash)}</div>` : ''}<div class="card"><p><a href="/?month=${c.date.slice(0, 7)}">&lsaquo; Calendar</a></p><h2>Cleaning ${h(prettyDate(c.date))}</h2>
${stepPills(c, service, config, who)}
${stateBanner(c, config)}
${paymentRow(c, config)}
${['completed', 'paid'].includes(c.status) ? `<div class="h3">Payment receipts</div>${receiptStrip(receipts, { deletable: true, back: `/cleanings/${c.id}` })}
<form method="post" action="/cleanings/${c.id}/receipt" enctype="multipart/form-data" data-upload data-autosubmit>${receiptInputs(receipts.length ? 'Add another (Venmo screenshot, invoice)' : 'Add a Venmo screenshot or invoice')}</form>` : ''}
<table style="margin-top:10px"><tr><th>After the stay of</th><td>${stayText(stay)}</td></tr><tr><th>Before the stay of</th><td>${stayText(nextStay)}</td></tr>
${c.note ? `<tr><th>Note</th><td>${h(c.note)}</td></tr>` : ''}</table></div>
${photosCard(c, photos, photosLink, nextStay)}
<div class="card"><h2>Notes</h2>${notes.length ? `<ul class="notes">${notes.map(n => noteItem(n, { config, cleanings, showCleaning: false })).join('')}</ul>` : '<p class="muted">No notes for this cleaning yet.</p>'}
<h2 style="margin-top:14px">Add a note</h2>${addNoteForm(config, cleanings, c.id)}</div>
${todos.length ? `<div class="card"><h2>To-dos from this cleaning</h2><ul>${todos.map(t => `<li>${t.status === 'done' ? '✓ ' : ''}${h(t.title)}</li>`).join('')}</ul></div>` : ''}
${groupMsgs.length ? `<div class="card"><h2>Group texts</h2><table>${groupMsgs.map(g => `<tr><td><span class="pill">${{ pending: 'Waiting on you', sent: 'Sent', skipped: 'Not sent', superseded: 'Replaced' }[g.status] || h(g.status)}</span></td><td>${h(g.body)}</td>
<td>${g.status === 'skipped' && g.id === latestId ? `<form method="post" action="/g/${g.token}"><input type="hidden" name="by" value="${h(who)}"><button class="ghost" name="send" value="undo">Undo</button></form>`
  : g.status === 'sent' && g.id === latestId && config.groupMode === 'phone' ? `<form method="post" action="/g/${g.token}"><input type="hidden" name="by" value="${h(who)}"><button class="ghost" name="send" value="unsend" title="Puts it back under Waiting on you so you can share it from your phone">Didn't go out? Send again</button></form>`
  : g.status === 'pending' ? `<a class="btn ghost" href="/?month=${c.date.slice(0, 7)}&msg=${g.token}">Decide</a>` : ''}</td></tr>`).join('')}</table></div>` : ''}
${c.source === 'manual' ? `<div class="card"><h2>Delete this cleaning</h2><p class="muted">For mistakes and tests. It's removed completely: nothing is texted, and it leaves the calendar and payment records.${c.group_known_date ? ' The group was told about it, so if it was real, use Cancel on Waiting on you instead, which asks whether to tell them.' : ''}</p>
<form method="post" action="/cleanings/${c.id}/delete" onsubmit="return confirm('Delete the ${h(prettyDate(c.date))} cleaning completely? Nothing is texted. This can\\'t be undone.')"><button class="danger">Delete cleaning</button></form></div>` : ''}
${c.status === 'declined' ? `<div class="card"><p>This cleaning was marked not needed.</p><form method="post" action="/cleanings/${c.id}/restore"><button class="ghost">Undo, put it back for approval</button></form></div>` : ''}
<div class="card"><h2>History</h2><table>${events.map(e => `<tr><td class="muted" style="white-space:nowrap">${h(when(e.at, config.timezone))}</td><td><b>${h(e.stage)}</b> ${h(e.detail || '')}</td></tr>`).join('')}</table></div>`);
}

// After-cleaning photos and the ways to pass them to the next guest.
function photosCard(c, photos, link, nextStay) {
  return `<div class="card" id="photos"><h2>Photos${photos.length ? ` (${photos.length})` : ''}</h2>
${photos.length ? `<div class="receipts">${photos.map(p => `<div class="receipt"><a href="/photos/${p.id}" target="_blank" rel="noopener"><img class="thumb" src="/photos/${p.id}" alt="" loading="lazy"></a><form method="post" action="/photos/${p.id}/delete" onsubmit="return confirm('Delete this photo?')"><button class="x" aria-label="Delete photo">&times;</button></form></div>`).join('')}</div>
<div class="row" style="margin-top:10px"><button type="button" id="share-photos">Share photos${nextStay ? ` with ${h(guestLabel(nextStay))}` : ''}</button><button type="button" class="ghost" id="copy-link">Copy guest link</button></div>
<p class="muted" id="share-note">"Share photos" opens your phone's share menu with the pictures, so you can pick Airbnb and attach them to a message. "Copy guest link" copies a private page with just these photos.</p>
<script>{const ids=${JSON.stringify(photos.map(p => p.id))};const link=${JSON.stringify(link).replace(/</g, '\\u003c')};const note=document.getElementById('share-note');
document.getElementById('copy-link').addEventListener('click',async()=>{try{await navigator.clipboard.writeText(link);note.textContent='Copied: '+link;}catch(e){note.textContent=link;}});
document.getElementById('share-photos').addEventListener('click',async()=>{try{note.textContent='Getting the photos ready...';
const files=await Promise.all(ids.map(async(id,i)=>{const b=await (await fetch('/photos/'+id)).blob();return new File([b],'photo-'+(i+1)+'.'+(b.type.split('/')[1]||'jpg'),{type:b.type});}));
if(navigator.canShare&&navigator.canShare({files})){await navigator.share({files});note.textContent='Shared.';}
else{await navigator.clipboard.writeText(link);note.textContent="This browser can't share photos directly, so the guest link was copied instead: "+link;}}catch(e){if(e.name!=='AbortError')note.textContent='Could not share: '+e.message;else note.textContent='';}});}</script>`
    : '<p class="muted">No photos yet. Quickest way: in Messages, select the photos the cleaner sent, tap Share, then pick <b>Cleaning</b>. Or add them here.</p>'}
<form method="post" action="/cleanings/${c.id}/photos" enctype="multipart/form-data" data-upload data-autosubmit><div class="upload"><div class="row">
<label class="btn ghost">Add photos<input type="file" name="photo" accept="image/*" multiple hidden></label></div><div class="muted upl-list" style="font-size:13px"></div></div></form>
${UPLOAD_JS}</div>`;  // one copy, after both upload forms (receipts and photos)
}

function staysCard(bookings, today, config, cleanings = []) {
  const live = cleanings.filter(c => !['cancelled', 'declined'].includes(c.status));
  const wins = cleaningWindows(bookings);
  const sorted = [...bookings].sort((a, b) => a.check_in.localeCompare(b.check_in));
  const rows = sorted.map((b, i) => [b, wins[i]]).filter(([b]) => b.check_out >= today).map(([b, w]) => {
    const nights = daysBetween(b.check_in, b.check_out);
    const gap = !w.to ? 'No next booking yet' : w.to === w.from ? '<b class="warn">Same day</b>' : `${w.days} days (${h(prettyDate(w.from))} to ${h(prettyDate(w.to))})`;
    const covering = live.find(c => c.date >= w.from && (!w.to || c.date <= w.to));
    const plan = !covering && w.to && w.to >= today
      ? '<div class="missing-text">No cleaning scheduled</div>'
      : covering
      ? `<div><a href="/cleanings/${covering.id}">${covering.status === 'awaiting_approval' ? 'Proposed' : 'Cleaning'} ${h(prettyDate(covering.date))}</a>${covering.status === 'awaiting_approval' ? ' <span class="muted">(waiting for approval)</span>' : ' ✓'}</div>`
      : '';
    const form = !covering || covering.status === 'awaiting_approval'
      ? `<form method="post" action="/cleanings" class="row" style="margin-top:4px"><input type="hidden" name="arranged" value="1">
<input type="date" name="date" value="${w.from}" min="${w.from}" ${w.to ? `max="${w.to}"` : ''} required><button class="ghost" title="Already arranged with the cleaner, nothing is texted">Schedule</button></form>`
      : '';
    return `<tr><td><form method="post" action="/bookings/name" class="row"><input type="hidden" name="uid" value="${h(b.uid)}">
<input name="name" value="${h(b.guest_name || '')}" placeholder="${h(guestLabel(b))}" style="width:150px" data-autosave autocomplete="off" aria-label="Guest name"><span class="save-state muted" aria-live="polite"></span></form></td>
<td>${b.source === 'personal' ? '<b>⌂ Personal</b><br>' : ''}${h(prettyDate(b.check_in))} to ${h(prettyDate(b.check_out))}<div class="muted">${nights} night${nights === 1 ? '' : 's'}</div></td><td>${gap}${plan}${form}</td></tr>`;
  }).join('');
  return `<div class="card"><h2>Stays and cleaning windows</h2>
<p class="muted">Airbnb's calendar link doesn't include guest names, only the last 4 digits of their phone. Type a name here and it saves on its own, then shows on the calendar. "Schedule" books a cleaning you've already arranged, without texting anyone.</p>
${rows ? `<div class="scroll"><table><tr><th>Guest</th><th>Stay</th><th>Time to clean after</th></tr>${rows}</table></div>` : '<p class="muted">No upcoming stays.</p>'}</div>`;
}

function pageData({ config, service, db, month }) {
  const today = todayIn(config.timezone);
  return {
    today,
    cleanings: service.list({ from: addDays(`${month || today.slice(0, 7)}-01`, -60) }),
    bookings: db.prepare("SELECT * FROM bookings WHERE status='active'").all(),
  };
}

function decisionsList({ db, service, who, config }) {
  const asked = db.prepare("SELECT * FROM cleanings WHERE status='approved' AND group_known_date = date AND cleaner_confirmed_at IS NULL AND date >= ? ORDER BY date").all(todayIn(config.timezone));
  const cleaner = h(config.cleaner?.name || 'the cleaner');
  const pendingMsgs = db.prepare("SELECT g.*, c.date FROM group_messages g JOIN cleanings c ON c.id = g.cleaning_id WHERE g.status='pending' ORDER BY g.created_at").all();
  const awaiting = db.prepare("SELECT * FROM cleanings WHERE status='awaiting_approval' ORDER BY date").all();
  return [
    ...pendingMsgs.map(m => `<tr><td>${h(prettyDate(m.date))}</td><td><span class="pill">Text the group?</span> ${h(m.body)}</td><td><a class="btn" href="/?month=${m.date.slice(0, 7)}&msg=${m.token}">Decide</a></td></tr>`),
    ...awaiting.map(c => `<tr><td>${h(prettyDate(c.date))}</td><td><span class="pill">Needs approval</span> ${h(service.describe(c))}</td><td><a class="btn" href="/?month=${c.date.slice(0, 7)}&review=${c.id}">Review</a></td></tr>`),
    ...asked.map(c => `<tr><td><a href="/cleanings/${c.id}">${h(prettyDate(c.date))}</a></td><td><span class="pill asked">Waiting on ${cleaner}</span> Texted to the group. A "yes" from ${cleaner} to the app's number confirms it automatically, or tap the button if the yes came another way.</td><td><form method="post" action="/cleanings/${c.id}/confirm"><input type="hidden" name="back" value="inbox"><button>${cleaner} confirmed</button></form></td></tr>`),
  ];
}

// Skipped group texts (the newest message for their cleaning) and declined cleanings, still upcoming.
function clearedList({ db, today, who }) {
  const skipped = db.prepare(`SELECT g.*, c.date FROM group_messages g JOIN cleanings c ON c.id = g.cleaning_id
    WHERE g.status = 'skipped' AND c.date >= ? AND NOT EXISTS (SELECT 1 FROM group_messages n WHERE n.cleaning_id = g.cleaning_id AND n.id > g.id AND n.status IN ('pending','sent'))
    ORDER BY c.date`).all(today);
  const declined = db.prepare("SELECT * FROM cleanings WHERE status = 'declined' AND date >= ? ORDER BY date").all(today);
  return [
    ...skipped.map(m => `<tr><td><a href="/cleanings/${m.cleaning_id}">${h(prettyDate(m.date))}</a></td><td><span class="pill">Text not sent</span> ${h(m.body)}${m.decided_by ? `<div class="muted">Skipped by ${h(m.decided_by)}</div>` : ''}</td>
<td><form method="post" action="/g/${m.token}"><input type="hidden" name="by" value="${h(who)}"><button class="ghost" name="send" value="undo">Undo</button></form></td></tr>`),
    ...declined.map(c => `<tr><td><a href="/cleanings/${c.id}">${h(prettyDate(c.date))}</a></td><td><span class="pill">Marked not needed</span></td>
<td><form method="post" action="/cleanings/${c.id}/restore"><button class="ghost">Undo</button></form></td></tr>`),
  ].join('');
}

// "Text the group?" as a dialog over the calendar. "Decide later" just closes it and the
// draft stays in Waiting on you.
function groupDialog({ db, config, m, who, note }) {
  const c = db.prepare('SELECT * FROM cleanings WHERE id = ?').get(m.cleaning_id);
  const staying = !['cancelled', 'declined'].includes(c.status)
    && db.prepare("SELECT 1 FROM bookings WHERE status='active' AND check_in < ? AND check_out > ?").get(c.date, c.date);
  const opts = config.approvers.map(a => `<option ${a.name === who ? 'selected' : ''}>${h(a.name)}</option>`).join('');
  const phoneMode = config.groupMode === 'phone';
  return `<dialog id="msg-dialog"><form method="post" action="/g/${m.token}"><input type="hidden" name="ui" value="dialog">
<h2>Text the group?</h2>
<p class="muted">Cleaning on ${h(prettyDate(c.date))} is <b>${h(c.status.replace('_', ' '))}</b>. ${h(config.cleaner?.name || 'Your cleaner')} goes by the group text, so nothing is sent unless you say so.</p>
${staying ? `<p class="warn">Heads up: guests are staying at the house on ${h(prettyDate(c.date))}.</p>` : ''}
${note ? `<div class="flash">${h(note)}</div>` : ''}
<textarea name="body" style="min-height:110px" aria-label="Message">${h(m.body)}</textarea>
<label class="muted" style="display:block;margin-top:8px">Deciding as <select name="by">${opts}</select></label>
<div class="dialog-actions"><button name="send" value="1" id="msg-send">${phoneMode ? 'Share to the group' : 'Send to group'}</button>
${phoneMode ? '' : '<button class="ghost" name="send" value="test">Send me a test</button>'}
<button class="ghost" name="send" value="0">Don't send</button>
<button class="ghost" type="button" id="msg-later">Decide later</button></div>
<p class="muted" style="margin-bottom:0" id="msg-note">${phoneMode ? 'Your Share menu opens: pick your group (in Messages), then tap Send there.' : '"Send me a test" texts it only to the person picked above.'} "Decide later" keeps the text waiting under Waiting on you.</p></form></dialog>
<script>{const d=document.getElementById('msg-dialog');${phoneMode ? `
${SHARE_JS}
wireShare(d.querySelector('form'),document.getElementById('msg-send'),document.getElementById('msg-note'),()=>location.replace('/?flash='+encodeURIComponent('Handed to Messages. Make sure you tapped Send in your group.')));` : ''}const clean=()=>{const u=new URL(location.href);u.searchParams.delete('msg');u.searchParams.delete('msgnote');history.replaceState(null,'',u)};
document.getElementById('msg-later').addEventListener('click',()=>d.close());d.addEventListener('close',clean);d.showModal();}</script>`;
}

// Home: just the calendar, with one line for anything that needs attention.
export function dashboard({ config, service, db, month, who, flash, review, msg, msgnote, textPay }) {
  const pendingMsg = msg ? db.prepare('SELECT * FROM group_messages WHERE token = ?').get(msg) : null;
  if (pendingMsg && pendingMsg.status !== 'pending' && !flash) flash = pendingMsg.status === 'sent' ? 'That text was already sent to the group.' : 'That text was already decided.';
  const { today, cleanings, bookings } = pageData({ config, service, db, month });
  const lastSync = JSON.parse(db.prepare("SELECT value FROM meta WHERE key='last_sync'").get()?.value || 'null');
  const waiting = decisionsList({ db, service, who, config }).length;
  const missing = Object.entries(stayReadiness(bookings, cleanings, today)).filter(([, v]) => v === 'missing').length;
  const alerts = [
    waiting ? `<a href="/inbox">${waiting} thing${waiting === 1 ? '' : 's'} waiting on you &rsaquo;</a>` : '',
    missing ? `<a href="/stays" class="missing-text">${missing} upcoming stay${missing === 1 ? ' has' : 's have'} no cleaning before check-in &rsaquo;</a>` : '',
  ].filter(Boolean);
  return layout('Cleaning Link', `${header({ config, db, who, active: 'calendar' })}
<div class="toolbar"><span class="muted">${lastSync ? `Airbnb checked ${h(new Date(lastSync.at).toLocaleString('en-US', { timeZone: config.timezone, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }))}` : 'Airbnb not checked yet'}</span>
<form method="post" action="/sync"><button class="ghost small">Check Airbnb now</button></form></div>
${flash ? `<div class="flash">${h(flash)}</div>` : ''}
${alerts.length ? `<div class="alerts">${alerts.join('')}</div>` : ''}
<div class="card">${calendar(month, cleanings, bookings, config.timezone, config, { ...calendarExtras(db), review: reviewFor(service, review) })}</div>
${pendingMsg?.status === 'pending' ? groupDialog({ db, config, m: pendingMsg, who, note: msgnote })
  : !review && textPay?.pending().length ? matchDialog({ config, db, textPay, who }) : ''}`);
}

// A payment text from the group that couldn't be tied to one cleaning: ask which, on opening the app.
function matchDialog({ config, db, textPay, who }) {
  const all = textPay.pending();
  const m = all[0];
  const cands = textPay.candidates(m);
  const stayBefore = (date) => db.prepare("SELECT * FROM bookings WHERE status='active' AND check_out <= ? ORDER BY check_out DESC LIMIT 1").get(date);
  const paid = m.kind === 'paid';
  const sent = new Date(m.at).toLocaleString('en-US', { timeZone: config.timezone, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const rows = cands.map((c, i) => {
    const st = stayBefore(c.date);
    const state = c.status === 'paid' ? `paid ${money(c.amount_cents)}` : c.amount_cents != null ? `${money(c.amount_cents)} owed` : c.status === 'completed' ? 'cleaned, no amount yet' : 'scheduled';
    return `<label class="pick"><input type="${paid ? 'checkbox' : 'radio'}" name="cleaning_id" value="${c.id}" ${i === 0 && !paid ? 'checked' : ''}>
<span><b>${h(prettyDate(c.date))}</b> <span class="muted">· ${h(state)}</span><br><span class="muted">${st ? `after ${h(guestLabel(st))}'s stay` : 'no stay before it'}</span></span></label>`;
  }).join('');
  // Any other cleaning can be picked too (she named the wrong day, or it's further out).
  const more = textPay.others(m, cands.map(c => c.id));
  const other = more.length ? `<label class="pick"><input type="${paid ? 'checkbox' : 'radio'}" name="cleaning_id" value="other" id="match-other" ${!rows && !paid ? 'checked' : ''}>
<span><b>${rows ? 'Another cleaning' : 'Pick a cleaning'}</b><br><select name="other_id" aria-label="Cleaning" style="margin-top:4px;max-width:100%" onchange="document.getElementById('match-other').checked=true">${more.map(c => `<option value="${c.id}">${h(prettyDate(c.date))}${c.status === 'paid' ? ' · paid' : c.status === 'completed' ? ' · cleaned' : ''}</option>`).join('')}</select></span></label>` : '';
  return `<dialog id="match-dialog"><form method="post" action="/text-matches/${m.id}">
<h2>${paid ? 'Which cleaning was paid?' : `Which cleaning is ${h(m.author)} talking about?`}</h2>
<p class="muted">From the group text${all.length > 1 ? ` (1 of ${all.length})` : ''}, ${h(sent)}:</p>
<blockquote style="white-space:pre-wrap;border-left:3px solid var(--line);margin:0 0 10px;padding:6px 12px"><b>${h(m.author)}:</b> ${h(m.body)}</blockquote>
${rows || (other ? '<p class="muted">No cleanings right around that date.</p>' : '<p class="muted">No cleanings around that date. If it was about one, add it on the calendar first.</p>')}${other}
<div class="row" style="margin-top:10px"><label>Amount $ <input name="amount" type="number" min="1" step="0.01" value="${m.amount_cents != null ? (m.amount_cents / 100).toFixed(2) : ''}" style="width:110px" ${paid ? '' : 'placeholder="if she said"'}></label>
${paid ? `<select name="method" aria-label="How it was paid">${['Venmo', 'Zelle', 'Cash', 'Check', 'Other'].map(x => `<option ${x === m.method ? 'selected' : ''}>${x}</option>`).join('')}</select>` : ''}</div>
<div class="dialog-actions">${rows || other ? `<button>${paid ? 'Mark paid' : 'Save'}</button>` : ''}<button class="ghost" name="skip" value="1">Not about a cleaning</button><button class="ghost" type="button" id="match-later">Ask me later</button></div>
<p class="muted" style="margin-bottom:0">${paid ? 'Tick every cleaning this payment covered.' : 'Saving marks it cleaned and, with an amount, records what she asked for.'}</p></form></dialog>
<script>{const d=document.getElementById('match-dialog');document.getElementById('match-later').addEventListener('click',()=>d.close());d.showModal();}</script>`;
}

// After sharing photos into the app: which cleaning are they from?
// A text message shared into the app from Messages: who wrote it?
export function shareTextPage({ config, db, who, text }) {
  const people = config.groupMembers;
  const guess = config.cleaner?.name || people[0]?.name;
  return layout('Save a group text', `${header({ config, db, who, active: 'notes' })}
<div class="card"><h2>Save a text from the group</h2>
<form method="post" action="/share-text"><textarea name="body" style="min-height:90px" aria-label="Message">${h(text)}</textarea>
<p>Who sent it?</p>${people.map(p => `<label class="pick"><input type="radio" name="author" value="${h(p.name)}" ${p.name === guess ? 'checked' : ''}><span><b>${h(p.name)}</b></span></label>`).join('')}
<div class="dialog-actions"><button>Save</button><a class="btn ghost" href="/notes">Cancel</a></div></form>
<p class="muted">It's handled like a forwarded text: saved to Notes, a "yes" from ${h(config.cleaner?.name || 'the cleaner')} confirms the cleaning, and "done, $X" or "paid" updates payments.</p></div>`);
}

export function shareInPage({ config, db, who, token, count, likely, cleanings }) {
  const stayBefore = (date) => db.prepare("SELECT * FROM bookings WHERE status='active' AND check_out <= ? ORDER BY check_out DESC LIMIT 1").get(date);
  const thumbs = Array.from({ length: Math.min(count, 12) }, (_, i) => `<img class="thumb" src="/share-photos/${token}/${i}" alt="" loading="lazy">`).join('');
  return layout('Save photos', `${header({ config, db, who, active: 'calendar' })}
<div class="card"><h2>Save ${count} photo${count === 1 ? '' : 's'}</h2><div class="receipts">${thumbs}</div>${count > 12 ? `<p class="muted">and ${count - 12} more</p>` : ''}
<form method="post" action="/share-photos/${token}"><p>Which cleaning are they from?</p>
${cleanings.map(c => { const st = stayBefore(c.date); return `<label class="pick"><input type="radio" name="cleaning_id" value="${c.id}" ${c.id === likely?.id ? 'checked' : ''}><span><b>${h(prettyDate(c.date))}</b>${st ? ` <span class="muted">after ${h(guestLabel(st))}'s stay</span>` : ''}</span></label>`; }).join('') || '<p class="muted">No cleanings yet.</p>'}
<div class="dialog-actions"><button ${cleanings.length ? '' : 'disabled'}>Save photos</button><button class="ghost" name="discard" value="1">Don't save</button></div></form></div>`);
}

// What the next guest sees from the link Mark sends them.
export function guestPhotosPage({ config, cleaning, photos, base }) {
  return layout(`${config.propertyName}, ready for you`, `<div class="card"><h1>${h(config.propertyName)}</h1>
<p class="muted">Freshly cleaned ${h(prettyDate(cleaning.date))}.</p>
${photos.length ? `<div class="gallery">${photos.map(p => `<a href="${base}/${p.id}" target="_blank" rel="noopener"><img src="${base}/${p.id}" alt="" loading="lazy"></a>`).join('')}</div>` : '<p>No photos yet.</p>'}</div>`);
}

export function inboxPage({ config, service, db, who }) {
  const { today, cleanings } = pageData({ config, service, db });
  const decisions = decisionsList({ db, service, who, config }).join('');
  const upcoming = cleanings.filter(c => c.date >= today && !['cancelled', 'declined'].includes(c.status));
  const rows = upcoming.map(c => `<tr><td><a href="/cleanings/${c.id}"><b>${h(prettyDate(c.date))}</b></a><div class="muted">${c.source === 'manual' ? 'Added by hand' : 'Airbnb'}${c.note ? ` · ${h(c.note)}` : ''}</div></td>
<td><div class="stages">${service.stageOf(c).map(s => `<span class="stage ${s.done ? 'done' : ''}">${h(s.name)}</span>`).join('')}</div></td>
<td><form method="post" action="/cleanings/${c.id}/move" class="row"><input type="date" name="date" value="${c.date}" required><button class="ghost">Move</button></form>
<div class="row" style="margin-top:6px"><form method="post" action="/cleanings/${c.id}/cancel" onsubmit="return confirm('Cancel this cleaning?')"><button class="danger">Cancel</button></form>
${c.source === 'manual' ? `<form method="post" action="/cleanings/${c.id}/delete" onsubmit="return confirm('Delete this cleaning completely? Nothing is texted.')"><button class="ghost">Delete</button></form>` : ''}
<form method="post" action="/cleanings/${c.id}/message"><input type="hidden" name="body" value=""><button class="ghost">Text group</button></form></div></td></tr>`).join('');
  const cleared = clearedList({ db, today, who });
  return layout('Waiting on you', `${header({ config, db, who, active: 'inbox' })}
<div class="card"><h2>Waiting on you</h2>${decisions ? `<div class="scroll"><table>${decisions}</table></div>` : '<p class="muted">Nothing needs a decision right now.</p>'}</div>
${cleared ? `<div class="card"><h2>Recently cleared</h2><p class="muted">Texts you chose not to send and cleanings you marked not needed. Undo puts them back in Waiting on you.</p><div class="scroll"><table>${cleared}</table></div></div>` : ''}
<div class="card"><h2>Upcoming cleanings</h2>${rows ? `<div class="scroll"><table><tr><th>Day</th><th>Progress</th><th>Change</th></tr>${rows}</table></div>` : '<p class="muted">Nothing scheduled.</p>'}</div>`);
}

export function staysPage({ config, service, db, who, flash }) {
  const { today, cleanings, bookings } = pageData({ config, service, db });
  const cleaner = h(config.cleaner?.name || 'the cleaner');
  return layout('Stays', `${header({ config, db, who, active: 'stays' })}
${flash ? `<div class="flash">${h(flash)}</div>` : ''}
${staysCard(bookings, today, config, cleanings)}
${personalCard(bookings, today)}
<div class="card"><h2>Schedule a cleaning</h2><form method="post" action="/cleanings">
<div class="row"><input type="date" name="date" required min="${today}"><input name="note" placeholder="Note (optional)" style="flex:1;min-width:180px"></div>
<div class="row" style="margin-top:8px"><button name="arranged" value="1">Schedule, already arranged with ${cleaner}</button><button class="ghost" name="arranged" value="0">Schedule and text the group</button></div></form>
<p class="muted">You can also tap a day on the calendar. A scheduled cleaning covers the turnover it falls in, so the app won't propose another one between those two stays.</p></div>
<script>
// Guest names save on their own as you type (and on Enter or leaving the box).
document.querySelectorAll('input[data-autosave]').forEach(inp=>{
  const form=inp.form,state=form.querySelector('.save-state');let timer=null,last=inp.value;
  const save=async()=>{clearTimeout(timer);if(inp.value===last)return;const v=inp.value;state.textContent='Saving…';
    try{const r=await fetch(form.action,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded','Accept':'application/json'},body:new URLSearchParams(new FormData(form))});
      if(!r.ok)throw 0;last=v;state.textContent='Saved ✓';setTimeout(()=>{if(state.textContent==='Saved ✓')state.textContent=''},2000);}
    catch(e){state.textContent='Not saved, try again';}};
  inp.addEventListener('input',()=>{clearTimeout(timer);state.textContent='';timer=setTimeout(save,700);});
  inp.addEventListener('blur',save);
  form.addEventListener('submit',e=>{e.preventDefault();save();});
});
</script>`);
}

function personalCard(bookings, today) {
  const mine = bookings.filter(b => b.source === 'personal' && b.check_out >= today).sort((a, b) => a.check_in.localeCompare(b.check_in));
  const rows = mine.map(b => `<tr><td><form method="post" action="/personal/${h(b.uid)}" class="row">
<input name="name" value="${h(b.guest_name || '')}" placeholder="Who's staying" style="width:150px">
<input type="date" name="check_in" value="${b.check_in}" required><input type="date" name="check_out" value="${b.check_out}" required>
<button class="ghost">Save</button></form></td>
<td><form method="post" action="/personal/${h(b.uid)}/delete" onsubmit="return confirm('Remove this personal stay and its proposed cleaning?')"><button class="danger">Remove</button></form></td></tr>`).join('');
  return `<div class="card" id="personal"><h2>Personal stays</h2>
<p class="muted">Airbnb only shows these as blocked dates, so add them here. A cleaning is proposed for the day you leave (it appears under "Waiting on you"), unless one is already scheduled before the next guests. You can also tap a day on the calendar.</p>
<form method="post" action="/personal" class="row"><label class="muted">Arriving <input type="date" name="check_in" required min="${today}"></label>
<label class="muted">Leaving <input type="date" name="check_out" required min="${today}"></label>
<input name="name" placeholder="Who's staying (optional)" style="flex:1;min-width:150px"><button>Add personal stay</button></form>
${rows ? `<div class="scroll" style="margin-top:10px"><table>${rows}</table></div>` : ''}</div>`;
}

// The owners, for "Who paid". The person signed in is picked first.
const payerOptions = (config, who) => config.approvers.map(a => `<option ${a.name === who ? 'selected' : ''}>${h(a.name)}</option>`).join('');

export const paidInYear = (db, year) => db.prepare("SELECT * FROM cleanings WHERE status='paid' AND substr(paid_at,1,4)=? ORDER BY paid_at, date").all(String(year));

export function paymentsCsv(db, config, year) {
  const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const rows = paidInYear(db, year);
  const total = rows.reduce((t, c) => t + (c.amount_cents || 0), 0);
  return ['Paid on,Cleaning date,Paid to,Amount (USD),Paid by,Method,Property,Cleaning ID',
    ...rows.map(c => [c.paid_at.slice(0, 10), c.date, config.cleaner?.name || 'Cleaner', (c.amount_cents / 100).toFixed(2), c.paid_by || '', c.paid_method || '', config.propertyName, c.id].map(q).join(',')),
    ['', '', 'Total', (total / 100).toFixed(2), '', '', '', ''].map(q).join(',')].join('\r\n') + '\r\n';
}

// What the cleaner is owed right now. Shown on the Payments page only when there is something to do.
export function cleanerCard({ config, db, who }) {
  const today = todayIn(config.timezone);
  const owed = db.prepare("SELECT * FROM cleanings WHERE status='completed' AND amount_cents IS NOT NULL ORDER BY date").all();
  const awaitingBill = db.prepare("SELECT * FROM cleanings WHERE status='completed' AND amount_cents IS NULL ORDER BY date").all();
  const cleanerName = h(config.cleaner?.name || 'the cleaner');
  const paidYear = db.prepare("SELECT COALESCE(SUM(amount_cents),0) s, COUNT(*) n FROM cleanings WHERE status='paid' AND substr(paid_at,1,4)=?").get(today.slice(0, 4));
  const owedRows = owed.map(c => `<tr><td><input type="checkbox" name="id" value="${c.id}" checked></td><td>${h(prettyDate(c.date))}</td><td>${money(c.amount_cents)}</td></tr>`).join('');
  const owedTotal = owed.reduce((s, c) => s + (c.amount_cents || 0), 0);
  if (!owed.length && !awaitingBill.length) return '';
  return `<div class="card" id="cleaner"><h2>Pay ${cleanerName}</h2>
<p>Owed now: <b>${money(owedTotal)}</b> for ${owed.length} cleaning(s) · Paid this year: ${money(paidYear.s)} (${paidYear.n})</p>
${awaitingBill.length ? `<h2 style="margin-top:14px">Cleaned, waiting for ${cleanerName}'s request</h2><p class="muted">When ${cleanerName} asks to be paid, enter the amount here.</p><table>
${awaitingBill.map(c => `<tr><td>${h(prettyDate(c.date))}</td><td><form method="post" action="/payments/request" class="row"><input type="hidden" name="id" value="${c.id}"><input name="amount" type="number" min="1" step="0.01" placeholder="Amount $" required style="width:120px"><button class="ghost">Save request</button></form></td></tr>`).join('')}</table>` : ''}
${owed.length ? `<h2 style="margin-top:14px">Requested, not paid yet</h2><form method="post" action="/payments/paid"><table><tr><th></th><th>Cleaning</th><th>Amount</th></tr>${owedRows}</table>
<div class="row" style="margin-top:10px"><select name="paid_by" aria-label="Who paid">${payerOptions(config, who)}</select><select name="method"><option>Venmo</option><option>Zelle</option><option>Cash</option><option>Check</option><option>Other</option></select><button>Mark selected paid</button></div></form>` : ''}
</div>`;
}

// GROUP_MODE=phone setup: the test link and how to forward group texts from the phone.
function phoneCard(config, who, phoneInbox) {
  if (config.groupMode !== 'phone') return '';
  const inbound = `${config.baseUrl}/phone/inbound?key=${config.phone.key}`;
  const members = config.groupMembers.filter(p => p.phone);
  const last = phoneInbox?.lastReceived() || [];
  return `<div class="card" id="group-phone"><h2>Group text (through your phone)</h2>
<p>Group texts go through your own group conversation with ${h(members.map(p => p.name).join(', '))}. When you approve one, tap <b>Share to the group</b>: your phone's Share menu opens, you pick your group (it's listed by its name, under Messages), and tap Send.</p>
<p class="row"><button type="button" class="ghost" id="share-test">Try it: share a test</button><span class="muted" id="share-test-note">Opens the Share menu with "Test from Cleaning Link". Pick your group to see it typed in, then delete it instead of sending.</span></p>
<p class="muted">Tip: if your group doesn't show up in the Share menu, send a message in it once so it's recent, or long-press it in the Share menu and pin it.</p>
<script>{${SHARE_JS}document.getElementById('share-test').addEventListener('click',async()=>{const r=await shareText('Test from Cleaning Link');document.getElementById('share-test-note').textContent=r==='shared'?'Shared. Delete the test text in Messages instead of sending it.':shareProblem[r];});}</script>
<h2 style="margin-top:14px">Reading the group text</h2>
<p>To save the group's texts as notes (and confirm a cleaning when ${h(config.cleaner?.name || 'the cleaner')} says yes), Mark's phone forwards each new message from the group here:</p>
<p><code style="word-break:break-all">${h(config.phone.key ? inbound : 'Set FEED_TOKEN or PHONE_KEY in Render first')}</code></p>
<details><summary>Set it up in MacroDroid (free, about 5 minutes)</summary><ol>
<li>Install <b>MacroDroid</b> from the Play Store and allow it to read notifications.</li>
<li>Add macro. Trigger: <b>Notification &gt; Notification received</b>, app <b>Messages</b>, text "contains" the group's name as it shows in your notifications (or a member's name).</li>
<li>Action: <b>Web interactions &gt; HTTP request</b>, method <b>POST</b>, the whole address above (keep the <code>?key=...</code> part). Leave the body empty and add two <b>Query params</b>: <code>title</code> and <code>text</code>. For their values, tap the <b>…</b> button and pick the notification title (it shows as <code>{not_title}</code>) and the notification text.</li>
<li>Check it: press and hold the action, tap <b>Test action</b>, and refresh this page. A line should appear under "Last messages forwarded".</li>
<li>Save. In Android settings, set MacroDroid's battery use to <b>Unrestricted</b> so it keeps running.</li>
<li>Ask Danielle to text the group "test". It should show up below and on the Notes tab.</li></ol>
<p class="muted">Messages you send yourself don't make a notification, so they aren't forwarded. A muted group doesn't either, so keep notifications on for it.</p></details>
<h2 style="margin-top:14px">Payments and photos from the group</h2>
<p>When ${h(config.cleaner?.name || 'the cleaner')} texts that she's done (with or without the amount, like "All done, $140"), that cleaning is marked cleaned and the amount is recorded. When Danielle texts "paid" (or "sent on Venmo"), what's owed is marked paid. If a text could fit more than one cleaning, the app asks which one the next time you open it.</p>
<p class="muted">Your own "paid" texts aren't forwarded (your phone doesn't notify you about your own messages), so mark those paid in the app. Photos can't come through a notification: in Messages, select her photos, tap Share and pick <b>Cleaning</b>. If Cleaning isn't in the share menu yet, remove the app from your home screen and add it again from Chrome.</p>
<h2 style="margin-top:14px">Last messages forwarded</h2>
${last.length ? `<table>${last.map(l => `<tr><td class="muted">${h(new Date(l.at).toLocaleString('en-US', { timeZone: config.timezone }))}</td><td>${h(l.title)}<div class="muted">${h(l.text)}</div></td><td>${l.known ? h(l.author) : `<span class="warn">Couldn't tell who sent it</span>`}</td></tr>`).join('')}</table>
<p class="muted">If the sender isn't recognised, add the name your phone shows for them as PHONE_ALIASES in Render, e.g. <code>Jenn=Jennifer Patterson</code>.</p>` : '<p class="muted">Nothing yet.</p>'}
</div>`;
}

function textingCard(config, who, flash = '', consents = {}) {
  const me = config.approvers.find(a => a.name === who) || config.approvers[0];
  const only = config.smsOnlyTo || [];
  const fmt = (d) => `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
  const mode = config.dryRun
    ? `<b>Test mode.</b> Nothing is really sent; messages are only listed below. ${!config.twilio.sid ? 'TWILIO_ACCOUNT_SID is missing.' : 'Set DRY_RUN=0 to go live.'}`
    : only.length ? `<b>Live, safety switch on.</b> Real texts go only to ${only.map(fmt).join(', ')}. Everyone else's texts are held and listed below.`
    : '<b>Live.</b> Texts go to everyone in the group.';
  const missing = ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_FROM'].filter(k => !{ TWILIO_ACCOUNT_SID: config.twilio.sid, TWILIO_AUTH_TOKEN: config.twilio.token, TWILIO_FROM: config.twilio.from }[k]);
  return `<div class="card" id="texting"><h2>Texting</h2>${flash ? `<div class="flash" style="margin:0 0 10px">${h(flash)}</div>` : ''}<p>${mode}</p>
<table><tr><th>Sends from</th><td>${h(config.twilio.from || 'not set')}</td></tr>
<tr><th>Group texts</th><td>${config.groupMode === 'conversation' ? 'One shared group thread (Twilio Conversations)' : 'Same text sent to each person separately'}</td></tr>
<tr><th>Replies come in at</th><td><code>${h(config.baseUrl)}/twilio/sms</code><div class="muted">Paste this into your Twilio number's "A message comes in" webhook (HTTP POST).</div></td></tr>
${missing.length ? `<tr><th>Missing in Render</th><td class="warn">${missing.join(', ')}</td></tr>` : ''}</table>
<h2 style="margin-top:14px">Who gets texts</h2>
<p class="muted">Before anyone gets texts, send them the sign-up link <a href="/join"><code>${h(config.baseUrl)}/join</code></a>. When they submit it with the box ticked, it's recorded here and they get the confirmation text.</p>
<table>${config.groupMembers.filter(p => p.phone).map(p => {
    const c = consents[p.phone.replace(/\D/g, '').slice(-10)];
    return `<tr><td><b>${h(p.name)}</b><div class="muted">${h(p.phone)}</div></td><td>${c ? `${c.method === 'web form' ? (c.sms === false ? 'Joined on the form, <b>said no to texts</b>' : 'Signed up on the form') : `Agreed, recorded by ${h(c.by)}`} ${h(new Date(c.at).toLocaleDateString('en-US', { timeZone: config.timezone, month: 'short', day: 'numeric', year: 'numeric' }))}` : '<span class="muted">Not signed up yet</span>'}</td></tr>`;
  }).join('')}</table>
<form method="post" action="/texting/test" class="row" style="margin-top:10px"><button ${config.dryRun || !me?.phone ? 'disabled' : ''}>Send me a test text</button><span class="muted">${me?.phone ? `Goes only to ${h(me.name)} at ${h(me.phone)}, then checks it was delivered.` : 'No phone number on file for you.'}</span></form></div>`;
}

function pushCard(push, flash) {
  const subs = push.subscriptions();
  const items = push.unsettled();
  return `<div class="card" id="push"><h2>Phone notifications</h2>
<p>When a new Airbnb booking comes in (or its dates change), you get an alert right away; tapping it opens that cleaning so you can approve it and text the cleaner.</p>
<p>Every morning at 9, phones with notifications on also get one alert if any cleaning in the next 7 days isn't set yet: still needs your OK, not sent, waiting on the cleaner to confirm, or a stay with no cleaning before it. Tapping it opens Waiting on you.</p>
${flash && /notification/i.test(flash) ? `<p class="flash">${h(flash)}</p>` : ''}
<p class="muted">Right now: ${items.length ? h(items.map(i => i.text).join('; ')) : 'nothing in the next 7 days needs you.'}</p>
<p class="muted">Turned on for ${subs.length ? h(subs.map(s => s.who).join(', ')) : 'no devices yet'}.</p>
<div class="row"><button type="button" id="push-on">Turn on for this phone</button><button type="button" class="ghost" id="push-off" hidden>Turn off for this phone</button>
<form method="post" action="/push/test" style="display:inline"><button class="ghost">Send a test notification</button></form></div>
<p class="muted" id="push-status"></p>
<script>
(() => {
  const on = document.getElementById('push-on'), off = document.getElementById('push-off'), status = document.getElementById('push-status');
  const say = (t) => { status.textContent = t; };
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) { on.disabled = true; say("This browser can't get notifications. On Android use Chrome; on iPhone, add the site to your home screen first and open it from there."); return; }
  const key = '${push.publicKey()}';
  const toBytes = (s) => { const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - s.length % 4) % 4)); return Uint8Array.from(b, c => c.charCodeAt(0)); };
  const post = (url, data) => fetch(url, { method: 'POST', body: new URLSearchParams(data), credentials: 'same-origin' });
  navigator.serviceWorker.register('/sw.js').then(reg => reg.pushManager.getSubscription()).then(sub => {
    if (sub) { on.hidden = true; off.hidden = false; say('Notifications are on for this phone.'); }
  });
  on.onclick = async () => {
    try {
      if (await Notification.requestPermission() !== 'granted') return say("Notifications are blocked. Allow them for this site in your phone's settings, then try again.");
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: toBytes(key) });
      const r = await post('/push/subscribe', { sub: JSON.stringify(sub) });
      if (!r.ok) throw new Error('server said ' + r.status);
      on.hidden = true; off.hidden = false; say('Done. Notifications are on for this phone. Try "Send a test notification".');
    } catch (e) { say('Could not turn on notifications: ' + e.message); }
  };
  off.onclick = async () => {
    const reg = await navigator.serviceWorker.ready; const sub = await reg.pushManager.getSubscription();
    if (sub) { await post('/push/unsubscribe', { endpoint: sub.endpoint }); await sub.unsubscribe(); }
    on.hidden = false; off.hidden = true; say('Notifications are off for this phone.');
  };
})();
</script></div>`;
}

// The cleaner's private link: copy it or share it straight into the group text.
function cleanerLinkCard(config, db, flash) {
  const name = config.cleaner?.name || 'the cleaner';
  const url = `${config.baseUrl || ''}/c/${cleanerKey(db)}`;
  const showFlash = flash && /New link made/.test(flash);
  return `<div class="card" id="cleaner-link"><h2>${h(name)}'s link</h2>
${showFlash ? `<p class="flash">${h(flash)}</p>` : ''}
<p>A page for ${h(name)} with no password: the cleanings she's been texted (asked or confirmed), with checkout and next check-in times, and a button to add them to her phone's calendar. No prices, notes, guest names or cleanings still waiting on your OK.</p>
<p><input id="cl-url" readonly value="${h(url)}" style="width:100%" onclick="this.select()"></p>
<p><button type="button" id="cl-copy">Copy link</button> <button type="button" class="ghost" id="cl-share" data-title="Cleanings at ${h(config.propertyName)}" data-text="Here are your cleanings at ${h(config.propertyName)}. Tap &quot;Add to my calendar&quot; to get them on your phone:">Share…</button> <a class="ghost" href="${h(url)}" target="_blank" rel="noopener">Open it</a></p>
<form method="post" action="/cleaner-link/reset" onsubmit="return confirm('Make a new link? The old one stops working.')"><button class="ghost">Make a new link</button></form>
<p class="muted">Making a new link turns the old one off, in case it gets passed around.</p>
<script>(()=>{const u=document.getElementById('cl-url').value,c=document.getElementById('cl-copy'),s=document.getElementById('cl-share');
c.onclick=async()=>{try{await navigator.clipboard.writeText(u)}catch{const i=document.getElementById('cl-url');i.select();document.execCommand('copy')}c.textContent='Copied!';setTimeout(()=>c.textContent='Copy link',2000)};
if(!navigator.share)s.hidden=true;else s.onclick=()=>navigator.share({title:s.dataset.title,text:s.dataset.text,url:u}).catch(()=>{});})();</script></div>`;
}

export function morePage({ config, db, who, flash, push, phoneInbox }) {
  const outbox = db.prepare('SELECT * FROM outbox ORDER BY id DESC LIMIT 40').all();
  return layout('More', `${header({ config, db, who, active: 'more' })}
${cleanerLinkCard(config, db, flash)}
${phoneCard(config, who, phoneInbox)}
${textingCard(config, who, flash && !/notification|New link made/i.test(flash) ? flash : '', Object.fromEntries(db.prepare("SELECT key, value FROM meta WHERE key LIKE 'consent:%'").all().map(r => [r.key.slice(8), JSON.parse(r.value)])))}
${push ? pushCard(push, flash) : ''}
<div class="card"><h2>Sign out</h2><p class="muted">Signs this device out. To sign out every device, change ADMIN_PASSWORD in Render.</p><form method="post" action="/logout"><button class="ghost">Sign out of this device</button></form></div>
<div class="card"><h2>Calendar for Google, iCal and Skylight</h2><p>Subscribe to this address (Google Calendar: Other calendars, From URL):</p>
<p><code>${h(config.baseUrl)}/feed/${h(config.feedId)}.ics</code></p>
<p class="muted">Shows everything the calendar here shows: every stay and every cleaning. Each title starts with the same color: stays 🔵 cleaning confirmed, 🟡 not confirmed yet, 🟠 no cleaning; cleanings 🟢 booked, 🟣 waiting on ${h(config.cleaner?.name || 'the cleaner')}, 🟡 needs OK or not sent; ⚪ past.</p>
<p class="muted">To color stays and cleanings separately in Skylight, add them as two calendars instead:<br><code>${h(config.baseUrl)}/feed/${h(config.feedId)}.ics?only=stays</code><br><code>${h(config.baseUrl)}/feed/${h(config.feedId)}.ics?only=cleanings</code></p>
<p class="muted">Google and Skylight refresh subscribed calendars every few hours.</p></div>
<div class="card"><h2>Messages sent</h2><div class="scroll"><table><tr><th>When</th><th>To</th><th>Message</th><th>Status</th></tr>
${outbox.map(o => `<tr><td class="muted">${h(new Date(o.at).toLocaleString('en-US', { timeZone: config.timezone }))}</td><td>${h(o.channel === 'group' ? 'Group' : o.to_addr)}</td><td>${h(o.body)}</td><td>${h(o.status)}${o.error ? ` <span class="muted">${h(o.error.slice(0, 80))}</span>` : ''}</td></tr>`).join('')}
</table></div></div>`);
}
