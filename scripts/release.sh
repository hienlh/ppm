#!/bin/bash
set -uo pipefail

# release.sh — full PPM release from a local machine.
#
# GitHub Actions release is disabled (billing), so binaries are built and
# uploaded here instead. Run this AFTER you have committed & pushed your source
# changes + the version bump in package.json. This script itself does NOT commit
# source; it performs the release steps:
#   1. regenerate skill assets + build frontend
#   2. publish the npm package (skipped if the version is already on npm)
#   3. compile binaries for every platform
#   4. package each binary with the web assets
#   5. create + push the git tag
#   6. create/update the GitHub release and upload the archives
#
# The npm version and the GitHub binary release always share the same version,
# so `curl … | sh` installs stay in sync with `bunx @hienlh/ppm`.
#
# Usage:
#   bash scripts/release.sh            # version from package.json
#   bash scripts/release.sh 0.17.8     # explicit version (must match package.json)

REPO_DEFAULT="hienlh/ppm"

VERSION="${1:-}"
if [ -z "$VERSION" ]; then
  VERSION=$(node -p "require('./package.json').version")
fi
VERSION="${VERSION#v}"          # strip leading 'v' if provided
TAG="v$VERSION"
PKG_VERSION=$(node -p "require('./package.json').version")
PKG_NAME=$(node -p "require('./package.json').name")

echo "=== PPM release $TAG ($PKG_NAME) ==="

fail() { echo "✗ $1" >&2; exit 1; }

# ---------------------------------------------------------------------------
# Preflight — refuse to release from an inconsistent state
# ---------------------------------------------------------------------------
echo "[preflight] validating repository state..."

[ "$VERSION" = "$PKG_VERSION" ] || \
  fail "requested $VERSION but package.json is $PKG_VERSION — bump + commit first."

BRANCH=$(git rev-parse --abbrev-ref HEAD)
[ "$BRANCH" = "main" ] || fail "on branch '$BRANCH', expected 'main'."

# No uncommitted TRACKED changes (untracked files are fine — dist/, etc.)
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  git status --short >&2
  fail "working tree has uncommitted tracked changes — commit or stash first."
fi

# Guard the concurrent multi-device release race: never release while behind,
# never tag commits the remote has not seen.
git fetch origin --tags --quiet || fail "git fetch failed."
BEHIND=$(git rev-list --count "HEAD..origin/main")
AHEAD=$(git rev-list --count "origin/main..HEAD")
[ "$BEHIND" = "0" ] || fail "local is $BEHIND commit(s) behind origin/main — pull/rebase first."
[ "$AHEAD" = "0" ] || fail "local is $AHEAD commit(s) ahead of origin/main — push your source first."

echo "  ✓ on main · clean · in sync with origin · version $VERSION"

# ---------------------------------------------------------------------------
# 1. Skill assets + frontend
# ---------------------------------------------------------------------------
echo "[1/6] Regenerating skill assets + building frontend..."
bun run generate:skill || fail "generate:skill failed."
bun run build:web      || fail "build:web failed."

# Skill assets are generated artifacts kept in git (mirrors the published pkg).
# Commit + push them if regeneration changed anything, so the tag we cut below
# matches exactly what npm ships.
if [ -n "$(git status --porcelain assets/skills)" ]; then
  echo "  -> skill assets changed — committing"
  git add assets/skills
  git commit -q -m "chore: regenerate skill assets for $TAG"
  git push origin main || fail "pushing skill-asset commit failed (remote moved?)."
fi

# ---------------------------------------------------------------------------
# 2. npm publish (idempotent)
# ---------------------------------------------------------------------------
echo "[2/6] Publishing to npm..."
PUBLISHED=$(npm view "${PKG_NAME}@${VERSION}" version 2>/dev/null || true)
if [ "$PUBLISHED" = "$VERSION" ]; then
  echo "  -> ${PKG_NAME}@${VERSION} already published — skipping"
else
  # generate:skill + build:web already ran above; --ignore-scripts avoids a
  # redundant second frontend build via prepublishOnly.
  npm publish --access public --ignore-scripts || fail "npm publish failed."
  echo "  -> published ${PKG_NAME}@${VERSION}"
fi

# ---------------------------------------------------------------------------
# 3. Compile binaries (reuse dist/web from step 1)
# ---------------------------------------------------------------------------
echo "[3/6] Compiling binaries..."
mkdir -p dist
TARGETS=(
  "bun-darwin-arm64:ppm-darwin-arm64"
  "bun-darwin-x64-baseline:ppm-darwin-x64"
  "bun-linux-x64-baseline:ppm-linux-x64"
  "bun-linux-arm64:ppm-linux-arm64"
  "bun-windows-x64-baseline:ppm-windows-x64.exe"
)
for entry in "${TARGETS[@]}"; do
  target="${entry%%:*}"; artifact="${entry##*:}"
  echo "  -> $artifact ($target)"
  bun build src/index.ts --compile --target="$target" --outfile="dist/$artifact" \
    || fail "compile failed for $target."
done

# ---------------------------------------------------------------------------
# 4. Package binaries with web assets
# ---------------------------------------------------------------------------
echo "[4/6] Packaging..."
rm -f dist/ppm-*.tar.gz dist/ppm-*.zip
for entry in "${TARGETS[@]}"; do
  artifact="${entry##*:}"
  if [[ "$artifact" == *.exe ]]; then
    name="${artifact%.exe}"
    mkdir -p "dist/$name"
    cp "dist/$artifact" "dist/$name/ppm.exe"
    cp -r dist/web "dist/$name/web"
    (cd dist && zip -qr "${name}.zip" "$name") || fail "zip failed for $name."
    rm -rf "dist/$name"
    echo "  -> ${name}.zip"
  else
    mkdir -p "dist/$artifact-pkg"
    cp "dist/$artifact" "dist/$artifact-pkg/ppm"
    cp -r dist/web "dist/$artifact-pkg/web"
    tar -czf "dist/${artifact}.tar.gz" -C "dist/$artifact-pkg" . || fail "tar failed for $artifact."
    rm -rf "dist/$artifact-pkg"
    echo "  -> ${artifact}.tar.gz"
  fi
done

# ---------------------------------------------------------------------------
# 5. Tag
# ---------------------------------------------------------------------------
echo "[5/6] Tagging $TAG..."
if git rev-parse "$TAG" >/dev/null 2>&1; then
  echo "  -> tag exists locally"
else
  git tag "$TAG" || fail "git tag failed."
fi
git push origin "$TAG" || fail "pushing tag failed."

# ---------------------------------------------------------------------------
# 6. GitHub release + upload archives
# ---------------------------------------------------------------------------
echo "[6/6] Uploading binaries to GitHub release..."
ARCHIVES=(dist/ppm-*.tar.gz dist/ppm-*.zip)
if gh release view "$TAG" >/dev/null 2>&1; then
  gh release upload "$TAG" "${ARCHIVES[@]}" --clobber || fail "gh release upload failed."
else
  gh release create "$TAG" "${ARCHIVES[@]}" --title "$TAG" --generate-notes \
    || fail "gh release create failed."
fi

REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null || echo "$REPO_DEFAULT")
echo ""
echo "=== Done: $TAG ==="
echo "  npm:    https://www.npmjs.com/package/${PKG_NAME}/v/${VERSION}"
echo "  github: https://github.com/${REPO}/releases/tag/${TAG}"
