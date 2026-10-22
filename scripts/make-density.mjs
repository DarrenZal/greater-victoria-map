#!/usr/bin/env node
// Builds one file of modelled whale and porpoise numbers from the three downloads of the
// Fisheries and Oceans Canada PRISMM density models (see data/SOURCES.md).
//
//   node scripts/make-density.mjs raw/density_dalls.json raw/density_harbour.json raw/density_humpback.json raw/density_merged.geojson
//
// Called by scripts/fetch-layers.sh. Plain Node, no dependencies.
//
// The service holds one layer for each species, and the three layers are the same 223 grid cells in
// the Salish Sea (cells of 25 km2, cut at the coast). Rather than send the same shapes three times,
// this joins them into one cell file that carries each species' own numbers:
//
// - km2: the area of the cell, to 3 significant figures. Cells cut by the coast are smaller than 25 km2, and the smallest is
//   about 0.005 km2.
// - <species>_n: "Nhat", the number of animals the model predicts in the cell (the service's own value).
// - <species>_cv: the coefficient of variation of that prediction. Higher means less certain.
//
// The cells must match one for one. If the three layers ever differ in a cell, its area or its shape,
// the script stops rather than guess, because a number written against the wrong cell would be a false
// map. Nhat is kept to 3 significant figures and the CV to 2 decimals.
import { readFileSync, writeFileSync } from 'node:fs'

const SPECIES = ['dalls', 'harbour', 'humpback']
const args = process.argv.slice(2)
if (args.length !== 4) { console.error('usage: node scripts/make-density.mjs <dalls.json> <harbour.json> <humpback.json> <out.geojson>'); process.exit(2) }
const [outPath] = args.slice(3)
const layers = SPECIES.map((_, i) => JSON.parse(readFileSync(args[i], 'utf8')).features)

const n = layers[0].length
if (!n || layers.some((l) => l.length !== n)) { console.error(`the three layers must hold the same cells, got ${layers.map((l) => l.length).join(', ')}`); process.exit(1) }
const features = layers[0].map((f, i) => {
  const p = { km2: Number((f.properties.area_m2 / 1e6).toPrecision(3)) }
  SPECIES.forEach((sp, k) => {
    const g = layers[k][i], q = g.properties
    if (q.OBJECTID !== f.properties.OBJECTID || q.area_m2 !== f.properties.area_m2 || JSON.stringify(g.geometry) !== JSON.stringify(f.geometry)) {
      console.error(`cell ${i} differs between the ${SPECIES[0]} and ${sp} layers`); process.exit(1)
    }
    if (!Number.isFinite(q.Nhat) || q.Nhat < 0 || !Number.isFinite(q.CV) || q.CV < 0) { console.error(`cell ${i} has no usable ${sp} number`); process.exit(1) }
    p[`${sp}_n`] = Number(q.Nhat.toPrecision(3))
    p[`${sp}_cv`] = Math.round(q.CV * 100) / 100
  })
  return { type: 'Feature', properties: p, geometry: f.geometry }
})
writeFileSync(outPath, JSON.stringify({ type: 'FeatureCollection', features }))
console.log(`${outPath}: ${features.length} cells, ${features.reduce((a, f) => a + f.properties.km2, 0).toFixed(0)} km2 in all`)
