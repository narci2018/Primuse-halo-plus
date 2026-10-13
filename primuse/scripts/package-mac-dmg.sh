#!/usr/bin/env bash
#
# Package the macOS build product into a distributable DMG/ZIP.
#
# Usage:
#   scripts/package-mac-dmg.sh <path-to-Primuse.app> <output-basename> [flags]
#
# Flags (all via environment, so CI can pass secrets without leaking them):
#   PRIMUSE_MAC_SIGN_IDENTITY   codesign identity. Default "-" = ad-hoc.
#                               Set to "Developer ID Application: ..." once a
#                               paid account exists.
#   PRIMUSE_MAC_ENTITLEMENTS    Path to an entitlements file. ONLY honoured when
#                               a real identity is supplied (see below).
#   PRIMUSE_MAC_PROVISIONING    .mobileprovision/.provisioningprofile to embed.
#   PRIMUSE_MAC_NOTARIZE        "1" to run notarytool + stapler (needs the three
#                               APPLE_* secrets in the CI workflow).
#
# Why ad-hoc signs WITHOUT entitlements:
#   Config/PrimuseMac.entitlements asks for iCloud containers / CloudKit, App
#   Groups and keychain-access-groups. Those are restricted entitlements: the
#   loader refuses to start the binary unless they are backed by a provisioning
#   profile issued to a team. An ad-hoc signature cannot carry them, so bundling
#   them into a free-distribution build turns a working app into one that dies
#   with "Code Signature Invalid" before any UI appears. Ad-hoc + no entitlements
#   launches fine; CloudKit sync, widgets and App Group sharing simply stay
#   inactive, which is the intended trade-off for unsigned distribution.
#
# Why every nested Mach-O is signed before the app bundle:
#   On arm64 macOS the system kills any process whose loaded Mach-O lacks a valid
#   signature. FFmpeg dylibs, SFBAudioEngine and the widget extension are loaded
#   after the main bundle, so --deep is not enough (and is deprecated anyway):
#   we sign innermost first, then the container.
set -euo pipefail

APP_PATH="${1:-}"
OUT_BASE="${2:-Primuse}"
if [[ -z "$APP_PATH" || ! -d "$APP_PATH" ]]; then
  echo "usage: $0 <path/to/Primuse.app> <output-basename>" >&2
  exit 2
fi

IDENTITY="${PRIMUSE_MAC_SIGN_IDENTITY:--}"
ENTITLEMENTS="${PRIMUSE_MAC_ENTITLEMENTS:-}"
PROVISIONING="${PRIMUSE_MAC_PROVISIONING:-}"
NOTARIZE="${PRIMUSE_MAC_NOTARIZE:-0}"
SIGN_ARGS=(--force)
if [[ "$IDENTITY" != "-" ]]; then
  SIGN_ARGS+=(--timestamp --options runtime)
  if [[ -n "$ENTITLEMENTS" && -f "$ENTITLEMENTS" ]]; then
    SIGN_ARGS+=(--entitlements "$ENTITLEMENTS")
    echo "==> signing with identity '$IDENTITY' and entitlements $ENTITLEMENTS"
  else
    echo "==> signing with identity '$IDENTITY' (no entitlements file supplied)"
  fi
else
  echo "==> ad-hoc signing (identity '-'); entitlements intentionally omitted"
  if [[ -n "$ENTITLEMENTS" ]]; then
    echo "    note: ignoring PRIMUSE_MAC_ENTITLEMENTS=$ENTITLEMENTS — restricted"
    echo "    entitlements cannot be carried by an ad-hoc signature."
  fi
fi

CONTENTS="$APP_PATH/Contents"
[[ -d "$CONTENTS" ]] || { echo "not a macOS bundle: $APP_PATH" >&2; exit 1; }

# 1. provisioning profile, when a real identity is in play
if [[ -n "$PROVISIONING" && -f "$PROVISIONING" ]]; then
  mkdir -p "$CONTENTS/Embedded.provisionprofile" 2>/dev/null || true
  cp "$PROVISIONING" "$CONTENTS/embedded.provisionprofile"
  echo "==> embedded provisioning profile"
fi

# 2. sign from the inside out: dylibs -> frameworks -> helpers -> appex -> bundle
sign_all() {
  local root="$1"
  [[ -d "$root" ]] || return 0
  # bare dylibs and versioned frameworks' binaries
  while IFS= read -r -d '' item; do
    codesign "${SIGN_ARGS[@]}" --sign "$IDENTITY" "$item"
  done < <(find "$root" -type f \( -name '*.dylib' -o -name '*.so' \) -print0)
  # frameworks, deepest first so an outer bundle never signs before its payload
  while IFS= read -r -d '' item; do
    codesign "${SIGN_ARGS[@]}" --sign "$IDENTITY" "$item" 2>/dev/null || true
  done < <(find "$root" -depth -type d -name '*.framework' -print0)
  # XPC services / login helpers / app extensions
  while IFS= read -r -d '' item; do
    codesign "${SIGN_ARGS[@]}" --sign "$IDENTITY" "$item"
  done < <(find "$root" -type d \( -name '*.xpc' -o -name '*.appex' -o -name '*.helper' \) -print0)
}

sign_all "$CONTENTS/Frameworks"
sign_all "$CONTENTS/PlugIns"
sign_all "$CONTENTS/XPCServices"
sign_all "$CONTENTS/Helpers"
codesign "${SIGN_ARGS[@]}" --sign "$IDENTITY" "$APP_PATH"

echo "==> verifying signature"
codesign --verify --verbose=2 "$APP_PATH"
codesign -dv --verbose=4 "$APP_PATH" 2>&1 | grep -E "^(Identifier|CodeDirectory|TeamIdentifier|Signature|Format)" || true
echo "==> architectures present"
lipo -archs "$CONTENTS/MacOS/"* 2>/dev/null || true
find "$CONTENTS/Frameworks" -name '*.dylib' -maxdepth 2 -exec sh -c 'echo "$(basename "$1"): $(lipo -archs "$1")"' _ {} \; 2>/dev/null || true

# 3. DMG with a drop-to-Applications symlink
STAGE="$(mktemp -d)"
cp -R "$APP_PATH" "$STAGE/"
ln -s /Applications "$STAGE/Applications"
DMG="${OUT_BASE}.dmg"
hdiutil create -quiet -volname "$(basename "$APP_PATH" .app)" -srcfolder "$STAGE" \
  -ov -format UDZO "$DMG"
ZIP="${OUT_BASE}.zip"
ditto -c -k --keepParent "$APP_PATH" "$ZIP"
rm -rf "$STAGE"
echo "==> wrote $DMG ($(du -h "$DMG" | cut -f1)) and $ZIP ($(du -h "$ZIP" | cut -f1))"

# 4. optional notarization (no-op for ad-hoc builds; Gatekeeper still blocks them)
if [[ "$NOTARIZE" == "1" && "$IDENTITY" != "-" ]]; then
  xcrun notarytool submit "$DMG" \
    --apple-id "${APPLE_ID:?}" --team-id "${APPLE_TEAM_ID:?}" \
    --password "${APPLE_APP_PASSWORD:?}" --wait
  xcrun stapler staple "$DMG"
  xcrun stapler validate "$DMG"
  echo "==> notarized and stapled $DMG"
elif [[ "$NOTARIZE" == "1" ]]; then
  echo "==> skipping notarization: ad-hoc signature cannot be notarized" >&2
fi
