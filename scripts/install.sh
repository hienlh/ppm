#!/bin/sh
set -e

REPO="hienlh/ppm"
INSTALL_DIR="${PPM_INSTALL_DIR:-$HOME/.ppm/bin}"

# Detect OS
OS="$(uname -s)"
case "$OS" in
  Linux*)  os="linux" ;;
  Darwin*) os="darwin" ;;
  *)       echo "Unsupported OS: $OS"; exit 1 ;;
esac

# Detect architecture
ARCH="$(uname -m)"
case "$ARCH" in
  x86_64|amd64) arch="x64" ;;
  arm64|aarch64) arch="arm64" ;;
  *)             echo "Unsupported architecture: $ARCH"; exit 1 ;;
esac

ARTIFACT="ppm-${os}-${arch}"
echo "Detected: ${os}/${arch}"

# Check current version
CURRENT=""
if [ -x "${INSTALL_DIR}/ppm" ]; then
  CURRENT=$("${INSTALL_DIR}/ppm" --version 2>/dev/null || true)
fi

# Get latest release info
echo "Fetching latest release..."
RELEASE_JSON=$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest")
TAG=$(echo "$RELEASE_JSON" | grep '"tag_name"' | cut -d'"' -f4)
if [ -z "$TAG" ]; then
  echo "Failed to fetch latest release"; exit 1
fi
LATEST="${TAG#v}"

# Show install/upgrade info
if [ -n "$CURRENT" ]; then
  if [ "$CURRENT" = "$LATEST" ]; then
    echo "Already up to date: v${CURRENT}"
    exit 0
  fi
  echo "Upgrading: v${CURRENT} -> v${LATEST}"
else
  echo "Installing: v${LATEST}"
fi

# Download binary
URL="https://github.com/${REPO}/releases/download/${TAG}/${ARTIFACT}"
echo "Downloading ${ARTIFACT}..."
mkdir -p "$INSTALL_DIR"
curl -fsSL -o "${INSTALL_DIR}/ppm" "$URL"
chmod +x "${INSTALL_DIR}/ppm"

# Show changelog
echo ""
echo "========== Changelog =========="
CHANGELOG_URL="https://raw.githubusercontent.com/${REPO}/${TAG}/CHANGELOG.md"
CHANGELOG=$(curl -fsSL "$CHANGELOG_URL" 2>/dev/null || true)
if [ -n "$CHANGELOG" ]; then
  if [ -n "$CURRENT" ]; then
    # Upgrade: show entries between current and latest
    echo "$CHANGELOG" | awk -v cur="$CURRENT" '
      /^## \[/ {
        ver = $0; gsub(/.*\[/, "", ver); gsub(/\].*/, "", ver)
        if (ver == cur) exit
        printing = 1
      }
      printing { print }
    '
  else
    # Fresh install: show latest entry only
    echo "$CHANGELOG" | awk '
      /^## \[/ { count++; if (count > 1) exit }
      count == 1 { print }
    '
  fi
else
  echo "(changelog unavailable)"
fi
echo "================================"

echo ""
if [ -n "$CURRENT" ]; then
  echo "Upgraded ppm v${CURRENT} -> v${LATEST}"
else
  echo "Installed ppm v${LATEST} to ${INSTALL_DIR}/ppm"
fi

# Check if in PATH
case ":$PATH:" in
  *":${INSTALL_DIR}:"*) ;;
  *)
    echo ""
    echo "Add to your PATH by running:"
    echo "  export PATH=\"${INSTALL_DIR}:\$PATH\""
    echo ""
    echo "Or add it to your shell profile (~/.bashrc, ~/.zshrc, etc.):"
    echo "  echo 'export PATH=\"${INSTALL_DIR}:\$PATH\"' >> ~/.zshrc"
    ;;
esac
