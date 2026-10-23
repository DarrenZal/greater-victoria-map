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
#   RAW_DIR=dir  where the raw downloads go (default raw/, not committed)
#   MAPSHAPER=   command that runs mapshaper
#   ONLY=marine  run only the marine life and protection files at the end of this
#                script and leave every other data file as it is
#
# Every layer is clipped to the demo box and simplified for the web, except the
# marine files, which are clipped to the area the map reaches (see the marine
# section below). Source, licence and filters per layer are recorded in
# data/SOURCES.md. Data retrieved for the committed files: 2026-10-21, and
# 2026-10-22 for the marine files.
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
wfs_box() {
  box="$1"; layer="$2"; file="$3"; shift 3
  curl -sS -m 300 -G "$WFS" \
    --data-urlencode "service=WFS" --data-urlencode "version=1.0.0" \
    --data-urlencode "request=GetFeature" --data-urlencode "typeName=pub:$layer" \
    --data-urlencode "outputFormat=application/json" --data-urlencode "srsName=EPSG:4326" \
    --data-urlencode "bbox=$box,EPSG:4326" "$@" -o "$RAW/$file" \
    -w "$layer -> HTTP %{http_code}, %{size_download} bytes\n"
}
wfs() { wfs_box "$BBOX" "$@"; }

ms() { $MAPSHAPER "$@"; }

# ---- Marine life and protection
# Eight files from open government data. They are clipped to the area the map reaches
# (SEA_BBOX, the same area as the live layers), not to the demo box: a sea layer cut off at
# the demo box would draw a straight edge through open water and read as a boundary. Run just
# this part with ONLY=marine. Source, licence, filters and sizes: data/SOURCES.md.
SEA_BBOX="-124.4,47.9,-122.7,49.1"
SEA_OPTS="precision=0.0001 format=geojson"
CPCAD="https://maps-cartes.ec.gc.ca/arcgis/rest/services/CWS_SCF/CPCAD/MapServer/0"
DFO_REST="https://egisp.dfo-mpo.gc.ca/arcgis/rest/services/open_data_donnees_ouvertes"

# One query of an ArcGIS REST layer for the features that touch SEA_BBOX, as GeoJSON in
# longitude,latitude with 6 decimals.
arcgis() {
  base="$1"; file="$2"; where="$3"; fields="$4"
  curl -sS -m 300 -G "$base/query" \
    --data-urlencode "where=$where" --data-urlencode "outFields=$fields" \
    --data-urlencode "geometry=$SEA_BBOX" --data-urlencode "geometryType=esriGeometryEnvelope" \
    --data-urlencode "inSR=4326" --data-urlencode "spatialRel=esriSpatialRelIntersects" \
    --data-urlencode "outSR=4326" --data-urlencode "geometryPrecision=6" --data-urlencode "f=geojson" \
    -o "$RAW/$file" -w "$file -> HTTP %{http_code}, %{size_download} bytes\n"
}

marine() {
  if [ "$FETCH" = "1" ]; then
    # CPCAD splits each protected area into a marine zone and a terrestrial zone (BIOME M and T).
    arcgis "$CPCAD" cpcad_marine.json "BIOME='M'" "NAME_E,TYPE_E,OWNER_E,ESTYEAR,NO_TAKE"
    arcgis "$DFO_REST/dfo_sara_critical_habitat/MapServer/0" srkw.json "COMMON_E='Killer Whale' AND POP_E LIKE '%Southern Resident%'" "COMMON_E,POP_E,CH_STATUS_E,Area_Km2"
    # Important Areas for the Strait of Georgia ecoregion, layer 3 (Resident killer whale): one polygon drawn by experts on paper maps in 2009.
    arcgis "$DFO_REST/important_areas_for_strait_of_georgia_ecoregion/MapServer/3" rkw.json "1=1" "seasonal,score"
    # PRISMM density models, the Salish Sea grid of each species (layer 0 Dall's porpoise, 6 harbour porpoise, 9 humpback whale).
    arcgis "$DFO_REST/spatial_density_models_cetaceans_canadian_pacific_2018/MapServer/0" density_dalls.json "1=1" "OBJECTID,area_m2,Nhat,CV"
    arcgis "$DFO_REST/spatial_density_models_cetaceans_canadian_pacific_2018/MapServer/6" density_harbour.json "1=1" "OBJECTID,area_m2,Nhat,CV"
    arcgis "$DFO_REST/spatial_density_models_cetaceans_canadian_pacific_2018/MapServer/9" density_humpback.json "1=1" "OBJECTID,area_m2,Nhat,CV"
    wfs_box "$SEA_BBOX" WHSE_WILDLIFE_MANAGEMENT.CRIMS_KELP_BEDS crims_kelp.json
    wfs_box "$SEA_BBOX" WHSE_WILDLIFE_MANAGEMENT.CRIMS_EELGRASSES crims_eelgrass.json
    wfs_box "$SEA_BBOX" WHSE_WILDLIFE_MANAGEMENT.CRIMS_HERRING_SPAWN crims_herring.json
    wfs_box "$SEA_BBOX" WHSE_WILDLIFE_MANAGEMENT.CRIMS_BIRD_COLONIES crims_birds.json
  fi

  # Protected marine areas: the marine zones only (BIOME M), so a park's land is not drawn twice.
  # The land parts are in bc-parks.geojson and greenspaces.geojson already. no_take is CPCAD's
  # "Marine Resource Use" code and is kept only where it says All (1), Part (2) or None (3).
  ms "$RAW/cpcad_marine.json" \
    -each 'no_take=(NO_TAKE>=1 && NO_TAKE<=3 ? NO_TAKE : null), year=(ESTYEAR>0 ? ESTYEAR : null)' \
    -rename-fields name=NAME_E,type=TYPE_E,owner=OWNER_E \
    -filter-fields name,type,owner,year,no_take \
    -clip bbox=$SEA_BBOX -simplify percentage=10% keep-shapes \
    -o data/marine-protected.geojson $SEA_OPTS

  # Southern Resident killer whale critical habitat. One polygon. area_km2 is its whole area, before clipping.
  ms "$RAW/srkw.json" \
    -each 'area_km2=Math.round(Area_Km2)' \
    -rename-fields status=CH_STATUS_E \
    -filter-fields status,area_km2 \
    -clip bbox=$SEA_BBOX -simplify percentage=30% keep-shapes \
    -o data/srkw-habitat.geojson $SEA_OPTS

  # The important area for Southern Resident killer whales, as experts drew it for June to October. One polygon, a mapped area and not a sighting.
  ms "$RAW/rkw.json" \
    -filter-fields seasonal,score \
    -clip bbox=$SEA_BBOX -simplify percentage=8% keep-shapes \
    -o data/rkw-important-area.geojson $SEA_OPTS

  # Modelled whale and porpoise numbers: the three species joined on one grid (see the script).
  node scripts/make-density.mjs "$RAW/density_dalls.json" "$RAW/density_harbour.json" "$RAW/density_humpback.json" "$RAW/density_merged.geojson"
  ms "$RAW/density_merged.geojson" \
    -clip bbox=$SEA_BBOX -simplify percentage=12% keep-shapes \
    -o data/whale-density.geojson $SEA_OPTS

  # Coastal habitat from CRIMS, a legacy survey from 1979 on. Only the fields the popups use.
  ms "$RAW/crims_kelp.json" \
    -rename-fields species=SPECIES,density=DENSITY \
    -filter-fields species,density \
    -clip bbox=$SEA_BBOX -simplify percentage=20% keep-shapes \
    -o data/kelp.geojson $SEA_OPTS
  ms "$RAW/crims_eelgrass.json" \
    -each 'year=(MAP_DATE ? +String(MAP_DATE).slice(0,4) : null)' \
    -filter-fields year \
    -clip bbox=$SEA_BBOX -simplify percentage=30% keep-shapes \
    -o data/eelgrass.geojson $SEA_OPTS
  ms "$RAW/crims_herring.json" \
    -each 'magnitude=(MAGNITUDE||"").trim()||null, consistency=(CONSISTENCY||"").trim()||null, first_year=(BEGINNING_YEAR>0 ? BEGINNING_YEAR : null), last_year=(ENDING_YEAR>0 ? ENDING_YEAR : null)' \
    -filter-fields magnitude,consistency,first_year,last_year \
    -clip bbox=$SEA_BBOX -simplify percentage=25% keep-shapes \
    -o data/herring-spawn.geojson $SEA_OPTS
  # A colony named for a First Nation is left out, as for the industry sites (this demo shows no First Nations content).
  ms "$RAW/crims_birds.json" \
    -filter '!/tsawwassen|tsawout/i.test(LOCATION)' \
    -rename-fields name=LOCATION \
    -filter-fields name \
    -clip bbox=$SEA_BBOX \
    -o data/seabird-colonies.geojson $SEA_OPTS

  # Rounding to 4 decimals can collapse a very small shape to nothing. Read each file back and drop those.
  for f in marine-protected srkw-habitat rkw-important-area whale-density kelp eelgrass herring-spawn seabird-colonies; do
    ms "data/$f.geojson" -filter '!this.isNull' -o "data/$f.geojson" force $SEA_OPTS
  done
}

if [ "${ONLY:-}" = "marine" ]; then
  marine
  echo "Done. Only the marine files were rebuilt. Next: node scripts/check-demo.mjs"
  exit 0
fi

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

marine

echo "Done. data/pins.geojson is hand-edited and is not touched by this script."
echo "Next: node scripts/check-demo.mjs"
