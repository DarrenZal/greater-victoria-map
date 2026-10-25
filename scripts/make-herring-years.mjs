#!/usr/bin/env node
// Builds one point per herring spawn location and year from the Fisheries and Oceans Canada
// "Pacific Herring Spawn Index Data" CSV (see data/SOURCES.md).
//
//   node scripts/make-herring-years.mjs raw/herring_spawn_index.csv raw/herring_years.geojson
//
// Called by scripts/fetch-time-layers.sh. Plain Node, no dependencies.
//
// What it does, in order:
// 1. Reads the CSV (one row per spawn, 31,460 rows for all of BC) and keeps the rows whose
//    point falls inside the area the map reaches (SEA_BBOX, the same box as the marine files).
//    Rows with "NA" coordinates cannot be placed and are skipped (484 of the 31,460 rows in the 2026 file,
//    anywhere in BC, so some in the map area may be missing).
// 2. Leaves out a location named for a First Nation, as the seabird colonies are in
//    scripts/fetch-layers.sh (that script's rule is /tsawwassen|tsawout/i). The map shows no
//    First Nations content and no Nation has been asked.
// 3. Groups the spawns of one location (LocationCode) and one year, so a slider shows one
//    circle per place and year, not a stack of overlapping circles.
//
// Properties of each point (all from the source, none invented):
// - year: the CSV's Year. DFO's data dictionary: Year is the herring season, 1 July to 30 June,
//   so 2020 is the 2019/2020 season. It is NOT the calendar year the spawn happened in.
// - name: LocationName exactly as published (DFO's abbreviations, "Hrbr", "Pt", "Is", kept).
// - spawns: how many spawn records were grouped.
// - index_t: spawn index in tonnes, the sum over the records of Surface + Macrocystis +
//   Understory (the three survey types), skipping "NA". This is the sum DFO's technical report
//   makes (Canadian Technical Report of Fisheries and Aquatic Sciences 3489, equation 33,
//   "we add the spawn indices from the three types of survey observations"). null where no
//   record had an index. It is a relative index and a minimum estimate of spawning biomass
//   (report, caveats 1 and 2), not a count of fish.
// - no_index: how many of the grouped records had no index at all ("NA": incomplete or withheld,
//   including Method "Incomplete"). When this is above 0, index_t is the sum of the others only.
// - length_m: the sum of the records' Length (spawn length along the shoreline, metres).
// - method: Surface, Dive, Incomplete, or Mixed when the grouped records differ.
import { readFileSync, writeFileSync } from 'node:fs'

const SEA = { w: -124.4, s: 47.9, e: -122.7, n: 49.1 }
const FIRST_NATION_NAME = /tsawwassen|tsawout/i

const args = process.argv.slice(2)
if (args.length !== 2) { console.error('usage: node make-herring-years.mjs <spawn-index.csv> <out.geojson>'); process.exit(2) }

// A small CSV reader that handles quoted fields and quotes inside quotes.
function parseCsv(text) {
  const rows = []
  let row = [], field = '', q = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++ } else q = false } else field += c
    } else if (c === '"') q = true
    else if (c === ',') { row.push(field); field = '' }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = '' }
    else if (c !== '\r') field += c
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row) }
  return rows
}

const text = readFileSync(args[0], 'utf8').replace(/^﻿/, '')
const [head, ...body] = parseCsv(text)
const col = Object.fromEntries(head.map((h, i) => [h.trim(), i]))
for (const need of ['Year', 'LocationCode', 'LocationName', 'Longitude', 'Latitude', 'Length', 'Method', 'Surface', 'Macrocystis', 'Understory']) {
  if (!(need in col)) { console.error(`the CSV has no ${need} column, got: ${head.join(', ')}`); process.exit(1) }
}
const num = (v) => (v === undefined || v === '' || v === 'NA' || !Number.isFinite(Number(v)) ? null : Number(v))

const groups = new Map()
let inBox = 0, noCoord = 0, droppedFirstNation = 0
for (const r of body) {
  if (r.length < head.length) continue
  const lon = num(r[col.Longitude]), lat = num(r[col.Latitude])
  if (lon === null || lat === null) { noCoord++; continue }
  if (lon < SEA.w || lon > SEA.e || lat < SEA.s || lat > SEA.n) continue
  inBox++
  const name = r[col.LocationName].trim()
  if (FIRST_NATION_NAME.test(name)) { droppedFirstNation++; continue }
  const year = Number(r[col.Year])
  if (!Number.isInteger(year)) { console.error(`bad Year "${r[col.Year]}"`); process.exit(1) }
  const key = `${r[col.LocationCode]}|${year}`
  let g = groups.get(key)
  if (!g) { g = { lon, lat, name, year, spawns: 0, idx: null, noIdx: 0, len: null, methods: new Set() }; groups.set(key, g) }
  g.spawns++
  const parts = [num(r[col.Surface]), num(r[col.Macrocystis]), num(r[col.Understory])].filter((v) => v !== null)
  if (parts.length) g.idx = (g.idx ?? 0) + parts.reduce((a, b) => a + b, 0)
  else g.noIdx++
  const len = num(r[col.Length])
  if (len !== null) g.len = (g.len ?? 0) + len
  g.methods.add(r[col.Method].trim())
}

const r4 = (v) => Math.round(v * 1e4) / 1e4
const features = [...groups.values()]
  .sort((a, b) => a.year - b.year || a.name.localeCompare(b.name))
  .map((g) => ({
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [r4(g.lon), r4(g.lat)] },
    properties: {
      year: g.year,
      name: g.name,
      spawns: g.spawns,
      index_t: g.idx === null ? null : Number(g.idx.toPrecision(3)),
      no_index: g.noIdx,
      length_m: g.len === null ? null : Math.round(g.len),
      method: g.methods.size === 1 ? [...g.methods][0] : 'Mixed',
    },
  }))

writeFileSync(args[1], JSON.stringify({ type: 'FeatureCollection', features }))
const years = [...new Set(features.map((f) => f.properties.year))].sort((a, b) => a - b)
console.error(`rows in area: ${inBox}, skipped for NA coordinates: ${noCoord}, left out for a First Nation name: ${droppedFirstNation}`)
console.log(`${args[1]}: ${features.length} location-years, ${years.length} years (${years[0]} to ${years[years.length - 1]})`)
