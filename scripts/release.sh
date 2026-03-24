#!/bin/bash
set -e

VERSION="${1:-}"
if [ -z "$VERSION" ]; then
  VERSION=$(node -p "require('./package.json').version")
  echo "No version specified, using package.json: v$VERSION"
fi

# Strip leading 'v' if provided
VERSION="${VERSION#v}"
TAG="v$VERSION"

echo "=== Release $TAG ==="

# 1. Build frontend
echo "[1/4] Building frontend..."
bun run build:web

# 2. Build binaries for all platforms
echo "[2/4] Compiling binaries..."
mkdir -p dist

TARGETS=(
  "bun-darwin-arm64:ppm-darwin-arm64"
  "bun-darwin-x64-baseline:ppm-darwin-x64"
  "bun-linux-x64-baseline:ppm-linux-x64"
  "bun-linux-arm64:ppm-linux-arm64"
  "bun-windows-x64-baseline:ppm-windows-x64.exe"
)

for entry in "${TARGETS[@]}"; do
  target="${entry%%:*}"
  artifact="${entry##*:}"
  echo "  -> $artifact ($target)"
  bun build src/index.ts --compile --target="$target" --outfile="dist/$artifact"
done

# 3. Package binaries with web assets
echo "[3/5] Packaging..."
rm -f dist/ppm-*.tar.gz dist/ppm-*.zip

for entry in "${TARGETS[@]}"; do
  artifact="${entry##*:}"
  if [[ "$artifact" == *.exe ]]; then
    # Windows: zip
    name="${artifact%.exe}"
    mkdir -p "dist/$name"
    cp "dist/$artifact" "dist/$name/ppm.exe"
    cp -r dist/web "dist/$name/web"
    (cd dist && zip -qr "${name}.zip" "$name")
    rm -rf "dist/$name"
    echo "  -> ${name}.zip"
  else
    # Unix: tar.gz
    mkdir -p "dist/$artifact-pkg"
    cp "dist/$artifact" "dist/$artifact-pkg/ppm"
    cp -r dist/web "dist/$artifact-pkg/web"
    tar -czf "dist/${artifact}.tar.gz" -C "dist/$artifact-pkg" .
    rm -rf "dist/$artifact-pkg"
    echo "  -> ${artifact}.tar.gz"
  fi
done

# 4. Create tag if not exists
if git rev-parse "$TAG" >/dev/null 2>&1; then
  echo "[4/5] Tag $TAG already exists, skipping"
else
  echo "[4/5] Creating tag $TAG..."
  git tag "$TAG"
  git push origin "$TAG"
fi

# 5. Create or update release
echo "[5/5] Uploading to GitHub release..."
ARCHIVES=(dist/ppm-*.tar.gz dist/ppm-*.zip)
if gh release view "$TAG" >/dev/null 2>&1; then
  gh release upload "$TAG" ${ARCHIVES[@]} --clobber
else
  gh release create "$TAG" ${ARCHIVES[@]} --title "$TAG" --generate-notes
fi

echo "=== Done: https://github.com/$(gh repo view --json nameWithOwner -q .nameWithOwner)/releases/tag/$TAG ==="
