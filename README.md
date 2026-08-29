# LinkedIn Profile API

Give it a LinkedIn profile URL, get back the profile as structured JSON.

```
GET https://<your-api-host>/api/profile?url=https://www.linkedin.com/in/williamhgates/
```

```jsonc
{
  "profile": {
    "publicIdentifier": "williamhgates",
    "fullName": "Bill Gates",
    "headline": "Chair, Gates Foundation and Founder, Breakthrough Energy",
    "location": { "text": "Seattle, Washington, United States", "country": "United States" },
    "about": "...",
    "profilePicture": { "url": "https://media.licdn.com/dms/image/...", "renditions": [] },
    "experience": [], "education": [], "skills": [],
    "certifications": [], "languages": [],
    "projects": [], "honors": [], "volunteer": [],
    "publications": [], "courses": [], "organizations": [],
    "contactInfo": {}
  },
  "meta": {
    "strategy": "html",
    "sources": ["https://www.linkedin.com/in/williamhgates/", ".../details/experience/"],
    "missingSections": ["courses"],
    "partial": true,
    "cached": false,
    "fetchedAt": "2026-08-29T12:00:00.000Z",
    "durationMs": 4210,
    "warnings": []
  }
}
```

Three pieces, deployed independently:

| | |
|---|---|
| `server/` | Express 5 + TypeScript API. This is the deliverable. |
| `web/` | React 19 + Vite client. A UI over the API; useful for demoing, not required by it. |
| `extension/` | ~150-line browser extension for anyone already signed in to LinkedIn in that browser: it hands the existing session over in one click, with no password typed. |

The API takes an email and password directly, drives a real browser through
LinkedIn's sign-in, waits out the approval tap on your phone, and keeps only the
session cookie that falls out the other end. The extension is the alternative for
people who would rather not hand over a password at all.

---

## Contents

- [Quick start](#quick-start)
- [Authentication](#authentication) — read this one
  - [Signing in with an email and password](#signing-in-with-an-email-and-password)
  - [The approval on your phone](#the-approval-on-your-phone)
- [Configuration](#configuration)
- [API documentation](#api-documentation)
- [Approach](#approach)
- [Known limitations](#known-limitations)
- [Deployment](#deployment)
- [Project structure](#project-structure)
- [Testing](#testing)
- [Legal and ethical note](#legal-and-ethical-note)

---

## Quick start

Requires Node 20 or newer.

```bash
# API
cd server
npm install
npx playwright install chromium   # only needed for email/password sign-in
cp .env.example .env       # optional: paste an li_at into it, see Authentication
npm run dev                # http://localhost:3000

# Client, in a second terminal
cd web
npm install
cp .env.example .env       # VITE_API_URL=http://localhost:3000
npm run dev                # http://localhost:5173
```

Open the web app, press **Settings**, and sign in with your LinkedIn email and
password. If LinkedIn asks you to approve it from the LinkedIn app on your phone,
the dialog waits while you do.

If you would rather not hand over a password — and you are already signed in to
LinkedIn in this browser — load the extension instead: `chrome://extensions` →
Developer mode → **Load unpacked** → pick `extension/`, then click it and press
**Send to this tab**. Both routes end with the same session cookie.

Verify the API on its own:

```bash
curl http://localhost:3000/health
curl http://localhost:3000/api/status
curl "http://localhost:3000/api/profile?url=https://www.linkedin.com/in/williamhgates/"
```

Production build:

```bash
cd server && npm run build && npm start
cd web    && npm run build          # static output in web/dist
```

---

## Authentication

Every lookup runs as some LinkedIn identity. There are four ways to give the API
one, and **all four end in the same place**: a `li_at` session cookie. That is
worth stating plainly up front, because it explains why signing in with a
password is not a different scraping mode — it is a way of *obtaining* the
cookie, after which nothing downstream can tell the difference.

| Way in | What you provide | Needs a browser on the server | Best for |
|---|---|---|---|
| Email + password | LinkedIn credentials | yes | a person using the web app |
| Extension | one click | no | a person already signed in here |
| Pasted cookie | the `Cookie:` header | no | curl, scripts, no-extension browsers |
| `LI_AT` env var | the cookie | no | an unattended deployment |

### Signing in with an email and password

This is the flow the hosted web app leads with, and it is the one that needs
explaining, because it cannot be done with an HTTP client.

**LinkedIn's login page has no `<form>`.** Captured from the live page:

```
forms:  0
inputs: type=email    autocomplete="username webauthn"   id="«r3»"  name=""
        type=password autocomplete="current-password"    id="«r4»"  name=""
buttons: type=button  text="Sign in"
```

Sign-in is declared instead as a server-driven-UI action,
`com.linkedin.sdui.requests.login.authenticate`, carrying
`"isEncrypted": true` and an `apfc` device-fingerprint token. The password is
encrypted **in the page**, by LinkedIn's own JavaScript, before anything is
sent; the fingerprint is minted the same way. Reproducing either outside a
browser means reimplementing code that changes without notice.

So the server drives a real Chromium through the real page and lets LinkedIn's
own JavaScript do the encrypting. `server/src/linkedin/login.ts`.

### The approval on your phone

Once the password is accepted, LinkedIn usually does **not** hand over a session
straight away. Because the sign-in is coming from a server it has never seen, it
redirects to `/checkpoint/challenge/...` and pushes a notification to the
LinkedIn app on the account holder's phone. That checkpoint page then
**long-polls**, waiting.

That wait is why `/api/auth` is three endpoints rather than one. A sign-in can
pause for as long as it takes somebody to find their phone, which is longer than
any HTTP request should stay open:

```
POST /api/auth/login    {username, password}
   -> 200  authenticated                    (no challenge; cookie returned)
   -> 428  CHALLENGE_PENDING + handle       (go tap approve, then poll)

POST /api/auth/verify   {handle}            poll the approval
POST /api/auth/verify   {handle, code}      or answer a verification code
   -> 200  authenticated                    (cookie returned)
   -> 428  CHALLENGE_PENDING                (still waiting; call again)

POST /api/auth/cancel   {handle}            give up, free the browser
```

The browser stays open between calls — parked in an in-memory registry under
the handle — because the tab that started the sign-in has to be the tab that
finishes it. Closing and reopening would lose the checkpoint. Parked sign-ins
are dropped after five minutes, and at most four are held at once; each one is
roughly 100 MB of Chromium.

`/api/auth/login` blocks for up to `LOGIN_WAIT_MS` (default 20s) before giving
up and handing back a handle, because an approval is often tapped within a few
seconds and it is better to answer once than to make the client poll for
something that already happened.

Four challenge kinds are recognised, and the difference matters — two of them
are resolvable and two are not:

| Kind | Resolvable | What happens |
|---|---|---|
| `app-approval` | yes | polled automatically; resolves when you tap approve |
| `code` | yes | the API asks for the code and submits it |
| `captcha` | no | nobody can answer it unattended; browser is closed immediately |
| `unknown` | no | an unrecognised checkpoint; browser is closed immediately |

Classification is a pure function, `classifyChallenge()`, and it is tested
against the real wordings in `tests/login.test.ts`. Order matters there: a
CAPTCHA page also says "verification", and the approval page offers "enter a
code instead" as a fallback underneath, so the most specific signal has to win
or the API sits waiting for input that is never coming.

### What is stored

**The password is used once and kept nowhere.** It is not written to disk, not
logged (`req.body.password` is in the redaction list), and not held in memory
past the sign-in. What comes back is the cookie, and the caller keeps it — the
server holds no user sessions, so there is nothing on it to steal and nothing to
expire. The web app keeps it in `sessionStorage`, which is cleared when the tab
closes.

A cookie is also the *safer* thing to hold: it is one revocable session, not
account control. Revoke it from LinkedIn's own "Where you're signed in" list.

### The three cookie paths

Signing in with a password is the friendliest option but the most expensive one:
it launches a browser and it may need a phone. The other three skip all of that.

**1. The extension** (`extension/`) reads the cookie out of a browser that is
already signed in to LinkedIn, and posts it to the web app. One click, no
password, no verification — the sign-in already happened.

It has to be an extension rather than a bookmarklet, and that is not a
preference: **`li_at` is `HttpOnly`**. `document.cookie` cannot see it. Only the
browser's own `chrome.cookies` API can, and only an extension can call that.
This is also why the commercial tools all ship one.

**2. Pasting the cookie.** DevTools → Network → any `linkedin.com` request →
copy the `Cookie` request header, paste the whole thing. The server picks out
`li_at` and `JSESSIONID` and **discards the rest** rather than forwarding it — a
copied header also carries analytics and fingerprinting cookies there is no
reason to hold. A bare `li_at` value on its own is accepted too.

**3. `LI_AT` in the environment**, for a deployment that should have an identity
of its own. See below.

### Whose session gets used

Precedence, per request:

1. A session on the request — signed in, pasted, or from the extension.
2. Otherwise the deployment's own session.

The deployment's own session comes from `LI_AT` if it is set. If it is not, and
`LI_USERNAME`/`LI_PASSWORD` are, the server signs itself in on first use through
the same browser flow and **promotes the harvested cookie to be** its session,
so the second request costs nothing. That sign-in is single-flighted: ten
concurrent cold-start requests trigger one browser and one approval push, not
ten.

If LinkedIn later rejects that cookie, it is dropped and the next request signs
in again. A cookie that came from `LI_AT` is left alone instead — re-signing-in
cannot fix an environment variable.

> **For an unattended deploy, prefer `LI_AT`.** LinkedIn treats a new server IP
> as a new device, so `LI_USERNAME`/`LI_PASSWORD` will very likely need one
> approval tap that nobody is there to give. The harvested cookie is also held
> in memory only, so a restart re-triggers it.

Set `ALLOW_REQUEST_CREDENTIALS=false` to refuse caller sessions entirely and pin
every lookup to the deployment's own; `/api/auth` then returns `BAD_REQUEST`.
Set `BROWSER_LOGIN=false` to make the API cookie-only, for a host with no
Chromium or no spare memory; `/api/auth` then returns `LOGIN_UNAVAILABLE`.

## Configuration

Server config is environment variables; `server/.env.example` is the annotated list.

| Variable | Default | Purpose |
|---|---|---|
| `LI_AT` | — | The deployment's own LinkedIn session cookie. Without it the server still boots and still serves callers who bring their own. |
| `LI_JSESSIONID` | — | Optional. Makes the session slightly stabler. |
| `LI_BCOOKIE`, `LI_LIDC` | — | Optional ambient cookies. |
| `LI_USERNAME`, `LI_PASSWORD` | — | The deployment's own LinkedIn account. Used **only when `LI_AT` is empty**: the server signs itself in through a browser on first use. Expect a one-time approval on the account holder's phone. |
| `BROWSER_LOGIN` | `true` | Whether this deployment may launch Chromium at all. `false` makes the API cookie-only and `/api/auth` returns `LOGIN_UNAVAILABLE`. |
| `BROWSER_HEADLESS` | `true` | `false` shows the window. Only useful for debugging a sign-in locally. |
| `LOGIN_WAIT_MS` | `20000` | How long one sign-in request blocks waiting for a phone tap before answering "still waiting". Keep under your platform's proxy timeout. |
| `API_KEY` | — | When set, `/api/profile` and `/api/auth` require `x-api-key` (or `Authorization: Bearer`). Unset means open. |
| `ALLOW_REQUEST_CREDENTIALS` | `true` | Whether callers may sign in or attach their own session. `false` disables `/api/auth`. |
| `CORS_ORIGIN` | `*` | Comma-separated origins. Pin this to your client URL in production. |
| `INBOUND_RPM` | `30` | Requests per minute per client IP. |
| `OUTBOUND_RPM` | `6` | Requests per minute to LinkedIn. Above ~6 invites HTTP 999. |
| `SECTION_CONCURRENCY` | `3` | Parallel `/details/` fetches per profile. |
| `CACHE_TTL_SECONDS` | `3600` | Response cache lifetime. |
| `CACHE_MAX_ENTRIES` | `500` | Cache ceiling; oldest evicted. |
| `REQUEST_TIMEOUT_MS` | `20000` | Per-hop timeout. |
| `PROXY_URL` | — | Outbound HTTP proxy. Strongly recommended for a public deploy. |
| `PORT`, `HOST`, `NODE_ENV`, `LOG_LEVEL` | `3000`, `0.0.0.0`, `development`, `info` | Standard. |

The client takes one: `VITE_API_URL`, the API base URL with no trailing slash.

---

## API documentation

All responses are JSON. Errors carry a stable `error.code` — branch on that,
never on the message.

### `GET /`

Service index: name, version, endpoint map. No auth.

### `GET /health`

Liveness. Deliberately dependency-free — a throttled LinkedIn session must not
make the platform restart an otherwise healthy process.

```json
{ "status": "ok", "version": "1.0.0", "uptimeSeconds": 421 }
```

### `GET /api/status`

Readiness and counters. No auth, so the client can show state before a key is
entered. Reports *whether* a credential is configured, never the credential.

```json
{
  "status": "ok",
  "version": "1.0.0",
  "cache": { "size": 12, "hits": 40, "misses": 12 },
  "inFlight": 0,
  "breaker": "closed",
  "tokensAvailable": 6,
  "credentialsConfigured": true,
  "authMode": "cookie",
  "sessionReady": true,
  "acceptsRequestCredentials": true,
  "passwordLoginAvailable": true,
  "activeSessions": 2,
  "activeLogins": 0
}
```

`authMode` is `cookie`, `credentials` or `none` — how this deployment gets its
own identity. `credentialsConfigured` says a way in exists; `sessionReady` says
a cookie is actually in hand. They differ during the window between boot and the
first sign-in. `activeLogins` counts browsers parked on a challenge.

### `POST /api/auth/login`

Signs in with an email and password. Rate limited to 10/min per IP, separately
from and far harder than `/api/profile` — each attempt drives a real browser at
LinkedIn's login page.

```jsonc
{ "username": "you@example.com", "password": "..." }
```

Signed straight in:

```json
{ "status": "authenticated", "credentials": { "liAt": "AQEDA...", "jsessionId": "ajax:12345" } }
```

Needs your phone (HTTP **428**):

```json
{
  "error": {
    "code": "CHALLENGE_PENDING",
    "message": "LinkedIn sent an approval request to the LinkedIn app on your phone. Open it and tap approve; this stays open while you do.",
    "hint": "Approve the sign-in in the LinkedIn app on your phone, then POST the handle back to /api/auth/verify.",
    "details": { "handle": "kQ8x...", "challenge": "app-approval" }
  }
}
```

### `POST /api/auth/verify`

Takes a parked sign-in one step further. Send `{ "handle": "..." }` on its own to
poll an app approval, or `{ "handle": "...", "code": "123456" }` to answer a
verification code. Returns the same shapes as `/login`: `authenticated` on
success, another `CHALLENGE_PENDING` while still waiting, `CHALLENGE_EXPIRED`
(HTTP 410) once the handle is gone.

Each call is held open for up to `LOGIN_WAIT_MS`, so polling in a loop is a few
requests per minute rather than a busy wait.

### `POST /api/auth/cancel`

`{ "handle": "..." }` — abandons a sign-in and frees its browser. Returns
`{ "cancelled": true }`, or `false` if the handle was already gone.

### `GET /api/profile`

| Param | Type | Required | Notes |
|---|---|---|---|
| `url` | string | yes | Profile URL or bare public identifier. |
| `refresh` | `true`/`false`/`1`/`0` | no | Bypass the cache. |

Optional headers: `x-li-at`, `x-li-jsessionid`, or `x-li-cookie` for a pasted
header. `x-api-key` when `API_KEY` is set.

```bash
curl "https://<host>/api/profile?url=https://www.linkedin.com/in/williamhgates/" \
  -H "x-api-key: $API_KEY"
```

### `POST /api/profile`

Same payload in a JSON body. Prefer this when sending credentials — a body does
not land in access logs or proxy history the way a query string does.

```bash
curl -X POST "https://<host>/api/profile" \
  -H "content-type: application/json" \
  -H "x-api-key: $API_KEY" \
  -d '{
        "url": "https://www.linkedin.com/in/williamhgates/",
        "refresh": false,
        "credentials": { "liAt": "AQEDAT...", "jsessionId": "ajax:123" }
      }'
```

`credentials` accepts `liAt` + `jsessionId`, or `cookie` for a pasted header, or
both — explicit fields win. It is optional and never persisted.

### Accepted URL forms

All of these resolve to the same profile:

```
https://www.linkedin.com/in/williamhgates/
https://in.linkedin.com/in/williamhgates
linkedin.com/in/williamhgates?trk=public_profile_browsemap
https://www.linkedin.com/in/williamhgates/details/experience/
https://www.linkedin.com/pub/william-gates/1/2/3
williamhgates
```

### Response shape

`profile` — every field is always present. Arrays default to `[]`, scalars to
`null`, so clients never need existence checks.

| Field | Type |
|---|---|
| `publicIdentifier`, `canonicalUrl` | `string` |
| `profileUrn`, `memberUrn` | `string \| null` |
| `firstName`, `lastName`, `fullName`, `headline`, `about` | `string \| null` |
| `location` | `{ text, country } \| null` |
| `profilePicture`, `backgroundImage` | `{ assetUrn, url, renditions[] } \| null` |
| `followerCount` | `number \| null` |
| `connectionCount`, `networkDistance` | `string \| null` |
| `isPremium`, `isOpenToWork` | `boolean` |
| `experience[]` | `{ title, company, employmentType, location, dateRange, description, skills[], companyUrl, logo }` |
| `education[]` | `{ school, degree, fieldOfStudy, grade, dateRange, description, schoolUrl, logo }` |
| `skills[]` | `{ name, endorsementCount, context[] }` |
| `certifications[]` | `{ name, issuer, issuedDate, expiryDate, credentialId, credentialUrl, logo }` |
| `languages[]` | `{ name, proficiency }` |
| `projects[]`, `honors[]`, `volunteer[]`, `publications[]`, `courses[]`, `organizations[]`, `recommendations[]` | `{ title, subtitle, caption, description, url }` |
| `contactInfo` | `{ profileUrl, websites[], email, phone, twitter, birthday, connectedDate } \| null` |

`dateRange` is `{ text, start, end, duration, isCurrent }`, where `text` is
exactly what LinkedIn rendered. `ImageAsset` carries every rendition LinkedIn
offers plus `url` for the largest.

`meta` — provenance, so a partial answer is legible rather than mysterious:

| Field | Meaning |
|---|---|
| `strategy` | `html` for a live extraction, `cache` for a served copy. |
| `sources[]` | Every LinkedIn URL that contributed. |
| `missingSections[]` | Sections that came back empty. |
| `partial` | True when anything was missing or warned. |
| `cached`, `fetchedAt`, `durationMs` | Self-explanatory. |
| `warnings[]` | Non-fatal problems, e.g. `contact info unavailable`. |

### Errors

```json
{
  "error": {
    "code": "SESSION_INVALID",
    "message": "LinkedIn served the logged-out authwall.",
    "hint": "The li_at cookie is missing, expired or revoked — refresh it and redeploy."
  }
}
```

| Code | HTTP | Meaning |
|---|---|---|
| `INVALID_URL` | 400 | `url` missing, or not a LinkedIn profile URL. |
| `BAD_REQUEST` | 400 | Malformed credentials, a paste with no `li_at` in it, or credentials sent to a deployment that refuses them. |
| `UNAUTHORIZED` | 401 | `API_KEY` is set and `x-api-key` was wrong or absent. |
| `SESSION_INVALID` | 401 | LinkedIn served the authwall. The cookie is dead. |
| `LOGIN_FAILED` | 401 | LinkedIn rejected the email or password, in its own words. |
| `CHALLENGE_REQUIRED` | 403 | A checkpoint this API cannot clear — a CAPTCHA, or an unrecognised one. Sign in from your own browser once. |
| `CHALLENGE_EXPIRED` | 410 | The sign-in handle is gone: five minutes elapsed, or the server restarted. |
| `CHALLENGE_PENDING` | 428 | Waiting on you. Carries `details.handle` and `details.challenge`. Not a failure — poll `/api/auth/verify`. |
| `PROFILE_NOT_FOUND` | 404 | No such identifier, or invisible to this session. |
| `NOT_FOUND` | 404 | Unknown route. |
| `RATE_LIMITED` | 429 | Inbound limit hit. Carries `retryAfterSeconds`. |
| `LOGIN_UNAVAILABLE` | 501 | `BROWSER_LOGIN=false`, or Chromium is not installed on the host. |
| `NOT_CONFIGURED` | 503 | No session available — none on the server, none on the request. |
| `UPSTREAM_THROTTLED` | 503 | LinkedIn returned HTTP 999, or the breaker is open. |
| `UPSTREAM_ERROR` | 502 | LinkedIn returned something unrecognisable. |
| `TIMEOUT` | 504 | Upstream exceeded `REQUEST_TIMEOUT_MS`. |
| `INTERNAL` | 500 | Bug — most likely extracted data failing its own schema. |

---

## Approach

### LinkedIn stopped shipping HTML

The obvious approach — fetch the page, run CSS selectors — has stopped working
well. The profile is a React Server Components app: the HTML that arrives is
largely a shell, and the actual data rides along in a rehydration payload.

```html
<script id="rehydrate-data">window.__como_rehydration__ = [ ... ]</script>
```

Two properties of that payload shape the whole design:

1. **It is not JSON.** It is the RSC flight format — typed rows with references
   between them, meant to be replayed by the client runtime, not parsed by a
   consumer.
2. **It is chunked, and chunks split mid-token.** A string literal can begin in
   one script tag and end in the next, so any decoder that tokenises per chunk
   produces garbage. `ssr/` concatenates every chunk before tokenising anything.

`server/src/linkedin/ssr/` does the decode: `tokenize.ts` walks the payload,
`resolve.ts` reassembles the reference graph into a plain object tree, and
`query.ts` provides traversal helpers. The result is structured data from
LinkedIn's own render — far more stable than class names that change every
deploy.

CSS selectors are still there, as a *fallback* layer. `extract/` tries the tree
first and falls back to cheerio when the tree does not carry a field. Both paths
feed the same mapper.

### Fetching only what is needed

A profile page shows the first two or three entries of each section behind a
"Show all 14 experiences" link; the full list lives at
`/in/<slug>/details/experience/`.

Fetching all eleven details pages every time would be eleven extra requests
against a limit that starts returning HTTP 999 around seven per minute. So the
extractor reads the profile page, finds which sections actually *have* a "Show
all" link, and fetches only those, three at a time. A short profile costs one
request. Contact info is one more, from `/overlay/contact-info/`, and its absence
is normal — so failure there is a warning, never an error.

Each section is allowed to fail alone. An unreachable `/details/skills/` names
itself in `meta.missingSections` and the rest of the profile still returns. A
partial profile is far more useful than a 502.

### Not getting banned

Everything defensive lives in `linkedin/fetcher.ts`:

- **Token bucket** at `OUTBOUND_RPM`, default 6/min.
- **Circuit breaker** — three consecutive throttles opens it for five minutes, so
  a rate-limited deployment stops digging.
- **Manual redirect following.** undici does not follow redirects by default,
  which is exactly right here: a bounce to `/authwall` or `/checkpoint/` is a
  *result to classify*, not a hop to follow.
- **Cookie persistence.** LinkedIn rotates `lidc`, `bcookie` and `__cf_bm`
  mid-session; a `tough-cookie` jar writes them back, without which later section
  fetches in the same run start failing.
- **Classification by body, not status.** The authwall is served with **HTTP
  200**, so a status code can never tell you authentication failed.
  `detectAuthState()` inspects the body. HTTP **999** is LinkedIn's throttle.

### Sessions are pooled per identity

Because callers can bring their own cookie, one shared cookie jar would be wrong
twice over: it would leak cookies between accounts, and one caller's throttling
would stall everyone. So each identity gets its own jar, token bucket and circuit
breaker, keyed by a truncated SHA-256 of the cookie — a digest, never the
material, so the key is safe to log.

The response cache is partitioned by that same key. LinkedIn shows different
fields to different viewers; serving one caller's copy of a profile to another
would be both wrong and a privacy leak.

Idle sessions are reaped after 15 minutes and the pool is capped at 12 with LRU
eviction. The deployment's own session is exempt — it is the server's identity,
and re-creating it would throw away a warm jar for nothing.

### Keeping secrets out of logs

`util/logger.ts` carries an explicit redaction list: `cookie`, `x-li-at`,
`x-li-jsessionid`, `x-li-cookie`, `x-li-password`, `req.body.credentials`,
`set-cookie`, `csrf-token`, and wildcard forms.

This was verified rather than assumed. Distinctive sentinel values were fired
through headers and bodies against a production-mode server; the log came back
with zero occurrences and `"x-li-cookie":"[redacted]"`.

Raw HTML captures are credential-bearing — LinkedIn embeds `data-csrf`, whose
value is the `JSESSIONID` verbatim. `fixtures/raw/` and `*.raw.html` are
gitignored; only redacted fixtures are committed.

### Stack notes

Express 5, so a rejected promise from an async handler reaches the error
middleware without wrapping every route in try/catch. `trust proxy` is `1`, not
`true` — `true` trusts the whole `X-Forwarded-For` chain and lets a caller spoof
its IP straight past the rate limiter.

The client shares types with the server by importing them directly:

```ts
import type { ProfileResponse } from '../../server/src/schema/profile.js';
```

Type-only, so it is erased at build time. The schema is the contract and the two
halves cannot drift.

---

## Known limitations

- **Password sign-in needs a browser on the server, and it is not free.** Each
  attempt launches Chromium (~100 MB RSS, a second or two of startup) and the
  runtime image is ~1.5 GB rather than ~150 MB. A host with 256 MB of RAM cannot
  run it; set `BROWSER_LOGIN=false` there and use a cookie.
- **A password sign-in usually needs a phone the first time.** LinkedIn treats a
  new server IP as a new device. That is fine for a person using the web app and
  awkward for an unattended deploy, which is why `LI_AT` is still the
  recommendation for one. Harvested cookies live in memory only, so a restart
  re-triggers the approval.
- **The login page is scraped markup too.** It carries no `<form>`, no stable
  `id` (React `useId` emits `«r0»`), and no `name` attributes, so the selectors
  match on `type` and `autocomplete` and filter to the visible copy of each
  duplicated field. Verified against the live page; still, LinkedIn can change
  it, and `LOGIN_FAILED` with "could not fill in" is what that looks like.
- **A CAPTCHA ends the sign-in.** `captcha` and `unknown` challenges close the
  browser immediately rather than parking it, because there is no step this API
  could take next. Sign in from your own browser once to clear it.
- **The extension is unpacked-only.** It is not on the Chrome Web Store, so it
  installs via Developer mode. Chromium browsers only; Firefox would need
  `browser.*` shims.
- **Cookies expire and can be challenged.** A `li_at` lasts roughly a year, but
  LinkedIn may issue a checkpoint at any time. When the deployment's own cookie
  came from a sign-in, it is dropped and re-acquired automatically; when it came
  from `LI_AT`, `SESSION_INVALID` asks for a fresh one.
- **Datacenter IPs get throttled hard.** LinkedIn rate-limits cloud ranges far
  more aggressively than residential ones. A free-tier deploy will meet HTTP 999
  sooner than a local run. `PROXY_URL` exists for this, and `OUTBOUND_RPM` should
  stay low.
- **What you see depends on who you are.** LinkedIn shows different fields to a
  1st-degree connection than to a stranger, and contact info is often hidden
  entirely. A `null` frequently means "not visible to this session", not "not on
  the profile". `meta.missingSections` distinguishes an empty section from a
  failed fetch.
- **The extractors track an undocumented format.** The rehydration payload is a
  private implementation detail and can change without notice. Tree-first,
  selectors-second limits the blast radius, and `npm run decode` replays a saved
  capture offline so a breakage is reproducible from a file — but a determined
  redesign upstream will need extractor work.
- **Recommendations are not extracted.** The field exists and always returns
  `[]`. Its details route uses a different card shape the generic mapper does not
  handle, and an empty array beats wrong data.
- **The cache is in-process.** Restarting clears it; two instances do not share
  it. Redis would be the fix; it was not worth the dependency here.
- **Live field coverage is unverified.** Extraction is tested against recorded
  fixtures, and the auth, error, rate-limit and redaction paths are tested live
  against the running server. The sign-in page is verified live: Chromium
  reaches it, `navigator.webdriver` reads `false`, and the email, password and
  submit locators all resolve and fill. But **no sign-in has been completed and
  no profile extracted end-to-end**, because no LinkedIn account was used during
  development and the development IP is currently serving HTTP 999. Expect a
  round of extractor tuning against your own first capture.
- **Person profiles only.** Company and school pages are out of scope.

---

## Deployment

The API is a plain Node server with no native dependencies, so it runs anywhere.
Configs for three platforms are included; pick one.

**Nothing secret is in any of them.** Every config marks secrets as
dashboard-supplied, and `.env` is gitignored.

### Fly.io

```bash
cd server
fly launch --no-deploy          # reads fly.toml
fly secrets set LI_AT='AQEDAT...' LI_JSESSIONID='ajax:123' API_KEY='...' \
                CORS_ORIGIN='https://your-client.vercel.app'
fly deploy
```

### Railway

Point Railway at the repo with root directory `server`; it reads `railway.json`
and builds the `Dockerfile`. Set `LI_AT`, `LI_JSESSIONID`, `API_KEY` and
`CORS_ORIGIN` as service variables. HTTPS is automatic.

### Render

New → **Blueprint** → point at the repo; it reads `server/render.yaml`. The
`sync: false` variables prompt in the dashboard rather than living in the file.

### Docker, anywhere

```bash
cd server
docker build -t linkedin-profile-api .
docker run -p 3000:3000 -e LI_AT='AQEDAT...' linkedin-profile-api
```

Multi-stage, so TypeScript never reaches the runtime image; runs as the
unprivileged `pwuser`.

The runtime stage is `mcr.microsoft.com/playwright`, not `node:alpine`, because
password sign-in needs Chromium and Chromium needs ~90 shared libraries (fonts,
nss, libdrm, ...). Installing those onto a slim base by hand is a long list that
drifts with every Chromium release. The cost is image size: roughly 1.5 GB,
against roughly 150 MB for the Node image.

**The base image tag and the `playwright` dependency must name the same
version.** They are both pinned to `1.62.1`; bump them together or the browser
will not launch. The dependency is pinned exactly rather than with a caret for
this reason.

For a host that cannot spare that, build without the browser and run cookie-only:

```bash
docker run -p 3000:3000 -e LI_AT='AQEDAT...' -e BROWSER_LOGIN=false linkedin-profile-api
```

Running locally outside Docker needs the browser fetched once:

```bash
cd server && npx playwright install chromium
```

### Client

`web/` builds to static files. `vercel.json` and `netlify.toml` are included
with SPA rewrites and security headers.

| Setting | Value |
|---|---|
| Root directory | `web` |
| Build command | `npm ci && npm run build` |
| Publish directory | `dist` |
| Environment | `VITE_API_URL=https://<your-api-host>` |

Then set `CORS_ORIGIN` on the API to the client's URL and redeploy it.

### Extension

Not published. Users load `extension/` unpacked — `chrome://extensions`,
Developer mode, Load unpacked. No build step; it is plain JS.

---

## Project structure

```
server/
  src/
    index.ts              process entry, signal handling
    app.ts                express wiring: cors, rate limit, routes, errors
    config.ts             env schema and validation
    service.ts            session pool, cache, in-flight coalescing
    middleware/           api key gate, error handler
    routes/               profile, auth, system
    schema/profile.ts     the response contract — the source of truth
    util/                 cache, errors, logger, rate limiting
    linkedin/
      fetcher.ts          retries, breaker, cookies, redirects
      session.ts          cookie jar, headers, auth-state detection
      credentials.ts      session resolution, cookie parsing, identity digests
      login.ts            browser-driven sign-in; challenge classification
      loginManager.ts     parked sign-ins, TTL, single-flight env login
      url.ts              profile URL parsing
      ssr/                RSC flight payload decoder
      pages/              profile, details and contact-info page fetchers
      extract/            payload tree + DOM -> typed profile
  scripts/decode.ts       replay a saved capture offline
  fixtures/               redacted HTML for tests
  tests/                  vitest
  Dockerfile, fly.toml, railway.json, render.yaml

web/
  src/
    api.ts                typed client; imports server types directly
    extensionBridge.ts    receives a session from the extension
    useSignIn.ts          sign-in state machine, approval polling
    useProfileLookup.ts   request state machine
    App.tsx               shell
    components/           profile sections, settings dialog, error panel
  vercel.json, netlify.toml

extension/
  manifest.json           MV3; cookies + activeTab + scripting
  popup.html/.css/.js     the entire extension, ~150 lines of logic
```

## Testing

```bash
cd server
npm test            # vitest, 78 tests
npm run typecheck
```

Tests run against recorded fixtures — no network, no LinkedIn session needed.
They cover the flight decoder including the chunk-splitting case that breaks
naive parsers, URL parsing, session resolution, pasted-cookie parsing, cookie jar
construction, auth-state detection, and the challenge classifier that decides
whether a stalled sign-in is waiting on a phone tap or on a typed code.

The sign-in itself is not unit-tested — it needs a browser and a LinkedIn
account. Its browser-independent half is (`classifyChallenge`,
`credentialErrorFrom`), and the selectors were verified against the live login
page.

To debug an extraction against a real page, save the HTML and run:

```bash
npm run decode -- path/to/capture.html
```

which runs the same code path the server uses and prints the extracted profile.
Keep captures in `fixtures/raw/` — it is gitignored, and raw captures contain
your CSRF token.

## Legal and ethical note

Automated collection is against LinkedIn's User Agreement. This was built as a
technical exercise for a hiring challenge, and it deliberately behaves itself:
low request rates, a circuit breaker that backs off, response caching to avoid
repeat fetches, and no attempt to defeat CAPTCHAs or device fingerprinting.

Use it against profiles you have a legitimate reason to look at, with an account
you own, and be aware that the account carries the risk of restriction.
