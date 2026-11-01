// One-time: create a real group text (Twilio Conversations group MMS, US/Canada numbers)
// with Mark, Danielle and the cleaner. Prints the TWILIO_CONVERSATION_SID to put in .env.
import { loadConfig } from './config.js';

const config = loadConfig();
const { sid, token, from } = config.twilio;
if (!sid || !token || !from) { console.error('Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_FROM first.'); process.exit(1); }
const auth = 'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64');

async function post(path, params) {
  const res = await fetch(`https://conversations.twilio.com/v1${path}`, {
    method: 'POST', headers: { Authorization: auth, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`${path}: ${res.status} ${JSON.stringify(json)}`);
  return json;
}

const convo = await post('/Conversations', { FriendlyName: `Cleanings: ${config.propertyName}` });
// The app posts as a chat participant projected through the Twilio number...
await post(`/Conversations/${convo.sid}/Participants`, { Identity: 'cleaning-link', 'MessagingBinding.ProjectedAddress': from });
// ...and each person joins by their phone number, which makes it a group text on their phones.
for (const p of config.groupMembers) {
  if (!p.phone) continue;
  await post(`/Conversations/${convo.sid}/Participants`, { 'MessagingBinding.Address': p.phone });
  console.log('Added', p.name, p.phone);
}
// Send every message in the thread to the app so it can file notes and to-dos.
await post(`/Conversations/${convo.sid}/Webhooks`, {
  Target: 'webhook', 'Configuration.Url': `${config.baseUrl}/twilio/conversation`,
  'Configuration.Method': 'POST', 'Configuration.Filters': 'onMessageAdded',
});
console.log('Group texts will be saved as notes at', `${config.baseUrl}/twilio/conversation`);
console.log(`\nAdd these to .env:\nGROUP_MODE=conversation\nTWILIO_CONVERSATION_SID=${convo.sid}`);
