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

# Get latest release tag
echo "Fetching latest release..."
TAG=$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" | grep '"tag_name"' | cut -d'"' -f4)
if [ -z "$TAG" ]; then
  echo "Failed to fetch latest release"; exit 1
fi
echo "Latest version: $TAG"

# Download binary
URL="https://github.com/${REPO}/releases/download/${TAG}/${ARTIFACT}"
echo "Downloading ${ARTIFACT}..."
mkdir -p "$INSTALL_DIR"
curl -fsSL -o "${INSTALL_DIR}/ppm" "$URL"
chmod +x "${INSTALL_DIR}/ppm"

echo ""
echo "Installed ppm $TAG to ${INSTALL_DIR}/ppm"

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
