# HillLink

Helps hospitals in hill districts (built around Arunachal Pradesh) find blood donors fast and send an ambulance to bring the donor in.

- **Team:** _<CESS>_ — _<Raj chouhan, Dikenno Pul, Chochong Tsering and Kaling Yapi>_
- **Deployment URL:** _<https://rajnitian.github.io/_HillLink/>
Helps hospitals in hill districts (built around Arunachal Pradesh) find blood donors fast and send an ambulance to bring the donor in.



## What it does

| Feature | Status |
|---|---|
| Hospital creates a blood request (group, component, units, deadline, urgency) and verifies it | Working |
| Donor ranking by blood-group compatibility, eligibility rules and estimated travel time | Working, on a **synthetic 30-junction road grid** (not real roads) |
| Donor alerts by SMS, with YES/NO replies handled automatically and the next donor contacted on timeout | Working. Real SMS needs the Node gateway and a provider (Twilio, or any app that can POST JSON). Without it, SMS is a logged dry run |
| Ambulance ranking and dispatch with stage tracking (to donor, to hospital, arrived) | Working on the same synthetic grid |
| Donor register: CSV import with row-by-row checks, add/edit/remove, CSV backup, remove sample data | Working |
| Roles (hospital, dispatcher, admin), password policy, session timeout, audit log | Working in the browser, see limitations |
| Rule-based assistant that summarises a request and drafts an SMS | Working, fixed rules, no AI model |
| Works offline once loaded (only map tiles need internet) | Working |

## Tech stack

- **Frontend and engine:** one `index.html` (plain HTML, CSS and JavaScript, no build step). Maps use Leaflet. Data is kept in the browser's `localStorage`.
- **Backend:** `server.js`, Node.js 18+ with **no dependencies**. It serves the page, sends SMS through Twilio (or a dry-run logger) and receives donor replies by webhook.
- **Tests:** Node's built-in test runner.

## Architecture

```
Browser (index.html)                        Node gateway (server.js)
 ├─ UI: Overview, Requests, Donors,   ──►    ├─ GET  /                 serves the page
 │   Matching, Ambulances, Admin             ├─ POST /gateway/send     sends an SMS
 ├─ Engine: matching, routing, rules  ◄──    ├─ GET  /gateway/inbox    donor replies
 └─ localStorage (donors, requests)          ├─ POST /webhooks/twilio  signed inbound SMS
                                             └─ POST /webhooks/generic inbound SMS from any gateway app
```

The matching and dispatch rules live in the page so the app keeps working with a weak connection. The gateway only handles the parts that need a secret key or a phone network.

## Run it

Requires Node.js 18 or newer.

```bash
git clone <this repo>
cd hilllink
cp .env.example .env          # then set GATEWAY_TOKEN
export GATEWAY_TOKEN=$(openssl rand -hex 24)
npm start                     # dry run: nothing is really sent
```

Open http://127.0.0.1:8080. The login screen lists the demo accounts; you choose a new password on first sign-in.

To connect the page to the gateway, open **Admin → Live SMS** and enter the gateway token.

### Real SMS with Twilio

```bash
export GATEWAY_TOKEN=... SMS_PROVIDER=twilio PUBLIC_URL=https://your.domain
export TWILIO_ACCOUNT_SID=AC... TWILIO_AUTH_TOKEN=... TWILIO_FROM=+1...
npm start
```

In Twilio, set the number's "A message comes in" webhook to `POST <PUBLIC_URL>/webhooks/twilio`. Put the server behind HTTPS before real use.

### Settings

All settings are environment variables; see `.env.example`. Only numbers starting with `ALLOWED_PREFIX` (default `+91`) can be texted, and sending is limited to `SMS_RATE_PER_MIN` per minute.

## Using your own donor data

Admin → Donors → **Donor register**. Required CSV columns: `name, phone, group, age`. Optional: `weightKg, area, lat, lon (or node), lastDonationDate, consent, screened, available, components, deferralDays, deferralNote`. "Check file" shows what will be accepted or rejected before anything is saved. Donors under 18, invalid phones or groups and duplicate phones are rejected, and a donor is only contacted if `consent` is `yes`.

## Tests

```bash
npm run check   # syntax check
npm test        # gateway tests: auth, number and prefix rules, dry-run send, webhook secret, inbox de-duplication
```

## Project structure

```
index.html            UI and in-browser engine
server.js             SMS gateway and static host
test/server.test.js   gateway tests
.env.example          settings template (the real .env is git-ignored)
```

## Security notes

- Secrets are read from environment variables only. `.env` and `data/` (which holds received replies and phone numbers) are git-ignored.
- Gateway calls need a bearer token, failed attempts are rate-limited, and Twilio webhooks are signature-checked.
- Donor phone numbers are masked for dispatchers and hidden from hospital users.

## Known limitations

- Routes and travel times are estimates on a synthetic road grid. Real roads would need a real road graph.
- Users, donors and requests live in the browser's `localStorage`, with no server-side accounts and no second factor. This is fine for a demo, not for real patient or donor data.
- The hospitals and ambulances in the sample data have placeholder phone numbers.
- Route times and donor suitability are aids only. Clinical staff confirm donor suitability.
>_

## What it does

| Feature | Status |
|---|---|
| Hospital creates a blood request (group, component, units, deadline, urgency) and verifies it | Working |
| Donor ranking by blood-group compatibility, eligibility rules and estimated travel time | Working, on a **synthetic 30-junction road grid** (not real roads) |
| Donor alerts by SMS, with YES/NO replies handled automatically and the next donor contacted on timeout | Working. Real SMS needs the Node gateway and a provider (Twilio, or any app that can POST JSON). Without it, SMS is a logged dry run |
| Ambulance ranking and dispatch with stage tracking (to donor, to hospital, arrived) | Working on the same synthetic grid |
| Donor register: CSV import with row-by-row checks, add/edit/remove, CSV backup, remove sample data | Working |
| Roles (hospital, dispatcher, admin), password policy, session timeout, audit log | Working in the browser, see limitations |
| Rule-based assistant that summarises a request and drafts an SMS | Working, fixed rules, no AI model |
| Works offline once loaded (only map tiles need internet) | Working |

## Tech stack

- **Frontend and engine:** one `index.html` (plain HTML, CSS and JavaScript, no build step). Maps use Leaflet. Data is kept in the browser's `localStorage`.
- **Backend:** `server.js`, Node.js 18+ with **no dependencies**. It serves the page, sends SMS through Twilio (or a dry-run logger) and receives donor replies by webhook.
- **Tests:** Node's built-in test runner.

## Architecture

```
Browser (index.html)                        Node gateway (server.js)
 ├─ UI: Overview, Requests, Donors,   ──►    ├─ GET  /                 serves the page
 │   Matching, Ambulances, Admin             ├─ POST /gateway/send     sends an SMS
 ├─ Engine: matching, routing, rules  ◄──    ├─ GET  /gateway/inbox    donor replies
 └─ localStorage (donors, requests)          ├─ POST /webhooks/twilio  signed inbound SMS
                                             └─ POST /webhooks/generic inbound SMS from any gateway app
```

The matching and dispatch rules live in the page so the app keeps working with a weak connection. The gateway only handles the parts that need a secret key or a phone network.

## Run it

Requires Node.js 18 or newer.

```bash
git clone <this repo>
cd hilllink
cp .env.example .env          # then set GATEWAY_TOKEN
export GATEWAY_TOKEN=$(openssl rand -hex 24)
npm start                     # dry run: nothing is really sent
```

Open http://127.0.0.1:8080. The login screen lists the demo accounts; you choose a new password on first sign-in.

To connect the page to the gateway, open **Admin → Live SMS** and enter the gateway token.

### Real SMS with Twilio

```bash
export GATEWAY_TOKEN=... SMS_PROVIDER=twilio PUBLIC_URL=https://your.domain
export TWILIO_ACCOUNT_SID=AC... TWILIO_AUTH_TOKEN=... TWILIO_FROM=+1...
npm start
```

In Twilio, set the number's "A message comes in" webhook to `POST <PUBLIC_URL>/webhooks/twilio`. Put the server behind HTTPS before real use.

### Settings

All settings are environment variables; see `.env.example`. Only numbers starting with `ALLOWED_PREFIX` (default `+91`) can be texted, and sending is limited to `SMS_RATE_PER_MIN` per minute.

## Using your own donor data

Admin → Donors → **Donor register**. Required CSV columns: `name, phone, group, age`. Optional: `weightKg, area, lat, lon (or node), lastDonationDate, consent, screened, available, components, deferralDays, deferralNote`. "Check file" shows what will be accepted or rejected before anything is saved. Donors under 18, invalid phones or groups and duplicate phones are rejected, and a donor is only contacted if `consent` is `yes`.

## Tests

```bash
npm run check   # syntax check
npm test        # gateway tests: auth, number and prefix rules, dry-run send, webhook secret, inbox de-duplication
```

## Project structure

```
index.html            UI and in-browser engine
server.js             SMS gateway and static host
test/server.test.js   gateway tests
.env.example          settings template (the real .env is git-ignored)
```

## Security notes

- Secrets are read from environment variables only. `.env` and `data/` (which holds received replies and phone numbers) are git-ignored.
- Gateway calls need a bearer token, failed attempts are rate-limited, and Twilio webhooks are signature-checked.
- Donor phone numbers are masked for dispatchers and hidden from hospital users.

## Known limitations

- Routes and travel times are estimates on a synthetic road grid. Real roads would need a real road graph.
- Users, donors and requests live in the browser's `localStorage`, with no server-side accounts and no second factor. This is fine for a demo, not for real patient or donor data.
- The hospitals and ambulances in the sample data have placeholder phone numbers.
- Route times and donor suitability are aids only. Clinical staff confirm donor suitability.
