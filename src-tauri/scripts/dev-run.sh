#!/bin/sh
# Dev builds only: sign with a stable identity so macOS Keychain "Always Allow"
# survives rebuilds (ad-hoc signatures change every build).
bin="$1"; shift
codesign --force --sign "${ZMAIL_DEV_SIGN_IDENTITY:-Apple Development}" \
  --identifier com.zach.zmail "$bin" >/dev/null 2>&1 \
  || echo "[dev-run] codesign failed; Keychain will ask again" >&2
exec "$bin" "$@"
