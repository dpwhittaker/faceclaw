#!/usr/bin/env bash
# Copy the Bible app's database (built by build_bible_db.py) to the phone,
# into Faceclaw's external files directory, where the app looks for it.
#
#   scripts/bible/push_bible_db.sh [path/to/bible.sqlite]
#
# Uses DEVICE_ID from build_paths.sh. The copy lands under a temporary name
# and is renamed into place, so a half-finished push never replaces a good
# database. Faceclaw keeps an open database until it restarts, so force-stop
# it afterwards to read the new one.
set -euo pipefail
cd "$(dirname "$0")/../.."
# shellcheck disable=SC1091
source ./build_paths.sh
DB="${1:-${FACECLAW_BIBLE_CACHE:-$HOME/.cache/faceclaw-bible}/bible.sqlite}"
DEST=/sdcard/Android/data/com.faceclaw.app/files/bible
if [ -z "${DEVICE_ID:-}" ]; then
  echo "No phone found (DEVICE_ID is empty); is wireless debugging on?" >&2
  exit 1
fi
[ -f "$DB" ] || { echo "No database at $DB; run scripts/bible/build_bible_db.py first." >&2; exit 1; }
adb -s "$DEVICE_ID" shell mkdir -p "$DEST"
adb -s "$DEVICE_ID" push "$DB" "$DEST/bible.sqlite.part"
adb -s "$DEVICE_ID" shell mv "$DEST/bible.sqlite.part" "$DEST/bible.sqlite"
echo "Pushed $(du -h "$DB" | cut -f1) to $DEST/bible.sqlite"
