#!/bin/sh
# Compiles the Icon Composer icon (src-tauri/icons/zMail.icon) into the
# Assets.car that macOS uses for the Liquid Glass app icon. Run after editing
# the icon: pnpm icon
#
# Tauri can compile .icon files itself, but its actool call fails here
# ("Bad file descriptor"), so we compile it ourselves and Tauri bundles the
# Assets.car as-is.
set -e
cd "$(dirname "$0")/../src-tauri/icons"
out="$(mktemp -d)"
trap 'rm -rf "$out"' EXIT
actool zMail.icon --compile "$out" \
  --output-format human-readable-text --errors \
  --output-partial-info-plist "$out/partial.plist" \
  --app-icon zMail --include-all-app-icons \
  --enable-on-demand-resources NO --development-region en \
  --target-device mac --minimum-deployment-target 26.0 --platform macosx </dev/null
test -f "$out/Assets.car" || { echo "actool did not produce Assets.car" >&2; exit 1; }
cp "$out/Assets.car" Assets.car
echo "Wrote src-tauri/icons/Assets.car"
