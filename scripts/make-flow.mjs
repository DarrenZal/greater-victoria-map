#!/usr/bin/env node
// Builds data/streams-flow.geojson, the lines the animated "Flow" layer draws.
//
//   node scripts/make-flow.mjs raw/streams_keyed.geojson data/streams-flow.geojson
//
// Called by scripts/fetch-layers.sh. Plain Node, no dependencies.
//
// Three things are done here because the Freshwater Atlas stream lines are not
// ready to animate as they come:
//
// 1. Direction. In the Freshwater Atlas the first vertex of a segment is its
//    DOWNSTREAM end (route measure counts up from the mouth), so vertex order
//    runs upstream. MapLibre marches a dash pattern along vertex order, so the
//    lines are reversed here: the last vertex of every output line is the
//    downstream end. Measured on 2026-10-21 from the vertex heights in the raw
//    download: of the 592 named segments in the demo box, the last vertex was
//    higher than the first on 401, lower on 4, and within half a metre on 187.
//    This script re-checks the assumption on every run and stops if it no
//    longer holds, using the distance-from-mouth field the Province publishes.
// 2. Joins. A dash pattern restarts at every feature, which shows as a flicker
//    where two segments meet. Segments of one stream that share an end point
//    are joined into one continuous line. A line also ends where the stream
//    order changes, so the width stays the same along a line.
// 3. Open flow only. Only edge types that are open channels are kept (1000
//    single line, 1050 through a wetland, 1200 construction line through a lake,
//    1250 construction line through a double-line river, 2000 single line canal).
//    Reaches the Province maps as underground flow (1425) and connection lines
//    (1450) get no dashes, so a pipe is never shown as a flowing creek. Canals
//    (2000) were left out in the first version and added on 2026-10-21, so
//    that creeks such as Bowker Creek show their mapped open channel.
import { readFileSync, writeFileSync } from 'node:fs'

const OPEN_FLOW = new Set([1000, 1050, 1200, 1250, 2000])
const [inPath, outPath] = process.argv.slice(2)
if (!inPath || !outPath) { console.error('usage: node scripts/make-flow.mjs <streams_keyed.geojson> <streams-flow.geojson>'); process.exit(2) }

const fc = JSON.parse(readFileSync(inPath, 'utf8'))
const pieces = []
for (const f of fc.features || []) {
  const p = f.properties || {}
  if (!OPEN_FLOW.has(p.edge)) continue
  const parts = f.geometry?.type === 'LineString' ? [f.geometry.coordinates] : f.geometry?.type === 'MultiLineString' ? f.geometry.coordinates : []
  for (const coords of parts) if (coords.length >= 2) pieces.push({ coords, name: p.name, order: p.order, key: p.key, measure: p.measure, used: false })
}

const pt = (c) => c[0] + ',' + c[1]
// Pieces of one stream (BLUE_LINE_KEY) with one stream order, indexed by their first vertex.
const group = (p) => p.key + ':' + p.order
const byFirst = new Map()
for (const p of pieces) {
  const k = group(p) + '@' + pt(p.coords[0])
  if (!byFirst.has(k)) byFirst.set(k, [])
  byFirst.get(k).push(p)
}
const hasPred = new Set()
for (const p of pieces) for (const q of byFirst.get(group(p) + '@' + pt(p.coords.at(-1))) || []) if (q !== p) hasPred.add(q)

const chains = []
let pairs = 0, consistent = 0
function walk(start) {
  const chain = [start]
  start.used = true
  for (let cur = start; ;) {
    const next = (byFirst.get(group(cur) + '@' + pt(cur.coords.at(-1))) || []).filter((q) => q !== cur && !q.used).sort((a, b) => a.measure - b.measure)[0]
    if (!next) break
    pairs++
    if (next.measure >= cur.measure - 1) consistent++
    next.used = true
    chain.push(next)
    cur = next
  }
  chains.push(chain)
}
for (const p of pieces) if (!hasPred.has(p) && !p.used) walk(p)
for (const p of pieces) if (!p.used) walk(p) // loops and branches left over

// Direction guard. If vertex order really runs upstream, the distance from the
// mouth never falls from one piece to the next one along a chain.
if (pairs === 0 || consistent / pairs < 0.95) {
  console.error(`direction check failed: distance from the mouth rises along vertex order on ${consistent} of ${pairs} joins, expected nearly all. The Province may have changed the line direction. Do not publish until this is understood.`)
  process.exit(1)
}

const features = chains.map((chain) => {
  const coords = []
  for (const p of chain) coords.push(...(coords.length ? p.coords.slice(1) : p.coords))
  coords.reverse() // last vertex is now the downstream end
  return { type: 'Feature', properties: { name: chain[0].name, order: chain[0].order }, geometry: { type: 'LineString', coordinates: coords } }
})
features.sort((a, b) => a.properties.name.localeCompare(b.properties.name) || a.properties.order - b.properties.order)

writeFileSync(outPath, '{"type":"FeatureCollection","features":[\n' + features.map((f) => JSON.stringify(f)).join(',\n') + '\n]}\n')
console.log(`streams-flow: ${pieces.length} open-flow pieces joined into ${features.length} lines, direction check ${consistent}/${pairs} joins -> ${outPath}`)
