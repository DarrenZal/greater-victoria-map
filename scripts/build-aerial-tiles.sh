#!/bin/sh
# Builds the 1932 and 1950 air photos of Victoria as two PMTiles files of WebP tiles, so the map can show them without asking NRCan's
# WMS to draw every tile (about 0.8 s a tile, 4 s a screen):
#   raw/aerials/aerial-1932.pmtiles   zoom 8 to 17 (the photo has 1 m pixels, zoom 17 has about 0.8 m on the ground here)
#   raw/aerials/aerial-1950.pmtiles   zoom 8 to 18 (the photo has 0.5 m pixels, zoom 18 has about 0.4 m)
#
# Developer machine only. The files are too big for the site (about 125 MB), so they are not committed. They are copied to the tile
# host by hand (see README, "Air photo tiles"). Source, licence and processing: data/SOURCES.md.
#
# Source: the National Air Photo Library mosaics in NRCan's datacube, listed by its STAC catalogue
# (https://datacube.services.geo.ca/stac/api/collections/napl-victoria), licence OGL-Canada-2.0. Greyscale, UTM zone 10, 0 is no data.
#
# Needs: curl, GDAL 3 with WebP (gdalwarp, gdal_translate, gdaladdo) and the pmtiles program (https://github.com/protomaps/go-pmtiles).
#
# Options (environment variables):
#   FETCH=0       skip the downloads and use the files already in $RAW_DIR/aerials (about 560 MB)
#   RAW_DIR=dir   where the downloads and the results go (default raw/, not committed)
#   GDAL_BIN=dir  folder with the GDAL programs (default ~/miniconda3/envs/cascadiamap/bin)
#   ONLY=1932     build one year only: 1932 or 1950
#   QUALITY=75    WebP quality of the tiles
set -eu
cd "$(dirname "$0")/.."

RAW="${RAW_DIR:-raw}"
DIR="$RAW/aerials"
FETCH="${FETCH:-1}"
ONLY="${ONLY:-}"
QUALITY="${QUALITY:-75}"
GDAL_BIN="${GDAL_BIN:-$HOME/miniconda3/envs/cascadiamap/bin}"
NAPL="https://datacube-prod-data-public.s3.amazonaws.com/store/imagery/aerial/napl/napl-victoria"
MIN_ZOOM=8

PATH="$GDAL_BIN:$PATH"
export PATH
export PROJ_NETWORK=OFF    # no grid downloads, so the warp gives the same result on every machine

mkdir -p "$DIR"
gdalinfo --version | grep -q '^GDAL 3' || { echo "GDAL 3 not found in $GDAL_BIN (set GDAL_BIN)"; exit 1; }
gdalinfo --format MBTiles | grep -q '<Value>WEBP</Value>' || { echo "this GDAL cannot write WebP tiles"; exit 1; }
command -v pmtiles > /dev/null || { echo "pmtiles not found (https://github.com/protomaps/go-pmtiles)"; exit 1; }

# One year: download, warp to Web Mercator at the pixel size of its deepest zoom (aligned to the tile grid, with 0 as clear), write
# the deepest zoom as WebP tiles, add the zooms above it down to $MIN_ZOOM, and pack the result as PMTiles.
build() {
  y="$1"; z="$2"
  [ -z "$ONLY" ] || [ "$ONLY" = "$y" ] || return 0
  src="$DIR/napl-victoria-$y-mosaic.tif"
  if [ "$FETCH" = "1" ]; then
    want=$(curl -sSI -m 60 "$NAPL/napl-victoria-$y-mosaic.tif" | tr -d '\r' | awk 'tolower($1) == "content-length:" { print $2 }')
    curl -sS -m 3600 "$NAPL/napl-victoria-$y-mosaic.tif" -o "$src" -w "napl $y -> HTTP %{http_code}, %{size_download} bytes\n"
    got=$(wc -c < "$src" | tr -d ' ')
    [ "$want" = "$got" ] || { echo "napl $y: the server says $want bytes, got $got"; exit 1; }
  fi
  res=$(awk -v z="$z" 'BEGIN { printf "%.10f", 2 * 20037508.342789244 / 256 / 2 ^ z }')
  gdalwarp -q -overwrite -t_srs EPSG:3857 -tr "$res" "$res" -tap -r cubic -srcnodata 0 -dstalpha -multi -wo NUM_THREADS=ALL_CPUS \
    -co TILED=YES -co COMPRESS=DEFLATE -co BIGTIFF=IF_SAFER "$src" "$DIR/aerial-$y-3857.tif"
  rm -f "$DIR/aerial-$y.mbtiles"
  gdal_translate -q -of MBTILES -co TILE_FORMAT=WEBP -co QUALITY="$QUALITY" -co NAME="Victoria air photos $y" \
    -co DESCRIPTION="National Air Photo Library mosaic of Victoria, $y. Contains information licensed under the Open Government Licence - Canada." \
    "$DIR/aerial-$y-3857.tif" "$DIR/aerial-$y.mbtiles"
  factors=""; f=2; zz=$((z - 1))
  while [ "$zz" -ge "$MIN_ZOOM" ]; do factors="$factors $f"; f=$((f * 2)); zz=$((zz - 1)); done
  # The zooms above are WebP too. Without these open options GDAL writes them as PNG, about 9 times bigger.
  # shellcheck disable=SC2086
  gdaladdo -q -r average -oo TILE_FORMAT=WEBP -oo QUALITY="$QUALITY" "$DIR/aerial-$y.mbtiles" $factors
  # GDAL stops the zooms above where the photo fits in a few tiles (zoom 11 here), and the map opens at about zoom 10. So the zooms from
  # there down to $MIN_ZOOM are made from the zoom below, four tiles into one. MBTiles rows count from the south.
  "$GDAL_BIN/python" -I - "$DIR/aerial-$y.mbtiles" "$MIN_ZOOM" "$QUALITY" <<'EOF'
import io, sqlite3, sys
from PIL import Image
db = sqlite3.connect(sys.argv[1])
lowest, quality = int(sys.argv[2]), int(sys.argv[3])
top = db.execute('select min(zoom_level) from tiles').fetchone()[0]
for z in range(top - 1, lowest - 1, -1):
    kids = {(x, y): d for x, y, d in db.execute('select tile_column, tile_row, tile_data from tiles where zoom_level = ?', (z + 1,))}
    for px, py in {(x // 2, y // 2) for x, y in kids}:
        im = Image.new('RGBA', (512, 512))
        for dx in (0, 1):
            for dy in (0, 1):
                d = kids.get((2 * px + dx, 2 * py + dy))
                if d:
                    im.paste(Image.open(io.BytesIO(d)).convert('RGBA'), (256 * dx, 256 * (1 - dy)))
        out = io.BytesIO()
        im.resize((256, 256), Image.LANCZOS).save(out, 'WEBP', quality=quality)
        db.execute('insert or replace into tiles values (?, ?, ?, ?)', (z, px, py, out.getvalue()))
db.execute("update metadata set value = ? where name = 'minzoom'", (str(min(top, lowest)),))
db.commit()
EOF
  rm -f "$DIR/aerial-$y.pmtiles"
  pmtiles convert "$DIR/aerial-$y.mbtiles" "$DIR/aerial-$y.pmtiles" > /dev/null
  echo "aerial-$y.pmtiles -> $(wc -c < "$DIR/aerial-$y.pmtiles" | tr -d ' ') bytes, zoom $MIN_ZOOM to $z"
}

build 1932 17
build 1950 18
(cd "$DIR" && shasum -a 256 aerial-1932.pmtiles aerial-1950.pmtiles > SHA256SUMS)
echo "Done. Check with: pmtiles show $DIR/aerial-1932.pmtiles. Copy the two files and SHA256SUMS to the tile server (README, Hosting)."
