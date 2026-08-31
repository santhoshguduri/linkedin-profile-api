# LinkedIn Profile API

Accepts a LinkedIn profile URL and returns the profile as structured JSON. Full
documentation, API reference and design notes live in the [repository
README](https://github.com/santhoshguduri/linkedin-profile-api).

## Deploying

The `Dockerfile` beside this file is the whole deployment. The server binds
`0.0.0.0` and takes its port from `PORT`, so it needs no changes on any container
host. Google Cloud Run, from this directory:

```bash
gcloud run deploy linkedin-profile-api --source . \
  --memory 2Gi --cpu 2 --concurrency 1 --timeout 120 \
  --execution-environment gen2 --allow-unauthenticated \
  --set-secrets LI_AT=LI_AT:latest
```

`--concurrency 1` is not a tuning preference. The default is 80 requests per
instance and a render holds roughly half a gigabyte, so a second concurrent
lookup takes the container out regardless of how much memory it was given.

## Configuration

Supply these through the host's secret store, never through a committed file.

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
