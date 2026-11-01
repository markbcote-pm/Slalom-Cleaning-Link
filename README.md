# Cleaning Link

Turns Airbnb bookings into cleaning days, gets Mark or Danielle to approve each one, texts the
shared group thread with the cleaner, publishes a calendar feed for Google Calendar / iCal / Skylight,
and tracks what the cleaner is owed.

No dependencies: Node.js 22.13 or newer only. Data lives in one SQLite file (`data/cleaning.db`).

## How it works

1. Every 30 minutes the app reads the Airbnb calendar export. Each guest checkout becomes a cleaning day.
   Owner blocks ("Not available") are ignored.
2. Mark and Danielle each get a text (and email, if set) with an approve/decline link. Whoever taps first wins.
3. Approving texts the group (Mark, Danielle, cleaner) a "CLEANING CONFIRMED" message and puts the cleaning
   on the shared calendar feed.
4. **Changes never text the group on their own.** If a confirmed cleaning moves or is cancelled (on Airbnb
   or by hand), the app drafts the group message and asks first. From the dashboard you see the draft right
   away and can edit it, send it, or skip it. If the change came from Airbnb, you get a text with a link to decide.
5. You can add cleaning days by hand, move them (drag on the calendar or pick a date), cancel them,
   or send the group a custom note.
6. The day after a cleaning it counts as cleaned. When the cleaner asks to be paid, enter her amount on the
   dashboard; it then shows as owed until you mark it paid (Venmo, Zelle, cash...). If you set a fixed
   `CLEANING_FEE` instead, it's owed automatically and you get a text with the running total.
7. Every cleaning shows its stages: Booked, Approval requested, Approved, Cleaner texted, Cleaned, Payment requested, Paid.
   The calendar shows each stay as a bar (11 AM checkout to 1 PM check-in), the open days to clean
   between stays, and same-day turnovers in red. Airbnb's link has no guest names, so you can type them in.
   Every message sent is listed at the bottom of the dashboard.

## Notes and to-dos

Texts from the group are saved as notes, each with its time and sender, and tied to the cleaning it's about
(a text on cleaning day or the two days after belongs to that cleaning; otherwise to the next one) and to the
stay before that cleaning. Notes about missing supplies ("not enough hand towels") become to-dos. Notes about
damage or mess are flagged under "Raise with Airbnb" on the To-do tab, with a link to that reservation.
Anything can be re-filed by hand, and texts from another thread can be pasted in on the Notes tab.

- With `GROUP_MODE=conversation`, every message in the group thread is captured (set up by `npm run setup-group`).
- With `GROUP_MODE=individual`, set the Twilio number's "A message comes in" webhook to `BASE_URL/twilio/sms`.
  Replies to the app's number are saved and passed on to the rest of the group.

## Run it locally (test mode, nothing is really sent)

    cp .env.example .env      # fill in at least ADMIN_PASSWORD and AIRBNB_ICAL_URL
    npm run dev               # http://localhost:3000
    npm test

## Going live

1. **Airbnb link:** Airbnb > Listing > Availability > Connect calendars > Export calendar. Paste into `AIRBNB_ICAL_URL`.
2. **Texting:** a Twilio account with a US number (about $1.15/month plus about a cent per text; US numbers
   need A2P 10DLC registration). Put the SID, token and number in `.env` and set `DRY_RUN=0`.
   - `GROUP_MODE=individual` texts each person separately (simplest).
   - For one real group thread, run `npm run setup-group` once and set `GROUP_MODE=conversation`
     with the printed SID.
3. **Hosting:** on Render, choose New > Blueprint and pick this repo; `render.yaml` sets everything up
   (Starter plan, about $7/month, plus a 1 GB disk for the database). Enter the secret values when asked,
   and set `BASE_URL` to the Render address so links in texts work. Any always-on host with a disk also works.
4. **Calendar:** in Google Calendar, Other calendars > From URL, paste `BASE_URL/feed/FEED_TOKEN.ics`.
   Skylight then shows it through Google. Moves happen in this app, not in Google (the feed is read-only).
