# River gauges: fixture and reading contract

Replies of Environment and Climate Change Canada's hydrometric collections as the map asked them on 2026-11-08, cases made from them, and the record the map's [`gaugeReading`](../../../js/overlays-data.js) gives for each. It is for any reader of the same gauges, the Salish Sea Atlas first. [check-demo.mjs](../../check-demo.mjs) fails if the code and these cases drift apart, and [browser-check.mjs](../../browser-check.mjs) (`--only "gauge states"`) draws them on the map.

## The record

One per gauge asked, including a gauge that gave no reading.

- `station`, `name`, `contributor`: as `hydrometric-stations` gives them (`STATION_NUMBER`, `STATION_NAME`, `CONTRIBUTOR_EN`).
- `datum`: the station's `VERTICAL_DATUM`, word for word. All 14 stations here say "ASSUMED DATUM".
- `coords`: [longitude, latitude] of the station. `km`: straight-line distance from downtown Victoria (48.4284, -123.3656), rounded.
- `state`: `current`, `stale` or `missing`. `missing` says why: `no answer` (the request failed), `no record` (no record in the collection's last 30 days), `no time` (the record has no time that parses) or `no value` (no level and no flow). Otherwise it is null.
- `measuredAt`: the record's `DATETIME`, in UTC. This is when the gauge measured. `askedAt`: when the map asked, by the asking machine's clock.
- `level`: `{ value, unit: "m", symbol }` and `discharge`: `{ value, unit: "m³/s", symbol }`. Each is null when the record has no number for it, and both are null when the gauge is missing.
- `preliminary`: always true. `source`: the station's Water Office page.

## Rules

- R1. Stale: measured more than 3 hours (10,800,000 ms) before it was asked. Exactly 3 hours is still current. The Water Office disclaimer says these data "are normally posted (in graphical form) within two hours of observation", so 3 hours is an hour past that. The Atlas's own rule is also 3 hours.
- R2. Every reading is preliminary. The same disclaimer says: "The data are preliminary and have been transmitted automatically with limited verification and review for quality assurance. Subsequent quality assurance and verification procedures may result in differences between what is currently displayed and what will become the official record."
- R3. A symbol (`LEVEL_SYMBOL_EN`, `DISCHARGE_SYMBOL_EN`) is kept word for word and never interpreted. MSC's description of the datamart's symbol column says "Future use", and none of the 1,433 stations in one reply for 23:10 UTC on 2026-11-07 had one. The `symbol-kept` case uses a made-up symbol for that reason.
- R4. A level is in metres above the station's own datum ("ASSUMED DATUM"). So two stations' levels are never compared, and a level is never compared with a tide height or chart datum.
- R5. The units are as published: level in metres ("Water Level (m)"), flow in cubic metres a second ("Discharge (cms)").

## Source, rights, coverage

- Stations: `https://api.weather.gc.ca/collections/hydrometric-stations/items?f=json&bbox=-124.4,47.9,-122.7,49.1&limit=200&STATUS_EN=Active`, asked at 2026-11-08T00:19:49.784Z.
- Readings: `https://api.weather.gc.ca/collections/hydrometric-realtime/items?f=json&STATION_NUMBER=<n>&limit=1&sortby=-DATETIME`, one request for each of the 5 nearest gauges, asked between 00:19:50.2Z and 00:19:50.6Z. The URL and time of each are in the file.
- The collection says: "Real-time water level and flow (discharge) data collected at over 2100 hydrometric stations across Canada (last 30 days)." The API has no version number, so the record of when each reply was asked is the version.
- Rights: the Environment and Climate Change Canada Data Services End-use Licence, its own licence and not the Open Government Licence – Canada. The map credits "Data Source: Environment and Climate Change Canada." The Water Office disclaimer adds: "An appropriate byline acknowledging Environment Canada is required." The licence wording the map read is in [data/SOURCES.md](../../../data/SOURCES.md).
- Coverage: the box holds 14 active ECCC stations, all Canadian, all real-time. The 5 nearest downtown are 40 to 57 km away: Koksilah River at Cowichan Station, Cowichan River near Duncan, Bings Creek, Chemainus River near Westholme and Garbage Creek. None is in Greater Victoria. On 2026-10-21, all 26 Water Survey of Canada stations in the map's demo box were discontinued. The reply holds no US station, though the box reaches into Washington.
- Sources read 2026-11-08: the Water Office disclaimer, in the HTML of https://wateroffice.ec.gc.ca/report/real_time_e.html?stn=08HA011 (page modified 2026-09-11), and https://eccc-msc.github.io/open-data/msc-data/obs_hydrometric/readme_hydrometric-datamart_en/.

## Files

| File | What | Bytes | sha256 |
|---|---|---|---|
| stations.json | The station reply as it came, with its URL and when it was asked | 38,755 | `631251ac2e8828d5386184e2e8add45eb26582a51f8205cc48feb94a80ff0650` |
| readings.json | The 5 reading replies as they came, each with its URL and when it was asked | 11,138 | `01d8bc9fbb58185aba2e27ea644472bcf5b59290a4a786c2547352b8e57455b7` |
| level-only.json | One record, kept as it came, from a nationwide reply for one time. It is a real level with no flow (Trout River, far outside the map). That reply was asked once, to look for symbols | 999 | `24d2ecd2f654a7cc467d41182edcae5e5c452e0e5f123ecaac7c72c7f23d1293` |
| cases.json | 12 cases: each input, the time it was asked, and the expected record | 31,152 | `9925a1e093637de10052521cc5fc74608cc84c31eb443f02b269cfed4845fbd8` |

There are 6 recorded cases: the 5 replies and the level-only record. The other 6 are derived:
- Stale, at 3 hours and 1 minute.
- Current, at exactly 3 hours.
- The three missing reasons other than `no time`.
- A made-up symbol.

The cases were written by the map's `gaugeReading` and checked by hand.

## For the Atlas

The Atlas's adapter at origin/main 69ba399 already does R1, R2 and R5. In [gateway/observations.mjs](https://github.com/BioregionalKnowledgeCommons/salish-sea-atlas/blob/main/gateway/observations.mjs), `normalizeCanadianWater` gives the Water Office link, `observedAt` and `sourceFetchedAt`, and `provisional: true`. `observationReadingStatus` in site/shared/observation-state.js gives stale after 3 hours, `empty` and `time-unknown`. Three changes would meet this contract. Each is the Atlas owner's to make or not:

- A1. Keep `LEVEL_SYMBOL_EN` and `DISCHARGE_SYMBOL_EN` word for word on each measurement when they are not null. It drops them now.
- A2. Keep a station that gives no reading, as missing, with its reason.
  - Now the five Canadian stations are asked inside one `Promise.all`, so one failed request makes the whole source `unavailable` and hides all five.
  - A station whose reply has no record is left out without a word.
  - A missing station needs a position. The Atlas could take it from stations.json at this pin, or ask `hydrometric-stations`.
- A3. Carry `VERTICAL_DATUM`. Its label "Water level (station datum)" fits, and the datum here is "ASSUMED DATUM".

To test, run its normaliser over each case's `input.reply` with `askedAt` as now, and compare with `expected`. The states map like this:

| This contract | Atlas state |
|---|---|
| `current` | `available` |
| `stale` | `stale` |
| `missing` `no value` | `empty` |
| `missing` `no time` | `time-unknown` |
| `missing` `no record`, `missing` `no answer` | none yet (A2) |

Not asked:
- Asking for 08HA016, 08HA001 and 08HA068 too. Its list is 08HA002, 08HA003, 08HA011, 08HB034 and 08MH024. Changing it changes the readings lane's identity hash, so it is the owner's call.
- Any edit to Atlas UI, or to its pins of other layers.

## Do not infer

- Calibration, or that a reading will stand. ECCC calls these readings preliminary, with limited verification.
- Anything about water quality or pollution. These gauges measure level and flow only.
- The level or flow now, from a stale reading.
- Coverage of Greater Victoria or the region. These are five gauges 40 to 57 km away, and no creek in Greater Victoria has one here.
- A comparison of levels between stations.
- A meaning for a symbol.

## Still missing

- No real-time ECCC gauge in Greater Victoria. Other gauges (the CRD's or a town's) were not looked for, since finding them would be new collection.
- No real symbol has been seen, and the meaning of its values was not found.
- The datamart's CSV gives each reading a QA/QC flag: "1 = preliminary, 2 = reviewed, 3 = checked, 4 = approved". The API gives no such flag, so nothing here uses it.
- US gauges are not in this contract. The Atlas has its own USGS adapter.
