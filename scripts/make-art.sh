#!/usr/bin/env bash
#
# Renders the AMO screenshot set — docs/store/amo/*.png — from the staged HTML
# in docs/store/. Both stages link the extension's own CSS, so a change to the
# product shows up in the pictures the next time this runs; that is the whole
# reason they are HTML and not a drawing.
#
# It does NOT touch docs/store/screenshot-1280x800.png. That one is the Chrome
# Web Store's, which wants exactly 1280×800, and the split between the two
# directories is what stops either store being sent the other's art.
#
# Chrome headless is the whole toolchain. Two traps, both paid for in the
# sibling repo before they were paid for here:
#
#   --user-data-dir hangs. Chrome writes the PNG correctly and then never
#   exits, so a run that looks fine locally sits until the job times out. Do
#   not add it, not even to keep a profile out of the way.
#
#   The stages are fixed-size: a window bigger than the stage adds background
#   rather than content. For 2x, keep the 1x window size and pass
#   --force-device-scale-factor=2; doubling the window letterboxes instead.
#
# Usage: npm run art   (CHROME=/path/to/chrome overrides the binary)

set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
CHROME=${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}
[ -x "$CHROME" ] || {
  echo "make-art: no Chrome at $CHROME (set CHROME=...)" >&2
  exit 1
}

# Both stages show the extension's icon, and src/icons/ is generated and
# gitignored — on a fresh clone the pictures would render with a broken image
# where the logo goes, and nothing would say so.
[ -f "$ROOT/src/icons/icon-128.png" ] || {
  echo 'make-art: src/icons/icon-128.png is missing — run `npm run icons` first' >&2
  exit 1
}

# Chrome's screenshot size is version-specific — scale factors and window
# insets have both moved between releases. Assert it every time: an asset that
# is quietly the wrong size is worse than a build that stops.
assert_size() {
  local file=$1 want_w=$2 want_h=$3 got
  [ -f "$file" ] || {
    echo "make-art: $file was never written — Chrome exited without a screenshot" >&2
    exit 1
  }
  got=$(sips -g pixelWidth -g pixelHeight "$file" | awk '/pixel(Width|Height)/ {print $2}' | paste -sd x -)
  if [ "$got" != "${want_w}x${want_h}" ]; then
    echo "make-art: $file is ${got}, expected ${want_w}x${want_h}" >&2
    exit 1
  fi
  echo "  $(basename "$file")  ${got}  $(wc -c <"$file" | tr -d ' ') bytes"
}

# $1 out, $2 stage file, rest: extra flags.
capture() {
  local out=$1 stage=$2
  shift 2
  "$CHROME" --headless=new --disable-gpu --hide-scrollbars --no-first-run \
    --window-size=1280,800 --screenshot="$out" "$@" "file://$ROOT/docs/store/$stage" >/dev/null 2>&1
}

mkdir -p "$ROOT/docs/store/amo"

# 2x, because AMO stores a preview at up to 2400×1800 and never upscales: at 1x
# the gallery would serve a 1280-wide picture to a hi-dpi screen. 2560×1600 is
# downscaled to 2400×1500 on upload and still fills the 1.6:1 card exactly.
echo 'make-art: AMO screenshots (docs/store/amo/)'
capture "$ROOT/docs/store/amo/01-launcher.png" screenshot.html --force-device-scale-factor=2
assert_size "$ROOT/docs/store/amo/01-launcher.png" 2560 1600
capture "$ROOT/docs/store/amo/02-manage.png" manage-shot.html --force-device-scale-factor=2
assert_size "$ROOT/docs/store/amo/02-manage.png" 2560 1600
