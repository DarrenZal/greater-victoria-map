# Greater Victoria open map (demo)

A small web map of Greater Victoria, built by Claude, an AI model, for Darren Zal. It is a demo of an open, self-hostable alternative to embedding Google Maps for local groups in Greater Victoria. It shows watersheds, creeks (with animated flow direction), parks, ecosystem zones and optional terrain shading from open data, plus an optional layer for events and places. It is a demo. It is not an official map of any group.

Status: published at https://darrenzal.github.io/greater-victoria-map/ (code in https://github.com/DarrenZal/greater-victoria-map). Built on 2026-10-21. Data retrieved 2026-10-21.

Repository name `greater-victoria-map`. The code is under the MIT licence, see [LICENSE](LICENSE) (Darren Zal, 2026). The MIT licence covers the code only. Each data layer keeps its own licence, recorded per layer in [data/SOURCES.md](data/SOURCES.md), and the MIT licence does not relicense any of it. The vendored MapLibre library keeps its own BSD-3-Clause licence in [vendor/MAPLIBRE-LICENSE.txt](vendor/MAPLIBRE-LICENSE.txt), which must stay with it.

## Run it locally

It is plain static files with no build step. From this folder:

```sh
python3 -m http.server 8000
```

Then open http://localhost:8000/. Opening `index.html` straight from disk will not work, because browsers block module scripts and data requests on `file://` pages.

The page needs internet for the street basemap (tiles.openfreemap.org), and for the terrain tiles (s3.amazonaws.com) once Terrain shading is ticked. If the basemap cannot be reached, the page shows the data layers on a plain background and adds a sentence to the banner.

## What is on the map

Default on: the example place, creeks, lakes and wetlands (with Flow, below), parks and green spaces, municipal boundaries. Default off: watersheds, terrain shading and ecosystem zones. Clicking a feature opens a popup with its name, type and source. Popups are built from plain text only, and only https links are clickable.

**Flow.** A sub-toggle under "Creeks, lakes and wetlands", on by default. Pale dashes march downstream along the creek lines from zoom 9 up, so a visitor can see which way Bowker Creek, the Colquitz River or Craigflower Creek drain. It shows drainage direction from provincial lines, not discharge or current. Only reaches the Province maps as main flow in a natural channel get dashes. Pipes (subsurface flow), canals and connection lines do not, and the panel and credits say so. Under a system setting of reduced motion the layer is hidden altogether, the box is off and disabled, and the page follows the setting if it changes. The animation loop runs only while the dashes can be seen: the Flow and creeks boxes are on, this tab is in front and the map is zoomed to 9 or more. How the direction was found and checked is in [data/SOURCES.md](data/SOURCES.md).

**Terrain shading.** A hillshade drawn in the browser from AWS Terrain Tiles. Off by default, and no elevation tile is requested until the box is ticked. Credits and the on-map attribution name the sources while it is on.

| Layer | File | Features | Licence | Source |
|---|---|---|---|---|
| Municipal boundaries (13 CRD municipalities) | [municipalities.geojson](data/municipalities.geojson) | 13 | OGL-BC | Municipalities - Legally Defined Administrative Areas of BC |
| Provincial parks and ecological reserves | [bc-parks.geojson](data/bc-parks.geojson) | 17 | OGL-BC | BC Parks, Ecological Reserves, and Protected Areas |
| Local and regional parks and green spaces | [greenspaces.geojson](data/greenspaces.geojson) | 933 | OGL-BC on the record, plus the City of Victoria and Saanich statements. Capital Regional District and Islands Trust rows removed. | Local and Regional Greenspaces |
| Named creeks and rivers | [streams.geojson](data/streams.geojson) | 578 | OGL-BC | Freshwater Atlas - Stream Network |
| Flow lines (open-flow creeks, joined, pointing downstream) | [streams-flow.geojson](data/streams-flow.geojson) | 124 | OGL-BC | Derived from the stream network by [scripts/make-flow.mjs](scripts/make-flow.mjs) |
| Lakes of 1 ha or more | [lakes.geojson](data/lakes.geojson) | 79 | OGL-BC | Freshwater Atlas - Lakes |
| Wetlands of 0.5 ha or more | [wetlands.geojson](data/wetlands.geojson) | 203 | OGL-BC | Freshwater Atlas - Wetlands |
| Named watersheds, core area | [watersheds.geojson](data/watersheds.geojson) | 43 | OGL-BC | Freshwater Atlas - Named Watersheds |
| Biogeoclimatic (BEC) zones | [bec.geojson](data/bec.geojson) | 5 | OGL-BC | BEC Map |
| Example place (Bowker Creek) | [pins.geojson](data/pins.geojson) | 1 | Our own text. Coordinates from OpenStreetMap (ODbL). | Bowker Creek Blueprint (2012), via the CRD |

OGL-BC is the Open Government Licence - British Columbia. The eight provincial datasets are published by the Province of British Columbia through the BC Data Catalogue, and the licence on each catalogue record was read on 2026-10-21. [data/SOURCES.md](data/SOURCES.md) lists, for every layer, the catalogue page, the WFS layer name, the filters, the simplification settings, the retrieval date (2026-10-21) and the file sizes. Feature counts are after clipping to the demo box (west -123.75, south 48.28, east -123.20, north 48.70). The basemap is OpenFreeMap with the pale "positron" style, loaded live.

The five biogeoclimatic zones are Coastal Douglas-fir (CDF mm) and four Coastal Western Hemlock variants. The zone polygons run out over open water, so the page redraws the basemap's own water on top of them.

### Attribution text

Shown on the map in the attribution control (the (i) button on phones) and in full in the "Data and credits" panel.

- Basemap, added automatically from the OpenFreeMap TileJSON: OpenFreeMap, (c) OpenMapTiles, Data from OpenStreetMap. The links are https://openfreemap.org, https://www.openmaptiles.org/ and https://www.openstreetmap.org/copyright.
- Province of British Columbia data, the statement given on the licence page: "Contains information licensed under the Open Government Licence - British Columbia." It links to the [licence](https://www2.gov.bc.ca/gov/content?id=A519A56BC2BF44E4A008B33FCF527F61). The licence has a non-endorsement clause. The page does not suggest the Province or any data provider endorses this map, and uses no Province logos.
- Parks and green spaces add the providers' own statements, as read on 2026-10-21. On the map: "Parks: also OGL – Victoria, Saanich". In the credits panel and in the popup of each park, word for word: "Contains information licensed under the Open Government Licence – City of Victoria." and "Contains information licenced under the Open Government Licence – District of Saanich." (Saanich's own spelling). Rows with no provider statement rely on the Province's statement above. The Capital Regional District's rows and the Islands Trust row are not on the map, see open item A1.
- Terrain shading, shown only while the layer is on. On the map: "Terrain: AWS Terrain Tiles, OGL – Canada, USGS, NOAA". In the credits panel, the lines the tile attribution notes ask for: "Canada terrain data contains information licensed under the Open Government Licence – Canada.", "United States 3DEP (formerly NED) and global GMTED2010 and SRTM terrain data courtesy of the U.S. Geological Survey." and "Global ETOPO1 terrain data U.S. National Oceanic and Atmospheric Administration."
- Software: MapLibre GL JS 6.9.0 (BSD-3-Clause).

## Left out on purpose

None of these is in the demo, and none is linked.

- **Native Land territories, languages and treaties.** Its Data Sovereignty Treaty (https://api-docs.native-land.ca/data-sovereignty-treaty) lists "Store or distribute API data without explicit permission from Native Land Digital." as prohibited, so a copy of the polygons in this repository is out. Every API request needs a key tied to one person's agreement, and a static page cannot keep a key secret. Native Land Digital's own pages disagree (one says the data can be treated as CC0, the Treaty and FAQ say otherwise), so the stricter text governs. It needs Native Land Digital's written permission first. See open item A2.
- **RUSH rain garden map data and any link to RUSH.** Excluded until RUSH agrees.
- **HydroSHEDS HydroBASINS and HydroRIVERS.** The rights review is not recorded as cleared. The rivers file is 73 MB and 500 m resolution. The Freshwater Atlas replaces both.
- **Live river gauges.** Not added. On 2026-10-21 all 26 Water Survey of Canada stations in the demo box were "Discontinued" with no real-time data, and the real-time service returned nothing for the box, so a layer would be empty. The API's own licence field also names the ECCC Data Server End-use Licence rather than OGL-Canada. Detail in [data/SOURCES.md](data/SOURCES.md).
- **Records, graph and people from the [Salish Sea Atlas](https://salishsee.life) project, and Indigenous place names.** Publishing Indigenous place names needs the Nations' permission, which has not been sought.
- **Industry and waste sites, mining footprints, species observations.** Mixed or unclear licences, facility names and sensitive locations.
- **Indian Reserves, Sensitive Ecosystems Inventory, Water Licensing Watersheds.** Held for a later decision. Water Licensing Watersheds is "Access Only", not open data.

## Adding pins

Edit [data/pins.geojson](data/pins.geojson) on GitHub or in a pull request. A pin appears only if `status` is `approved`. No invented events: a pin is added only once its organiser has confirmed it. Every property is plain text.

| Property | Meaning |
|---|---|
| `id` | short unique name |
| `kind` | `happening`, `learning-journey`, `partner-event` or `example-place` |
| `title` | shown in the popup and as the map label |
| `summary` | plain text, 300 characters or fewer |
| `date` | text, optional |
| `place_name` | text, optional |
| `url`, `url_label` | an https link and its text (the organiser's own page for partner events) |
| `source_url` | an https link to the source of the facts |
| `status` | `draft` or `approved` |

The geometry is a `Point` with `[longitude, latitude]`. For events at private homes use a public place or round to about 100 m. Do not add private addresses or named private individuals without their consent. The popup tag and the empty-state text follow `kind`, so adding a real event needs no code change. The Layers panel label still reads "Example place" and counts every pin, so rename it when real events go in. While no real pins exist, the Layers panel says "No events listed yet."

If pins later come from a Google Sheet, publish only a separate tab that holds approved rows. "Publish to the web" exposes every row of the published tab, so a status column alone does not keep drafts private. CORS on a published sheet has not been tested.

## Checks

```sh
node scripts/check-demo.mjs            # static checks, plain Node, no dependencies
node scripts/check-demo.mjs --browser  # also runs the headless browser checks
```

[scripts/check-demo.mjs](scripts/check-demo.mjs) first proves each "must not contain" rule can fire, by running it on seeded bad input, then checks this folder: no held-layer file names (native-land, rush, hydro, person), no email addresses, phone numbers, tokens or private path markers in the page, data, README and fetch script (not in LICENSE, the other scripts or the git history), every URL on an allowed host, no root-relative paths, pin rules (status, kind, https links), a size limit of 10 MB, every layer file present with valid GeoJSON inside the demo box, the licence statement, banner and credits present, and the vendored MapLibre files matching their pinned checksums. It also checks that LICENSE is the MIT text, that the README says MIT covers the code only, that the park layer has no Capital Regional District rows and no Islands Trust rows, that the credits carry each kept provider's statement (Victoria, Saanich) and the terrain lines word for word, and that the flow lines point downstream. The direction rule runs at two creek mouths, the Colquitz River at Portage Inlet and Bowker Creek at the Oak Bay shore, and its self-test feeds it reversed lines and a missing creek. A second self-test runs `scripts/make-flow.mjs` on a creek drawn the right way (it turns it around) and on one already drawn downstream (it refuses).

[scripts/browser-check.mjs](scripts/browser-check.mjs) loads the page in headless Chromium at 1280 px and 390 px wide. It needs Playwright, which is not a dependency of this folder: set `PLAYWRIGHT_MODULE` to an existing install, or leave it unset if `playwright` resolves from here. It also needs network access for the basemap and for the terrain tiles. It checks for page errors, horizontal overflow, layer toggles, the example popup, the municipality popup, the credits panel, the Fit button, and the page with the basemap blocked. For the flow and terrain layers it checks that Flow is on by default and its loop stops when the Flow or creeks box is off, when the tab is hidden and (on a phone) when zoomed out, that the dash pattern marches along vertex order on all 14 steps (a west to east test line is drawn and its pixels compared step by step), that under reduced motion Flow is off, disabled and never animates and follows the setting live, that the page contacts only the basemap host on load, and that no terrain tile is requested until Terrain shading is ticked. The page is declared ready by a `window.__ready` flag in test mode, because the map's own `loaded()` and `idle` do not settle while the dashes animate.

Not tested yet: the deployed site on a phone and a desktop (see the post-deploy checks under Hosting), Safari, Firefox, a screen reader, keyboard-only use of popups (popups open from mouse or touch only), a Sheet-fed pins layer, and the look of the flow animation in motion (its direction is checked by pixel comparison, but its speed and dash size were set from still screenshots, not watched).

## Refreshing the data

[scripts/fetch-layers.sh](scripts/fetch-layers.sh) downloads the layers from the BC Data Catalogue WFS and rebuilds `data/*.geojson` with mapshaper 0.7.93 and, for the flow lines, [scripts/make-flow.mjs](scripts/make-flow.mjs) (plain Node). Run it on a developer machine, never from the browser, then run the checks and commit. Set `FETCH=0` to reprocess already-downloaded files in `raw/` (which is not committed). On 2026-10-21 the whole script, download step included, was run from scratch. It reproduced seven of the committed layers byte for byte, changed `greenspaces.geojson` (Capital Regional District rows removed) and created `streams-flow.geojson`. The Islands Trust row was removed later, by filtering the committed file directly. The script now drops it before clipping, and because the simplifier ranks vertices across the whole layer, a full run can differ from the committed `greenspaces.geojson` by a few vertices in other parks.

## Hosting

The site is served by GitHub Pages, deployed from the `main` branch, root folder, at https://darrenzal.github.io/greater-victoria-map/. It is plain static files, so there is no build step. Every path in the page is relative, so it works under the project path. `.nojekyll` stops GitHub from running Jekyll over the files.

After each deploy:

1. Run `curl -sI -H 'Accept-Encoding: gzip'` on the three `.mjs` files under `vendor/` (`maplibre-gl.mjs`, `maplibre-gl-shared.mjs`, `maplibre-gl-worker.mjs`) and expect `content-type: text/javascript` and `content-encoding: gzip`. If `.mjs` were served with the wrong type, load MapLibre from the jsDelivr copy of 6.9.0 instead.
2. Open the page on a phone and a desktop, confirm the demo banner and attribution show, and open the example popup.

The repository is public, so its history is public too. Before pushing, run both checks and scan the repository for personal paths, email addresses and tokens. Updates: edit pins in the repository, or refresh the provincial data with the fetch script.

Visitor privacy: the page uses no analytics and no cookies. Map tiles come from tiles.openfreemap.org, so that service receives visitors' tile requests. If a visitor ticks Terrain shading, elevation tiles come from s3.amazonaws.com, so Amazon Web Services receives those requests too, and the credits say so. The tile notes say the bucket is meant for efficient use from EC2 and is not behind a CDN, so a busy public site should host pre-extracted tiles instead. A self-hosted Protomaps extract of the Greater Victoria area (about 3.6 MB at zoom 13) would remove that third-party request, but needs hosted fonts and sprites and is about a day of work.

Risks: OpenFreeMap is a single-operator service with no SLA and can change or stop without notice, the boundaries are provincial and approximate, and a public repository makes the data files and the pins history public.

## Open items

- **A1.** Park licences were read on 2026-10-21 (see [data/SOURCES.md](data/SOURCES.md)). Victoria and Saanich are kept with their statements. Two providers are removed from the map.
  - Capital Regional District. The only terms found forbid passing its data on and name no open licence, so 75 rows (27 regional parks such as Thetis Lake, Elk/Beaver Lake and East Sooke, plus parks of Metchosin and Highlands) are off the map until the CRD confirms an open licence in writing. To restore them, remove `lic!="C"` from the filter in [scripts/fetch-layers.sh](scripts/fetch-layers.sh), run the script, and add the statement the CRD specifies to the credits, the park popups and the checks.
  - Islands Trust, one row (SISȻENEM). Its terms page could not be fetched on 2026-10-21 (connection refused, twice), so its licence is unconfirmed and the row is off the map. To restore it, read the [terms page](https://islandstrust.bc.ca/mapping-resources/mapping/terms-and-conditions-of-use/) from a network that can reach it. If it grants an open licence, follow "Restoring Islands Trust" in [data/SOURCES.md](data/SOURCES.md).
  - 532 rows have no provider statement and rest on the Province's OGL-BC licence alone. Either read each municipality's terms or ship only rows with an explicit statement (401 rows).
- **A2.** Whether and how to show First Nations territories is open, including consulting the Nations (Lekwungen, W̱SÁNEĆ communities) first. The credits make no statement about territories. Native Land needs Native Land Digital's written permission before it is used in any form: its Data Sovereignty Treaty prohibits storing or distributing API data without permission, and its API key cannot be kept secret in a static page. The other sources found in the 2026-10-21 licence read are below. None is on the map, and each should be re-read before anyone relies on it.
  - Native Land Digital (territories, languages, treaties, by API): written permission from Native Land Digital, via https://native-land.ca/contact. Its pages say the data is for non-commercial and educational use, with attribution and acknowledgement of Indigenous communities as stewards. Its "What We Map" page says territories will no longer be provided through the API (undated), so languages is the likelier layer.
  - First Peoples' Map of B.C. (First Peoples' Cultural Council), https://maps.fpcc.ca/page/tos: language regions, place names and band offices. The terms are copyright with no open licence and forbid copying, merging or publishing the data. An iframe embed with acknowledgement is allowed, and API use needs approval from the Council. Language regions are not territory.
  - Reserves (Aboriginal Lands of Canada Legislative Boundaries, Natural Resources Canada, https://open.canada.ca/data/en/dataset/522b07b9-78e2-4819-b736-ad9208eb1067): Open Government Licence - Canada, usable with attribution. Legal reserve parcels under Indian Act names, not traditional territory, so how they are labelled is a Nation-relations question.
  - First Nations Location (Indigenous Services Canada points, https://open.canada.ca/data/en/dataset/b6567c5c-8339-4055-99fa-63f92114d9e4): Open Government Licence - Canada. Administrative office locations, not territory.
  - Historic Treaties (Crown-Indigenous Relations, https://open.canada.ca/data/en/dataset/f281b150-0645-48e4-9c30-01f55f93f78e): Open Government Licence - Canada. One island-wide Douglas Treaties estimate for Victoria, "for informational and representational purposes only".
  - BC Data Catalogue First Nations layers (treaty areas and lands, community locations) and BC Geographical Names with the Indigenous tag: "Access Only", so written permission from the Province is needed (its Copyright Permission Request Form).
  - Nation-published material (the W̱SÁNEĆ Leadership Council's SENĆOŦEN place names map, the Songhees, Esquimalt, T'Sou-ke and Scia'new websites, the Te'mexw Treaty Association statement of intent map): no reuse terms found, so each needs the Nation's or the body's permission. The treaty-association map shows preliminary negotiation boundaries from the early 2000s.
- **A3.** RUSH. Nothing about RUSH is included unless RUSH agrees.
- **Data edge.** The data layers end at the demo box. On a wide screen the home view shows the western edge of the data near Sooke (about 123.75 W), where layers stop and the basemap continues. A wider box costs file size.
- **Creek length.** The Freshwater Atlas has 12 named Bowker Creek segments, about 2.1 km of a creek the 2012 Blueprint measures at 9.4 km, because piped stretches are unnamed or unmapped. The popups say so.
- **Watershed sizes.** The Province draws the Bowker Creek watershed at 1,381 ha. Other sources use other figures. The watershed popup says other groups draw watersheds differently.
- **Dependency on a newer MapLibre.** MapLibre 6.9.0 is pinned because it is the version already in use and tested in the related [Salish Sea Atlas](https://salishsee.life) project. Later releases exist, and an upgrade is a later, deliberate step. Version 6.x has no UMD file, so the page loads MapLibre as an ES module.
