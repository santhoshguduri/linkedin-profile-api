# LinkedIn Session Connector

A ~150-line browser extension that reads your existing LinkedIn session and hands
it to the Profile API, so nobody has to be walked through DevTools.

## Why an extension and not a bookmarklet

`li_at` is set `HttpOnly`. Page scripts cannot see it — `document.cookie` returns
everything *except* the one value that matters — so a bookmarklet physically
cannot capture it. Extensions can, through the `chrome.cookies` API, which is
exactly why every tool in this space ships one rather than a snippet.

## Install (unpacked)

1. Sign in to LinkedIn in this browser.
2. Open `chrome://extensions` (or `edge://extensions`).
3. Turn on **Developer mode**.
4. **Load unpacked** and pick this `extension/` folder.

Works in Chrome, Edge, Brave, Arc and any other Chromium browser. Firefox needs
`browser.*` shims; not done here.

## Use

1. Open the Profile API web app.
2. Click the extension icon.
3. **Send to this tab** — the app fills itself in and you are done.

**Copy instead** puts the session on the clipboard if you would rather paste it
yourself, or if you are using the API directly with curl.

## What it can and cannot touch

| | |
|---|---|
| Standing access | `https://www.linkedin.com/*` cookies, and nothing else |
| Granted per site, on request | The one tab you press **Send to this tab** on |
| Sent anywhere by the extension | Nothing. It has no network code at all. |

The session goes only where you point it. "Send to this tab" asks the browser
for permission to that specific origin the first time, and posts the value into
that page — so treat it the way you would treat pasting the cookie there, because
it is the same trust decision.

Revoke everything by signing out of LinkedIn, which invalidates `li_at`
immediately, or by removing the extension.
