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
    "sources": [
      "https://www.linkedin.com/in/williamhgates/",
      "https://www.linkedin.com/in/williamhgates/overlay/contact-info/"
    ],
    "missingSections": ["skills", "courses"],
    "partial": true,
    "cached": false,
    "fetchedAt": "2026-08-29T12:00:00.000Z",
    "durationMs": 11840,
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

The web app asks to connect before it offers a search box — every lookup runs as
a signed-in member, so a search without a session could only ever fail. Press
**Connect LinkedIn** and sign in with your LinkedIn email and password. If
LinkedIn asks you to approve it from the LinkedIn app on your phone, the dialog
waits while you do, showing what to tap and how long it has been waiting. There
is nothing to save: the dialog closes itself the moment a session arrives.

Two ways to skip the password, both ending in the same session cookie:

- **Paste the cookie header** under *Already signed in to LinkedIn here?* in the
  same dialog, then press **Use this cookie**. DevTools → Network → any
  `linkedin.com` request → copy the `Cookie` header.
- **Load the extension**: `chrome://extensions` → Developer mode → **Load
  unpacked** → pick `extension/`, then click it and press **Send to this tab**.
  It fills the dialog in for you. The dialog no longer walks through this — it
  was a lot of setup to explain to someone who mostly wants the paste box — but
  the listener is still there, so an installed extension still works.

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

Four challenge kinds are recognised, and the difference matters — only one of
them is a dead end:

| Kind | Resolvable | What happens |
|---|---|---|
| `app-approval` | yes | polled automatically; resolves when you tap approve |
| `code` | yes | the API asks for the code and submits it |
| `unknown` | yes | polled like an approval — see below |
| `captcha` | no | nobody can answer it unattended; browser is closed immediately |

`unknown` is deliberately treated as waitable rather than fatal. It means
LinkedIn showed a screen the classifier could not name, which is not the same as
a screen nobody can clear — in practice it is usually an approval prompt worded
in a way the patterns have not seen. Failing on it closed the browser and ended
the sign-in within seconds, while the person was still reaching for their phone.
Waiting costs one parked browser and is right far more often than it is wrong.

There is a second, subtler reason that used to happen. The password field
disappears the instant LinkedIn accepts the password, but the screen it swaps in
is rendered by the SDUI runtime a beat later. Reading the page at that exact
moment finds an empty body, so classification had nothing to match on and
answered `unknown`. `#awaitChallengeScreen()` now polls for up to six seconds
for the screen to become legible before it is judged.

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
| `LOGIN_WAIT_MS` | `20000` | How long one sign-in request blocks waiting for a phone tap before answering "still waiting". Keep under your platform's proxy timeout — the first request can also spend up to 6s waiting for the challenge screen to render. The total wait is not bounded by this: the client polls until the sign-in is five minutes old. |
| `API_KEY` | — | When set, `/api/profile` and `/api/auth` require `x-api-key` (or `Authorization: Bearer`). Unset means open. |
| `ALLOW_REQUEST_CREDENTIALS` | `true` | Whether callers may sign in or attach their own session. `false` disables `/api/auth`. |
| `CORS_ORIGIN` | `*` | Comma-separated origins. Pin this to your client URL in production. |
| `INBOUND_RPM` | `30` | Requests per minute per client IP. |
| `OUTBOUND_RPM` | `6` | Requests per minute to LinkedIn. Above ~6 invites HTTP 999. |
| `RENDER_PROFILES` | `true` | Load each profile in Chromium so LinkedIn's own runtime fetches the sections. `false` is much faster and returns the top card alone — the sections are not obtainable without it. |
| `RENDER_TIMEOUT_MS` | `45000` | Ceiling on one render. Long profiles genuinely take tens of seconds; a value that is too low truncates them silently rather than failing. |
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

### The page below the top card is not in the page

This is the part that took the longest to work out, and the part the earlier
design got wrong.

The document LinkedIn returns carries the top card and nothing else. Experience,
education, skills — every section below the fold — is absent from the markup
entirely. The whole profile arrives as **55 text runs**, and the sections are
fetched afterwards by the page's own runtime.

The first plan was to read the "Show all 14 experiences" links and fetch
`/in/<slug>/details/experience/`. That plan is dead, and it is worth saying why
rather than quietly not doing it: **every profile route returns the same shell.**
The contact-info overlay came back with the same 55 text runs as the profile
page, byte for byte, differing only in the follower count — which proved the
second fetch had really happened and had really returned nothing new. There is no
details page to scrape.

What the shell does carry is the anchors. Each empty section is a
`ReplaceComponent` action with an `asyncContent` request naming the component to
go and get:

```jsonc
"proto.sdui.actions.core.AsyncComponentRequest": {
  "newComponentId": "com.linkedin.sdui.generated.profile.dsl.impl.profileCardsExperienceOnly",
  "requestedArguments": { "payload": { "isSelfView": false, "vanityName": "..." } }
}
```

There are about a dozen of these — `profileCardsExperienceOnly`,
`profileCardsAboveActivity`, `profileCardsBelowActivityPart1` through `Part7`,
and so on. No Voyager endpoint and no GraphQL query ids appear anywhere in the
HTML; the URL those requests go to lives in the JavaScript bundle.

Reimplementing that protocol by hand would mean pinning an endpoint, a set of
component ids and a request envelope that LinkedIn changes on its own schedule.
So `linkedin/renderer.ts` takes the other option: **load the page in Chromium and
let LinkedIn's own runtime make those requests.** Playwright, a seeded `li_at`
cookie, scroll to the bottom, read the DOM.

Three things that are less obvious than they sound:

- **`networkidle` never fires.** LinkedIn holds long-poll connections open for
  the life of the page, so the built-in wait never resolves. The renderer instead
  tracks in-flight requests itself and calls the page settled only when it is
  scrolled to the bottom, nothing is pending, and neither the document height nor
  its text length has changed across four consecutive half-second checks. An
  earlier, shorter version of this declared victory after ~1.4s and silently
  truncated longer profiles.
- **The sign-in wall can arrive mid-render.** An expired cookie gets a 679 KB
  profile shell first and a 76 KB auth wall swapped in a moment later, under the
  profile's own URL, with HTTP 200. Nothing about the status or the path gives it
  away, so the renderer checks for the wall's markup both on arrival *and* after
  the scroll.
- **Fonts, media and stylesheets are blocked; images are not.** Profile and
  company images are part of the response contract, so their URLs have to be in
  the DOM.

### Reading the rendered DOM

Hydrated markup has no stable class names — LinkedIn ships hashed CSS modules, so
every element looks like `class="_02484ad3 _1f667e81"`. Two things survive a
deploy, and `extract/rendered.ts` uses only those: **heading text** and the
`componentkey` attribute.

Sections are found by matching `<h2>` text against a table of known headings
(including the variants LinkedIn actually uses — both `Licenses & Certifications`
and `Licenses and Certifications`). The first match wins: section names recur
further down the page inside "People also viewed" cards.

Entries within a section come in two shapes — experience rows are
`componentkey="entity-collection-item-<hash>"`, education rows are plain-UUID
keys separated by `<hr>` — so the extractor takes every keyed element and keeps
only the outermost, because an experience row contains a keyed `<a>` of its own
and counting that would double the list.

Each entry is reduced to its visible text runs in document order, plus the first
image and the links. That is a `RawEntity`, the same shape the flight-tree path
produces, so **every existing mapper is reused unchanged**.

One consequence worth naming: hydration discards the
`urn:li:fsd_profile:` strings entirely. The profile id survives only inside a
component key — `sdui.profile.card.ref<id>Topcard` — which is where the identity
extractor now recovers it from.

Rendering costs a browser page and roughly ten seconds per profile, against a
fraction of a second for a plain fetch. `RENDER_PROFILES=false` turns it off and
returns the top card alone. That is the honest trade: the sections are not
obtainable without it.

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

- **A lookup takes about ten seconds, not one.** Every profile is rendered in a
  browser, because that is the only way the sections load at all. A cache hit is
  instant; a cold lookup is not. `RENDER_PROFILES=false` gets the sub-second
  response back and gives up everything below the top card.
- **Renders can truncate silently, and a truncated section is indistinguishable
  from an absent one.** The settle heuristic — scrolled to the bottom, nothing in
  flight, height and text unchanged for four consecutive checks — is a heuristic.
  An earlier, more impatient version of it cut a long profile off at the Activity
  section and reported the missing Experience as simply not present. The current
  thresholds and the 45s ceiling hold for the profiles I have rendered; a much
  longer profile on a much slower link could still trip it, and it would show up
  as an unexpected entry in `meta.missingSections` rather than as an error.
- **Skills, certifications and languages are the least-exercised paths.** Neither
  profile I have captured has any of those sections, so the section-routing is
  covered by tests and the container parsing is covered only by the two shapes I
  have actually seen (experience's `entity-collection-item-<hash>` rows and
  education's UUID-keyed rows). If LinkedIn renders skills as a third shape, that
  is where it will surface.
- **Password sign-in needs a browser on the server, and it is not free.** Each
  attempt launches Chromium (~100 MB RSS, a second or two of startup) and the
  runtime image is ~2.5 GB rather than ~150 MB. A host with 256 MB of RAM cannot
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
- **Recommendations are not extracted.** The field is in the schema and always
  returns `[]`. The card carries a quote, an author and the author's relationship
  to the subject, none of which the generic entity mapper models, and an empty
  array beats wrong data.
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
drifts with every Chromium release. The cost is image size: roughly 2.5 GB
(measured, not estimated: `docker images` reports 2.52 GB),
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

> **The build reads files outside `web/`.** `src/api.ts` type-imports the
> response contract from `server/src/schema/profile.ts`, so the whole repo has
> to be on disk at build time. Vercel gates this behind *Settings > General >
> Root Directory > Include source files outside of the Root Directory*; leave
> it on. Netlify clones the whole repo regardless.
>
> That import is also why `zod` is a devDependency here and why `tsconfig.json`
> maps it to this package's copy. TypeScript resolves a bare specifier from the
> directory of the file that wrote it, so without the mapping it searches
> `server/node_modules` -- present locally, absent on a build host -- and every
> profile type quietly degrades to `any`.

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
      renderer.ts         pooled Chromium; scroll until the lazy sections land
      url.ts              profile URL parsing
      ssr/                RSC flight payload decoder
      pages/              profile and contact-info page fetchers
      extract/            payload tree + rendered DOM -> typed profile
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
npm test            # vitest, 127 tests
npm run typecheck
```

Tests run against recorded fixtures — no network, no LinkedIn session needed.
They cover the flight decoder including the chunk-splitting case that breaks
naive parsers, URL parsing, session resolution, pasted-cookie parsing, cookie jar
construction, auth-state detection, and the challenge classifier that decides
whether a stalled sign-in is waiting on a phone tap or on a typed code.

Section extraction is tested against `tests/fixtures/rendered-profile.html`,
which is a real authenticated render with every attribute the parser does not
read stripped off — which is also what removes the CSRF token, so it is safe to
commit where the capture it came from is not. Real markup matters more here than
anywhere else in the suite: the whole premise of `extract/rendered.ts` is that
LinkedIn's DOM has no stable class names, so a hand-written fixture would only
prove the extractor agrees with my guess about the DOM rather than with the DOM.

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
