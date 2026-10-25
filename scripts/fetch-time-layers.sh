#!/bin/sh
# Rebuilds the data files of two layers under "Change over time": herring spawn by year and the
# Sensitive Ecosystems Inventory (three vintages, for the Garry oak then-and-now). The pictures of
# the vegetation from LiDAR and the forest loss shapes are made by scripts/fetch-time-rasters.sh.
#
# Developer machine only. The browser never calls these services. Run it once, check the result
# with `node scripts/check-demo.mjs`, and commit the data files. Same style as scripts/fetch-layers.sh.
#
# Needs: curl, node, and mapshaper 0.7.93 (npm). By default it runs
# `npx --yes mapshaper@0.7.93`, which downloads mapshaper on first use. To use
# a copy you already have, set MAPSHAPER=/path/to/mapshaper.
#
# Options (environment variables):
#   FETCH=0       skip the downloads and process the files already in $RAW_DIR
#   RAW_DIR=dir   where the raw downloads go (default raw/, not committed)
#   MAPSHAPER=    command that runs mapshaper
#   ONLY=herring  run only one part: herring or sei
#
# Source, licence and filters per file are recorded in data/SOURCES.md. Data retrieved for the
# committed files: 2026-10-22.
set -eu
cd "$(dirname "$0")/.."

RAW="${RAW_DIR:-raw}"
OUT=data
FETCH="${FETCH:-1}"
ONLY="${ONLY:-}"
MAPSHAPER="${MAPSHAPER:-npx --yes mapshaper@0.7.93}"
BBOX="-123.75,48.28,-123.20,48.70"       # the demo box, for the land layers
WFS="https://openmaps.gov.bc.ca/geo/pub/ows"

mkdir -p "$RAW" "$OUT"

ms() { $MAPSHAPER "$@"; }
want() { [ -z "$ONLY" ] || [ "$ONLY" = "$1" ]; }

# One WFS layer as GeoJSON for a box and a CQL filter. version=1.0.0 keeps
# longitude,latitude axis order. A bbox cannot be combined with a cql_filter in one request, so
# the box goes inside the filter.
wfs_cql() {
  box="$1"; layer="$2"; file="$3"; cql="$4"
  curl -sS -m 300 -G "$WFS" \
    --data-urlencode "service=WFS" --data-urlencode "version=1.0.0" \
    --data-urlencode "request=GetFeature" --data-urlencode "typeName=pub:$layer" \
    --data-urlencode "outputFormat=application/json" --data-urlencode "srsName=EPSG:4326" \
    --data-urlencode "cql_filter=${cql}BBOX(GEOMETRY,$box,'EPSG:4326')" -o "$RAW/$file" \
    -w "$layer -> HTTP %{http_code}, %{size_download} bytes\n"
}

# ---- Herring spawn by year (Fisheries and Oceans Canada, OGL-Canada)
# The CSV is replaced every year and its file name carries the year, so the address is read
# from the open.canada.ca record instead of being written here. The CSV must be fetched with GET
# (a HEAD request returns 404). Clipped to the area the map reaches, like the marine files.
if want herring; then
  if [ "$FETCH" = "1" ]; then
    curl -sS -m 120 "https://open.canada.ca/data/api/action/package_show?id=d892511c-d851-4f85-a0ec-708bc05d2810" -o "$RAW/herring_record.json" \
      -w "herring record -> HTTP %{http_code}, %{size_download} bytes\n"
    CSV_URL=$(node -e '
      const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).result.resources
        .find((x) => x.format === "CSV" && (x.language || []).includes("en"))
      if (!r) { console.error("no English CSV in the record"); process.exit(1) }
      console.log(r.url)' "$RAW/herring_record.json")
    curl -sS -m 300 "$CSV_URL" -o "$RAW/herring_spawn_index.csv" -w "herring csv -> HTTP %{http_code}, %{size_download} bytes\n"
  fi
  # One point per location and year; see the header of make-herring-years.mjs.
  node scripts/make-herring-years.mjs "$RAW/herring_spawn_index.csv" "$RAW/herring_years.geojson"
  ms "$RAW/herring_years.geojson" -o "$OUT/herring-spawn-years.geojson" precision=0.0001 format=geojson
fi

# ---- Sensitive Ecosystems Inventory, three vintages (BC, OGL-BC)
# Project 4206: surveyed 1994 and 1995, completed 1998, photos of 1992.
# Project 9914: the 2002 update, completed 2003. It keeps the 1990s polygons, cuts out the parts
#   that were disturbed by 2002 and labels those parts NS (non-sensitive), with the disturbance type.
# Project 6567: "CWHxm1 TEM Garry Oak Ecosystems", photos of 2014, completed 2021, 1:10,000.
#   It covers the west of the demo box only (west of about -123.52).
# Clipped to the demo box like the other land layers. Kept: polygons that have woodland (WD),
# herbaceous (HT, HB), broadleaf woodland (BW), coastal bluff (CB) or sparsely vegetated (SV) as any of
# their up to three components, plus every NS patch in the 2002 file. Set SEI_ALL=1 to keep every class.
# The free-text comment, project names, mapper fields and staff names are never kept.
if want sei; then
  if [ "$FETCH" = "1" ]; then
    for p in 4206 9914 6567; do
      wfs_cql "$BBOX" WHSE_TERRESTRIAL_ECOLOGY.STE_SEI_ATTRIBUTE_POLYS_SVW "sei_$p.json" "BUSINESS_AREA_PROJECT_ID=$p AND "
    done
  fi
  C1=SNSTVE_ECOSYSTEM_CLASS_CPNT_1; C2=SNSTVE_ECOSYSTEM_CLASS_CPNT_2; C3=SNSTVE_ECOSYSTEM_CLASS_CPNT_3
  if [ "${SEI_ALL:-0}" = "1" ]; then
    KEEP='true'
  else
    KEEP="[\"WD\",\"HT\",\"HB\",\"BW\",\"CB\",\"SV\"].some(c => [$C1,$C2,$C3].includes(c))"
  fi
  ALSO="also=[$C2,$C3].filter(Boolean).join('+')||null"
  # The disturbance type, taken from the one phrase of the polygon comment that has it
  # ("Source disturbance type: 'Cleared/Logged'"). Nothing else of the comment is kept.
  DIST="dist=(m => m ? m[1].replace(/^urban use\$/i, \"Urban Use\") : null)((POLYGON_COMMENTS||\"\").match(/Source disturbance type: \\x27([^\\x27]*)\\x27/))"
  TENTHS="tenths=(ECOSYSTEM_DECILE_CPNT_1>0 ? +ECOSYSTEM_DECILE_CPNT_1 : null)"
  SEI_OPTS="precision=0.00001 format=geojson"

  ms "$RAW/sei_4206.json" -filter "$KEEP" -each "$ALSO" \
    -rename-fields class=$C1,sub=SNSTVE_ECOSYSTEM_SUBCLS_CPNT_1 -filter-fields class,sub,also \
    -clip bbox=$BBOX -filter-slivers min-area=150 remove-empty -simplify percentage=20% keep-shapes \
    -o "$OUT/sei-garry-oak-1994-95.geojson" $SEI_OPTS

  ms "$RAW/sei_9914.json" -filter "($KEEP) || $C1==\"NS\"" -each "$ALSO, $DIST" \
    -rename-fields class=$C1,sub=SNSTVE_ECOSYSTEM_SUBCLS_CPNT_1 -filter-fields class,sub,also,dist \
    -clip bbox=$BBOX -filter-slivers min-area=150 remove-empty -simplify percentage=20% keep-shapes \
    -o "$OUT/sei-garry-oak-2002.geojson" $SEI_OPTS

  ms "$RAW/sei_6567.json" -filter "$KEEP" -each "$ALSO, $TENTHS" \
    -rename-fields class=$C1,sub=SNSTVE_ECOSYSTEM_SUBCLS_CPNT_1 -filter-fields class,sub,also,tenths \
    -clip bbox=$BBOX -filter-slivers min-area=150 remove-empty -simplify percentage=20% keep-shapes \
    -o "$OUT/sei-garry-oak-2014.geojson" $SEI_OPTS
fi

echo "Done. Next: node scripts/check-demo.mjs"
