#!/usr/bin/env node
// Writes data/herring-spawn-before-1951.geojson: herring spawn by shore section and season before 1951, the first season of DFO's Pacific
// Herring Spawn Index Data (data/herring-spawn-years.geojson). Plain Node, no dependencies.
//
//   node scripts/make-herring-early.mjs data/herring-spawn-before-1951.geojson
//
// The figures are typed from one report, read as page images on 2026-10-27:
//   D. E. Hay, P. B. McCarter, R. Kronlund and C. Roy, 1989. Spawning areas of British Columbia herring: a review, geographical analysis
//   and classification. Volume V. Strait of Georgia. Canadian Manuscript Report of Fisheries and Aquatic Sciences 2019.
//   https://publications.gc.ca/collections/collection_2026/mpo-dfo/fs97-4/Fs97-4-2019-5-eng.pdf
// - Table 185-3 (report page 223, PDF page 231), section 185, Saanich Inlet (191 in DFO's numbering today).
// - Table 193-3 (report page 243, PDF page 251), section 193, Victoria Harbour, which includes Esquimalt Harbour and Portage Inlet.
// - Table 191-4 (report page 229, PDF page 237), section 191 of 1989, Sidney Channel: "Only one record of spawning has been made for
//   section 191, in Sidney Channel, April 14, 1932." Its tables begin in 1937, so this record has no figures but its date.
// Section 202, Sooke, has no record before 1951 in the report, and Cordova Bay none either.
//
// The report gives no places within a section, so each feature is a point with a radius that covers the section's spawning area as the
// report names it, from the positions in DFO's own location index (Herring Geographical Bulletin, Internet Archive copy of 2013-09-16,
// https://web.archive.org/web/20130916090235/http://www.pac.dfo-mpo.gc.ca:80/science/species-especes/pelagic-pelagique/herring-hareng/herspawn/locindex-eng.html):
// - Victoria Harbour: the report's "Portage Inlet-Esquimalt Harbour vicinity". The middle of Portage Inlt (Gorge) (48.4619, -123.414)
//   and Esquimalt Hrbr (48.4363, -123.447), 1.9 km from each, so a radius of 2.2 km.
// - Saanich Inlet: the report's two areas, "Pat Bay-Tod Inlet" and "Goldstream Flats". The middle of Patricia Bay (48.6665, -123.465)
//   and Goldstream Flats (48.4997, -123.548), 9.8 km from each, so a radius of 10 km.
// - Sidney Channel: Sidney Chnl (48.62, -123.3), given to two decimals, so a radius of 3 km.
//
// Properties (from the tables, none invented):
// - year: the report's year, the calendar year of the spawn. Spawning is from February to April, so it is DFO's herring season of the
//   same number (1937 is the 1936/1937 season).
// - name: the section as the map calls it. table: where the figures are.
// - records: total spawn records. places: the number of different spawning locations used ("Ind loc").
// - length_m: the total length of spawn in metres. width_m: the average width in metres, null where the table gives 0 (1937 to 1941).
// - intensity: the average intensity. The report's scale runs from 1 (very light) to 9 (very heavy), but DFO's Technical Report 3489
//   (https://waves-vagues.dfo-mpo.gc.ca/library-bibliotheque/41216787.pdf) says that from 1928 to 1968 there were five categories, very
//   light to very heavy, numbered 1 to 5, which is the range of these seasons.
// - first_day, last_day: the earliest and latest spawn date, as the day of the year (1 January is day 1).
// - date: the one dated record of Sidney Channel. r_m: the radius the map draws, in metres.
import { writeFileSync } from 'node:fs'

const SECTIONS = {
  'Victoria Harbour': { at: [-123.4305, 48.4491], r_m: 2200, table: '193-3' },
  'Saanich Inlet': { at: [-123.5065, 48.5831], r_m: 10000, table: '185-3' },
  'Sidney Channel': { at: [-123.3, 48.62], r_m: 3000, table: '191-4' },
}
// year, records, sum length (m), average width (m), average intensity, min day, max day, locations. Seasons with no record are left out.
const ROWS = {
  'Victoria Harbour': [
    [1937, 2, 676, 0, 5.0, 60, 74, 2],
    [1938, 2, 676, 0, 5.0, 46, 69, 2],
    [1939, 3, 859, 0, 4.3, 69, 84, 3],
    [1940, 2, 676, 0, 5.0, 65, 72, 2],
    [1941, 3, 859, 0, 3.7, 64, 75, 3],
    [1942, 1, 91, 23, 5.0, 60, 60, 1],
    [1943, 1, 91, 23, 5.0, 60, 60, 1],
    [1944, 1, 91, 23, 3.0, 61, 61, 1],
    [1946, 2, 46, 23, 2.0, 74, 100, 2],
    [1947, 4, 160, 15, 3.0, 58, 79, 3],
    [1948, 3, 115, 21, 1.0, 73, 83, 3],
    [1949, 3, 145, 18, 1.0, 71, 89, 3],
    [1950, 3, 164, 27, 1.0, 84, 87, 3],
  ],
  'Saanich Inlet': [
    [1937, 3, 548, 0, 5.0, 96, 113, 2],
    [1945, 2, 457, 115, 3.0, 85, 86, 1],
    [1946, 2, 2066, 55, 3.0, 79, 79, 2],
    [1947, 1, 457, 69, 5.0, 97, 97, 1],
    [1948, 4, 1673, 16, 3.5, 89, 99, 2],
    [1949, 1, 320, 160, 3.0, 98, 98, 1],
    [1950, 3, 325, 25, 2.3, 105, 105, 3],
  ],
}

const out = process.argv[2]
if (!out) { console.error('usage: node scripts/make-herring-early.mjs <out.geojson>'); process.exit(1) }
const feature = (name, props) => {
  const s = SECTIONS[name]
  return { type: 'Feature', geometry: { type: 'Point', coordinates: s.at }, properties: { name, table: s.table, ...props, r_m: s.r_m } }
}
const features = [feature('Sidney Channel', { year: 1932, records: 1, places: null, length_m: null, width_m: null, intensity: null, first_day: null, last_day: null, date: '1932-04-14' })]
for (const [name, rows] of Object.entries(ROWS)) for (const [year, records, length, width, intensity, first, last, places] of rows) {
  features.push(feature(name, { year, records, places, length_m: length, width_m: width || null, intensity, first_day: first, last_day: last, date: null }))
}
features.sort((a, b) => a.properties.year - b.properties.year || a.properties.name.localeCompare(b.properties.name))
writeFileSync(out, `{"type":"FeatureCollection","features":[\n${features.map((f) => JSON.stringify(f)).join(',\n')}\n]}\n`)
console.log(`${features.length} section seasons written to ${out}`)
