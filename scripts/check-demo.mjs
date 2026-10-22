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
import { copyFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const BBOX = [-123.75, 48.28, -123.20, 48.70]
const SIZE_LIMIT = 10 * 1024 * 1024
const BANNER = 'A test of what an open, self-hostable map can do. It is not an official map of any group.'
const PINS_EMPTY = 'No events listed yet.'
const LAYER_FILES = ['municipalities', 'bc-parks', 'greenspaces', 'streams', 'streams-flow', 'lakes', 'wetlands', 'watersheds', 'bec', 'pins', 'ecoregions', 'industry-waste']
const PIN_KINDS = ['happening', 'learning-journey', 'partner-event', 'example-place']
const PIN_STATUS = ['draft', 'approved']
// Hosts the page may name. Most appear only as credit links. The page fetches from
// tiles.openfreemap.org (basemap) on load. After the matching box is ticked it also fetches from
// s3.amazonaws.com (elevation tiles for Terrain shading and 3D terrain), api.weather.gc.ca and
// geo.weather.gc.ca (Environment and Climate Change Canada: radar, alerts, air quality,
// conditions, river gauges), earthquake.usgs.gov (earthquakes) and api.gbif.org (life observations).
const ALLOWED_HOSTS = [
  'tiles.openfreemap.org', 'openfreemap.org', 'www2.gov.bc.ca', 'www.openstreetmap.org',
  'www.openmaptiles.org', 'crd.ca', 'www.crd.ca', 'catalogue.data.gov.bc.ca',
  'opendata.victoria.ca', 'www.saanich.ca', 'islandstrust.bc.ca',
  's3.amazonaws.com', 'registry.opendata.aws', 'github.com', 'open.canada.ca',
  'api.weather.gc.ca', 'geo.weather.gc.ca', 'eccc-msc.github.io', 'wateroffice.ec.gc.ca',
  'earthquake.usgs.gov', 'www.usgs.gov', 'api.gbif.org', 'www.gbif.org', 'creativecommons.org',
  'ecoregions.appspot.com', 'www.hydrosheds.org', 'doi.org', 'datasets.wri.org',
  'www.opengis.net', // names the coordinate system in a sea currents request (EPSG 4326). It is an identifier, not fetched
]
// Third-party hosts the page fetches from once a box is ticked. Each must be named in the privacy note.
const FETCH_HOSTS = ['s3.amazonaws.com', 'api.weather.gc.ca', 'geo.weather.gc.ca', 'earthquake.usgs.gov', 'api.gbif.org']
const OVERLAY_IDS = ['radar', 'currents', 'alerts', 'aqhi', 'conditions', 'water', 'quakes', 'life', 'ecoregions', 'industry']
const LIVE_SENTENCE = 'These load from outside services when ticked. Nothing loads until you tick one.'
// Credit text the new layers must carry, word for word, in the credits panel.
const OVERLAY_STATEMENTS = [
  'Data Source: Environment and Climate Change Canada.',
  'Contains information licenced under the Data Server End-use Licence of Environment and Climate Change Canada.',
  'Credit: U.S. Geological Survey.',
  'USGS-authored or produced data and information are considered to be in the U.S. Public Domain',
  'Ecoregions 2017 \u00a9 Resolve. Licensed under CC BY 4.0.',
  'Statistics Canada, Open Database of Infrastructure, Version 2 (Catalogue no. 34-26-0003), released November 13, 2024. Contains information licensed under the Open Government Licence \u2013 Canada.',
  'Ehalt Macedo, H., Lehner, B., Nicell, J., Grill, G., Li, J., Limtong, A., Shakya, R. (2022). Distribution and characteristics of wastewater treatment plants within the global river network. Earth System Science Data, 14(2): 559-577',
  'Global Energy Observatory, Google, KTH Royal Institute of Technology in Stockholm, Enipedia, World Resources Institute. 2021.',
]
const INDUSTRY_SRC = ['odi', 'hydrowaste', 'gppd']
const INDUSTRY_KINDS = ['landfill', 'power', 'wastewater']
// Bowker Creek, mapped length of open channel in the flow file. Canals (edge type 2000) are
// in, pipes (1425) are out. With canals the file holds about 1,420 m. Without them about 480 m.
// With the pipes as well it would hold about 2,110 m.
const BOWKER_OPEN_M = [1300, 1600]
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
  'Contains information licensed under the Open Government Licence \u2013 Islands Trust.',
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
// until the CRD confirms an open licence in writing. See data/SOURCES.md.
function ruleDroppedProvider(files, code, name) {
  const f = files.find((x) => x.path === 'data/greenspaces.geojson')
  if (!f) return ['data/greenspaces.geojson is missing']
  let fc
  try { fc = JSON.parse(f.text) } catch { return ['data/greenspaces.geojson is not valid JSON'] }
  const n = (fc.features || []).filter((x) => x.properties?.lic === code).length
  return n ? [`${n} park rows carry the ${name} statement (lic "${code}")`] : []
}
const ruleDroppedProviders = (files) => ruleDroppedProvider(files, 'C', 'Capital Regional District')

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

// Canals are in the flow file and pipes are not. Bowker Creek is the test: its open channel
// (natural channel plus canal) is about 1,420 m, and its subsurface reach about 680 m more.
function lengthM(coords) { let n = 0; for (let i = 1; i < coords.length; i++) n += metres(coords[i - 1], coords[i]); return n }
function ruleFlowCanals(files, range = BOWKER_OPEN_M) {
  const f = files.find((x) => x.path === 'data/streams-flow.geojson')
  if (!f) return ['data/streams-flow.geojson is missing']
  let fc
  try { fc = JSON.parse(f.text) } catch { return ['data/streams-flow.geojson is not valid JSON'] }
  const total = (fc.features || []).filter((x) => x.properties?.name === 'Bowker Creek' && x.geometry?.type === 'LineString').reduce((a, x) => a + lengthM(x.geometry.coordinates), 0)
  return total >= range[0] && total <= range[1] ? [] : [`Bowker Creek flow lines are ${Math.round(total)} m long, expected ${range[0]} to ${range[1]} m (canals in, pipes out)`]
}

// The Environment and Climate Change Canada licence is its own licence, not the Open Government
// Licence - Canada. No paragraph of the credits may join the two.
function ruleEcccLicence(html) {
  const out = []
  for (const para of html.split(/<\/p>|<\/li>/)) {
    const t = textOf(para)
    if (/Environment and Climate Change Canada/.test(t) && /Open Government Licence/.test(t)) out.push(`ECCC data credited to the Open Government Licence: ${t.slice(0, 80)}`)
  }
  return out
}

// Sea currents carry the same Environment and Climate Change Canada credit on the map as the other live
// layers, and say in the panel, the status line and the credits that the model is experimental and not
// for navigation.
function ruleCurrentsCredit(html, js) {
  const out = []
  const para = html.split(/<\/p>|<\/li>/).filter((p) => p.includes('<strong>Sea currents</strong>')).map(textOf)[0]
  if (!para) out.push('the credits have no Sea currents paragraph')
  else {
    if (!/experimental/i.test(para)) out.push('the Sea currents credit does not say the model is experimental')
    if (!/not for navigation/i.test(para)) out.push('the Sea currents credit does not say it is not for navigation')
  }
  if (!/src\('ov-currents-credit', ECCC_ATTRIB\)/.test(js)) out.push('the sea currents credit source does not carry ECCC_ATTRIB')
  if (!/experimental, not for navigation\)/.test(js)) out.push('the sea currents status line does not say experimental, not for navigation')
  return out
}

// Every third-party host the page fetches from once a box is ticked is named in the privacy note.
function rulePrivacyHosts(html) {
  const privacy = textOf(html.slice(html.indexOf('<strong>Privacy.</strong>'), html.indexOf('<strong>Software.</strong>')))
  return FETCH_HOSTS.filter((h) => !privacy.includes(h)).map((h) => `the privacy note does not name ${h}`)
}

// Boxes: every new overlay has a box in the panel, off by default, 3D terrain is on by default, and the Live data sentence is there.
function ruleOverlayBoxes(html) {
  const out = []
  for (const id of OVERLAY_IDS) {
    const m = html.match(new RegExp(`<input[^>]*data-overlay="${id}"[^>]*>`))
    if (!m) out.push(`no box for overlay ${id}`)
    else if (/\bchecked\b/.test(m[0])) out.push(`overlay ${id} is on by default`)
  }
  const m3 = html.match(/<input[^>]*id="terrain3d"[^>]*>/)
  if (!m3) out.push('no box for 3D terrain'); else if (!/\bchecked\b/.test(m3[0])) out.push('3D terrain is off by default')
  if (!textOf(html).includes(LIVE_SENTENCE)) out.push('the Live data sentence is missing')
  return out
}

// Industry and waste sites: only the sources whose licences were read as open, only the kinds
// shown, and no site named for a First Nation.
function ruleIndustry(files) {
  const f = files.find((x) => x.path === 'data/industry-waste.geojson')
  if (!f) return ['data/industry-waste.geojson is missing']
  let fc
  try { fc = JSON.parse(f.text) } catch { return ['data/industry-waste.geojson is not valid JSON'] }
  const out = []
  for (const [i, x] of (fc.features || []).entries()) {
    const p = x.properties || {}
    if (!INDUSTRY_SRC.includes(p.src)) out.push(`site ${i} (${p.name}): source ${p.src} is not on the open list`)
    if (!INDUSTRY_KINDS.includes(p.kind)) out.push(`site ${i} (${p.name}): kind ${p.kind} is not shown`)
    if (/tsawout/i.test(String(p.name))) out.push(`site ${i}: named for a First Nation`)
  }
  return out
}

const RULES = { ruleForbiddenNames, rulePrivacy, ruleExternalRefs, rulePins, ruleSize, ruleDroppedProviders, ruleFlowDirection, ruleFlowCanals, ruleEcccLicence, ruleCurrentsCredit, rulePrivacyHosts, ruleOverlayBoxes, ruleIndustry }

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
  // A flow file whose Bowker Creek line is about `metres` long, running east to the creek's mouth.
  const bowker = (n) => JSON.stringify({ features: [{ geometry: { type: 'LineString', coordinates: [[FLOW_MOUTHS[1].at[0] - n / (111320 * Math.cos(FLOW_MOUTHS[1].at[1] * Math.PI / 180)), FLOW_MOUTHS[1].at[1]], FLOW_MOUTHS[1].at] }, properties: { name: 'Bowker Creek' } }] })
  const boxes = (checked, terrainOn = true) => OVERLAY_IDS.map((id) => `<input type="checkbox" data-overlay="${id}"${checked ? ' checked' : ''}>`).join('') + `<input type="checkbox" id="terrain3d"${terrainOn ? ' checked' : ''}> <p>${LIVE_SENTENCE}</p>`
  const industry = (over) => JSON.stringify({ features: [{ geometry: { type: 'Point', coordinates: [-123.4, 48.5] }, properties: { name: 'Plant', kind: 'wastewater', src: 'hydrowaste', ...over } }] })
  const currentsHtml = '<p><strong>Sea currents</strong> (off until you switch it on). This is an experimental model and is not for navigation.</p>'
  const currentsJs = "src('ov-currents-credit', ECCC_ATTRIB); const m = `(experimental, not for navigation).`"
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
    ['ruleFlowDirection (reversed)', ruleFlowDirection, [f('data/streams-flow.geojson', flow(true, true))], [f('data/streams-flow.geojson', flow(false, false))]],
    ['ruleFlowDirection (missing line)', ruleFlowDirection, [f('data/streams-flow.geojson', flow(false, false).replace('Colquitz River', 'Other Creek'))], [f('data/streams-flow.geojson', flow(false, false))]],
    ['ruleFlowCanals (canals missing)', ruleFlowCanals, [f('data/streams-flow.geojson', bowker(480))], [f('data/streams-flow.geojson', bowker(1420))]],
    ['ruleFlowCanals (pipes included)', ruleFlowCanals, [f('data/streams-flow.geojson', bowker(2110))], [f('data/streams-flow.geojson', bowker(1420))]],
    ['ruleEcccLicence', (files) => ruleEcccLicence(files[0].text), [f('x.html', '<p>Data Source: Environment and Climate Change Canada. Contains information licensed under the Open Government Licence &ndash; Canada.</p>')], [f('x.html', '<p>Data Source: Environment and Climate Change Canada. Contains information licenced under the Data Server End-use Licence of Environment and Climate Change Canada.</p><p>Canada terrain data contains information licensed under the Open Government Licence &ndash; Canada.</p>')]],
    ['ruleCurrentsCredit (no experimental, no navigation line)', (files) => ruleCurrentsCredit(files[0].text, files[1].text), [f('x.html', '<p>Sea currents (off until you switch it on). Modelled.</p>'), f('x.js', currentsJs)], [f('x.html', currentsHtml), f('x.js', currentsJs)]],
    ['ruleCurrentsCredit (credit source missing)', (files) => ruleCurrentsCredit(files[0].text, files[1].text), [f('x.html', currentsHtml), f('x.js', currentsJs.replace('ECCC_ATTRIB', 'USGS_ATTRIB'))], [f('x.html', currentsHtml), f('x.js', currentsJs)]],
    ['ruleCurrentsCredit (status line)', (files) => ruleCurrentsCredit(files[0].text, files[1].text), [f('x.html', currentsHtml), f('x.js', currentsJs.replace('experimental, not for navigation)', 'a model)'))], [f('x.html', currentsHtml), f('x.js', currentsJs)]],
    ['rulePrivacyHosts', (files) => rulePrivacyHosts(files[0].text), [f('x.html', '<strong>Privacy.</strong> tiles.openfreemap.org <strong>Software.</strong>')], [f('x.html', `<strong>Privacy.</strong> ${FETCH_HOSTS.join(' ')} <strong>Software.</strong>`)]],
    ['ruleOverlayBoxes (on by default)', (files) => ruleOverlayBoxes(files[0].text), [f('x.html', boxes(true))], [f('x.html', boxes(false))]],
    ['ruleOverlayBoxes (3D terrain off)', (files) => ruleOverlayBoxes(files[0].text), [f('x.html', boxes(false, false))], [f('x.html', boxes(false))]],
    ['ruleOverlayBoxes (no live sentence)', (files) => ruleOverlayBoxes(files[0].text), [f('x.html', boxes(false).replace(LIVE_SENTENCE, ''))], [f('x.html', boxes(false))]],
    ['ruleIndustry (source)', ruleIndustry, [f('data/industry-waste.geojson', industry({ src: 'climate-trace' }))], [f('data/industry-waste.geojson', industry({ src: 'hydrowaste' }))]],
    ['ruleIndustry (kind)', ruleIndustry, [f('data/industry-waste.geojson', industry({ kind: 'river' }))], [f('data/industry-waste.geojson', industry({ kind: 'wastewater' }))]],
    ['ruleIndustry (First Nation name)', ruleIndustry, [f('data/industry-waste.geojson', industry({ name: 'Tsawout WWTP' }))], [f('data/industry-waste.geojson', industry({ name: 'Saanich Peninsula WWTP' }))]],
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
    // Edge types: a canal (2000) is kept and joins the creek it runs into, subsurface flow (1425) and connection lines (1450) are dropped.
    const edge = (n, e, key, measure, coords) => ({ ...piece(measure, coords), properties: { name: 'Test Creek ' + n, order: 1, edge: e, key, measure } })
    const kinds = run([edge(1, 1000, 1, 0, [[0, 0], [1, 0]]), edge(1, 2000, 1, 100, [[1, 0], [2, 0]]), edge(2, 1425, 2, 0, [[10, 10], [11, 10]]), edge(3, 1450, 3, 0, [[20, 20], [21, 20]])])
    const lines = kinds.out?.features || []
    const edgesOk = kinds.status === 0 && lines.length === 1 && lines[0].geometry.coordinates.length === 3 && lines[0].geometry.coordinates.every(([x]) => x < 10)
    report(edgesOk, 'selftest make-flow: canals (edge type 2000) are kept and joined, subsurface flow (1425) and connection lines (1450) are dropped', JSON.stringify(lines.map((l) => l.geometry.coordinates)))
    return turned && bad.status !== 0 && edgesOk
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
  report(...pair(ruleFlowDirection(files), 'flow lines end at the creek mouths (Colquitz River, Bowker Creek): dashes march downstream'))
  report(...pair(ruleFlowCanals(files), `flow lines include the canals and not the pipes: Bowker Creek open channel ${BOWKER_OPEN_M[0]} to ${BOWKER_OPEN_M[1]} m`))
  report(...pair(ruleIndustry(files), 'industry and waste sites: only open-licence sources, only landfill, power and wastewater kinds, no site named for a First Nation'))
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
  report(missingStatements.length === 0, 'credits carry the Victoria, Saanich and Islands Trust statements and the three terrain attribution lines word for word', missingStatements.join(' | '))
  report(PROVIDER_STATEMENTS.every((t) => app.includes(t)) && !/Open Government Licence \u2013 Capital Regional District/.test(creditsText + app), 'park popups carry each kept provider statement; no Capital Regional District statement is shown')
  report(/id="flow"[^>]*\bchecked\b/.test(html) && /data-group="terrain"[^>]*\bchecked\b/.test(html), 'Flow box and Terrain shading box are on by default')
  report(app.includes('prefers-reduced-motion') && app.includes('visibilitychange') && app.includes('cancelAnimationFrame'), 'flow loop honours reduced motion and stops when the tab is hidden')
  report(/<title>Greater Victoria open map \(demo\)<\/title>/.test(html), 'page title marks the map as a demo')
  report(...pair(ruleOverlayBoxes(html), 'every new layer has a box, all are off by default, 3D terrain is on, and the Live data sentence is present'))
  report(...pair(ruleEcccLicence(html), 'Environment and Climate Change Canada data is not credited to the Open Government Licence'))
  report(...pair(rulePrivacyHosts(html), 'the privacy note names every third-party host the page fetches from after a box is ticked'))
  const overlaysJs = byPath['js/overlays.js']?.text || '', currentsJs = byPath['js/currents.js']?.text || ''
  report(...pair(ruleCurrentsCredit(html, overlaysJs), 'sea currents carry the Environment and Climate Change Canada credit on the map and say the model is experimental and not for navigation'))
  report(currentsJs.includes('motionQuery') && currentsJs.includes('visibilitychange') && currentsJs.includes('cancelAnimationFrame') && currentsJs.includes("'movestart'"), 'sea currents loop honours reduced motion, stops when the tab is hidden and while the map moves')
  report(overlaysJs.includes('Contains information licenced under the <a href="${ECCC_LICENCE}" target="_blank" rel="noopener">Data Server End-use Licence</a> of Environment and Climate Change Canada.') && overlaysJs.includes("const ECCC_LICENCE = 'https://eccc-msc.github.io/open-data/licence/readme_en/'"), 'on-map attribution carries the Environment and Climate Change Canada licence statement and a link to the licence')
  const missingOverlay = OVERLAY_STATEMENTS.filter((t) => !creditsText.includes(t))
  report(missingOverlay.length === 0, 'credits carry the Environment Canada, USGS, ecoregion and industry source statements word for word', missingOverlay.join(' | '))

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

// A one-band GeoTIFF of 32-bit floats in strips, built the way the sea currents service sends one, in
// either byte order. The options let a test break one thing at a time.
function tiff({ w, h, values, le = true, compression = 1, bits = 32, format = 3, rows = 2, scale = [0.5, 0.25], tie = [-124, 49], strips = true }) {
  const spans = []
  for (let r = 0; r < h; r += rows) spans.push([r, Math.min(h, r + rows)])
  const entries = [[256, 3, [w]], [257, 3, [h]], [258, 3, [bits]], [259, 3, [compression]], [273, 4, null], [277, 3, [1]], [278, 3, [rows]], [279, 4, spans.map(([a, b]) => (b - a) * w * 4)], [339, 3, [format]], [33550, 12, [...scale, 0]], [33922, 12, [0, 0, 0, ...tie, 0]]]
  const size = { 3: 2, 4: 4, 12: 8 }
  let extra = 8 + 2 + entries.length * 12 + 4 // the first byte after the directory
  const offsets = []
  const place = (type, vals) => { if (size[type] * vals.length <= 4) return null; const at = extra; extra += size[type] * vals.length; return at }
  const at = entries.map(([tag, type, vals]) => (tag === 273 ? place(4, spans) : place(type, vals)))
  const dataStart = extra
  spans.forEach(([a], i) => offsets.push(dataStart + a * w * 4))
  const buf = new ArrayBuffer(dataStart + w * h * 4), dv = new DataView(buf)
  dv.setUint8(0, le ? 0x49 : 0x4d); dv.setUint8(1, le ? 0x49 : 0x4d); dv.setUint16(2, 42, le); dv.setUint32(4, 8, le); dv.setUint16(8, entries.length, le)
  const put = (o, type, v) => (type === 3 ? dv.setUint16(o, v, le) : type === 4 ? dv.setUint32(o, v, le) : dv.setFloat64(o, v, le))
  entries.forEach(([tag, type, vals], i) => {
    const list = tag === 273 ? offsets : vals, o = 10 + i * 12
    dv.setUint16(o, tag, le); dv.setUint16(o + 2, type, le); dv.setUint32(o + 4, list.length, le)
    if (at[i] == null) list.forEach((v, k) => put(o + 8 + k * size[type], type, v))
    else { dv.setUint32(o + 8, at[i], le); list.forEach((v, k) => put(at[i] + k * size[type], type, v)) }
  })
  values.forEach((v, i) => dv.setFloat32(dataStart + i * 4, v, le))
  return strips ? new Uint8Array(buf) : new Uint8Array(buf, 0, dataStart)
}

// js/overlays-data.js turns the replies of outside services into map data. It has no DOM code, so
// it is run here on sample replies: bad rows must be dropped, good rows kept, and the text of an
// alert passed on unchanged.
async function checkOverlayData() {
  const dir = mkdtempSync(join(tmpdir(), 'gv-ov-'))
  try {
    copyFileSync(join(ROOT, 'js/overlays-data.js'), join(dir, 'data.mjs'))
    const D = await import(pathToFileURL(join(dir, 'data.mjs')).href)
    const now = Date.parse('2026-10-21T20:00:00Z')
    const threw = (fn) => { try { fn(); return false } catch { return true } }
    const pt = (x, y) => ({ type: 'Point', coordinates: [x, y] })

    const xml = (name, dim) => `<Layer><Name>OTHER</Name><Dimension name="time" units="ISO8601">2026-01-01T00:00:00Z/2026-01-01T01:00:00Z/PT1H</Dimension></Layer><Layer><Name>${name}</Name><Dimension name="time" units="ISO8601">${dim}</Dimension></Layer>`
    const times = D.radarTimes(xml('RADAR_1KM_RRAI', '2026-10-21T21:00:00Z/2026-10-22T00:00:00Z/PT6M'))
    report(times.length === 10 && times.at(-1) === '2026-10-22T00:00:00Z' && times[0] === '2026-10-21T23:06:00Z', 'radar: the ten newest frames, six minutes apart, read from the radar layer and not a sibling layer', times.join(','))
    report(threw(() => D.radarTimes(xml('SOMETHING_ELSE', '2026-10-21T21:00:00Z/2026-10-22T00:00:00Z/PT6M'))) && threw(() => D.radarTimes(xml('RADAR_1KM_RRAI', '2026-10-21T21:00:00Z/2026-10-22T00:00:00Z/P1D'))), 'radar: a missing layer or an unreadable step is refused, not guessed')
    report(D.radarFrameUrl(times[0]).includes('layers=RADAR_1KM_RRAI') && D.radarFrameUrl(times[0]).includes('EPSG%3A3857') && threw(() => D.radarFrameUrl('not a time')), 'radar: frame request names the layer and web Mercator, and refuses a bad time')

    const alertFeature = (over, geometry = { type: 'Polygon', coordinates: [[[-123.5, 48.4], [-123.3, 48.4], [-123.3, 48.6], [-123.5, 48.4]]] }) => ({ id: 'a1', geometry, properties: { alert_short_name_en: 'yellow warning - wind', feature_name_en: 'Greater Victoria', alert_text_en: 'Line one.\n\nLine two, unchanged.', risk_colour_en: 'yellow', publication_datetime: '2026-10-21T18:00:00Z', expiration_datetime: '2026-10-22T06:00:00Z', ...over } })
    const al = D.normaliseAlerts({ features: [alertFeature({}), alertFeature({ expiration_datetime: '2026-10-21T10:00:00Z' }), alertFeature({}, null)] }, now)
    report(al.items.length === 1 && al.items[0].text === 'Line one.\n\nLine two, unchanged.' && al.items[0].colour === '#d9a400', 'alerts: an expired alert and one with no area are dropped, and the text is passed on exactly as published', JSON.stringify(al.items.map((i) => i.text)))

    const aq = (id, loc, v, t, c) => ({ id, geometry: pt(...c), properties: { location_id: loc, location_name_en: loc, aqhi: v, observation_datetime: t } })
    const aqhi = D.normaliseAqhi({ features: [aq('1', 'V', 3.4, '2026-10-21T18:00:00Z', [-123.37, 48.43]), aq('2', 'V', 3.6, '2026-10-21T19:00:00Z', [-123.37, 48.43]), aq('3', 'Far', 2, '2026-10-21T19:00:00Z', [-122.5, 49.1])] })
    report(aqhi.features.length === 1 && aqhi.features[0].properties.band === 'Moderate risk' && D.aqhiBand(3.4) === 'Low risk', 'air quality: the newest reading per station, stations outside the box dropped, band read on the rounded index', JSON.stringify(aqhi.features.map((f) => f.properties)))

    const q = (id, type, c, extra = {}) => ({ id, geometry: pt(c[0], c[1]), properties: { type, mag: 2, time: now - 3600000, place: 'x', url: 'https://earthquake.usgs.gov/earthquakes/eventpage/' + id, ...extra } })
    const quakes = D.normaliseQuakes({ features: [q('e1', 'earthquake', [-123.5, 48.3]), q('e2', 'explosion', [-123.5, 48.3]), q('e3', 'earthquake', [-120, 40]), q('e4', 'earthquake', [-123.5, 48.3], { url: 'http://evil.example/x' })] }, now)
    report(quakes.features.length === 2 && quakes.features[1].properties.url === null, 'earthquakes: only earthquakes inside the map area are kept, and a link off the USGS host is dropped')

    const sw = (name, t, c, extra = {}) => ({ geometry: pt(c[0], c[1]), properties: { 'stn_nam-value': name, 'date_tm-value': t, air_temp: 11, ...extra } })
    const cond = D.normaliseConditions({ features: [sw('A', '2026-10-21T19:50:00Z', [-123.4, 48.4]), sw('A', '2026-10-21T19:55:00Z', [-123.4, 48.4], { air_temp: 12 }), sw('B', '2026-10-21T12:00:00Z', [-123.4, 48.5]), sw('C', '2026-10-21T19:55:00Z', [-123.4, 48.5], { air_temp: null }), sw('D', '2026-10-21T19:55:00Z', [-130, 40])] }, now)
    report(cond.features.length === 1 && cond.features[0].properties.temp === 12, 'conditions: one report per station (the newest), reports older than 3 hours, empty reports and stations outside the area dropped')

    const st = (n, c, over = {}) => ({ geometry: pt(c[0], c[1]), properties: { STATION_NUMBER: n, STATION_NAME: 'S' + n, REAL_TIME: 1, STATUS_EN: 'Active', ...over } })
    const gauges = D.nearestGauges({ features: [st('08HA011', [-123.71, 48.77]), st('08HA003', [-123.67, 48.73]), st('08HB099', [-123.4, 48.5], { STATUS_EN: 'Discontinued' }), st('08HB098', [-123.4, 48.5], { REAL_TIME: 0 }), st('bad', [-123.4, 48.5])] }, 5)
    report(gauges.length === 2 && gauges[0].number === '08HA003' && gauges[0].km < gauges[1].km, 'river gauges: only active real-time gauges, nearest first, a bad station number refused')
    report(D.gaugeFeature(gauges[0], { features: [] }) === null && D.gaugeFeature(gauges[0], { features: [{ properties: { LEVEL: 0.5, DISCHARGE: null, DATETIME: '2026-10-21T19:00:00Z' } }] }).properties.km === Math.round(gauges[0].km) && threw(() => D.waterReadingUrl('08HA003; drop')), 'river gauges: a gauge with no reading is left out, the distance is kept, and a station number is checked before it goes into a URL')

    const rec = (over) => ({ key: Math.floor(Math.random() * 1e9) + 1e9, species: 'Quercus garryana', kingdom: 'Plantae', eventDate: '2026-06-01T10:00', license: 'http://creativecommons.org/publicdomain/zero/1.0/legalcode', decimalLatitude: 48.42951, decimalLongitude: -123.36549, datasetKey: '50c9509d-22c7-4a22-a47d-8c48425ef4a7', datasetName: 'D', rightsHolder: 'R. Holder', ...over })
    const good1 = rec({ key: 1 }), good2 = rec({ key: 2, license: 'http://creativecommons.org/licenses/by/4.0/legalcode' })
    const life = D.normaliseLife([good1, good2, rec({ key: 3, license: 'http://creativecommons.org/licenses/by-nc/4.0/legalcode' }), rec({ key: 4, informationWithheld: 'Coordinate uncertainty increased' }), rec({ key: 5, dataGeneralizations: 'Coordinates obscured' }), rec({ key: 6, coordinateUncertaintyInMeters: 9000 }), rec({ key: 7, decimalLatitude: 49.5 }), rec({ key: 1 }), rec({ key: 8, license: null }), rec({ key: 9, order: 'Cetacea', species: 'Orcinus orca' })])
    const p1 = life.features.find((f) => f.properties.key === 1)?.properties, p2 = life.features.find((f) => f.properties.key === 2)?.properties
    report(life.features.length === 2 && !!p1 && !!p2, 'life observations: records under another licence, withheld, generalised, too uncertain, outside the box, repeated or of whales, dolphins and porpoises are dropped; the two good ones stay', String(life.features.length))
    report(life.features[0].geometry.coordinates[0] === -123.37 && life.features[0].geometry.coordinates[1] === 48.43 && p1.holder === null && p2.holder === 'R. Holder' && p2.licence === 'CC BY 4.0' && p2.licence_url.startsWith('https://'), 'life observations: positions rounded to 0.01 degree, a credit kept only where CC BY asks for one, the licence kept with each record')
    const urls = D.lifeUrls(now)
    report(urls.length === 3 && urls.every((u) => u.includes('license=CC0_1_0') && u.includes('license=CC_BY_4_0') && u.includes('limit=100') && u.startsWith('https://api.gbif.org/')), 'life observations: three requests of 100 records, each asking for CC0 and CC BY 4.0 only')
    report(D.quakesUrl(now).includes('eventtype=earthquake') && D.quakesUrl(now).includes('starttime=2026-10-14T20:00:00'), 'earthquakes: request covers the last 7 days')

    // sea currents
    const vals = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] // 4 wide, 3 high: row 0 is the north row
    const sameValues = (a, b) => a.length === b.length && a.every((x, i) => x === b[i])
    const readOk = (le) => { const t = D.readGeoTiff(tiff({ w: 4, h: 3, values: vals, le })); return t.width === 4 && t.height === 3 && sameValues(t.bbox.map((x) => +x.toFixed(6)), [-124, 48.25, -122, 49]) && sameValues([...t.data], vals) }
    report(readOk(true) && readOk(false), 'sea currents: the GeoTIFF reader reads little- and big-endian files in strips, row 0 at the north (49 N) and the box from the tie point and pixel scale')
    const refused = (opts) => threw(() => D.readGeoTiff(tiff({ w: 4, h: 3, values: vals, ...opts })))
    report(refused({ compression: 5 }) && refused({ compression: 8 }), 'sea currents: a compressed GeoTIFF is refused, not misread')
    report(refused({ bits: 16 }) && refused({ format: 1 }) && refused({ strips: false }) && refused({ scale: [0.5, -0.25] }) && threw(() => D.readGeoTiff(new TextEncoder().encode('<?xml version="1.0"?><ServiceExceptionReport>no such time</ServiceExceptionReport>'))) && threw(() => D.readGeoTiff(new Uint8Array(4))), 'sea currents: integer or 16-bit values, missing data, a southward-growing scale, an XML error reply and a short file are refused')
    const whole = tiff({ w: 4, h: 3, values: vals })
    report(threw(() => D.readGeoTiff(whole.slice(0, whole.length - 8))), 'sea currents: a file cut short is refused')
    const hours = '2026-10-21T19:00:00Z/2026-10-23T18:00:00Z/PT1H'
    const ct = D.currentsTimes(xml('CIOPS-SalishSea_500m_SeaWaterVelocity_0.5m', hours))
    report(ct.length === 48 && ct[0] === '2026-10-21T19:00:00Z' && ct.at(-1) === '2026-10-23T18:00:00Z' && threw(() => D.currentsTimes(xml('RADAR_1KM_RRAI', hours))) && threw(() => D.currentsTimes(xml('CIOPS-SalishSea_500m_SeaWaterVelocity_0.5m', '2026-10-21T19:00:00Z/2026-10-23T18:00:00Z/P1D'))), 'sea currents: the 48 hours are read from the currents layer and not from a sibling, and an unreadable step is refused')
    const w1 = D.currentsWindow(ct, Date.parse('2026-10-22T04:20:00Z'))
    report(w1.times.length === 13 && w1.times[w1.at] === '2026-10-22T04:00:00Z' && w1.at === 0 && w1.times.at(-1) === '2026-10-22T16:00:00Z', 'sea currents: the first hour is the latest one not after now, and Play covers the 13 hours from there', JSON.stringify(w1))
    const wEarly = D.currentsWindow(ct, Date.parse('2026-10-20T00:00:00Z')), wLate = D.currentsWindow(ct, Date.parse('2026-10-25T00:00:00Z'))
    report(wEarly.times[0] === ct[0] && wEarly.at === 0 && wLate.times.length === 13 && wLate.times[wLate.at] === ct.at(-1) && wLate.times.at(-1) === ct.at(-1), 'sea currents: before the range it starts at the first hour, after it the window moves back to end at the last hour')
    const cu = D.currentsUrl('X', '2026-10-22T05:00:00Z'), cv = D.currentsUrl('Y', '2026-10-22T05:00:00Z')
    report(cu.startsWith('https://geo.weather.gc.ca/geomet?') && cu.includes('request=GetCoverage') && cu.includes('coverageid=CIOPS-SalishSea_500m_SeaWaterVelocityX_0.5m') && cv.includes('coverageid=CIOPS-SalishSea_500m_SeaWaterVelocityY_0.5m') && cu.includes('format=image%2Ftiff') && cu.includes('subset=x%28-124.5%2C-122.6%29') && cu.includes('subset=y%2847.8%2C49.2%29') && cu.includes('time=2026-10-22T05%3A00%3A00Z') && threw(() => D.currentsUrl('Z', '2026-10-22T05:00:00Z')) && threw(() => D.currentsUrl('X', 'soon')), 'sea currents: a request names the velocity layer, the time and the box, and refuses an unknown axis or a bad time')
    report(D.CURRENTS_BOX[0] < D.REGION[0] && D.CURRENTS_BOX[1] < D.REGION[1] && D.CURRENTS_BOX[2] > D.REGION[2] && D.CURRENTS_BOX[3] > D.REGION[3], 'sea currents: the box asked for covers everywhere the map can go, with a margin')
    report(D.pacificHour('2026-10-22T04:00:00Z') === 'Oct 21, 9 p.m. PDT' && D.pacificHour('nonsense') === null, 'sea currents: the hour is named in Pacific time, whatever the visitor\'s zone is')

    // A 5 x 4 grid of cells 1 degree wide, 52 N to 48 N, 0 to 5 E, with a land column and the three ways land is marked.
    const cells = (f) => Array.from({ length: 20 }, (_, i) => f(i % 5, Math.floor(i / 5)))
    const east = tiff({ w: 5, h: 4, values: cells((x, y) => (x === 2 ? [0, 1e20, NaN, 0][y] : 1 + x)), scale: [1, 1], tie: [0, 52], rows: 4 })
    const north = tiff({ w: 5, h: 4, values: cells((x, y) => (x === 2 ? [0, 1e20, NaN, 0][y] : 0.5)), scale: [1, 1], tie: [0, 52], rows: 4 })
    const grid = D.currentsGrid(D.readGeoTiff(east), D.readGeoTiff(north))
    report(sameValues([...grid.sea], cells((x, y) => (x === 2 ? 0 : 1))) && threw(() => D.currentsGrid(D.readGeoTiff(east), D.readGeoTiff(tiff({ w: 5, h: 4, values: cells(() => 1), scale: [1, 1], tie: [0, 51], rows: 4 })))), 'sea currents: zero in both components, a fill value and NaN all mark land, and two grids that do not match are refused')
    const near = (a, b) => Math.abs(a - b) < 1e-9
    const at = (lng, lat) => D.seaVelocity(grid, lng, lat)
    // Cell centres are at 0.5, 1.5 ... east. The east velocity of a sea cell is 1 + its column.
    const mid = at(0.5, 51.5), halfway = at(1, 51.5), nearLand = at(2.3, 51.5)
    report(near(mid[0], 1) && near(mid[1], 0.5) && near(halfway[0], 1.5) && nearLand === null, 'sea currents: bilinear between sea cells, no flow where the nearest cell is land', JSON.stringify({ mid, halfway, nearLand }))
    report(at(2.5, 51.5) === null && at(2.5, 50.5) === null && at(2.5, 49.5) === null && at(2.5, 48.5) === null, 'sea currents: land cells have no flow, whichever way they are marked')
    // Next to land the flow keeps its full value: the land cell is left out and the weights of the rest are scaled to add up to one.
    report(near(at(1.9, 51.5)[0], 2) && at(-0.4, 51.5) === null && at(5.2, 51.5) === null && at(1.5, 52.2) === null && at(1.5, 47.8) === null && at(NaN, 51) === null, 'sea currents: next to land the flow is not thinned by the land, and a place outside the grid has no flow')

    // The screen field. A north-up view, 10 px = 0.1 degree east and 0.05 degree south, then the same view turned so that east is up.
    const lattice = (cols, rows, spacing, at) => { const lng = new Float64Array(cols * rows), lat = new Float64Array(cols * rows); for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) [lng[j * cols + i], lat[j * cols + i]] = at(i * spacing, j * spacing); return { cols, rows, spacing, lng, lat } }
    // 0.5 m/s one way and next to nothing the other (exactly zero in both would be land).
    const eastAll = D.currentsGrid(D.readGeoTiff(tiff({ w: 5, h: 4, values: cells(() => 0.5), scale: [1, 1], tie: [0, 52], rows: 4 })), D.readGeoTiff(tiff({ w: 5, h: 4, values: cells(() => 1e-9), scale: [1, 1], tie: [0, 52], rows: 4 })))
    const northAll = D.currentsGrid(D.readGeoTiff(tiff({ w: 5, h: 4, values: cells(() => 1e-9), scale: [1, 1], tie: [0, 52], rows: 4 })), D.readGeoTiff(tiff({ w: 5, h: 4, values: cells(() => 0.5), scale: [1, 1], tie: [0, 52], rows: 4 })))
    const flat = lattice(5, 5, 20, (x, y) => [0.2 + x * 0.01, 51 - y * 0.0025 * 2]) // 20 px: 0.2 degree east, 0.05 degree south
    const perPixelLng = 0.01, perPixelLat = 0.005
    const fe = D.screenField(eastAll, 80, 80, 10, flat), fn = D.screenField(northAll, 80, 80, 10, flat)
    const wantX = 0.5 / (111320 * Math.cos(51 * Math.PI / 180) * perPixelLng) // px per second for 0.5 m/s east
    const o = 1 * fe.cols + 1
    report(fe.list.length === 81 && Math.abs(fe.vx[o] / wantX - 1) < 0.01 && Math.abs(fe.vy[o]) < 1e-3 * wantX && Math.abs(fe.speed[o] - 0.5) < 1e-6, 'sea currents: east flow moves right on a north-up screen, by the right number of pixels per second', JSON.stringify([fe.vx[o], wantX, fe.vy[o], fe.speed[o], fe.list.length]))
    const wantY = -0.5 / (111320 * perPixelLat)
    report(Math.abs(fn.vy[o] / wantY - 1) < 0.01 && Math.abs(fn.vx[o]) < 1e-3 * Math.abs(wantY), 'sea currents: north flow moves up the screen (y gets smaller), by the right number of pixels per second', JSON.stringify([fn.vy[o], wantY, fn.vx[o]]))
    // Turned a quarter turn (bearing 90, so east is at the top of the screen and south at the right).
    const turned = lattice(5, 5, 20, (x, y) => [0.5 - y * 0.01, 51 - x * 0.005])
    const ft = D.screenField(eastAll, 80, 80, 10, turned)
    report(ft.vy[o] < 0 && Math.abs(ft.vx[o]) < 1e-3 * Math.abs(ft.vy[o]) && Math.abs(Math.abs(ft.vy[o]) / (0.5 / (111320 * Math.cos(51 * Math.PI / 180) * 0.01)) - 1) < 0.01, 'sea currents: with the map turned so east is up, east flow moves up the screen, not right (the screen slope is applied, not assumed)', JSON.stringify([ft.vx[o], ft.vy[o]]))
    // No data: places over land, off the model or in the sky leave no flow, and the field is empty there.
    const sky = lattice(5, 5, 20, (x, y) => (y < 20 ? [NaN, NaN] : [0.2 + x * 0.01, 51 - y * 0.005]))
    const fs = D.screenField(eastAll, 80, 80, 10, sky)
    const landOnly = D.screenField(grid, 80, 80, 10, lattice(5, 5, 20, () => [2.5, 51.5])) // every point over a land cell
    const faraway = D.screenField(eastAll, 80, 80, 10, lattice(5, 5, 20, (x, y) => [20 + x, 10 + y]))
    report(fs.sea[0] === 0 && Number.isNaN(fs.vx[0]) && fs.sea[2 * fs.cols + 1] === 1 && fs.list.length < 81 && landOnly.list.length === 0 && faraway.list.length === 0, 'sea currents: points under the sky, over land or off the model have no flow', JSON.stringify([fs.list.length, landOnly.list.length, faraway.list.length]))
    report(Math.abs(D.horizonRow(800, 36.87, 75) - 78.46) < 0.1 && D.horizonRow(800, 36.87, 60) < 0 && D.horizonRow(800, 36.87, 0) === -Infinity && Math.abs(D.horizonRow(800, 36.87, 90) - 400) < 1e-6, 'sea currents: the horizon row of a tilted view (pitch 75 puts it 78 px below the top of an 800 px screen, pitch 60 puts it off the screen)', String(D.horizonRow(800, 36.87, 75)))
    const sample = [0, 0, 0]
    report(D.fieldAt(fe, 25, 25, sample) && Math.abs(sample[0] / wantX - 1) < 0.01 && !D.fieldAt(fs, 5, 5, sample) && !D.fieldAt(fe, -20, 10, sample) && !D.fieldAt(fe, 500, 10, sample), 'sea currents: a particle gets the velocity of the field around it, and none outside or where there is no flow')
  } finally { rmSync(dir, { recursive: true, force: true }) }
}

console.log('Self-test (each forbid rule must fire on bad input and stay quiet on clean input)')
selftest()
console.log('\nChecks on this folder')
checkTree()
console.log('\nParsing of outside replies (js/overlays-data.js, run on sample replies)')
await checkOverlayData()
console.log(`\n${failures === 0 ? 'All static checks passed.' : failures + ' check(s) failed.'}`)
if (failures) process.exitCode = 1
if (process.argv.includes('--browser')) {
  const { runBrowserChecks } = await import('./browser-check.mjs')
  const bad = await runBrowserChecks()
  if (bad) process.exitCode = 1
}
