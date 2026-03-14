# Phase 9: PWA + Build + Deploy

**Owner:** Lead
**Priority:** Medium
**Depends on:** All previous phases
**Effort:** Medium

## Overview

PWA configuration, production build pipeline, single binary compilation, CI/CD for cross-platform releases.

## PWA Setup

### vite-plugin-pwa Config
```typescript
// vite.config.ts
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      manifest: {
        name: 'PPM - Personal Project Manager',
        short_name: 'PPM',
        description: 'Mobile-first web IDE for managing code projects',
        theme_color: '#0f172a',
        background_color: '#0f172a',
        display: 'standalone',
        orientation: 'any',
        icons: [
          { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,ico,png,svg,woff2}'],
        // Cache UI shell for offline. API calls always need network.
        runtimeCaching: [
          {
            urlPattern: /^https?:\/\/.*\/api\//,
            handler: 'NetworkOnly', // API = always online
          },
        ],
      },
    }),
  ],
});
```

### PWA Features
- Install prompt on mobile
- Offline: UI shell loads, shows "No connection" for API features
- App icon + splash screen

## Build Pipeline

### scripts/build.ts
```typescript
import { $ } from 'bun';

// 1. Build frontend (Vite)
await $`bun run vite build --outDir dist/web`;

// 2. Compile backend + embedded frontend into single binary
await $`bun build src/index.ts --compile --outfile dist/ppm`;

// For cross-platform:
// bun build src/index.ts --compile --target=bun-linux-x64 --outfile dist/ppm-linux-x64
// bun build src/index.ts --compile --target=bun-darwin-arm64 --outfile dist/ppm-darwin-arm64
```

### Static File Embedding
```typescript
// server/routes/static.ts
// In dev: proxy to Vite dev server
// In prod: serve from embedded dist/web/ directory

if (process.env.NODE_ENV === 'production') {
  // Serve built files
  app.use('/*', serveStatic({ root: './dist/web' }));
  // SPA fallback
  app.get('*', (c) => c.html(readFileSync('./dist/web/index.html', 'utf-8')));
} else {
  // Proxy to Vite dev server
  // Or just run Vite separately
}
```

### Package.json Scripts
```json
{
  "scripts": {
    "dev": "concurrently \"bun run --hot src/index.ts start\" \"bun run vite\"",
    "build": "bun run scripts/build.ts",
    "build:linux": "bun build src/index.ts --compile --target=bun-linux-x64 --outfile dist/ppm-linux-x64",
    "build:mac-arm": "bun build src/index.ts --compile --target=bun-darwin-arm64 --outfile dist/ppm-darwin-arm64",
    "build:mac-x64": "bun build src/index.ts --compile --target=bun-darwin-x64 --outfile dist/ppm-darwin-x64"
  }
}
```

## CI/CD (GitHub Actions)

### .github/workflows/release.yml
```yaml
name: Release
on:
  push:
    tags: ['v*']

jobs:
  build:
    strategy:
      matrix:
        include:
          - os: ubuntu-latest
            target: bun-linux-x64
            artifact: ppm-linux-x64
          - os: macos-latest
            target: bun-darwin-arm64
            artifact: ppm-darwin-arm64
          - os: macos-13
            target: bun-darwin-x64
            artifact: ppm-darwin-x64

    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
      - run: bun install
      - run: bun run vite build --outDir dist/web
      - run: bun build src/index.ts --compile --target=${{ matrix.target }} --outfile dist/${{ matrix.artifact }}
      - uses: actions/upload-artifact@v4
        with:
          name: ${{ matrix.artifact }}
          path: dist/${{ matrix.artifact }}

  release:
    needs: build
    runs-on: ubuntu-latest
    steps:
      - uses: actions/download-artifact@v4
      - uses: softprops/action-gh-release@v2
        with:
          files: |
            ppm-linux-x64/ppm-linux-x64
            ppm-darwin-arm64/ppm-darwin-arm64
            ppm-darwin-x64/ppm-darwin-x64
```

### Dockerfile (fallback)
```dockerfile
FROM oven/bun:1.2-alpine
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --production
COPY dist/ ./dist/
COPY src/ ./src/
EXPOSE 8080
CMD ["bun", "run", "src/index.ts", "start"]
```

## Deployment Docs

### Local
```bash
# Install
curl -fsSL https://github.com/user/ppm/releases/latest/download/ppm-$(uname -s | tr A-Z a-z)-$(uname -m) -o /usr/local/bin/ppm
chmod +x /usr/local/bin/ppm

# Setup
ppm init
ppm start
```

### VPS
```bash
scp ppm-linux-x64 user@vps:/usr/local/bin/ppm
scp ppm.yaml user@vps:/etc/ppm/config.yaml
ssh user@vps "ppm start -c /etc/ppm/config.yaml -d"
```

## Success Criteria

- [ ] PWA installable on mobile (add to homescreen)
- [ ] `bun run build` produces working binary
- [ ] Binary serves embedded frontend
- [ ] Cross-platform binaries compile in CI
- [ ] GitHub Release created with binaries on tag push
- [ ] Docker image works as fallback
- [ ] `ppm init && ppm start` works end-to-end on fresh install
