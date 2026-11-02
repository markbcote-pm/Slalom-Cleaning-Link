// Public pages for US carrier (A2P 10DLC) registration: what the texts are, privacy, and terms.
// No login, so carrier reviewers can open them.
import { layout } from './views.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function contactLine(config) {
  return config.supportEmail
    ? `email <a href="mailto:${esc(config.supportEmail)}">${esc(config.supportEmail)}</a> or reply HELP to any message`
    : 'reply HELP to any message, or contact the owner who added you';
}

const nav = '<p class="muted"><a href="/sms">About these texts</a> · <a href="/privacy">Privacy policy</a> · <a href="/terms">SMS terms and conditions</a></p>';

// "Cleaning Link, operated by <brand>" so reviewers can match the pages to the registered brand.
const operator = (config) => config.brandName
  ? `Cleaning Link is a software application operated by <b>${esc(config.brandName)}</b>`
  : 'Cleaning Link is a software application operated by the owners of the home';

// The exact words used to ask for consent, and the confirmation text sent afterwards.
export const consentScript = (config) => `"May I add your mobile number to Cleaning Link${config.brandName ? `, the scheduling app run by ${config.brandName},` : ''} so it can text you cleaning schedules for ${config.propertyName}? You'd get about 5 to 15 texts a month with cleaning dates, guest checkout times and next guest arrivals, and you can reply to confirm. Message and data rates may apply. You can reply STOP at any time to stop, or HELP for help. Do you agree?"`;
export const confirmationText = (config) => `Cleaning Link${config.brandName ? ` (${config.brandName})` : ''}: you're signed up for cleaning schedule texts for ${config.propertyName}. About 5-15 msgs/month. Msg & data rates may apply. Reply HELP for help, STOP to opt out.`;

export function smsInfoPage(config) {
  const place = esc(config.propertyName);
  return layout('Cleaning schedule texts', `<div class="card"><h1>Cleaning schedule texts for ${place}</h1>
<p>${operator(config)} to schedule house cleanings for one short-term rental home at ${place}. It reads the home's booking calendar and automatically sends text messages about each cleaning: the cleaning date, the guest checkout time and when the next guests arrive. Recipients can reply to confirm a date.</p>
<h2>Who receives these texts</h2>
<p>Only the home's owners and their house cleaner. There are no public sign-ups and no marketing.</p>
<h2>How people opt in</h2>
<p>Consent is collected verbally, in person or by phone, before a number is added to the app. The owner reads this script word for word:</p>
<blockquote style="margin:8px 0;padding:8px 12px;border-left:3px solid var(--accent);background:var(--win)">${esc(consentScript(config))}</blockquote>
<p>The number is added only if the person says yes. The date of each person's consent is recorded. The first text they receive confirms the sign-up:</p>
<blockquote style="margin:8px 0;padding:8px 12px;border-left:3px solid var(--accent);background:var(--win)">${esc(confirmationText(config))}</blockquote>
<h2>Opting out and help</h2>
<p>Reply <b>STOP</b> to stop all messages. Reply <b>HELP</b> for help. For anything else, ${contactLine(config)}.</p>
${nav}</div>`);
}

export function privacyPage(config) {
  return layout('Privacy policy', `<div class="card"><h1>Privacy policy</h1>
<p class="muted">${operator(config)}. This policy covers its cleaning schedule texts for ${esc(config.propertyName)}.</p>
<h2>What we collect</h2>
<p>The name and mobile phone number of each person who agreed to receive cleaning schedule texts, the messages we send them, and any replies they send back.</p>
<h2>How we use it</h2>
<p>Only to schedule and confirm house cleanings for this one rental home, and to keep a record of what was agreed.</p>
<h2>Sharing</h2>
<p><b>We do not sell, rent or share mobile phone numbers or SMS opt-in information with third parties or affiliates for marketing or promotional purposes.</b> Text messaging originator opt-in data and consent will not be shared with any third parties. Messages are delivered through our SMS provider (Twilio) solely to send and receive these texts.</p>
<h2>Keeping and deleting</h2>
<p>We keep this information while the person is part of the cleaning schedule. Reply STOP to stop messages; to have your number removed entirely, ${contactLine(config)}.</p>
${nav}</div>`);
}

export function termsPage(config) {
  const place = esc(config.propertyName);
  return layout('Terms and conditions', `<div class="card"><h1>Terms and conditions</h1>
<p class="muted">${operator(config)}. These terms cover its SMS program.</p>
<h2>Program</h2>
<p>Program name: Cleaning Link cleaning schedule texts. Cleaning Link automatically sends text messages about house cleanings at ${place} (cleaning dates, guest checkout times and next guest arrivals) to the home's owners and their house cleaner, who agreed to receive them.</p>
<h2>Message frequency</h2>
<p>Message frequency varies, usually about 5 to 15 messages a month.</p>
<h2>Cost</h2>
<p>Message and data rates may apply. We do not charge for these messages.</p>
<h2>Opt out and help</h2>
<p>Reply <b>STOP</b> at any time to stop receiving messages; you will get one final message confirming you are unsubscribed. Reply <b>HELP</b> for help. For support, ${contactLine(config)}.</p>
<h2>Carriers</h2>
<p>Carriers are not liable for delayed or undelivered messages.</p>
<h2>Privacy</h2>
<p>See our <a href="/privacy">privacy policy</a>.</p>
${nav}</div>`);
}
