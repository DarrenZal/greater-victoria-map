#!/bin/sh
# Rebuilds the pictures of two layers under "Change over time":
#   data/canopy-2013.png, canopy-2019.png, canopy-2023.png  (City of Victoria tree canopy from LiDAR)
#   data/forest-loss.png                                    (Hansen Global Forest Change v1.13, loss year)
#
# Developer machine only. The browser never calls these services. Run it once, check the result with
# `node scripts/check-demo.mjs`, and commit the pictures. Same style as scripts/fetch-time-layers.sh.
# Source, licence and processing: data/SOURCES.md. Data retrieved for the committed files: 2026-10-25.
#
# Needs: curl, node, and GDAL 3 with its Python (rasterio, numpy and Pillow), for example a conda
# environment (gdalwarp, gdal_calc.py, gdal_translate, gdalattachpct.py, gdaltransform, gdalinfo).
# zopflipng is optional and shrinks the PNGs by about 16%.
#
# Options (environment variables):
#   FETCH=0       skip the downloads and process the files already in $RAW_DIR (about 300 MB)
#   RAW_DIR=dir   where the downloads go (default raw/, not committed)
#   WORK_DIR=dir  scratch files (default $RAW_DIR/work)
#   GDAL_BIN=dir  folder with the GDAL programs and their python (default ~/miniconda3/envs/cascadiamap/bin)
#   ONLY=canopy   run only one part: canopy or loss
#   ZOPFLI=0      skip zopflipng
#   STATS=1       also print the value distribution of each canopy year
set -eu
cd "$(dirname "$0")/.."

RAW="${RAW_DIR:-raw}"
WORK="${WORK_DIR:-$RAW/work}"
OUT=data
FETCH="${FETCH:-1}"
ONLY="${ONLY:-}"
ZOPFLI="${ZOPFLI:-1}"
STATS="${STATS:-0}"
GDAL_BIN="${GDAL_BIN:-$HOME/miniconda3/envs/cascadiamap/bin}"
BOX_W=-123.75; BOX_S=48.28; BOX_E=-123.20; BOX_N=48.70    # the demo box
ARCGIS="https://www.arcgis.com/sharing/rest/content/items"
HANSEN="https://storage.googleapis.com/earthenginepartners-hansen/GFC-2025-v1.13"
HANSEN_TILE="Hansen_GFC-2025-v1.13_lossyear_50N_130W.tif"

# One grid for all three canopy years, in EPSG:3857 metres, snapped outward to multiples of 2. It is
# the union of the three rasters' extents (the 2013 one gives the west and north edges, the 2023
# one the east edge, the 2019 and 2023 ones the south edge). check_grid below tests that it still
# contains all three. 4023 x 4013 pixels, so each side is under 4096.
TE_W=-13736212; TE_S=6174120; TE_E=-13728166; TE_N=6182146
RES=2

PATH="$GDAL_BIN:$PATH"
export PATH
export PROJ_NETWORK=OFF    # no grid downloads, so the warp gives the same result on every machine

mkdir -p "$RAW" "$WORK" "$OUT"

want() { [ -z "$ONLY" ] || [ "$ONLY" = "$1" ]; }

gdalinfo --version | grep -q '^GDAL 3' || { echo "GDAL 3 not found in $GDAL_BIN (set GDAL_BIN)"; exit 1; }

# ---- City of Victoria tree canopy from LiDAR, 2013, 2019 and 2023 (OGL-City of Victoria)
# Each year is an ArcGIS item. /data answers 302 to a signed address, which curl follows. The
# signed address is never printed or stored. The file size is checked against the item's size.
fetch_canopy() {
  y="$1"; id="$2"
  curl -sS -m 60 "$ARCGIS/$id?f=json" -o "$RAW/canopy_item_$y.json" \
    -w "canopy $y item -> HTTP %{http_code}, %{size_download} bytes\n"
  curl -sS -L -m 900 "$ARCGIS/$id/data" -o "$RAW/canopy_$y.tif" \
    -w "canopy $y data -> HTTP %{http_code}, %{size_download} bytes\n"
  item_size=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).size)' "$RAW/canopy_item_$y.json")
  file_size=$(wc -c < "$RAW/canopy_$y.tif" | tr -d ' ')
  [ "$item_size" = "$file_size" ] || { echo "canopy $y: item says $item_size bytes, got $file_size"; exit 1; }
}

# The grid must contain the four corners of every year after the warp.
check_grid() {
  for y in 2013 2019 2023; do
    gdalinfo -json "$RAW/canopy_$y.tif" | node -e '
      let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
        const c = JSON.parse(s).cornerCoordinates
        for (const k of ["upperLeft", "upperRight", "lowerRight", "lowerLeft"]) console.log(c[k][0], c[k][1])
      })'
  done | gdaltransform -s_srs EPSG:26910 -t_srs EPSG:3857 -output_xy |
    awk -v w=$TE_W -v s=$TE_S -v e=$TE_E -v n=$TE_N \
      '$1 < w || $1 > e || $2 < s || $2 > n { bad = 1; print "outside the grid:", $1, $2 } END { exit bad }'
}

# One year: a mask of the pixels that have a value, averaged down to the common grid, kept where
# at least half of the pixel is set, written as a 1-bit paletted PNG (index 0 transparent, index 1
# #2e7d32).
#
# All three years are warped as EPSG:26910 (NAD83 / UTM 10N), although the 2023 file says
# NAD83(CSRS) / UTM 10N (EPSG:3157). PROJ puts the same UTM numbers 1.1 m further west and 0.6 m
# further north on the ground (1.7 m and 0.9 m in Web Mercator metres) than it does for EPSG:26910.
# The three files agree to well under a metre when their UTM numbers are compared directly
# (the round 3 raster notes), so declaring them alike keeps them aligned with each other. The offset from the
# basemap was not measured.
build_canopy_png() {
  y="$1"
  # Valid = not the no-data value (about 3.4e38 in 2013 and 2023, -9999 in 2019). The 2013 file has
  # two values below zero, so the test is on the no-data values, not on the sign.
  gdal_calc.py -A "$RAW/canopy_$y.tif" --outfile="$WORK/mask_$y.tif" \
    --calc="((A>-9000)*(A<1e30))*255" --type=Byte --hideNoData --NoDataValue=none \
    --format=GTiff --creation-option=COMPRESS=DEFLATE --creation-option=TILED=YES --overwrite --quiet
  gdalwarp -q -overwrite -s_srs EPSG:26910 -t_srs EPSG:3857 \
    -te $TE_W $TE_S $TE_E $TE_N -tr $RES $RES -r average -ot Byte -wo INIT_DEST=0 \
    -co COMPRESS=DEFLATE "$WORK/mask_$y.tif" "$WORK/avg_$y.tif"
  gdal_calc.py -A "$WORK/avg_$y.tif" --outfile="$WORK/set_$y.tif" --calc="(A>=128)*1" \
    --type=Byte --NoDataValue=none --creation-option=COMPRESS=DEFLATE --overwrite --quiet
  # The palette file gives the colours. Nodata 0 is what makes GDAL write the tRNS chunk.
  printf '0 0 0 0\n1 46 125 50\n' > "$WORK/palette.txt"
  rm -f "$WORK/pct_$y.tif"
  gdalattachpct.py "$WORK/palette.txt" "$WORK/set_$y.tif" "$WORK/pct_$y.tif"
  gdal_translate -q -of PNG -a_nodata 0 -co NBITS=1 -co ZLEVEL=9 "$WORK/pct_$y.tif" "$WORK/plain_$y.png"
  if [ "$ZOPFLI" = "1" ] && command -v zopflipng > /dev/null; then
    zopflipng -y --filters=0me "$WORK/plain_$y.png" "$OUT/canopy-$y.png" > /dev/null
  else
    cp "$WORK/plain_$y.png" "$OUT/canopy-$y.png"
  fi
  echo "canopy-$y.png -> $(wc -c < "$OUT/canopy-$y.png" | tr -d ' ') bytes (without zopflipng: $(wc -c < "$WORK/plain_$y.png" | tr -d ' '))"
}

if want canopy; then
  if [ "$FETCH" = "1" ]; then
    fetch_canopy 2013 c064dcd2d10b4d6092f069e7db89abbf
    fetch_canopy 2019 ee10f28fcef8490e87da5e7f010701b5
    fetch_canopy 2023 2f6665924f5747b69c07f103930ba77d
  fi
  check_grid
  for y in 2013 2019 2023; do build_canopy_png "$y"; done

  # The four corners of the PNGs for a MapLibre image source: top-left, top-right, bottom-right,
  # bottom-left, as [longitude, latitude], from the exact EPSG:3857 bounds of the grid.
  printf '%s\n' "$TE_W $TE_N" "$TE_E $TE_N" "$TE_E $TE_S" "$TE_W $TE_S" |
    gdaltransform -s_srs EPSG:3857 -t_srs EPSG:4326 -output_xy |
    awk 'BEGIN { printf "canopy corners: [" } { printf "%s[%.6f, %.6f]", (NR > 1 ? ", " : ""), $1, $2 } END { print "]" }'

  if [ "$STATS" = "1" ]; then
    for y in 2013 2019 2023; do
      "$GDAL_BIN/python" -I - "$RAW/canopy_$y.tif" <<'EOF'
import sys
import numpy as np
import rasterio
with rasterio.open(sys.argv[1]) as ds:
    a = ds.read(1)
v = a[(a > -9000) & (a < 1e30)].astype(np.float64)
q = np.percentile(v, [0, 1, 5, 25, 50, 75, 95, 99, 100])
print(sys.argv[1], "valid %d of %d (%.4f)" % (v.size, a.size, v.size / a.size),
      "min/p1/p5/p25/p50/p75/p95/p99/max", " ".join("%.2f" % x for x in q))
EOF
    done
  fi
fi

# ---- Hansen Global Forest Change v1.13, loss year 2001 to 2025 (CC BY 4.0)
# The tile address comes from the page's own list (lossyear.txt). The tile covers 40 to 50 N and
# 120 to 130 W. Values: 0 no loss, 1 to 25 loss in 2001 to 2025. Pixels are 0.00025 degrees, and the
# box edges fall on pixel edges, so the clip is exact (2200 x 1680 pixels). Shapes made from it were
# 2.9 MB (11,431 polygons), against about 0.1 MB for this picture, so the map ships the picture.
if want loss; then
  if [ "$FETCH" = "1" ]; then
    curl -sS -m 60 "$HANSEN/download.html" -o "$RAW/hansen_download.html" \
      -w "hansen page -> HTTP %{http_code}, %{size_download} bytes\n"
    curl -sS -m 120 "$HANSEN/lossyear.txt" -o "$RAW/hansen_lossyear_list.txt" \
      -w "hansen list -> HTTP %{http_code}, %{size_download} bytes\n"
    TILE_URL=$(grep "$HANSEN_TILE" "$RAW/hansen_lossyear_list.txt" | head -n 1 | tr -d '\r')
    [ -n "$TILE_URL" ] || { echo "$HANSEN_TILE is not in the page's list"; exit 1; }
    curl -sS -m 900 "$TILE_URL" -o "$RAW/hansen_lossyear_50N_130W.tif" \
      -w "hansen tile -> HTTP %{http_code}, %{size_download} bytes\n"
  fi
  gdal_translate -q -projwin $BOX_W $BOX_N $BOX_E $BOX_S -co COMPRESS=DEFLATE \
    "$RAW/hansen_lossyear_50N_130W.tif" "$WORK/loss_clip.tif"
  # The clip moved to Web Mercator cell for cell (nearest neighbour), on the box's own Mercator extent. The 2200 columns stay the
  # 2200 columns of the clip, and 2535 rows keep the cells about as tall as they are wide in Mercator metres.
  gdalwarp -q -overwrite -s_srs EPSG:4326 -t_srs EPSG:3857 -r near \
    -te -13775786.985667605 6153563.915440912 -13714561.265731305 6224110.131660087 -ts 2200 2535 -ot Byte \
    "$WORK/loss_clip.tif" "$WORK/loss_3857.tif"
  # One indexed PNG: palette entry i is red 10 x i (2001 is 10, 2025 is 250), and entry 0 (no loss) is transparent. The page reads
  # the year back from the red value (lossYearOf in js/time-data.js) and colours the loss itself.
  "$GDAL_BIN/python" -I -c '
import sys
import numpy as np
import rasterio
from PIL import Image
with rasterio.open(sys.argv[1]) as ds:
    a = ds.read(1)
if a.max() > 25:
    sys.exit("a loss value above 25")
im = Image.fromarray(a.astype(np.uint8), mode="P")
im.putpalette([v for i in range(256) for v in (min(10 * i, 255), 0, 0)])
im.save(sys.argv[2], optimize=True, transparency=0)
print("loss cells per year:", " ".join("%d:%d" % (2000 + v, c) for v, c in enumerate(np.bincount(a.ravel(), minlength=26)) if v))
' "$WORK/loss_3857.tif" "$WORK/loss_plain.png"
  if [ "$ZOPFLI" = "1" ] && command -v zopflipng > /dev/null; then
    zopflipng -y --filters=0me "$WORK/loss_plain.png" "$OUT/forest-loss.png" > /dev/null
  else
    cp "$WORK/loss_plain.png" "$OUT/forest-loss.png"
  fi
  echo "forest-loss.png -> $(wc -c < "$OUT/forest-loss.png" | tr -d ' ') bytes"
fi

echo "Done. Next: node scripts/check-demo.mjs"
