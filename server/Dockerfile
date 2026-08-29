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

# Runtime is Playwright's own image: it ships Chromium plus the ~90 shared
# libraries it needs (fonts, nss, libdrm, ...). Installing those onto a slim base
# by hand is a long list that drifts every Chromium release, so this is both
# smaller in effort and more reliable. The tag is pinned to the Playwright
# version in package.json; they must match or the browser will not launch.
FROM mcr.microsoft.com/playwright:v1.62.1-noble AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY package*.json ./
# Browsers are already in the image at /ms-playwright, so the npm postinstall
# download is skipped -- it would otherwise add ~150 MB of duplicates.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist

# Run unprivileged. The Playwright image ships this user, and Chromium is
# already readable by it.
USER pwuser
EXPOSE 3000

# The platform's own health check hits /health over HTTP; this one is for
# `docker run` outside a platform, so the image is self-describing either way.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
