# Twilio Toll-Free Verification — Submission Details

**Why this is needed:** Our SMS integration is fully working — Twilio accepts our
messages and formats them correctly. But US/Canada carriers will not **deliver** SMS
from a toll-free number until that number completes **Toll-Free Verification**. Until
then, sends return status `undelivered`, error **`30032`** ("Toll-Free Number Has Not
Been Verified").

Once verified, delivery starts automatically — **no code change, nothing to redeploy.**

## Account status (checked 2026-09-05)
- Twilio account type: **Full** (paid, active) — *not* on trial, so no upgrade needed.
- Balance: ~$17.85 USD.
- Twilio number to verify: **+18883653670** (toll-free).
- Timeline after submission: **3–5 business days.**

---

## Where to submit
Twilio Console:
1. **Phone Numbers → Manage → Active Numbers** → click **+18883653670**.
2. Open the **Regulatory Information** tab (or Messaging → Regulatory Compliance →
   Toll-Free Verification, or follow the "Verify your toll-free number" prompt).
3. Start the verification and fill in the packet below.

---

## Submission packet

### Business / use case
- **Business name / website:** _<your legal business name>_ — website: _<your Pho Ha Noi
  site>_ or `https://pho-ha-noi-waitlist.fly.dev`
- **Use case:** Customer Care / Notifications — restaurant waitlist status notifications
  to guests, plus operational shift notifications to our own staff.
- **Estimated volume:** conservative, e.g. **under 3,000 messages/month** (adjust to taste).
- **Message frequency:** 1–3 messages per waitlist visit.

### Opt-in type
Web form (self-service check-in kiosk) **and** in person at the host stand.

### Opt-in workflow description (paste this)
> Guests opt in when joining the restaurant waitlist. On our self check-in page they
> enter their mobile number and must tick a consent checkbox reading: "Text me updates
> about my table. By checking this box, I agree to receive SMS text messages from Pho Ha
> Noi at the number above about my place in line. Message & data rates may apply. Reply
> STOP to opt out, HELP for help." At the host stand, staff add a guest only after the
> guest verbally agrees, confirmed via a "guest agreed to receive texts" checkbox. No
> text is sent unless consent is recorded. Live opt-in page:
> https://pho-ha-noi-waitlist.fly.dev/checkin

### Opt-in proof URL (publicly viewable)
`https://pho-ha-noi-waitlist.fly.dev/checkin` — the reviewer can see the consent checkbox
and disclosure live on the page.

### Sample messages (the actual texts our system sends)
1. `Pho Ha Noi — Milpitas: you're #3 on the waitlist, party of 3 — about 20 min. Track your spot and we'll text when your table is ready. Reply STOP to opt out.`
2. `Pho Ha Noi — Milpitas: your table is ready! Please see the host. 🍜`

_(Optional staff-facing sample, if asked to cover the staff use case:)_
3. `Pho Ha Noi: reminder — please clock in for your shift.`

---

## Notes
- Our opt-in was built to **CTIA spec** (brand name, "Message & data rates may apply",
  STOP/HELP instructions), which is what reviewers look for — the submission should pass
  cleanly.
- If **rejected**, resubmit **within 7 days** for priority re-review. After 7 days the
  number reverts to Restricted and a resubmission goes to the back of the queue.
- Twilio auto-handles **STOP / HELP** replies at the number level, so opt-outs are covered.
- Don't spread the same use case across multiple toll-free numbers ("snowshoeing") — keep
  it on this one number.
- While waiting, the platform runs normally; every send is still recorded in the audit
  logs (`notify_log`, `sms_messages` / `sms_recipients`) — messages just won't reach
  handsets until verification clears.

## After approval
When Twilio emails that the number is **Verified**, re-test delivery:
- Ask the assistant to re-send the test to **408-930-8636**, or
- Send from the app: **Messages → 📱 Text**, or page a consented waitlist guest.

Delivery status can be confirmed by the message's Twilio status changing from
`undelivered`/`30032` to `delivered`.

---

## Reference: what's already live
- SMS is enabled on both Fly apps (`SMS_PROVIDER=twilio` + `TWILIO_*` secrets set
  2026-09-05). `/api/sms/status` returns `{"enabled":true,"provider":"twilio"}`.
- Provider-agnostic sender: `lib/sms.js` (both apps).
- Security reminder: the Auth Token was shared in chat during setup — **rotate it** in the
  Twilio Console (Account Info → Auth Token) when convenient, then re-run
  `fly secrets set ... TWILIO_AUTH_TOKEN=<new> ...` on both `pho-ha-noi-management` and
  `pho-ha-noi-waitlist`.
