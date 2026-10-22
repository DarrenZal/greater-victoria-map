#!/bin/sh
# Rebuilds data/*.geojson from the BC Data Catalogue (OpenMaps WFS).
#
# Developer machine only. The browser never calls the WFS. Run it once, check
# the result with `node scripts/check-demo.mjs`, and commit the data files.
#
# Needs: curl, node, and mapshaper 0.7.93 (npm). By default it runs
# `npx --yes mapshaper@0.7.93`, which downloads mapshaper on first use. To use
# a copy you already have, set MAPSHAPER=/path/to/mapshaper.
#
# Options (environment variables):
#   FETCH=0      skip the downloads and process the files already in $RAW_DIR
#   RAW_DIR=dir  where the raw WFS downloads go (default raw/, not committed)
#   MAPSHAPER=   command that runs mapshaper
#
# Every layer is clipped to the demo box and simplified for the web. Source,
# licence and filters per layer are recorded in data/SOURCES.md. Data
# retrieved for the committed files: 2026-10-21.
set -eu
cd "$(dirname "$0")/.."

RAW="${RAW_DIR:-raw}"
FETCH="${FETCH:-1}"
MAPSHAPER="${MAPSHAPER:-npx --yes mapshaper@0.7.93}"
BBOX="-123.75,48.28,-123.20,48.70"
WFS="https://openmaps.gov.bc.ca/geo/pub/ows"
OUT_OPTS="precision=0.00001 format=geojson"

mkdir -p "$RAW" data

# version=1.0.0 keeps longitude,latitude axis order in the GeoJSON.
wfs() {
  layer="$1"; file="$2"; shift 2
  curl -sS -m 300 -G "$WFS" \
    --data-urlencode "service=WFS" --data-urlencode "version=1.0.0" \
    --data-urlencode "request=GetFeature" --data-urlencode "typeName=pub:$layer" \
    --data-urlencode "outputFormat=application/json" --data-urlencode "srsName=EPSG:4326" \
    --data-urlencode "bbox=$BBOX,EPSG:4326" "$@" -o "$RAW/$file" \
    -w "$layer -> HTTP %{http_code}, %{size_download} bytes\n"
}

if [ "$FETCH" = "1" ]; then
  wfs WHSE_LEGAL_ADMIN_BOUNDARIES.ABMS_MUNICIPALITIES_SP muni.json
  wfs WHSE_TANTALIS.TA_PARK_ECORES_PA_SVW parks.json
  wfs WHSE_BASEMAPPING.GBA_LOCAL_REG_GREENSPACES_SP greenspaces.json
  wfs WHSE_BASEMAPPING.FWA_STREAM_NETWORKS_SP streams_all.json \
    --data-urlencode "propertyName=GNIS_NAME,STREAM_ORDER,LINEAR_FEATURE_ID,EDGE_TYPE,BLUE_LINE_KEY,DOWNSTREAM_ROUTE_MEASURE,GEOMETRY"
  wfs WHSE_BASEMAPPING.FWA_LAKES_POLY lakes.json
  wfs WHSE_BASEMAPPING.FWA_WETLANDS_POLY wetlands.json
  wfs WHSE_BASEMAPPING.FWA_NAMED_WATERSHEDS_POLY namedws.json
  wfs WHSE_FOREST_VEGETATION.BEC_BIOGEOCLIMATIC_POLY bec.json
fi

ms() { $MAPSHAPER "$@"; }

# 13 municipalities of the Capital Regional District. Legal boundaries include
# adjacent water, so the popup says so.
ms "$RAW/muni.json" \
  -filter 'ADMIN_AREA_GROUP_NAME=="Capital Regional District"' \
  -filter-fields ADMIN_AREA_ABBREVIATION \
  -rename-fields name=ADMIN_AREA_ABBREVIATION \
  -clip bbox=$BBOX -simplify percentage=8% keep-shapes \
  -o data/municipalities.geojson $OUT_OPTS

# Provincial parks and ecological reserves. Names are kept exactly as published.
ms "$RAW/parks.json" \
  -filter-fields PROTECTED_LANDS_NAME,PROTECTED_LANDS_DESIGNATION,PARK_CLASS \
  -clip bbox=$BBOX -simplify percentage=15% keep-shapes \
  -o data/bc-parks.geojson $OUT_OPTS

# Local and regional parks. 'lic' records which provider's licence statement
# the source row carries (S Saanich, V Victoria, C Capital Regional District,
# I Islands Trust, null none), so a provider can be dropped with one filter.
# Private parks are dropped. Slivers under 150 sq m are dropped.
# Rows that carry the Capital Regional District statement (lic "C") are dropped
# too: the only CRD terms found forbid passing the data on to others and name
# no open licence (see data/SOURCES.md). Remove that filter only after the CRD
# confirms an open licence in writing. Rows that carry the Islands Trust
# statement (lic "I") are kept: its terms page, read on 2026-10-21, is the Open
# Government Licence - Islands Trust v2.0, which allows copying and publishing
# with attribution (see data/SOURCES.md).
ms "$RAW/greenspaces.json" \
  -filter 'REGIONAL_DISTRICT=="Capital" && PARK_TYPE!="Private"' \
  -each 'name=PARK_NAME, type=PARK_TYPE, use=PARK_PRIMARY_USE, muni=(MUNICIPALITY=="<Null>" ? null : MUNICIPALITY), lic=(/Saanich/.test(LICENCE_COMMENTS||"") ? "S" : /Victoria/.test(LICENCE_COMMENTS||"") ? "V" : /Capital Regional District/.test(LICENCE_COMMENTS||"") ? "C" : /Islands Trust/.test(LICENCE_COMMENTS||"") ? "I" : null)' \
  -filter 'lic!="C"' \
  -filter-fields name,type,use,muni,lic \
  -clip bbox=$BBOX -filter-slivers min-area=150 remove-empty \
  -simplify percentage=20% keep-shapes \
  -o data/greenspaces.geojson $OUT_OPTS

# Named streams only, with stream order for line width. The first output keeps
# the fields the flow builder needs (edge type, stream key, distance from the
# mouth) and stays in raw/, which is not committed. The second is the file the
# page loads.
ms "$RAW/streams_all.json" \
  -filter 'GNIS_NAME!=null && GNIS_NAME!=""' \
  -filter-fields GNIS_NAME,STREAM_ORDER,EDGE_TYPE,BLUE_LINE_KEY,DOWNSTREAM_ROUTE_MEASURE \
  -rename-fields name=GNIS_NAME,order=STREAM_ORDER,edge=EDGE_TYPE,key=BLUE_LINE_KEY,measure=DOWNSTREAM_ROUTE_MEASURE \
  -clip bbox=$BBOX -simplify percentage=40% keep-shapes \
  -o "$RAW/streams_keyed.geojson" $OUT_OPTS \
  -filter-fields name,order \
  -o data/streams.geojson $OUT_OPTS

# Flow lines for the animated "Flow" layer: open-flow reaches only, joined into
# continuous lines and turned so the last vertex is downstream. See the header
# of scripts/make-flow.mjs for why.
node scripts/make-flow.mjs "$RAW/streams_keyed.geojson" data/streams-flow.geojson

# Lakes of 1 ha or more.
ms "$RAW/lakes.json" \
  -filter 'AREA_HA>=1' \
  -each 'name=GNIS_NAME_1, area_ha=Math.round(AREA_HA*10)/10' \
  -filter-fields name,area_ha \
  -clip bbox=$BBOX -simplify percentage=30% keep-shapes \
  -o data/lakes.geojson $OUT_OPTS

# Wetlands of 0.5 ha or more.
ms "$RAW/wetlands.json" \
  -filter 'AREA_HA>=0.5' \
  -each 'name=GNIS_NAME_1, area_ha=Math.round(AREA_HA*10)/10' \
  -filter-fields name,area_ha \
  -clip bbox=$BBOX -simplify percentage=30% keep-shapes \
  -o data/wetlands.geojson $OUT_OPTS

# Named watersheds of the core area (under 8,000 ha, centroid in the home box).
ms "$RAW/namedws.json" \
  -filter 'AREA_HA<8000 && $.centroidX>-123.65 && $.centroidX<-123.22 && $.centroidY>48.34 && $.centroidY<48.66' \
  -each 'name=GNIS_NAME, area_ha=Math.round(AREA_HA)' \
  -filter-fields name,area_ha \
  -clip bbox=$BBOX -simplify percentage=12% keep-shapes \
  -o data/watersheds.geojson $OUT_OPTS

# Biogeoclimatic zones, dissolved to one polygon per zone label. The polygons
# extend over open water, so the page masks the sea with the basemap's water.
ms "$RAW/bec.json" \
  -filter-fields ZONE_NAME,SUBZONE_NAME,VARIANT_NAME,BGC_LABEL \
  -clip bbox=$BBOX \
  -dissolve BGC_LABEL copy-fields=ZONE_NAME,SUBZONE_NAME,VARIANT_NAME \
  -simplify percentage=4% keep-shapes \
  -o data/bec.geojson $OUT_OPTS

echo "Done. data/pins.geojson is hand-edited and is not touched by this script."
echo "Next: node scripts/check-demo.mjs"
