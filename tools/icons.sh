#!/bin/bash
# Regenerates every raster icon from the SVG sources.
set -euo pipefail
cd "$(dirname "$0")/.."

magick -background none app/icons/magpie.svg -resize 192x192 app/icons/icon-192.png
magick -background none app/icons/magpie.svg -resize 512x512 app/icons/icon-512.png

fg=tools/icon-fg.svg
res=android/app/src/main/res
magick -background none "$fg" -resize 108x108 "$res/mipmap-mdpi/ic_launcher_fg.png"
magick -background none "$fg" -resize 162x162 "$res/mipmap-hdpi/ic_launcher_fg.png"
magick -background none "$fg" -resize 216x216 "$res/mipmap-xhdpi/ic_launcher_fg.png"
magick -background none "$fg" -resize 324x324 "$res/mipmap-xxhdpi/ic_launcher_fg.png"
magick -background none "$fg" -resize 432x432 "$res/mipmap-xxxhdpi/ic_launcher_fg.png"

# iOS wants a full-bleed opaque square; the brand background fills the
# rounded corners invisibly and iOS applies its own mask.
magick -size 1024x1024 xc:'#17697a' \
  \( -background none app/icons/magpie.svg -resize 1024x1024 \) \
  -composite -alpha off ios/Assets.xcassets/AppIcon.appiconset/AppIcon1024.png
magick -background none app/icons/magpie.svg -resize 180x180 \
  -size 180x180 xc:'#17697a' +swap -composite -alpha off app/icons/apple-touch-icon.png
echo "icons regenerated"
