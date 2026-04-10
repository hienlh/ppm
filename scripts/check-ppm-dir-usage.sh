#!/bin/bash
# Fail if any service file uses hardcoded homedir + .ppm (should use getPpmDir())
# Allowed exceptions: ppm-dir.ts itself, autostart, ppmbot, fs-browse, git-dirs, claude-usage, slash-discovery

VIOLATIONS=$(grep -rn -E '(resolve|join)\(homedir\(\).*\.ppm' src/ \
  --include='*.ts' \
  | grep -v 'ppm-dir.ts' \
  | grep -v 'autostart-' \
  | grep -v 'ppmbot/' \
  | grep -v 'bot-cmd' \
  | grep -v 'claude-usage' \
  | grep -v 'fs-browse' \
  | grep -v 'git-dirs' \
  | grep -v 'discover-skill-roots')

if [ -n "$VIOLATIONS" ]; then
  echo "ERROR: Direct homedir() + .ppm usage found. Use getPpmDir() from src/services/ppm-dir.ts instead:"
  echo "$VIOLATIONS"
  exit 1
fi
echo "OK: All services use getPpmDir()"
