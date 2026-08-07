# PCG Commission Leaderboard

Broker leaderboard for Prestigious Capital Group's **New York** and **Miami**
offices, powered by the GoHighLevel API v2. Pulls funded opportunities from both
sub-accounts, aggregates them by broker, and gates commission data behind an
admin login.

Toggle between New York, Miami, or a combined **Joint** view.

---

## Why this needs a backend

GHL tokens cannot live in frontend code — anyone can open devtools and read them,
then use them to read or modify your entire CRM. This app keeps tokens on the
server and exposes only aggregated results.

The same principle covers commission gating: for a viewer, commission and fee
fields are never computed into the API response at all. There is nothing to
un-hide in devtools because the numbers never leave the server.

---

## Setup

### 1. Create Private Integration Tokens

Do this in **both** the New York and Miami sub-accounts — you'll end up with
two tokens and two location IDs:

1. In the sub-account: **Settings → Private Integrations → Create New**
2. Name it `Leaderboard`
3. Enable these scopes:
   - `opportunities.readonly`
   - `users.readonly`
   - `locations.readonly`
4. Copy the token — it starts with `pit-` and is shown only once
5. Grab the Location ID from **Settings → Business Profile**, or from the URL:
   `app.gohighlevel.com/v2/location/<LOCATION_ID>/...`

### 2. Push to GitHub

Create a new repo and upload every file in this project. Do **not** upload a
`.env` file — `.gitignore` already excludes it.

### 3. Deploy to Railway

1. **New Project → Deploy from GitHub repo**, pick your repo
2. Railway detects Node and runs `npm start` automatically
3. Under **Variables**, paste these six — nothing else is required:

```
NY_LOCATION_ID       = <New York location id>
NY_TOKEN             = <New York pit- token>
MIAMI_LOCATION_ID    = <Miami location id>
MIAMI_TOKEN          = <Miami pit- token>
ADMIN_PASSWORD       = <password that unlocks commission data>
JWT_SECRET           = <random 32+ char string>
```

4. Under **Settings → Networking**, click **Generate Domain**

Office names, keys, and toggle order are hardcoded — there is no
`LOCATION_NAME` to set. Generate the JWT secret with:

```
openssl rand -base64 32
```

If only one office's variables are filled in, the app still runs with that
office and shows a banner about the missing one, rather than refusing to
start.

### 4. Verify the field mapping

Log in as admin and visit `/api/diagnostics`. It returns which pipeline stage
resolved, how many deals were found per location, and a sample normalized deal.

If `fundedAmount` or `commission` come back as `0`, your custom fields are named
something the defaults don't cover. Add the real names via the `FIELD_*`
variables — no code change needed.

---

## How data is resolved

| Field | Source |
|---|---|
| Broker | Opportunity owner (`assignedTo`), resolved to a name via the Users API |
| Business name | Contact's company name, falling back to a custom field, then the opportunity name |
| Funded amount | Custom field, falling back to the opportunity's `monetaryValue` |
| Commission | Custom field — **admin only** |
| Fee | Custom field — **admin only** |
| Lender | Custom field |
| Funded date | `Funded Date` custom field if present, otherwise `lastStageChangeAt` |

**On funded date:** since the app only queries the Funded stage,
`lastStageChangeAt` is the moment the deal landed there. That holds unless a deal
is moved *out* of Funded and back in, which would reset it. If you need the date
to be tamper-proof, add a `Funded Date` custom field and set it with a workflow
when the opportunity enters the stage — the app prefers that field when it exists.

---

## Filters

- **MTD** — 1st of the current month through right now
- **30D / 60D / 90D** — rolling windows ending now
- **Last Mo** — the previous full calendar month
- **YTD** — January 1 through now
- **Month** — any single month found in your data
- **Range** — any span of months, inclusive on both ends

All boundaries are computed in `REPORT_TZ`, not the server's timezone, so a
container running in UTC still agrees with your office on which deals are
"this month."

---

## Access levels

| | Viewer | Admin |
|---|---|---|
| Broker rankings | ✅ | ✅ |
| Funded volume, deal counts, lenders | ✅ | ✅ |
| Commission, fees, combined total | ❌ | ✅ |
| Force data refresh | ❌ | ✅ |
| `/api/diagnostics` | ❌ | ✅ |

Viewers rank by funded volume; admins rank by total revenue. Sessions last 12
hours, and login is rate-limited to 10 attempts per 15 minutes per IP.

---

## Rate limits

GHL allows 100 requests per 10 seconds per location. The app stays under that
with a throttle, a 10-minute cache, and single-flight de-duplication so ten
people opening the dashboard at once trigger one sync rather than ten. If a
location errors mid-refresh, the last good data is served with a warning banner
instead of the page breaking.

---

## Embedding in GHL

Add a **Custom Menu Link** (Settings → Custom Menu Links), set it to your Railway
URL, and choose iframe display.

Anyone who opens it gets the viewer board by default; managers click **Admin
login** for commission figures. Since the leaderboard is meant to be visible on
office screens, keep the admin password out of any shared or embedded view.

---

## Adding broker photos

Photos are mapped by **first name**, lowercased, in `public/app.js`:

```js
const BROKER_PHOTOS = {
  daniel: 'https://.../photo.jpeg',
};
```

The key must match the first name on the **GHL user account** that owns the
opportunity. If a photo URL fails to load, that broker falls back to initials.

---

## Project layout

```
server.js              Express app, routes, auth wiring
src/config.js          Env parsing and boot validation
src/ghl.js             GHL API v2 client — throttle, retry, pagination
src/normalize.js       Custom field mapping, broker aggregation
src/dateRange.js       Timezone-correct range resolution
src/auth.js            Session cookies, admin password check
src/cache.js           TTL cache with single-flight
public/                Frontend (vanilla JS, no build step)
```

## Local development

```
npm install
cp .env.example .env    # then fill it in
npm run dev
```

Runs on http://localhost:3000.

## Troubleshooting

**"No pipeline stage named Funded"** — the stage name must match exactly. Check
spelling in GHL, or set `NY_STAGE_ID` / `MIAMI_STAGE_ID` directly.

**Amounts showing $0** — custom field names don't match. Check
`/api/diagnostics` and set the `FIELD_*` variables.

**Brokers showing "Unassigned"** — those opportunities have no owner set in GHL.

**Empty board on a period with known deals** — usually missing funded dates.
`/api/diagnostics` reports `missingFundedDate` per location.
