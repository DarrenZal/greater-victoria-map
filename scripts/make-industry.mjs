#!/usr/bin/env node
// Builds data/industry-waste.geojson from a Salish Sea Atlas snapshot of industry and waste sites.
//
//   node scripts/make-industry.mjs <material-sites-salish.json> data/industry-waste.geojson
//
// Plain Node, no dependencies. The snapshot is a file in the Salish Sea Atlas
// project (atlas/public/material/), which merges several publishers' records
// into one point per site. This script keeps only what can be shown here:
//
// - sites inside the demo box (west -123.75, south 48.28, east -123.20, north 48.70);
// - records from the sources in OPEN below, whose licences were read as open
//   with an attribution duty (OGL-Canada, CC BY 4.0). A record from any other
//   source is dropped, even when it sits on a site that has an open record, so
//   the Climate TRACE rows (their terms list external datasets with other
//   terms), IMF PortWatch (IMF terms), EPA LMOP (US only) and the Maus et al.
//   mining footprints (CC BY-SA) never reach the output;
// - not the "river" kind: those points are modelled river-plastic outfalls with no
//   name, not sites;
// - not sites named for a First Nation (EXCLUDED_NAMES). This demo has no First
//   Nations content and has not asked any Nation, so the name is left out;
// - positions are kept as the sources give them.
//
// Every number keeps its basis in words (reported, capacity, modelled), so a
// dot with no number is never read as an empty site and a model is never read
// as a measurement.
import { readFileSync, writeFileSync } from 'node:fs'

const BBOX = [-123.75, 48.28, -123.20, 48.70]
const OPEN = {
  'statcan-odi-solid-waste': 'odi',
  hydrowaste: 'hydrowaste',
  'wri-gppd': 'gppd',
}
const EXCLUDED_NAMES = [/^tsawout\b/i]
const KINDS = new Set(['landfill', 'power', 'wastewater'])
// Names the source spells wrongly, shown as corrected with the original kept.
const NAME_FIXES = { 'Hartland Lanfill': 'Hartland Landfill' }

const [inPath, outPath] = process.argv.slice(2)
if (!inPath || !outPath) { console.error('usage: node scripts/make-industry.mjs <material-sites-salish.json> <industry-waste.geojson>'); process.exit(2) }

const snap = JSON.parse(readFileSync(inPath, 'utf8'))
const inBox = ([x, y]) => x >= BBOX[0] && x <= BBOX[2] && y >= BBOX[1] && y <= BBOX[3]
const num = (n) => Number(n).toLocaleString('en-CA', { maximumFractionDigits: 1 })
const features = []
const dropped = { kind: 0, name: 0, noOpenRecord: 0, outside: 0 }
for (const f of snap.features || []) {
  const p = f.properties || {}
  if (f.geometry?.type !== 'Point' || !inBox(f.geometry.coordinates)) { dropped.outside++; continue }
  if (!KINDS.has(p.kind)) { dropped.kind++; continue }
  const records = (p.records || []).filter((r) => OPEN[r.source])
  if (!records.length) { dropped.noOpenRecord++; continue }
  const rec = records[0]
  const rawName = rec.name ? rec.name.replace(/\s+/g, ' ').trim() : null
  if (rawName && EXCLUDED_NAMES.some((re) => re.test(rawName))) { dropped.name++; continue }
  const name = rawName ? (NAME_FIXES[rawName] || rawName) : null
  const out = {
    name,
    kind: p.kind,
    type: rec.type || null,
    status: rec.status || null,
    src: OPEN[rec.source],
  }
  if (name && name !== rawName) out.listed_as = rawName
  const capacity = [], notes = []
  for (const m of rec.measures || []) {
    if (!Number.isFinite(m.value)) continue
    if (m.source_field === 'WASTE_DIS') capacity.push(`Treated wastewater discharged: ${num(m.value)} m3 per day (reported as treated flow by the national dataset)`)
    else if (m.source_field === 'POP_SERVED') capacity.push(`Population served: about ${num(m.value)} people (a HydroWASTE estimate, modelled, not counted)`)
    else if (m.basis === 'capacity') capacity.push(`Installed capacity: ${num(m.value)} ${m.unit} (capacity, not output)`)
    else capacity.push(`${m.metric || 'Measure'}: ${num(m.value)} ${m.unit} (${m.basis})`)
  }
  // The location sentence keeps the source's own rating and test result. The
  // estimated outfall position that follows it in the snapshot is not used.
  const loc = (rec.geometry_note || '').match(/QUAL_LOC=\d (\w+): (.*?)(?:;|$)/)
  if (loc) notes.push(`HydroWASTE rates the accuracy of this location as ${loc[1]}: ${loc[2]}.`)
  for (const n of rec.notes || []) {
    const url = n.match(/\((https:\/\/[^)\s]+)\)\s*$/)
    if (url) out.note_url = url[1]
    notes.push(n.replace(/\s*\(https:\/\/[^)\s]+\)\s*$/, ''))
  }
  if (capacity.length) out.facts = capacity.join(' | ')
  if (notes.length) out.note = notes.join(' ')
  const [x, y] = f.geometry.coordinates
  features.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [Math.round(x * 1e5) / 1e5, Math.round(y * 1e5) / 1e5] }, properties: out })
}
features.sort((a, b) => a.properties.kind.localeCompare(b.properties.kind) || String(a.properties.name).localeCompare(String(b.properties.name)))
writeFileSync(outPath, '{"type":"FeatureCollection","features":[\n' + features.map((f) => JSON.stringify(f)).join(',\n') + '\n]}\n')
const byKind = features.reduce((a, f) => ((a[f.properties.kind] = (a[f.properties.kind] || 0) + 1), a), {})
console.log(`industry-waste: ${features.length} sites ${JSON.stringify(byKind)}; dropped ${JSON.stringify(dropped)} -> ${outPath}`)
