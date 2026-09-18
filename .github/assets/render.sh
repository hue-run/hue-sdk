#!/usr/bin/env sh
# Regenerate the README header wordmark PNGs from hue-ascii.html.
# Run from the repository root:  sh .github/assets/render.sh
#
# The art in hue-ascii.html is byte-identical to the <details> fold at the foot of
# README.md. Edit neither without the other.
#
# Sources are exported at 2x (1440x763) and displayed at width="720" in the README;
# GitHub strips srcset, so 2x-and-downscale is the only retina path available.
set -eu

OUT=.github/assets
PAGE="file://$(pwd)/$OUT/hue-ascii.html"
W=1440 H=763            # 2 x 720x381, measured via --dump-dom (see below)

# --disable-dev-shm-usage: /dev/shm is 64M in CI/sandbox containers and Chrome aborts without it.
# --default-background-color=00000000: yields a real alpha channel instead of compositing on white.
# Note: --force-device-scale-factor crashes Chrome 153 here; scale via font-size (?w=) instead.
FLAGS="--headless=new --no-sandbox --disable-gpu --disable-dev-shm-usage --hide-scrollbars
       --default-background-color=00000000 --virtual-time-budget=3000 --window-size=$W,$H"

# shellcheck disable=SC2086
for pair in light:1f2328 dark:e6edf3 neutral:7a828b; do
  name=${pair%%:*}; ink=${pair#*:}
  google-chrome $FLAGS --screenshot="$OUT/hue-ascii-$name.png" \
    "$PAGE?w=$W&ink=$ink&font=Source%20Code%20Pro"
  echo "wrote $OUT/hue-ascii-$name.png"
done

# To re-measure the exact box after any font/size change:
#   google-chrome --headless=new --no-sandbox --disable-gpu --disable-dev-shm-usage \
#     --dump-dom "$PAGE?w=1440" | grep -o 'data-w="[0-9]*" data-h="[0-9]*"'
