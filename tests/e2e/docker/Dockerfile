# The capped image PPM's browser e2e scripts run in (ppm-e2e-chromium): Bun for the fixture
# server and the Vite build, Node 20 for the e2e script itself, Debian's Chromium, and
# playwright-core (no bundled browsers) at /opt/pw.
#
#   docker build -t ppm-e2e-chromium:latest tests/e2e/docker
#
# Run a script with the repository mounted read-only and node_modules in a named volume, so the
# Linux builds of native packages (the Claude CLI binary among them) never touch the host's:
#
#   docker run --rm --cpus=4 --memory=6g -v <repo>:/app:ro -v ppm-e2e-nm:/app/node_modules \
#     -v <out>:/out -w /app -e IS_SANDBOX=1 ppm-e2e-chromium:latest \
#     sh -c 'bun install --frozen-lockfile && node tests/e2e/<script>.mjs'
#
# Keep the CPU and memory caps: a host-run e2e once starved the live server into a supervisor
# restart. IS_SANDBOX=1 lets a bypass-mode Claude CLI run as root, should a script start one.
# Bun is pinned: 1.3.14 breaks the mermaid install and 1.3.10 loses tests under Linux.
FROM node:20-bookworm-slim AS node

FROM oven/bun:1.3.13
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -sf /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
 && apt-get update \
 && apt-get install -y --no-install-recommends chromium fonts-liberation fonts-noto-color-emoji ca-certificates git \
 && rm -rf /var/lib/apt/lists/*
RUN mkdir -p /opt/pw && cd /opt/pw && npm init -y >/dev/null && npm install --no-audit --no-fund playwright-core@1.60
ENV PPM_PLAYWRIGHT_MODULE=/opt/pw/node_modules/playwright-core/index.mjs \
    PPM_PLAYWRIGHT_EXECUTABLE=/usr/bin/chromium
