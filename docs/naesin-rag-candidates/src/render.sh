#!/bin/zsh
# usage: render.sh in.html out.png WIDTH HEIGHT   (2x device scale)
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
"$CHROME" --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=2 \
  --window-size=$3,$4 --screenshot="$2" "file://$1" 2>&1 | grep -v -i allocator
