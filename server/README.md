---
title: LinkedIn Profile API
emoji: 🔎
colorFrom: blue
colorTo: indigo
sdk: docker
app_port: 3000
pinned: false
---

# LinkedIn Profile API

Accepts a LinkedIn profile URL and returns the profile as structured JSON. Full
documentation, API reference and design notes live in the [repository
README](https://github.com/santhoshguduri/linkedin-profile-api).

## Why this directory has its own README

The front matter above is what a Hugging Face Space reads to build this folder
as a Docker Space: `sdk: docker` selects the `Dockerfile` beside this file, and
`app_port` tells the router which port the container listens on. The file is
inert everywhere else, so the same directory deploys unchanged to any container
host.

## Configuration

Set these as Space secrets rather than committing them.

| Variable | Required | Purpose |
| --- | --- | --- |
| `LI_AT` | yes | LinkedIn session cookie the server reads profiles with. |
| `LI_JSESSIONID` | no | Paired CSRF token; raises the ceiling on what LinkedIn will serve. |
| `CORS_ORIGIN` | no | Origin of the deployed web client. |
| `RENDER_PROFILES` | no | `true` by default. Set `false` only on an instance under 1 GB. |

## Sizing

Reading a profile drives a real browser, because everything below the top card
is fetched by the page's own runtime after load and is simply absent from the
HTML LinkedIn serves over HTTP. Measured inside this image under a hard cap with
swap disabled: Chromium is 289 MB before it loads a page, 382 MB after one static
article with images blocked, and 434 MB once that article is scrolled. A profile
is heavier than an article.

So a 512 MB instance does not run this. It is not slow or flaky there -- the
kernel kills the container mid-request and the platform answers 502 with no body,
because the process that would have written one no longer exists. Give it 1 GB
and preferably 2.
