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
| `extension/` | ~150-line browser extension that hands your LinkedIn session to the API in one click, so nobody has to go hunting for a cookie. |

---

## Contents

- [Quick start](#quick-start)
- [Authentication](#authentication) — read this one
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
cp .env.example .env       # optional: paste an li_at into it, see Authentication
npm run dev                # http://localhost:3000

# Client, in a second terminal
cd web
npm install
cp .env.example .env       # VITE_API_URL=http://localhost:3000
npm run dev                # http://localhost:5173
```

Then load the extension: `chrome://extensions` → Developer mode → **Load
unpacked** → pick `extension/`. Open the web app, click the extension, press
**Send to this tab**, and you are connected.

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

**The API authenticates with a LinkedIn session cookie, not an email and
password.** That is not a shortcut — it is the only thing that works, and it is
what every commercial tool in this space does. The reasoning is worth reading
before you judge the design.

### Why not email and password

Fetching `https://www.linkedin.com/login` today returns:

- HTTP 200, ~488 KB, and **zero `<form>` elements**
- no `loginCsrfParam`, no `session_key` field, no `/checkpoint/lg/login-submit`
- a `window.__como_rehydration__` payload instead

The login page is now server-driven UI: `proto.sdui.*` protobuf-shaped JSON
actions embedded in that payload. The sign-in action reads:

```jsonc
{
  "requestId": "com.linkedin.sdui.requests.login.authenticate",
  "authenticationType": "AuthenticationType_PASSWORD",
  "identifier": "memberIdentifierInput",
  "password":   "passwordInput",
  "isEncrypted": true,          // the browser encrypts it before it is sent
  "apfc": "..."                 // device-signal fingerprint token
}
```

The password is encrypted client-side with a key from the page bundle and sent
with a device fingerprint. The bundle entry point
(`static.licdn.com/aero-v1/sc/h/assets/RocgrYlk.js`) is 4 KB — a loader; the real
code sits behind an import map in obfuscated chunks. Reproducing that would mean
running a headless browser, and LinkedIn issues a CAPTCHA or an emailed PIN to
almost any login from a datacenter IP anyway, so it would still need a human.

So a password is rejected at the route with `LOGIN_UNSUPPORTED` (501) and a hint
pointing at the real path, rather than half-attempted and failing three layers
deep with a confusing message.

This is also what the reference platforms do. PhantomBuster, Expandi, Dripify
and Waalaxy all ask for the session cookie and none of them accept a LinkedIn
password. What they add on top is a browser extension that fetches the cookie
for you — which is the part this repo reproduces.

### Three ways to hand over a session

In descending order of how much the user needs to understand:

#### 1. The extension (what a normal user does)

`extension/` is a Manifest V3 extension. Load it unpacked, click it while signed
in to LinkedIn, press **Send to this tab**, and the web app fills itself in. The
user never sees a cookie or opens DevTools.

It has to be an extension rather than a bookmarklet, and the reason is the
interesting bit: **`li_at` is `HttpOnly`**. `document.cookie` returns every
LinkedIn cookie *except* the one that matters, so no page script can capture it.
Only the browser's own `chrome.cookies` API can — which is exactly why the
commercial tools ship extensions too.

The extension has no network code at all. Its standing permissions are LinkedIn
cookies and nothing else; access to the page you send to is requested at the
moment you press the button, for that one origin. See `extension/README.md`.

#### 2. Paste the cookie header

For anyone who cannot install an extension. DevTools → **Network** → click any
`linkedin.com` request → copy the whole `Cookie:` request header → paste it into
the app's **No extension?** box, or send it directly:

```bash
curl -X POST https://<host>/api/profile \
  -H 'content-type: application/json' \
  -d '{ "url": "williamhgates", "credentials": { "cookie": "bcookie=...; li_at=AQEDAT...; JSESSIONID=\"ajax:1\"; lidc=..." } }'
```

The server picks out `li_at` and `JSESSIONID` and **discards everything else** —
a copied header also carries analytics and fingerprinting cookies, and there is
no reason to forward those to LinkedIn on someone's behalf.

#### 3. The raw values

For operators. DevTools → **Application** → **Cookies** → `li_at`. This is what
goes in `server/.env` for a deployment that has a session of its own:

```env
LI_AT=AQEDAT...
LI_JSESSIONID="ajax:1234567890"
```

### Whose session gets used

| Situation | Runs as |
|---|---|
| Caller sent credentials | The caller's session |
| Caller sent nothing, `LI_AT` is set | The deployment's session |
| Neither | `NOT_CONFIGURED`, with a hint explaining both options |

Both can be live at once. A public demo should set `LI_AT` so it works out of the
box, while visitors who connect their own session spend their own rate limit
rather than the operator's. `ALLOW_REQUEST_CREDENTIALS=false` pins everything to
the deployment's session.

A caller-supplied session is never written to disk. It is held in memory only
while in use — 15 minutes idle, 12 identities maximum — then dropped. A `li_at`
is revoked the moment you sign that LinkedIn session out.

---

## Configuration

Server config is environment variables; `server/.env.example` is the annotated list.

| Variable | Default | Purpose |
|---|---|---|
| `LI_AT` | — | The deployment's own LinkedIn session cookie. Without it the server still boots and still serves callers who bring their own. |
| `LI_JSESSIONID` | — | Optional. Makes the session slightly stabler. |
| `LI_BCOOKIE`, `LI_LIDC` | — | Optional ambient cookies. |
| `API_KEY` | — | When set, `/api/profile` requires `x-api-key` (or `Authorization: Bearer`). Unset means open. |
| `ALLOW_REQUEST_CREDENTIALS` | `true` | Whether callers may attach their own session. |
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
  "acceptsRequestCredentials": true,
  "activeSessions": 2
}
```

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
| `CHALLENGE_REQUIRED` | 403 | Checkpoint or CAPTCHA. Clear it in a browser, reconnect. |
| `PROFILE_NOT_FOUND` | 404 | No such identifier, or invisible to this session. |
| `NOT_FOUND` | 404 | Unknown route. |
| `RATE_LIMITED` | 429 | Inbound limit hit. Carries `retryAfterSeconds`. |
| `LOGIN_UNSUPPORTED` | 501 | An email/password was sent. See [Authentication](#why-not-email-and-password). |
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

- **No email/password sign-in.** Covered at length in
  [Authentication](#why-not-email-and-password). The extension exists to make the
  cookie requirement invisible to normal users, not to work around it.
- **The extension is unpacked-only.** It is not on the Chrome Web Store, so it
  installs via Developer mode. Chromium browsers only; Firefox would need
  `browser.*` shims.
- **Cookies expire and can be challenged.** A `li_at` lasts roughly a year, but
  LinkedIn may issue a checkpoint at any time — a CAPTCHA or an emailed PIN. A
  server cannot answer either unattended, so `CHALLENGE_REQUIRED` asks a human to
  clear it in a browser and reconnect.
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
  against the running server. But the pipeline has not been run end-to-end
  against a real profile with a valid cookie, because no live session was
  available during development and the development IP is currently serving
  HTTP 999. Expect a round of extractor tuning against your own first capture.
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
unprivileged `node` user.

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
    routes/               profile, system
    schema/profile.ts     the response contract — the source of truth
    util/                 cache, errors, logger, rate limiting
    linkedin/
      fetcher.ts          retries, breaker, cookies, redirects
      session.ts          cookie jar, headers, auth-state detection
      credentials.ts      session resolution, cookie parsing, identity digests
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
npm test            # vitest, 66 tests
npm run typecheck
```

Tests run against recorded fixtures — no network, no LinkedIn session needed.
They cover the flight decoder including the chunk-splitting case that breaks
naive parsers, URL parsing, session resolution, pasted-cookie parsing, cookie jar
construction and auth-state detection.

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
