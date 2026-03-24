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

# Check if binary exists in release
URL="https://github.com/${REPO}/releases/download/${TAG}/${ARTIFACT}"
HTTP_CODE=$(curl -sL -o /dev/null -w "%{http_code}" "$URL")
if [ "$HTTP_CODE" != "200" ] && [ "$HTTP_CODE" != "302" ]; then
  echo "Binary not available for ${os}/${arch} in ${TAG} (HTTP ${HTTP_CODE})"
  echo "Try installing via: bunx @hienlh/ppm start"
  exit 1
fi

# Download binary
echo "Downloading ${ARTIFACT}..."
mkdir -p "$INSTALL_DIR"
curl -fSL# -o "${INSTALL_DIR}/ppm" "$URL"
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

# Add to PATH if not already there
PATH_LINE="export PATH=\"${INSTALL_DIR}:\$PATH\""
case ":$PATH:" in
  *":${INSTALL_DIR}:"*) ;;
  *)
    # Detect shell profile
    PROFILE=""
    if [ -n "$ZSH_VERSION" ] || [ "$(basename "$SHELL")" = "zsh" ]; then
      PROFILE="$HOME/.zshrc"
    elif [ -f "$HOME/.bashrc" ]; then
      PROFILE="$HOME/.bashrc"
    elif [ -f "$HOME/.bash_profile" ]; then
      PROFILE="$HOME/.bash_profile"
    elif [ -f "$HOME/.profile" ]; then
      PROFILE="$HOME/.profile"
    fi

    if [ -n "$PROFILE" ]; then
      if ! grep -q "${INSTALL_DIR}" "$PROFILE" 2>/dev/null; then
        echo "" >> "$PROFILE"
        echo "# PPM" >> "$PROFILE"
        echo "$PATH_LINE" >> "$PROFILE"
        echo "Added to PATH in ${PROFILE}"
        echo "Restart your terminal or run: source ${PROFILE}"
      fi
    else
      echo ""
      echo "Could not detect shell profile. Add manually:"
      echo "  ${PATH_LINE}"
    fi
    ;;
esac

# Next steps (fresh install only)
if [ -z "$CURRENT" ]; then
  echo ""
  echo "========== Getting Started =========="
  echo "1. Open a new terminal (or run: source ${PROFILE:-~/.bashrc})"
  echo "2. Run the setup wizard:"
  echo "     ppm init"
  echo "3. Start the server:"
  echo "     ppm start"
  echo "4. Open in browser:"
  echo "     ppm open"
  echo ""
  echo "For remote access (public URL via Cloudflare tunnel):"
  echo "     ppm start --share"
  echo ""
  echo "Docs: https://github.com/${REPO}#readme"
  echo "====================================="
fi
