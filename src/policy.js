// Public pages for US carrier (A2P 10DLC) registration: what the texts are, privacy, and terms.
// No login, so carrier reviewers can open them.
import { layout } from './views.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function contactLine(config) {
  return config.supportEmail
    ? `email <a href="mailto:${esc(config.supportEmail)}">${esc(config.supportEmail)}</a> or reply HELP to any message`
    : 'reply HELP to any message, or contact the owner who added you';
}

const nav = '<p class="muted"><a href="/sms">About these texts</a> · <a href="/privacy">Privacy policy</a> · <a href="/terms">Terms and conditions</a></p>';

export function smsInfoPage(config) {
  const place = esc(config.propertyName);
  return layout('Cleaning schedule texts', `<div class="card"><h1>Cleaning schedule texts for ${place}</h1>
<p>Cleaning Link is a private scheduling tool used by the owners of one short-term rental home at ${place}. It sends text messages about house cleanings: the cleaning date, the guest checkout time and when the next guests arrive. Recipients can reply to confirm a date.</p>
<h2>Who receives these texts</h2>
<p>Only the home's owners and their house cleaner. There are no public sign-ups and no marketing.</p>
<h2>How people opt in</h2>
<p>Before a phone number is added, the owner asks the person in person or by phone whether they agree to receive cleaning schedule texts for ${place}. They are told to expect about 5 to 15 messages a month, that message and data rates may apply, and that they can reply STOP to opt out or HELP for help. The number is added only after they agree.</p>
<h2>Opting out and help</h2>
<p>Reply <b>STOP</b> to stop all messages. Reply <b>HELP</b> for help. For anything else, ${contactLine(config)}.</p>
${nav}</div>`);
}

export function privacyPage(config) {
  return layout('Privacy policy', `<div class="card"><h1>Privacy policy</h1>
<p class="muted">Cleaning Link, cleaning schedule texts for ${esc(config.propertyName)}</p>
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
<p class="muted">Cleaning Link, cleaning schedule texts for ${place}</p>
<h2>Program</h2>
<p>Cleaning Link sends text messages about house cleanings at ${place} (cleaning dates, guest checkout times and next guest arrivals) to the home's owners and their house cleaner, who agreed to receive them.</p>
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
