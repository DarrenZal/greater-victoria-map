#!/usr/bin/env node
// Static checks for the Greater Victoria demo map. Plain Node, no dependencies.
//
//   node scripts/check-demo.mjs            static checks
//   node scripts/check-demo.mjs --browser  also run scripts/browser-check.mjs
//
// Every "forbids" rule has a positive twin: before the real tree is checked,
// each rule is run on a seeded bad input and must fire, and on a clean input
// and must stay quiet. A rule that cannot fire would otherwise pass silently.
import { readFileSync, writeFileSync, mkdtempSync, rmSync, readdirSync, statSync, existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, relative, dirname, basename, extname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const BBOX = [-123.75, 48.28, -123.20, 48.70]
const SIZE_LIMIT = 10 * 1024 * 1024
const BANNER = 'A test of what an open, self-hostable map can do. It is not an official map of any group.'
const PINS_EMPTY = 'No events listed yet.'
const LAYER_FILES = ['municipalities', 'bc-parks', 'greenspaces', 'streams', 'streams-flow', 'lakes', 'wetlands', 'watersheds', 'bec', 'pins']
const PIN_KINDS = ['happening', 'learning-journey', 'partner-event', 'example-place']
const PIN_STATUS = ['draft', 'approved']
// Hosts the page may name. Most appear only as credit links. The two the page
// fetches from at run time are tiles.openfreemap.org (basemap) and
// s3.amazonaws.com (terrain tiles, only after the Terrain shading box is ticked).
const ALLOWED_HOSTS = [
  'tiles.openfreemap.org', 'openfreemap.org', 'www2.gov.bc.ca', 'www.openstreetmap.org',
  'www.openmaptiles.org', 'crd.ca', 'www.crd.ca', 'catalogue.data.gov.bc.ca',
  'opendata.victoria.ca', 'www.saanich.ca',
  's3.amazonaws.com', 'registry.opendata.aws', 'github.com', 'open.canada.ca',
]
// Where two creeks reach the sea. Flow lines must END there: the last vertex is
// the downstream end, and MapLibre marches the dashes toward it.
const FLOW_MOUTHS = [
  { name: 'Colquitz River', at: [-123.41134, 48.45947], where: 'Portage Inlet' },
  { name: 'Bowker Creek', at: [-123.30658, 48.42922], where: 'the Oak Bay shore' },
]
const FLOW_TOLERANCE_M = 300
// Statements each kept park provider specifies. The credits must carry them word for word.
const PROVIDER_STATEMENTS = [
  'Contains information licensed under the Open Government Licence \u2013 City of Victoria.',
  'Contains information licenced under the Open Government Licence \u2013 District of Saanich.',
]
const TERRAIN_STATEMENTS = [
  'Canada terrain data contains information licensed under the Open Government Licence \u2013 Canada.',
  'United States 3DEP (formerly NED) and global GMTED2010 and SRTM terrain data courtesy of the U.S. Geological Survey.',
  'Global ETOPO1 terrain data U.S. National Oceanic and Atmospheric Administration.',
]
const VENDOR_SHA256 = {
  'vendor/maplibre-gl.mjs': '0197eee4c6e8fd5d8b68f5f94a23e1c77e0c8fd054c377a280bcd08117aadfc4',
  'vendor/maplibre-gl-shared.mjs': '0aa7432c2d4644e8f46158cc99d0a05e0bf5db98afe6ded2b258a68dcc91bb90',
  'vendor/maplibre-gl-worker.mjs': '836616cb05bef91f9c7f3920ee2aeef648b81cee0645a037e70365286009ac98',
  'vendor/maplibre-gl.css': '8e2dbbab312dc57656fbb76e9fa5308c75c9d7c7ba5808a7d55bcdb64cc813fa',
}

// ---------------------------------------------------------------- forbid rules
// Each rule takes [{ path, text }] (text null for binary) and returns findings.

const BAD_NAME = /native-?land|rush|hydro|person/i
function ruleForbiddenNames(files) {
  return files.filter((f) => BAD_NAME.test(f.path)).map((f) => `file name matches a held layer: ${f.path}`)
}

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/
const PHONE = /(?:\+?1[ .-])?\(?\b\d{3}\)?[ .-]\d{3}[ .-]\d{4}\b/
const PRIVATE_MARKERS = [/Meetings\//, /vault/i, /\/Users\//, /(^|[\s"'(])~\//]
const TOKEN = /\b(?:sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{20,}|xox[abp]-[A-Za-z0-9-]{10,})\b/
function rulePrivacy(files) {
  const out = []
  for (const f of files) {
    if (f.text == null) continue
    for (const [label, re] of [['email address', EMAIL], ['phone number', PHONE], ['token', TOKEN], ...PRIVATE_MARKERS.map((r) => ['private path marker ' + r, r])]) {
      const m = f.text.match(re)
      if (m) out.push(`${label} in ${f.path}: ${JSON.stringify(m[0].slice(0, 40))}`)
    }
  }
  return out
}

const URL_RE = /https?:\/\/[^\s"'`<>)\\]+/g
const ABS_ATTR = /\b(?:src|href)\s*=\s*["'](\/|https?:)/gi
function ruleExternalRefs(files) {
  const out = []
  for (const f of files) {
    if (f.text == null) continue
    for (const u of f.text.match(URL_RE) || []) {
      let host
      try { host = new URL(u).host } catch { out.push(`unparseable URL in ${f.path}: ${u.slice(0, 60)}`); continue }
      if (!ALLOWED_HOSTS.includes(host)) out.push(`host not allowed in ${f.path}: ${host}`)
    }
    if (f.path.endsWith('.html')) {
      for (const m of f.text.matchAll(ABS_ATTR)) if (m[1] === '/') out.push(`root-relative src or href in ${f.path}`)
    }
  }
  return out
}

function rulePins(files) {
  const out = []
  const f = files.find((x) => x.path === 'data/pins.geojson')
  if (!f) return ['data/pins.geojson is missing']
  let fc
  try { fc = JSON.parse(f.text) } catch { return ['data/pins.geojson is not valid JSON'] }
  for (const [i, feat] of (fc.features || []).entries()) {
    const p = feat.properties || {}
    const tag = `pin ${i} (${p.id ?? 'no id'})`
    if (!PIN_STATUS.includes(p.status)) out.push(`${tag}: missing or unknown status`)
    if (!PIN_KINDS.includes(p.kind)) out.push(`${tag}: kind not allowed: ${p.kind}`)
    for (const k of ['url', 'source_url']) if (p[k] != null && !/^https:\/\//.test(p[k])) out.push(`${tag}: ${k} is not https`)
    if (typeof p.summary === 'string' && p.summary.length > 300) out.push(`${tag}: summary over 300 characters`)
    const [x, y] = feat.geometry?.coordinates || []
    if (feat.geometry?.type !== 'Point' || !(x >= BBOX[0] && x <= BBOX[2] && y >= BBOX[1] && y <= BBOX[3])) out.push(`${tag}: not a point inside the demo box`)
  }
  return out
}

function ruleSize(files, limit = SIZE_LIMIT) {
  const total = files.reduce((a, f) => a + f.size, 0)
  return total > limit ? [`total size ${total} bytes is over ${limit}`] : []
}

// The Capital Regional District's only terms found forbid passing its data on and
// name no open licence, so its rows (lic "C") must not be in the park layer
// until the CRD confirms an open licence in writing. The Islands Trust terms
// page could not be read, so its rows (lic "I") must not be in the layer until
// the page has been read and grants an open licence. See data/SOURCES.md.
function ruleDroppedProvider(files, code, name) {
  const f = files.find((x) => x.path === 'data/greenspaces.geojson')
  if (!f) return ['data/greenspaces.geojson is missing']
  let fc
  try { fc = JSON.parse(f.text) } catch { return ['data/greenspaces.geojson is not valid JSON'] }
  const n = (fc.features || []).filter((x) => x.properties?.lic === code).length
  return n ? [`${n} park rows carry the ${name} statement (lic "${code}")`] : []
}
const ruleDroppedProviders = (files) => ruleDroppedProvider(files, 'C', 'Capital Regional District')
const ruleDroppedIslandsTrust = (files) => ruleDroppedProvider(files, 'I', 'Islands Trust')

const metres = ([x1, y1], [x2, y2]) => {
  const r = Math.PI / 180, dy = (y2 - y1) * r, dx = (x2 - x1) * r * Math.cos(((y1 + y2) / 2) * r)
  return 6371000 * Math.hypot(dx, dy)
}
// Direction of the flow lines, checked at two creek mouths. A reversed file would
// march the dashes toward the headwaters. The "missing" findings are the positive
// twin: removing the lines altogether must not pass.
function ruleFlowDirection(files) {
  const f = files.find((x) => x.path === 'data/streams-flow.geojson')
  if (!f) return ['data/streams-flow.geojson is missing']
  let fc
  try { fc = JSON.parse(f.text) } catch { return ['data/streams-flow.geojson is not valid JSON'] }
  const out = []
  for (const m of FLOW_MOUTHS) {
    const lines = (fc.features || []).filter((x) => x.properties?.name === m.name && x.geometry?.type === 'LineString')
    if (!lines.length) { out.push(`${m.name}: no flow line`); continue }
    // Lines that reach the mouth. A short line has both ends near it, so what
    // counts is which end is nearer.
    const near = lines.map((x) => ({ first: metres(x.geometry.coordinates[0], m.at), last: metres(x.geometry.coordinates.at(-1), m.at) })).filter((d) => Math.min(d.first, d.last) <= FLOW_TOLERANCE_M)
    if (!near.length) out.push(`${m.name}: no flow line reaches within ${FLOW_TOLERANCE_M} m of ${m.where}`)
    if (near.some((d) => d.first < d.last)) out.push(`${m.name}: a flow line starts nearer ${m.where} than it ends, so it points upstream`)
  }
  return out
}

const RULES = { ruleForbiddenNames, rulePrivacy, ruleExternalRefs, rulePins, ruleSize, ruleDroppedProviders, ruleDroppedIslandsTrust, ruleFlowDirection }

// ---------------------------------------------------------------- self test
function selftest() {
  const f = (path, text) => ({ path, text, size: text.length })
  const goodPin = JSON.stringify({ features: [{ geometry: { type: 'Point', coordinates: [-123.3, 48.4] }, properties: { id: 'a', kind: 'example-place', status: 'approved', url: 'https://www.crd.ca/x', summary: 'ok' } }] })
  const gs = (lic) => JSON.stringify({ features: [{ geometry: { type: 'Polygon', coordinates: [] }, properties: { name: 'A', lic } }] })
  // A flow file with one line per creek. A line "downstream" ends at the creek's mouth.
  const flow = (colquitzReversed, bowkerReversed) => JSON.stringify({ features: FLOW_MOUTHS.map((m, i) => {
    const up = [m.at[0] + 0.02, m.at[1] + 0.02]
    return { geometry: { type: 'LineString', coordinates: (i === 0 ? colquitzReversed : bowkerReversed) ? [m.at, up] : [up, m.at] }, properties: { name: m.name } }
  }) })
  const cases = [
    ['ruleForbiddenNames', ruleForbiddenNames, [f('data/native-land.geojson', '{}')], [f('data/streams.geojson', '{}')]],
    ['ruleForbiddenNames (rush)', ruleForbiddenNames, [f('data/rush-map.geojson', '{}')], [f('data/bec.geojson', '{}')]],
    ['ruleForbiddenNames (hydro)', ruleForbiddenNames, [f('data/hydrorivers.geojson', '{}')], [f('data/lakes.geojson', '{}')]],
    ['ruleForbiddenNames (person)', ruleForbiddenNames, [f('data/persons.json', '{}')], [f('data/wetlands.geojson', '{}')]],
    ['rulePrivacy (email)', rulePrivacy, [f('data/x.geojson', 'write to someone@example.org')], [f('data/x.geojson', '{"a":1}')]],
    ['rulePrivacy (phone)', rulePrivacy, [f('js/a.js', 'call 250-555-0100')], [f('js/a.js', 'const lat = 48.4309387')]],
    ['rulePrivacy (path)', rulePrivacy, [f('js/a.js', '/Users/someone/project')], [f('js/a.js', 'import x from "./x.js"')]],
    ['rulePrivacy (meetings)', rulePrivacy, [f('data/a.json', 'Meetings/2026-10-01')], [f('data/a.json', 'meeting point')]],
    ['rulePrivacy (token)', rulePrivacy, [f('js/a.js', 'ghp_' + 'a'.repeat(30))], [f('js/a.js', 'const t = 1')]],
    ['ruleExternalRefs (host)', ruleExternalRefs, [f('js/a.js', 'fetch("https://tracker.example.com/x")')], [f('js/a.js', 'fetch("https://tiles.openfreemap.org/styles/positron")')]],
    ['ruleExternalRefs (root path)', ruleExternalRefs, [f('index.html', '<script src="/js/app.js"></script>')], [f('index.html', '<script src="js/app.js"></script>')]],
    ['rulePins (status)', rulePins, [f('data/pins.geojson', goodPin.replace('"status":"approved",', ''))], [f('data/pins.geojson', goodPin)]],
    ['rulePins (http url)', rulePins, [f('data/pins.geojson', goodPin.replace('https://', 'http://'))], [f('data/pins.geojson', goodPin)]],
    ['rulePins (kind)', rulePins, [f('data/pins.geojson', goodPin.replace('example-place', 'rumour'))], [f('data/pins.geojson', goodPin)]],
    ['ruleSize', (files) => ruleSize(files, 100), [{ path: 'x', text: null, size: 1000 }], [{ path: 'x', text: null, size: 10 }]],
    ['ruleDroppedProviders', ruleDroppedProviders, [f('data/greenspaces.geojson', gs('C'))], [f('data/greenspaces.geojson', gs('V'))]],
    ['ruleDroppedIslandsTrust', ruleDroppedIslandsTrust, [f('data/greenspaces.geojson', gs('I'))], [f('data/greenspaces.geojson', gs('V'))]],
    ['ruleFlowDirection (reversed)', ruleFlowDirection, [f('data/streams-flow.geojson', flow(true, true))], [f('data/streams-flow.geojson', flow(false, false))]],
    ['ruleFlowDirection (missing line)', ruleFlowDirection, [f('data/streams-flow.geojson', flow(false, false).replace('Colquitz River', 'Other Creek'))], [f('data/streams-flow.geojson', flow(false, false))]],
  ]
  let ok = true
  for (const [name, rule, bad, clean] of cases) {
    const fires = rule(bad).length > 0
    const quiet = rule(clean).length === 0
    report(fires && quiet, `selftest ${name}: fires on bad input, quiet on clean input`, fires ? (quiet ? '' : 'fired on clean input: ' + rule(clean).join('; ')) : 'did not fire on bad input')
    ok = ok && fires && quiet
  }
  ok = selftestFlowBuilder() && ok
  return ok
}

// scripts/make-flow.mjs must refuse lines that run downstream and must turn
// correct (upstream-pointing) Freshwater Atlas lines around.
function selftestFlowBuilder() {
  const dir = mkdtempSync(join(tmpdir(), 'gv-flow-'))
  const piece = (measure, coords) => ({ type: 'Feature', properties: { name: 'Test Creek', order: 1, edge: 1000, key: 1, measure }, geometry: { type: 'LineString', coordinates: coords } })
  const run = (features) => {
    writeFileSync(join(dir, 'in.geojson'), JSON.stringify({ type: 'FeatureCollection', features }))
    const r = spawnSync(process.execPath, [join(ROOT, 'scripts/make-flow.mjs'), join(dir, 'in.geojson'), join(dir, 'out.geojson')], { encoding: 'utf8' })
    return { status: r.status, out: r.status === 0 ? JSON.parse(readFileSync(join(dir, 'out.geojson'), 'utf8')) : null }
  }
  try {
    // Province order: first vertex is downstream, and distance from the mouth grows with it.
    const good = run([piece(0, [[0, 0], [1, 0]]), piece(100, [[1, 0], [2, 0]])])
    const last = good.out?.features[0]?.geometry.coordinates.at(-1)
    const turned = good.status === 0 && good.out.features.length === 1 && last[0] === 0
    // Same creek drawn downstream: the builder has to stop.
    const bad = run([piece(0, [[1, 0], [0, 0]]), piece(100, [[2, 0], [1, 0]])])
    report(turned && bad.status !== 0, 'selftest make-flow: joins and turns correct lines, refuses lines that already run downstream', turned ? 'accepted reversed input' : 'did not turn correct input')
    return turned && bad.status !== 0
  } finally { rmSync(dir, { recursive: true, force: true }) }
}

// ---------------------------------------------------------------- real tree
let failures = 0
function report(pass, name, detail = '') {
  if (!pass) failures++
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${!pass && detail ? ': ' + detail : ''}`)
}

function walk(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    if (['.git', 'raw', 'node_modules', '.DS_Store'].includes(name)) continue
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...walk(p)); else out.push(p)
  }
  return out
}
const TEXT_EXT = new Set(['.html', '.js', '.mjs', '.css', '.json', '.geojson', '.md', '.txt', '.sh'])
function loadFiles() {
  return walk(ROOT).map((abs) => {
    const path = relative(ROOT, abs)
    const size = statSync(abs).size
    return { path, size, text: TEXT_EXT.has(extname(abs)) || basename(abs) === 'LICENSE' ? readFileSync(abs, 'utf8') : null }
  })
}

function coordsInBox(coords, bad) {
  if (typeof coords[0] === 'number') {
    const [x, y] = coords
    // Small tolerance: clipping at the box edge can round past it by 1e-5.
    if (x < BBOX[0] - 1e-4 || x > BBOX[2] + 1e-4 || y < BBOX[1] - 1e-4 || y > BBOX[3] + 1e-4) bad.n++
  } else for (const c of coords) coordsInBox(c, bad)
}

function checkTree() {
  const files = loadFiles()
  const byPath = Object.fromEntries(files.map((f) => [f.path, f]))
  const scanned = files.filter((f) => !f.path.startsWith('vendor/') && f.path !== 'scripts/check-demo.mjs' && f.path !== 'scripts/browser-check.mjs')

  // forbid rules on the real tree
  report(...pair(ruleForbiddenNames(files), 'no held-layer file names (native-land, rush, hydro, person)'))
  const privacyScope = scanned.filter((f) => /^(data\/|js\/|css\/|index\.html$|README\.md$|scripts\/fetch-layers\.sh$)/.test(f.path))
  report(...pair(rulePrivacy(privacyScope), 'no email, phone, token or private path markers in data/, js/, css/, index.html, README.md, fetch script'))
  const refScope = scanned.filter((f) => /^(index\.html$|js\/|css\/|data\/.*\.geojson$)/.test(f.path))
  report(...pair(ruleExternalRefs(refScope), 'every URL names an allowed host; no root-relative src or href'))
  report(...pair(rulePins(files), 'pins: status, allowed kind, https links, summary length, inside demo box'))
  report(...pair(ruleDroppedProviders(files), 'park layer has no Capital Regional District rows (no open licence confirmed)'))
  report(...pair(ruleDroppedIslandsTrust(files), 'park layer has no Islands Trust rows (terms page could not be read)'))
  report(...pair(ruleFlowDirection(files), 'flow lines end at the creek mouths (Colquitz River, Bowker Creek): dashes march downstream'))
  report(...pair(ruleSize(files), `total size under 10 MB (${(files.reduce((a, f) => a + f.size, 0) / 1048576).toFixed(2)} MB)`))

  // require rules (the positive twins)
  for (const name of LAYER_FILES) {
    const p = `data/${name}.geojson`
    const f = byPath[p]
    if (!f) { report(false, `layer file ${p}`, 'missing'); continue }
    let fc
    try { fc = JSON.parse(f.text) } catch (e) { report(false, `layer file ${p}`, 'invalid JSON'); continue }
    const feats = fc.features || []
    const nullGeom = feats.filter((x) => !x.geometry).length
    const bad = { n: 0 }
    for (const x of feats) if (x.geometry) coordsInBox(x.geometry.coordinates, bad)
    const detail = []
    if (fc.type !== 'FeatureCollection') detail.push('not a FeatureCollection')
    if (feats.length < 1) detail.push('no features')
    if (nullGeom) detail.push(`${nullGeom} features with null geometry`)
    if (bad.n) detail.push(`${bad.n} coordinates outside the demo box`)
    report(detail.length === 0, `layer file ${p}: ${feats.length} features, valid GeoJSON, inside demo box`, detail.join('; '))
  }
  const pinsFc = (() => { try { return JSON.parse(byPath['data/pins.geojson'].text) } catch { return { features: [] } } })()
  report(pinsFc.features.some((x) => x.properties?.status === 'approved'), 'pins.geojson has at least one approved pin')
  report(pinsFc.features.every((x) => PIN_KINDS.includes(x.properties?.kind)), 'every pin kind is in the allowed list')

  const html = byPath['index.html']?.text || '', app = byPath['js/app.js']?.text || ''
  report((html + app).includes('Open Government Licence'), 'page names the Open Government Licence')
  report(html.includes(BANNER), 'demo banner text present in index.html')
  report(html.includes(PINS_EMPTY), 'pins empty-state text present in index.html')
  const credits = html.slice(html.indexOf('id="credits"'))
  report(credits.includes('OpenStreetMap') && credits.includes('MapLibre'), 'credits mention OpenStreetMap and MapLibre')
  report(app.includes('BC_ATTRIB') && app.includes('attribution'), 'BC layers carry a source attribution string')
  const creditsText = textOf(credits)
  const missingStatements = [...PROVIDER_STATEMENTS, ...TERRAIN_STATEMENTS].filter((t) => !creditsText.includes(t))
  report(missingStatements.length === 0, 'credits carry the Victoria and Saanich statements and the three terrain attribution lines word for word', missingStatements.join(' | '))
  report(PROVIDER_STATEMENTS.every((t) => app.includes(t)) && !/Open Government Licence \u2013 (Capital Regional District|Islands Trust)/.test(creditsText + app), 'park popups carry each kept provider statement; no Capital Regional District or Islands Trust statement is shown')
  report(/id="flow"[^>]*\bchecked\b/.test(html) && /data-group="terrain"(?![^>]*\bchecked\b)/.test(html), 'Flow box is on by default and Terrain shading box is off by default')
  report(app.includes('prefers-reduced-motion') && app.includes('visibilitychange') && app.includes('cancelAnimationFrame'), 'flow loop honours reduced motion and stops when the tab is hidden')
  report(/<title>Greater Victoria open map \(demo\)<\/title>/.test(html), 'page title marks the map as a demo')

  const sources = byPath['data/SOURCES.md']?.text || ''
  report(LAYER_FILES.filter((n) => n !== 'pins').every((n) => sources.includes(`${n}.geojson`)), 'data/SOURCES.md lists every data file')
  const licence = byPath['LICENSE']?.text || ''
  report(licence.startsWith('MIT License') && licence.includes('Copyright (c) 2026 Darren Zal') && licence.includes('Permission is hereby granted, free of charge'), 'LICENSE is the MIT licence with the Darren Zal copyright line')
  const readme = byPath['README.md']?.text || ''
  report(/MIT[^.]*covers the code only/.test(readme) && readme.includes('data/SOURCES.md'), 'README says the MIT licence covers the code only and points to data/SOURCES.md for the data')
  report(!!byPath['.nojekyll'], '.nojekyll present')
  report(!!byPath['vendor/MAPLIBRE-LICENSE.txt'], 'MapLibre licence text is shipped with the vendored library')

  for (const [p, want] of Object.entries(VENDOR_SHA256)) {
    const have = existsSync(join(ROOT, p)) ? createHash('sha256').update(readFileSync(join(ROOT, p))).digest('hex') : 'missing'
    report(have === want, `vendored ${basename(p)} matches the pinned sha256`, have)
  }
}

// Visible text of an HTML fragment: tags removed, the entities used on the page decoded.
function textOf(html) {
  return html.replace(/<[^>]*>/g, '').replace(/&ndash;/g, '\u2013').replace(/&amp;/g, '&').replace(/&copy;/g, '\u00a9').replace(/\s+/g, ' ')
}

function pair(findings, name) {
  return [findings.length === 0, name, findings.slice(0, 5).join('; ')]
}

console.log('Self-test (each forbid rule must fire on bad input and stay quiet on clean input)')
selftest()
console.log('\nChecks on this folder')
checkTree()
console.log(`\n${failures === 0 ? 'All static checks passed.' : failures + ' check(s) failed.'}`)
if (failures) process.exitCode = 1
if (process.argv.includes('--browser')) {
  const { runBrowserChecks } = await import('./browser-check.mjs')
  const bad = await runBrowserChecks()
  if (bad) process.exitCode = 1
}
