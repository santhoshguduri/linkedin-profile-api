# Build stage stays on plain Node: compiling TypeScript needs no browser.
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
# Chromium is fetched in the runtime stage, not here.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Runtime installs Chromium onto the same slim base rather than starting from
# mcr.microsoft.com/playwright. That image is the convenient answer and was the
# first one used here, but it ships Firefox and WebKit too, and this server
# drives only Chromium: 2.5 GB of image to run 1.1 GB of it. Free tiers cap
# image size, so the difference decides whether this deploys at all.
#
# `playwright install --with-deps` is what makes the slim base viable. It reads
# the browser revision from the installed playwright package and pulls the ~90
# shared libraries Chromium links against (fonts, nss, libdrm, ...) through apt.
# Listing those by hand is a long list that drifts every Chromium release.
FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Installed outside the default per-user cache so the unprivileged user below
# can read it. The revision comes from the dependency itself, so the two can no
# longer disagree -- the pinned base-image tag this replaces had to be bumped by
# hand in lockstep, and a mismatch meant a browser that would not launch.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN npx --yes playwright install --with-deps chromium
RUN rm -rf /var/lib/apt/lists/* && chmod -R a+rX /ms-playwright

COPY --from=build /app/dist ./dist

# Run unprivileged. Chromium launches with --no-sandbox because the container is
# already the isolation boundary, so it needs no elevated capabilities.
RUN useradd --create-home --shell /bin/bash appuser && chown -R appuser /app
USER appuser
EXPOSE 3000

# The platform's own health check hits /health over HTTP; this one is for
# `docker run` outside a platform, so the image is self-describing either way.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
