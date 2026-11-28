#!/bin/sh
# Starts the fake Telegram and the Assistant fixture with its Telegram bridge, and reports whether
# the fixture became ready (used to tell a fixture-start failure on one Bun from a branch's own).
set -u
T=$(mktemp -d)
mkdir -p "$T/ppm" "$T/home"
bun tests/e2e/fixtures/fake-telegram-server.ts >"$T/ft.log" 2>&1 &
FT=$!
i=0; while [ $i -lt 40 ] && ! grep -q FAKE_TELEGRAM "$T/ft.log"; do sleep 0.3; i=$((i+1)); done
INFO=$(grep -o 'FAKE_TELEGRAM {.*}' "$T/ft.log" | sed 's/^FAKE_TELEGRAM //')
API=$(echo "$INFO" | sed 's/.*"api":"\([^"]*\)".*/\1/')
TOKEN=$(echo "$INFO" | sed 's/.*"token":"\([^"]*\)".*/\1/')
PPM_HOME="$T/ppm" HOME="$T/home" USERPROFILE="$T/home" PPM_HTML_TEST_REAL_HOME=/root PPM_HTML_TEST_PORT=48773 \
  PPM_ASSISTANT_WEB_DIR="${WEB_DIR:-/web}" PPM_ASSISTANT_FIXTURE_STATE="$T/state.json" PPM_ASSISTANT_MANAGER_LOOP=1 \
  PPM_ASSISTANT_APPROVAL_TIMEOUT_MS=180000 PPM_ASSISTANT_FAKE_TELEGRAM=1 PPM_TELEGRAM_API_BASE="$API" \
  PPM_ASSISTANT_FAKE_TELEGRAM_TOKEN="$TOKEN" PPM_ASSISTANT_FAKE_TELEGRAM_CHATS='[["1001","1001","Phone"]]' \
  bun tests/e2e/fixtures/assistant-server.ts >"$T/fx.log" 2>&1 &
FX=$!
i=0; while [ $i -lt 80 ]; do
  if grep -q "Assistant fixture ready" "$T/fx.log"; then echo "FIXTURE READY"; break; fi
  if ! kill -0 $FX 2>/dev/null; then echo "FIXTURE EXITED"; tail -8 "$T/fx.log"; break; fi
  sleep 0.5; i=$((i+1))
done
kill $FX $FT 2>/dev/null
