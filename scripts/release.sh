#!/usr/bin/env bash
# Builds a zMail release for Apple silicon: the signed .app, a DMG made with create-dmg, the
# updater's .app.tar.gz and .sig, and the latest.json the in-app updater reads. Everything lands
# in release/. With --publish it also creates the GitHub release; otherwise it prints the command.
#
# Signing: APPLE_SIGNING_IDENTITY picks the certificate (my Developer ID by default, ad hoc with
# --adhoc). NOTARY_PROFILE names an `xcrun notarytool store-credentials` profile ("notary" by
# default); with a Developer ID it notarizes the DMG.
# The updater's private key and its password are read from the Keychain for the build only.
set -euo pipefail

DEFAULT_IDENTITY="Developer ID Application: Zachary Rossmiller (V2P99VF75Q)"
# Only this team's certificates sign releases; anything else in the keychain is refused.
TEAM_ID="V2P99VF75Q"
DEFAULT_NOTARY_PROFILE="notary"
TARGET="aarch64-apple-darwin"
PLATFORM="darwin-aarch64"
REPO_URL="https://github.com/umzcio/zMail"
KEYCHAIN_SERVICE="com.zach.zmail.updater"
MAX_NOTES_BYTES=20000

usage() {
  cat <<'EOF'
Usage: scripts/release.sh [options]   (or: pnpm release -- [options])

Builds zMail for Apple silicon and writes release/: the DMG, the updater's
zMail_<version>_aarch64.app.tar.gz and .sig, and latest.json.

Options:
  --notes <text>        Release notes, shown in zMail when it offers the update.
  --notes-file <path>   Read the release notes from a file instead.
  --publish             Create the GitHub release v<version> and upload everything
                        (needs gh, signed in). Without it, the command is printed.
  --skip-jenkins        Passed to create-dmg: skip the Finder step that lays out the
                        DMG window (it opens Finder windows). The DMG still works.
  --adhoc               Sign ad hoc and skip notarization, for a quick local build.
                        It only opens without warnings on this Mac.
  -h, --help            Show this help.

Environment:
  APPLE_SIGNING_IDENTITY  Signing certificate. Default:
                          "Developer ID Application: Zachary Rossmiller (V2P99VF75Q)".
  NOTARY_PROFILE          A notarytool keychain profile (default "notary"). With a
                          Developer ID identity, the DMG is notarized and stapled;
                          set it empty (NOTARY_PROFILE=) to skip that.

The version comes from src-tauri/tauri.conf.json; package.json and
src-tauri/Cargo.toml must match it.
EOF
}

die() {
  echo "release: $*" >&2
  exit 1
}
step() { echo "==> $*"; }

notes=""
notes_file=""
publish=0
skip_jenkins=0
adhoc=0
while (($#)); do
  case "$1" in
    --notes)
      (($# >= 2)) || die "--notes needs text"
      notes="$2"
      shift 2
      ;;
    --notes-file)
      (($# >= 2)) || die "--notes-file needs a path"
      notes_file="$2"
      shift 2
      ;;
    --publish) publish=1; shift ;;
    --skip-jenkins) skip_jenkins=1; shift ;;
    --adhoc) adhoc=1; shift ;;
    -h | --help) usage; exit 0 ;;
    --) shift ;;
    *) usage >&2; die "unknown option: $1" ;;
  esac
done

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

# ---- Checks ------------------------------------------------------------------

if [[ -n $notes && -n $notes_file ]]; then die "use --notes or --notes-file, not both"; fi
if [[ -n $notes_file ]]; then
  [[ -f $notes_file ]] || die "no such notes file: $notes_file"
  notes="$(cat "$notes_file")"
fi
if ((${#notes} > MAX_NOTES_BYTES)); then die "release notes are over $MAX_NOTES_BYTES characters"; fi
if ((publish)) && [[ -z ${notes//[[:space:]]/} ]]; then die "--publish needs --notes or --notes-file"; fi

for tool in git node pnpm codesign xcrun ditto; do
  command -v "$tool" >/dev/null || die "$tool is missing"
done
create_dmg="$(command -v create-dmg || true)"
[[ -n $create_dmg ]] || die "create-dmg is missing (brew install create-dmg)"
if ((publish)); then command -v gh >/dev/null || die "--publish needs the GitHub CLI (brew install gh)"; fi
if command -v rustup >/dev/null && ! rustup target list --installed | grep -qx "$TARGET"; then
  die "the Rust target $TARGET isn't installed (rustup target add $TARGET)"
fi

[[ -z "$(git status --porcelain --untracked-files=no)" ]] || die "commit or stash your changes first (the tree has modified tracked files)"

version="$(node -p 'require("./src-tauri/tauri.conf.json").version')"
pkg_version="$(node -p 'require("./package.json").version')"
cargo_version="$(sed -n 's/^version = "\(.*\)"$/\1/p' src-tauri/Cargo.toml | head -n 1)"
[[ $version =~ ^[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.-]+)?$ ]] || die "tauri.conf.json has an odd version: $version"
[[ $pkg_version == "$version" ]] || die "package.json is $pkg_version but tauri.conf.json is $version"
[[ $cargo_version == "$version" ]] || die "src-tauri/Cargo.toml is $cargo_version but tauri.conf.json is $version"
tag="v$version"
if ((publish)) && gh release view "$tag" >/dev/null 2>&1; then die "the GitHub release $tag already exists"; fi

# ---- Signing identity ----------------------------------------------------------

identity="${APPLE_SIGNING_IDENTITY:-$DEFAULT_IDENTITY}"
# Set but empty turns notarization off.
notary_profile="${NOTARY_PROFILE-$DEFAULT_NOTARY_PROFILE}"
((adhoc)) && identity="-"
if ((publish)) && [[ $identity == "-" ]]; then die "an ad hoc build can't be published; drop --adhoc"; fi
developer_id=0
if [[ $identity == "-" ]]; then
  echo "Signing ad hoc: this build will only open without warnings on this Mac."
else
  # The identity may be a name or a hash; look at the certificate it names.
  match="$(security find-identity -v -p codesigning | grep -F "$identity" || true)"
  [[ -n $match ]] || die "no valid signing identity matches \"$identity\""
  (($(grep -c . <<<"$match") == 1)) || die "\"$identity\" matches more than one signing identity; use the full name"
  if [[ $match != *"($TEAM_ID)\""* ]]; then
    die "refusing to sign with a certificate from outside team $TEAM_ID: ${match#*\"}"
  fi
  [[ $match == *"Developer ID Application:"* ]] && developer_id=1
  echo "Signing with: ${match#*\"}" | sed 's/"$//'
fi

# ---- Build ---------------------------------------------------------------------

# Read here and passed only to the build; never echoed or written anywhere.
updater_key="$(security find-generic-password -s "$KEYCHAIN_SERVICE" -a private-key -w 2>/dev/null)" ||
  die "the updater's private key isn't in the Keychain (service $KEYCHAIN_SERVICE, account private-key)"
updater_password="$(security find-generic-password -s "$KEYCHAIN_SERVICE" -a password -w 2>/dev/null)" ||
  die "the updater key's password isn't in the Keychain (service $KEYCHAIN_SERVICE, account password)"

bundle_dir="src-tauri/target/$TARGET/release/bundle/macos"
# A stale bundle must never be shipped by mistake.
rm -rf "$bundle_dir"

step "Building zMail $version for $TARGET"
# Tauri notarizes the .app itself when it sees Apple credentials in the environment; here only
# the DMG is notarized, through NOTARY_PROFILE, so those are left out of the build.
# (A subshell, not `env`, so the key never shows up in a process's arguments.)
(
  unset APPLE_ID APPLE_PASSWORD APPLE_TEAM_ID APPLE_API_KEY APPLE_API_KEY_ID APPLE_API_ISSUER APPLE_API_KEY_PATH
  export APPLE_SIGNING_IDENTITY="$identity"
  export TAURI_SIGNING_PRIVATE_KEY="$updater_key"
  export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="$updater_password"
  pnpm tauri build --bundles app --target "$TARGET"
)
unset updater_key updater_password

app="$bundle_dir/zMail.app"
tarball="$bundle_dir/zMail.app.tar.gz"
[[ -d $app ]] || die "the build made no $app"
[[ -f $tarball && -s "$tarball.sig" ]] || die "the build made no updater bundle ($tarball and .sig); is bundle.createUpdaterArtifacts on?"
codesign --verify --deep --strict "$app" || die "the app's signature doesn't verify"

# ---- DMG -----------------------------------------------------------------------

rm -rf release
mkdir -p release
dmg="release/zMail_${version}_aarch64.dmg"
stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT
ditto "$app" "$stage/zMail.app"

step "Making $dmg"
dmg_args=(
  --volname "zMail"
  --volicon "src-tauri/icons/icon.icns"
  --window-pos 200 120
  --window-size 640 470
  --background "scripts/dmg/background.tiff"
  --icon-size 128
  --icon "zMail.app" 180 188
  --hide-extension "zMail.app"
  --app-drop-link 460 188
  --no-internet-enable
  --hdiutil-quiet
)
((skip_jenkins)) && dmg_args+=(--skip-jenkins)
"$create_dmg" "${dmg_args[@]}" "$dmg" "$stage"
[[ -f $dmg ]] || die "create-dmg made no $dmg"

if [[ $identity != "-" ]]; then
  codesign --force --timestamp --sign "$identity" "$dmg"
fi

if ((developer_id)) && [[ -n $notary_profile ]]; then
  step "Notarizing $dmg with the \"$notary_profile\" profile (this waits for Apple)"
  result="$(xcrun notarytool submit "$dmg" --keychain-profile "$notary_profile" --wait --output-format json)" ||
    die "notarytool couldn't submit the DMG (is \"$notary_profile\" a notarytool keychain profile?)"
  status="$(node -e 'const r = JSON.parse(process.argv[1]); process.stdout.write(`${r.status ?? ""} ${r.id ?? ""}`)' "$result")"
  if [[ ${status%% *} != "Accepted" ]]; then
    die "notarization ended as \"${status%% *}\"; see: xcrun notarytool log ${status#* } --keychain-profile \"$notary_profile\""
  fi
  # The ticket also covers the app inside, so the update bundle's identical app is known to Gatekeeper.
  xcrun stapler staple "$dmg"
  xcrun stapler validate "$dmg"
elif ((developer_id)); then
  echo "Skipping notarization: NOTARY_PROFILE is set but empty."
else
  echo "Skipping notarization: it needs a Developer ID Application identity."
fi

# ---- Updater artifacts ---------------------------------------------------------

update_name="zMail_${version}_aarch64.app.tar.gz"
cp "$tarball" "release/$update_name"
cp "$tarball.sig" "release/$update_name.sig"

step "Writing release/latest.json"
VERSION="$version" NOTES="$notes" PLATFORM="$PLATFORM" \
  PUB_DATE="$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  SIGNATURE="$(tr -d '\r\n' <"release/$update_name.sig")" \
  URL="$REPO_URL/releases/download/$tag/$update_name" \
  node -e '
    const e = process.env;
    if (!e.SIGNATURE) throw new Error("empty signature");
    const manifest = {
      version: e.VERSION,
      notes: e.NOTES,
      pub_date: e.PUB_DATE,
      platforms: { [e.PLATFORM]: { signature: e.SIGNATURE, url: e.URL } },
    };
    process.stdout.write(JSON.stringify(manifest, null, 2) + "\n");
  ' >release/latest.json
node -e 'JSON.parse(require("fs").readFileSync("release/latest.json", "utf8"))' || die "release/latest.json isn't valid JSON"

step "Done"
ls -lh release

# ---- Publish ---------------------------------------------------------------------

gh_cmd=(gh release create "$tag" "$dmg" "release/$update_name" "release/$update_name.sig" release/latest.json
  --target "$(git rev-parse HEAD)" --title "zMail $version")
if [[ -n $notes_file ]]; then gh_cmd+=(--notes-file "$notes_file"); else gh_cmd+=(--notes "$notes"); fi

if ((publish)); then
  step "Publishing $tag"
  "${gh_cmd[@]}"
else
  echo
  echo "Not published. To publish (the commit must be pushed first):"
  printf '  '
  printf '%q ' "${gh_cmd[@]}"
  echo
fi
