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
// geo.weather.gc.ca (Environment and Climate Change Canada: radar, sea currents, wind, sea temperature, sea saltiness,
// alerts, air quality, conditions, river gauges), earthquake.usgs.gov (earthquakes), api.gbif.org (life observations)
// and api.tidesandcurrents.noaa.gov (tides and tidal currents, after a station is clicked).
const ALLOWED_HOSTS = [
  'tiles.openfreemap.org', 'openfreemap.org', 'www2.gov.bc.ca', 'www.openstreetmap.org',
  'www.openmaptiles.org', 'crd.ca', 'www.crd.ca', 'catalogue.data.gov.bc.ca',
  'opendata.victoria.ca', 'www.saanich.ca', 'islandstrust.bc.ca',
  's3.amazonaws.com', 'registry.opendata.aws', 'github.com', 'open.canada.ca',
  'api.weather.gc.ca', 'geo.weather.gc.ca', 'eccc-msc.github.io', 'wateroffice.ec.gc.ca',
  'earthquake.usgs.gov', 'www.usgs.gov', 'api.gbif.org', 'www.gbif.org', 'creativecommons.org',
  'ecoregions.appspot.com', 'www.hydrosheds.org', 'doi.org', 'datasets.wri.org',
  'www.opengis.net', // names the coordinate system in a sea currents request (EPSG 4326). It is an identifier, not fetched
  'api.tidesandcurrents.noaa.gov', 'tidesandcurrents.noaa.gov', // NOAA: predictions (fetched after a station is clicked) and its disclaimer and station pages (links)
  'www.w3.org', // the SVG namespace of a tide curve. It is an identifier, not fetched
  'tc.canada.ca', 'laws-lois.justice.gc.ca', // Transport Canada's Ship Safety Bulletin and the Marine Mammal Regulations: links in the vessel rules, never fetched
]
// Third-party hosts the page fetches from once a box is ticked. Each must be named in the privacy note.
const FETCH_HOSTS = ['s3.amazonaws.com', 'api.weather.gc.ca', 'geo.weather.gc.ca', 'earthquake.usgs.gov', 'api.gbif.org', 'api.tidesandcurrents.noaa.gov']
const OVERLAY_IDS = ['radar', 'currents', 'wind', 'temperature', 'salinity', 'tides', 'seafloor', 'alerts', 'aqhi', 'conditions', 'water', 'quakes', 'life', 'ecoregions', 'industry', 'protected', 'srkw', 'cetaceans', 'kelp', 'eelgrass', 'herring', 'seabirds']
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

// Wind carries the same Environment and Climate Change Canada credit on the map, says in the credits and
// in the status line that it is a forecast model and not for navigation, and is named in the privacy note.
function ruleWindCredit(html, js) {
  const out = []
  const para = html.split(/<\/p>|<\/li>/).filter((p) => p.includes('<strong>Wind</strong>')).map(textOf)[0]
  if (!para) out.push('the credits have no Wind paragraph')
  else {
    if (!/HRDPS/.test(para)) out.push('the Wind credit does not name the HRDPS model')
    if (!/forecast/i.test(para)) out.push('the Wind credit does not say it is a forecast')
    if (!/not for navigation/i.test(para)) out.push('the Wind credit does not say it is not for navigation')
  }
  if (!/src\('ov-wind-credit', ECCC_ATTRIB\)/.test(js)) out.push('the wind credit source does not carry ECCC_ATTRIB')
  if (!/forecast, not for navigation\)/.test(js)) out.push('the wind status line does not say forecast, not for navigation')
  const privacy = textOf(html.slice(html.indexOf('<strong>Privacy.</strong>'), html.indexOf('<strong>Software.</strong>')))
  if (!/\bwind\b/i.test(privacy)) out.push('the privacy note does not name wind')
  return out
}

// Sea temperature and Sea saltiness carry the same Environment and Climate Change Canada credit on the map as the other
// live layers, and say in the credits and the status line that the model is experimental and not for navigation.
function ruleScalarCredit(html, js) {
  const out = []
  const para = html.split(/<\/p>|<\/li>/).filter((p) => p.includes('<strong>Sea temperature and Sea saltiness</strong>')).map(textOf)[0]
  if (!para) out.push('the credits have no Sea temperature and Sea saltiness paragraph')
  else {
    if (!/CIOPS-SalishSea/.test(para)) out.push('the sea temperature credit does not name the CIOPS-SalishSea model')
    if (!/experimental/i.test(para)) out.push('the sea temperature credit does not say the model is experimental')
    if (!/not for navigation/i.test(para)) out.push('the sea temperature credit does not say it is not for navigation')
  }
  for (const kind of ['temperature', 'salinity']) if (!new RegExp(`src\\('ov-${kind}-credit', ECCC_ATTRIB\\)`).test(js)) out.push(`the ${kind} credit source does not carry ECCC_ATTRIB`)
  if (!/\(experimental, not for navigation\)\./.test((js.match(/const scalarMessage = [^\n]*/) || [''])[0])) out.push('the sea temperature status line does not say experimental, not for navigation')
  return out
}

// Tides and tidal currents carry NOAA's attribution on the map, in the credits and in every popup, say that they are
// predictions and not for navigation, and say that the curves are drawn here and are not official NOAA material.
function ruleTidesCredit(html, js) {
  const out = []
  const para = html.split(/<\/p>|<\/li>/).filter((p) => p.includes('<strong>Tides and tidal currents</strong>')).map(textOf)[0]
  if (!para) out.push('the credits have no Tides and tidal currents paragraph')
  else {
    if (!/NOAA\/NOS\/CO-OPS/.test(para)) out.push('the tides credit does not name NOAA/NOS/CO-OPS')
    if (!/in the public domain/.test(para)) out.push('the tides credit does not quote NOAA saying its information is in the public domain')
    if (!/not official NOAA material/.test(para)) out.push('the tides credit does not say the curves are not official NOAA material')
    if (!/not for navigation/i.test(para)) out.push('the tides credit does not say predictions are not for navigation')
  }
  if (!/const TIDES_ATTRIB = [^\n]*NOAA\/NOS\/CO-OPS/.test(js)) out.push('the on-map tides credit does not name NOAA/NOS/CO-OPS')
  if (!/src\('ov-tides', TIDES_ATTRIB\)/.test(js)) out.push('the tides source does not carry TIDES_ATTRIB')
  if (!js.includes('Predictions, not for navigation. Source: NOAA/NOS/CO-OPS') || !js.includes('Not official NOAA material.')) out.push('the tide popup does not carry the not-for-navigation and not-official lines')
  return out
}

// Seafloor depth says where its depths come from, how coarse they are and that they are not for navigation, and is
// drawn as a colour relief from an elevation source of its own on the existing tile address.
function ruleSeafloorCredit(html, js) {
  const out = []
  const para = html.split(/<\/p>|<\/li>/).filter((p) => p.includes('<strong>Seafloor depth</strong>')).map(textOf)[0]
  if (!para) out.push('the credits have no Seafloor depth paragraph')
  else {
    if (!/ETOPO1/.test(para)) out.push('the seafloor credit does not name ETOPO1')
    if (!/1 arc-minute/.test(para)) out.push('the seafloor credit does not say how coarse the grid is')
    if (!/not for navigation/i.test(para)) out.push('the seafloor credit does not say it is not for navigation')
  }
  if (!/const SEAFLOOR_ATTRIB = [^\n]*ETOPO1[^\n]*not for navigation/.test(js)) out.push('the on-map seafloor credit does not name ETOPO1 and say not for navigation')
  if (!/type: 'color-relief'/.test(js) || !/maxzoom: SEAFLOOR_MAX_ZOOM/.test(js)) out.push('the seafloor layer is not a colour relief on a source with a maximum zoom')
  return out
}

// Held ocean data stays out of the code and the page: Canadian Hydrographic Service tides, bathymetry and currents (their
// licences are not accepted), DFO conservation areas and shellfish closures, seal haulouts, whale sighting feeds and AIS.
const HELD_OCEAN = /iwls|nonna|chs-shc|dfo-mpo|rockfish|shellfish|haulout|acartia|obis\.org|inaturalist|aisstream|whalemuseum|orcanetwork/i
function ruleHeldOcean(files) {
  return files.filter((f) => f.text != null && HELD_OCEAN.test(f.text)).map((f) => `held ocean data named in ${f.path}: ${f.text.match(HELD_OCEAN)[0]}`)
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

// ---- marine life and protection: seven files cut at the edge of the area the map reaches (not at the demo box, which would draw a
// straight edge through open water), none of which shows where an animal is now
const MARINE_FILES = ['marine-protected', 'srkw-habitat', 'whale-density', 'kelp', 'eelgrass', 'herring-spawn', 'seabird-colonies']
const SEA_REGION = [-124.4, 47.9, -122.7, 49.1]
// The vessel distances, said wherever whales appear. This copy is kept apart from the one in js/overlays-data.js so that a change in one is caught.
const WHALE_RULES_TEXT = 'Vessels must stay at least 1,000 m from Southern Resident killer whales from June 1, 2026 to May 31, 2027, at least 200 m from all other killer whales and at least 100 m from all other whales, dolphins and porpoises. Some exceptions apply.'
const WHALE_LINKS = [
  'https://tc.canada.ca/en/marine-transportation/marine-safety/ship-safety-bulletins/protecting-killer-whales-waters-southern-british-columbia-2026-ssb-no-08-2026',
  'https://laws-lois.justice.gc.ca/eng/regulations/SOR-93-56/FullText.html',
]
const OGL_CANADA_STATEMENT = 'Contains information licensed under the Open Government Licence – Canada.'
const OGL_BC_STATEMENT = 'Contains information licensed under the Open Government Licence – British Columbia.'
const MARINE_NAMES = { protected: 'RACE ROCKS ECOLOGICAL RESERVE', minAreas: 15, minCells: 200, minColonies: 30 }

function marineJson(files, name) {
  const f = files.find((x) => x.path === `data/${name}.geojson`)
  if (!f) return { error: `data/${name}.geojson is missing` }
  try { const fc = JSON.parse(f.text); return Array.isArray(fc.features) ? { fc } : { error: `data/${name}.geojson is not a feature collection` } } catch { return { error: `data/${name}.geojson is not valid JSON` } }
}
// Every marine file is a feature collection with at least one feature, no empty shape, and every coordinate inside the area the map reaches.
function ruleMarineFiles(files) {
  const out = []
  for (const name of MARINE_FILES) {
    const { fc, error } = marineJson(files, name)
    if (error) { out.push(error); continue }
    if (!fc.features.length) out.push(`${name}: no features`)
    const bad = { n: 0 }
    const nulls = fc.features.filter((x) => !x.geometry).length
    for (const x of fc.features) if (x.geometry) coordsIn(x.geometry.coordinates, bad, SEA_REGION)
    if (nulls) out.push(`${name}: ${nulls} features with no shape`)
    if (bad.n) out.push(`${name}: ${bad.n} coordinates outside the area the map reaches`)
  }
  return out
}
function coordsIn(coords, bad, box) {
  if (typeof coords[0] === 'number') {
    if (coords[0] < box[0] - 1e-4 || coords[0] > box[2] + 1e-4 || coords[1] < box[1] - 1e-4 || coords[1] > box[3] + 1e-4) bad.n++
  } else for (const c of coords) coordsIn(c, bad, box)
}
// Protected marine areas: marine zones with a name and a type, a no-take code only where CPCAD gives one, no held rockfish area, and Race Rocks
// among them (the positive twin: an empty or wrong file would not have it).
function ruleProtectedAreas(files) {
  const { fc, error } = marineJson(files, 'marine-protected')
  if (error) return [error]
  const out = []
  if (fc.features.length < MARINE_NAMES.minAreas) out.push(`only ${fc.features.length} protected areas, expected ${MARINE_NAMES.minAreas} or more`)
  if (!fc.features.some((x) => x.properties?.name === MARINE_NAMES.protected)) out.push('Race Rocks Ecological Reserve is not in the file')
  for (const [i, x] of fc.features.entries()) {
    const p = x.properties || {}
    if (!p.name || !p.type) out.push(`area ${i}: no name or type`)
    if (p.no_take != null && ![1, 2, 3].includes(p.no_take)) out.push(`area ${i} (${p.name}): no_take ${p.no_take} is not All, Part or None`)
    if (/rockfish/i.test(String(p.name))) out.push(`area ${i}: a rockfish conservation area (held, no licence found)`)
    if (!['Polygon', 'MultiPolygon'].includes(x.geometry?.type)) out.push(`area ${i} (${p.name}): not an area`)
  }
  return out
}
// Seabird colonies: points, enough of them, and none named for a First Nation (this demo shows no First Nations content and no Nation has been asked).
function ruleSeabirds(files) {
  const { fc, error } = marineJson(files, 'seabird-colonies')
  if (error) return [error]
  const out = []
  if (fc.features.length < MARINE_NAMES.minColonies) out.push(`only ${fc.features.length} colonies, expected ${MARINE_NAMES.minColonies} or more`)
  for (const [i, x] of fc.features.entries()) {
    if (x.geometry?.type !== 'Point') out.push(`colony ${i}: not a point`)
    if (/tsawwassen|tsawout/i.test(String(x.properties?.name))) out.push(`colony ${i}: named for a First Nation`)
  }
  return out
}
// The density cells: every cell has an area and, for each of the three species, the model's number and its uncertainty.
function ruleDensityCells(files) {
  const { fc, error } = marineJson(files, 'whale-density')
  if (error) return [error]
  const out = []
  if (fc.features.length < MARINE_NAMES.minCells) out.push(`only ${fc.features.length} cells, expected ${MARINE_NAMES.minCells} or more`)
  for (const [i, x] of fc.features.entries()) {
    const p = x.properties || {}
    if (!(p.km2 > 0 && p.km2 <= 25.0001)) out.push(`cell ${i}: area ${p.km2} km2 is not above 0 and at most 25`)
    for (const sp of ['humpback', 'harbour', 'dalls']) {
      if (!(typeof p[`${sp}_n`] === 'number' && p[`${sp}_n`] >= 0)) out.push(`cell ${i}: no ${sp} number`)
      if (!(typeof p[`${sp}_cv`] === 'number' && p[`${sp}_cv`] > 0)) out.push(`cell ${i}: no ${sp} uncertainty`)
    }
    if (!['Polygon', 'MultiPolygon'].includes(x.geometry?.type)) out.push(`cell ${i}: not an area`)
  }
  return out.slice(0, 10)
}
// The critical habitat file is the Southern Resident killer whale area and nothing else.
function ruleSrkwHabitat(files) {
  const { fc, error } = marineJson(files, 'srkw-habitat')
  if (error) return [error]
  const out = []
  if (fc.features.length !== 1) out.push(`${fc.features.length} features, expected one`)
  else if (!/final/i.test(String(fc.features[0].properties?.status)) || !(fc.features[0].properties?.area_km2 > 1000) || !['Polygon', 'MultiPolygon'].includes(fc.features[0].geometry?.type)) out.push('the feature is not the large final or proposed critical habitat area')
  return out
}
// The credits give the survey years of the CRIMS files, and they must be the years in the data.
function ruleCrimsVintage(files, credits) {
  const out = []
  const herring = marineJson(files, 'herring-spawn'), eelgrass = marineJson(files, 'eelgrass')
  if (herring.error || eelgrass.error) return [herring.error || eelgrass.error]
  const ys = (fc, k) => fc.features.map((x) => x.properties?.[k]).filter((y) => Number.isInteger(y))
  const from = Math.min(...ys(herring.fc, 'first_year')), to = Math.max(...ys(herring.fc, 'last_year')), years = [...new Set(ys(eelgrass.fc, 'year'))]
  if (!Number.isFinite(from) || !Number.isFinite(to) || years.length !== 1) out.push(`the herring years (${from} to ${to}) or the eelgrass years (${years.join(', ')}) are not usable`)
  else {
    if (!credits.includes(`herring spawn records run from ${from} to ${to}`)) out.push(`the credits do not say the herring spawn records run from ${from} to ${to}`)
    if (!credits.includes(`eelgrass here was mapped in ${years[0]}`)) out.push(`the credits do not say the eelgrass was mapped in ${years[0]}`)
  }
  return out
}
// Whales: the vessel distances are in the code (one constant), in the credits, and in the panel notes and popups of the two layers that show whales.
function ruleWhaleRules(html, js) {
  const out = []
  const credits = textOf(html.slice(html.indexOf('id="credits"')))
  const paras = html.split(/<\/p>|<\/li>/).map(textOf)
  for (const name of ['Southern Resident killer whale critical habitat.', 'Whale and porpoise density.']) {
    const para = paras.find((p) => p.includes(name))
    if (!para) out.push(`the credits have no ${name} paragraph`)
    else if (!para.includes(WHALE_RULES_TEXT)) out.push(`the ${name} paragraph does not carry the vessel distances word for word`)
  }
  for (const l of WHALE_LINKS) if (!html.includes(`href="${l}"`)) out.push(`the credits do not link ${l}`)
  if (!credits.includes('Transport Canada Ship Safety Bulletin 08/2026') || !credits.includes('Marine Mammal Regulations, Schedule VI')) out.push('the credits do not name the bulletin and the regulations')
  const m = js.match(/export const WHALE_RULES = '([^']*)'/)
  if (!m || m[1] !== WHALE_RULES_TEXT) out.push('WHALE_RULES in js/overlays-data.js is not the vessel distances word for word')
  return out
}
function ruleWhaleRulesInCode(overlaysJs, dataJs) {
  const out = []
  if (!/\$\('srkw-note'\)\.textContent = `[^`]*\$\{WHALE_RULES\}`/.test(overlaysJs)) out.push('the panel note of the critical habitat does not carry the vessel distances')
  if (!/\$\('cetaceans-note'\)\.textContent = `[^`]*\$\{WHALE_RULES\}`/.test(overlaysJs)) out.push('the panel note of the density model does not carry the vessel distances')
  if (!/box\.append\(el\('p', WHALE_RULES\)\)/.test(overlaysJs)) out.push('the popup of a whale layer does not end with the vessel distances')
  const info = (name) => (dataJs.match(new RegExp(`export function ${name}\\([\\s\\S]*?\\n}\\n`)) || [''])[0]
  for (const name of ['srkwInfo', 'cetaceanInfo']) if (!info(name).includes('WHALE_RULES')) out.push(`${name} does not carry the vessel distances`)
  return out
}
// Wording of the marine layers: the credits and the panel say what they are, how old and not for navigation, and the on-map credits are in the code.
function ruleMarineCredits(html, js) {
  const out = []
  const paras = html.split(/<\/p>|<\/li>/).map(textOf)
  const find = (name) => paras.find((p) => p.includes(name))
  const need = (para, name, tests) => {
    if (!para) { out.push(`the credits have no ${name} paragraph`); return }
    for (const [re, what] of tests) if (!re.test(para)) out.push(`the ${name} credit does not say ${what}`)
  }
  need(find('Marine life and protection (each box'), 'Marine life and protection', [[/none shows where an animal is now/i, 'that none shows where an animal is now'], [/not for navigation/i, 'that it is not for navigation'], [/one file from this site/, 'that each loads one file from this site']])
  need(find('Protected marine areas.'), 'Protected marine areas', [[/CPCAD/, 'CPCAD'], [/Only the marine zone/, 'that only the marine zone is shown'], [/Marine Resource Use/, 'where the no-take line comes from']])
  need(find('Whale and porpoise density.'), 'Whale and porpoise density', [[/summer 2018/, 'summer 2018'], [/not where animals are now/, 'that it is not where animals are now'], [/Nhat/, 'what Nhat is'], [/Canadian waters only/, 'that it covers Canadian waters only']])
  need(find('Coastal habitat (kelp beds'), 'Coastal habitat', [[/legacy dataset that began in 1979/, 'that CRIMS is a legacy dataset that began in 1979'], [/only updated now and then/, 'that it was only updated now and then'], [/no plans to update/, 'that there are no plans to update it'], [new RegExp(OGL_BC_STATEMENT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'the Open Government Licence – British Columbia statement']])
  const federal = find('Federal data in the marine layers above')
  if (!federal || !federal.includes(OGL_CANADA_STATEMENT)) out.push('the credits do not carry the Open Government Licence – Canada statement for the federal marine data')
  const panel = textOf(html)
  if (!panel.includes('Nothing here shows where an animal is now. Not for navigation.')) out.push('the panel does not say that nothing in Marine life and protection shows where an animal is now')
  if (!/\(CRIMS\)\. It is a legacy survey that began in 1979 and was only updated now and then, so it is not a current record\./.test(panel)) out.push('the panel does not say that CRIMS is a legacy survey from 1979 and not a current record')
  const attribLine = (attr) => (js.match(new RegExp(`const ${attr} = [^\\n]*`)) || [''])[0]
  const attribs = { PROTECTED_ATTRIB: /CPCAD[\s\S]*OGL_CANADA_LINK/, SRKW_ATTRIB: /critical habitat[\s\S]*OGL_CANADA_LINK/, CETACEANS_ATTRIB: /Whale and porpoise model[\s\S]*OGL_CANADA_LINK/, CRIMS_ATTRIB: /CRIMS[\s\S]*legacy survey from 1979[\s\S]*OGL_BC_LINK/ }
  for (const [attr, re] of Object.entries(attribs)) if (!re.test(attribLine(attr))) out.push(`${attr} does not credit its data and name its licence`)
  for (const [src, attr] of [['ov-protected', 'PROTECTED_ATTRIB'], ['ov-srkw', 'SRKW_ATTRIB'], ['ov-cetaceans', 'CETACEANS_ATTRIB'], ['ov-kelp', 'CRIMS_ATTRIB'], ['ov-eelgrass', 'CRIMS_ATTRIB'], ['ov-herring', 'CRIMS_ATTRIB'], ['ov-seabirds', 'CRIMS_ATTRIB']]) {
    if (!new RegExp(`src\\('${src}', ${attr}\\)`).test(js)) out.push(`the ${src} source does not carry ${attr}`)
  }
  return out
}
// Reader-facing text of the marine layers is plain: no em dash and no semicolon.
function ruleMarinePlain(texts) {
  return texts.filter((t) => /[—;]/.test(t)).map((t) => `an em dash or semicolon in: ${t.slice(0, 70)}`)
}

const RULES = { ruleForbiddenNames, rulePrivacy, ruleExternalRefs, rulePins, ruleSize, ruleDroppedProviders, ruleFlowDirection, ruleFlowCanals, ruleEcccLicence, ruleCurrentsCredit, ruleWindCredit, ruleScalarCredit, ruleTidesCredit, ruleSeafloorCredit, ruleHeldOcean, rulePrivacyHosts, ruleOverlayBoxes, ruleIndustry, ruleMarineFiles, ruleProtectedAreas, ruleSeabirds, ruleDensityCells, ruleSrkwHabitat, ruleCrimsVintage, ruleWhaleRules, ruleWhaleRulesInCode, ruleMarineCredits, ruleMarinePlain }

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
  const windHtml = '<p><strong>Wind</strong> (off until you switch it on). The HRDPS model. It is a forecast model and is not for navigation.</p><p><strong>Privacy.</strong> Environment and Climate Change Canada for radar, sea currents, wind and alerts. <strong>Software.</strong></p>'
  const windJs = "src('ov-wind-credit', ECCC_ATTRIB); const m = `(forecast, not for navigation).`"
  const scalarHtml = '<p><strong>Sea temperature and Sea saltiness</strong> (each off until you switch it on). From the CIOPS-SalishSea model. It is an experimental model, and it is not for navigation.</p>'
  const scalarJs = "src('ov-temperature-credit', ECCC_ATTRIB); src('ov-salinity-credit', ECCC_ATTRIB)\nconst scalarMessage = (kind, time) => `Modelled for ${time}, Environment Canada’s CIOPS Salish Sea model (experimental, not for navigation).`\nconst z = 1"
  const tidesHtml = '<p><strong>Tides and tidal currents</strong> (off until you switch it on). From NOAA/NOS/CO-OPS, whose disclaimer says its information is &ldquo;in the public domain&rdquo;. The curves are not official NOAA material. Predictions are not for navigation.</p>'
  const tidesJs = "const TIDES_ATTRIB = 'Tides: <a href=\"x\">NOAA/NOS/CO-OPS</a> predictions'\nsrc('ov-tides', TIDES_ATTRIB)\nline(`Predictions, not for navigation. Source: NOAA/NOS/CO-OPS, station 1. Not official NOAA material.`)"
  const floorHtml = '<p><strong>Seafloor depth</strong> (off until you switch it on). From the ETOPO1 grid. Its cells are 1 arc-minute. It is not for navigation.</p>'
  const floorJs = "const SEAFLOOR_ATTRIB = 'Seafloor depth: ETOPO1, NOAA (coarse, not for navigation)'\nmap.addSource('seafloor', { maxzoom: SEAFLOOR_MAX_ZOOM }); map.addLayer({ id: 'seafloor', type: 'color-relief' })"
  // Marine life and protection fixtures
  const fc = (features) => JSON.stringify({ type: 'FeatureCollection', features })
  const sq = (b = [-123.5, 48.3, -123.4, 48.4]) => ({ type: 'Polygon', coordinates: [[[b[0], b[1]], [b[2], b[1]], [b[2], b[3]], [b[0], b[1]]]] })
  const area = (name, over = {}) => ({ type: 'Feature', geometry: sq(), properties: { name, type: 'Ecological Reserve', owner: 'Government of British Columbia', year: 1980, no_take: 1, ...over } })
  const protectedFc = (over = {}, first = 'RACE ROCKS ECOLOGICAL RESERVE') => fc(Array.from({ length: 20 }, (_, i) => area(i ? `AREA ${i}` : first, i === 1 ? over : {})))
  const colonies = (name, geometry = { type: 'Point', coordinates: [-123.5, 48.4] }) => fc(Array.from({ length: 40 }, (_, i) => ({ type: 'Feature', geometry, properties: { name: i === 3 ? name : `COLONY ${i}` } })))
  const cells = (over = {}) => fc(Array.from({ length: 220 }, (_, i) => ({ type: 'Feature', geometry: sq(), properties: { km2: 25, humpback_n: 0.5, humpback_cv: 0.5, harbour_n: 3, harbour_cv: 0.5, dalls_n: 1, dalls_cv: 0.5, ...(i === 5 ? over : {}) } })))
  const srkw = (over = {}) => ({ type: 'Feature', geometry: sq(), properties: { status: 'Final/Proposed', area_km2: 7497, ...over } })
  const herringFc = (a, b) => fc([{ type: 'Feature', geometry: { type: 'LineString', coordinates: [[-123.4, 48.4], [-123.3, 48.4]] }, properties: { first_year: a, last_year: b } }])
  const eelFc = (y) => fc([{ type: 'Feature', geometry: sq(), properties: { year: y } }])
  const marineSet = (kind) => MARINE_FILES.flatMap((n, i) => {
    const path = `data/${n}.geojson`
    if (i !== 2) return [f(path, fc([{ type: 'Feature', geometry: sq(), properties: {} }]))]
    return kind === 'missing' ? [] : [f(path, fc([{ type: 'Feature', geometry: kind === 'null' ? null : sq(kind === 'outside' ? [-120, 40, -119, 41] : undefined), properties: {} }]))]
  })
  const whaleHtml = `<section id="credits"><p><strong>Southern Resident killer whale critical habitat.</strong> ${WHALE_RULES_TEXT} Rules: <a href="${WHALE_LINKS[0]}">Transport Canada Ship Safety Bulletin 08/2026</a> and <a href="${WHALE_LINKS[1]}">Marine Mammal Regulations, Schedule VI</a>.</p><p><strong>Whale and porpoise density.</strong> ${WHALE_RULES_TEXT}</p></section>`
  const whaleJs = `export const WHALE_RULES = '${WHALE_RULES_TEXT}'`
  const whaleCodeJs = "$('srkw-note').textContent = `The area. ${WHALE_RULES}`\n$('cetaceans-note').textContent = `A model. ${WHALE_RULES}`\nbox.append(el('p', WHALE_RULES))"
  const whaleDataJs = 'export function srkwInfo(p) {\n  return { lines: [WHALE_RULES] }\n}\nexport function cetaceanInfo(p, key) {\n  return { lines: [WHALE_RULES] }\n}\n'
  const marineHtml = `<p><strong>Marine life and protection</strong> (each box off until you switch it on). None shows where an animal is now. Not for navigation. Each loads one file from this site.</p><p><strong>Protected marine areas.</strong> From CPCAD. Only the marine zone of each area is shown. The no-take line is the Marine Resource Use field.</p><p><strong>Whale and porpoise density.</strong> A model of summer 2018, not where animals are now. Nhat is the model's number. Canadian waters only.</p><p><strong>Coastal habitat</strong> (kelp beds, eelgrass, herring spawn and seabird colonies). Contains information licensed under the Open Government Licence – British Columbia. CRIMS is a legacy dataset that began in 1979 and was only updated now and then, and the Province has no plans to update it.</p><p><strong>Federal data in the marine layers above</strong> (protected areas). ${OGL_CANADA_STATEMENT}</p><p>Nothing here shows where an animal is now. Not for navigation.</p><p>Coastal habitat comes from the Province's Coastal Resource Information Management System (CRIMS). It is a legacy survey that began in 1979 and was only updated now and then, so it is not a current record.</p>`
  const marineJs = "const PROTECTED_ATTRIB = `Protected areas: CPCAD (${OGL_CANADA_LINK})`\nconst SRKW_ATTRIB = `Killer whale critical habitat: DFO (${OGL_CANADA_LINK})`\nconst CETACEANS_ATTRIB = `Whale and porpoise model: DFO (${OGL_CANADA_LINK})`\nconst CRIMS_ATTRIB = `Coastal habitat: CRIMS, a legacy survey from 1979 (${OGL_BC_LINK})`\nsrc('ov-protected', PROTECTED_ATTRIB)\nsrc('ov-srkw', SRKW_ATTRIB)\nsrc('ov-cetaceans', CETACEANS_ATTRIB)\nsrc('ov-kelp', CRIMS_ATTRIB)\nsrc('ov-eelgrass', CRIMS_ATTRIB)\nsrc('ov-herring', CRIMS_ATTRIB)\nsrc('ov-seabirds', CRIMS_ATTRIB)"
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
    ['ruleWindCredit (no forecast, no navigation line)', (files) => ruleWindCredit(files[0].text, files[1].text), [f('x.html', windHtml.replace('It is a forecast model and is not for navigation.', 'Modelled.')), f('x.js', windJs)], [f('x.html', windHtml), f('x.js', windJs)]],
    ['ruleWindCredit (credit source missing)', (files) => ruleWindCredit(files[0].text, files[1].text), [f('x.html', windHtml), f('x.js', windJs.replace('ECCC_ATTRIB', 'USGS_ATTRIB'))], [f('x.html', windHtml), f('x.js', windJs)]],
    ['ruleWindCredit (status line)', (files) => ruleWindCredit(files[0].text, files[1].text), [f('x.html', windHtml), f('x.js', windJs.replace('forecast, not for navigation)', 'a model)'))], [f('x.html', windHtml), f('x.js', windJs)]],
    ['ruleWindCredit (privacy note)', (files) => ruleWindCredit(files[0].text, files[1].text), [f('x.html', windHtml.replace('sea currents, wind and alerts', 'sea currents and alerts')), f('x.js', windJs)], [f('x.html', windHtml), f('x.js', windJs)]],
    ['ruleScalarCredit (no model, experimental or navigation line)', (files) => ruleScalarCredit(files[0].text, files[1].text), [f('x.html', '<p><strong>Sea temperature and Sea saltiness</strong> (each off until you switch it on). Modelled.</p>'), f('x.js', scalarJs)], [f('x.html', scalarHtml), f('x.js', scalarJs)]],
    ['ruleScalarCredit (credit source missing)', (files) => ruleScalarCredit(files[0].text, files[1].text), [f('x.html', scalarHtml), f('x.js', scalarJs.replace("src('ov-salinity-credit', ECCC_ATTRIB)", "src('ov-salinity-credit', USGS_ATTRIB)"))], [f('x.html', scalarHtml), f('x.js', scalarJs)]],
    ['ruleScalarCredit (status line)', (files) => ruleScalarCredit(files[0].text, files[1].text), [f('x.html', scalarHtml), f('x.js', scalarJs.replace('(experimental, not for navigation).', 'a model).'))], [f('x.html', scalarHtml), f('x.js', scalarJs)]],
    ['ruleTidesCredit (no attribution, quote or caveat)', (files) => ruleTidesCredit(files[0].text, files[1].text), [f('x.html', '<p><strong>Tides and tidal currents</strong> (off until you switch it on). Predictions.</p>'), f('x.js', tidesJs)], [f('x.html', tidesHtml), f('x.js', tidesJs)]],
    ['ruleTidesCredit (on-map credit)', (files) => ruleTidesCredit(files[0].text, files[1].text), [f('x.html', tidesHtml), f('x.js', tidesJs.replace('NOAA/NOS/CO-OPS</a> predictions', 'NOAA</a> predictions'))], [f('x.html', tidesHtml), f('x.js', tidesJs)]],
    ['ruleTidesCredit (popup lines)', (files) => ruleTidesCredit(files[0].text, files[1].text), [f('x.html', tidesHtml), f('x.js', tidesJs.replace('Not official NOAA material.', 'Thanks.'))], [f('x.html', tidesHtml), f('x.js', tidesJs)]],
    ['ruleSeafloorCredit (no grid, coarseness or navigation line)', (files) => ruleSeafloorCredit(files[0].text, files[1].text), [f('x.html', '<p><strong>Seafloor depth</strong> (off until you switch it on). Depth.</p>'), f('x.js', floorJs)], [f('x.html', floorHtml), f('x.js', floorJs)]],
    ['ruleSeafloorCredit (layer type)', (files) => ruleSeafloorCredit(files[0].text, files[1].text), [f('x.html', floorHtml), f('x.js', floorJs.replace("type: 'color-relief'", "type: 'raster'"))], [f('x.html', floorHtml), f('x.js', floorJs)]],
    ['ruleHeldOcean', ruleHeldOcean, [f('js/a.js', "const u = 'api-iwls.dfo-mpo.gc.ca'")], [f('js/a.js', "const u = 'api.tidesandcurrents.noaa.gov'")]],
    ['ruleHeldOcean (whale feed)', ruleHeldOcean, [f('index.html', '<p>Sightings from Acartia.</p>')], [f('index.html', '<p>Modelled density only.</p>')]],
    ['rulePrivacyHosts', (files) => rulePrivacyHosts(files[0].text), [f('x.html', '<strong>Privacy.</strong> tiles.openfreemap.org <strong>Software.</strong>')], [f('x.html', `<strong>Privacy.</strong> ${FETCH_HOSTS.join(' ')} <strong>Software.</strong>`)]],
    ['ruleOverlayBoxes (on by default)', (files) => ruleOverlayBoxes(files[0].text), [f('x.html', boxes(true))], [f('x.html', boxes(false))]],
    ['ruleOverlayBoxes (3D terrain off)', (files) => ruleOverlayBoxes(files[0].text), [f('x.html', boxes(false, false))], [f('x.html', boxes(false))]],
    ['ruleOverlayBoxes (no live sentence)', (files) => ruleOverlayBoxes(files[0].text), [f('x.html', boxes(false).replace(LIVE_SENTENCE, ''))], [f('x.html', boxes(false))]],
    ['ruleIndustry (source)', ruleIndustry, [f('data/industry-waste.geojson', industry({ src: 'climate-trace' }))], [f('data/industry-waste.geojson', industry({ src: 'hydrowaste' }))]],
    ['ruleIndustry (kind)', ruleIndustry, [f('data/industry-waste.geojson', industry({ kind: 'river' }))], [f('data/industry-waste.geojson', industry({ kind: 'wastewater' }))]],
    ['ruleIndustry (First Nation name)', ruleIndustry, [f('data/industry-waste.geojson', industry({ name: 'Tsawout WWTP' }))], [f('data/industry-waste.geojson', industry({ name: 'Saanich Peninsula WWTP' }))]],
    ['ruleMarineFiles (a file with an empty shape)', ruleMarineFiles, marineSet('null'), marineSet()],
    ['ruleMarineFiles (outside the area the map reaches)', ruleMarineFiles, marineSet('outside'), marineSet()],
    ['ruleMarineFiles (a missing file)', ruleMarineFiles, marineSet('missing'), marineSet()],
    ['ruleProtectedAreas (no Race Rocks)', ruleProtectedAreas, [f('data/marine-protected.geojson', protectedFc({}, 'SOME OTHER RESERVE'))], [f('data/marine-protected.geojson', protectedFc())]],
    ['ruleProtectedAreas (a no-take code of 4)', ruleProtectedAreas, [f('data/marine-protected.geojson', protectedFc({ no_take: 4 }))], [f('data/marine-protected.geojson', protectedFc({ no_take: null }))]],
    ['ruleProtectedAreas (a rockfish conservation area)', ruleProtectedAreas, [f('data/marine-protected.geojson', protectedFc({ name: 'Bamfield Rockfish Conservation Area' }))], [f('data/marine-protected.geojson', protectedFc({ name: 'Gulf Islands National Park Reserve' }))]],
    ['ruleProtectedAreas (too few areas)', ruleProtectedAreas, [f('data/marine-protected.geojson', fc([area('RACE ROCKS ECOLOGICAL RESERVE')]))], [f('data/marine-protected.geojson', protectedFc())]],
    ['ruleSeabirds (First Nation name)', ruleSeabirds, [f('data/seabird-colonies.geojson', colonies('TSAWWASSEN BKWATER'))], [f('data/seabird-colonies.geojson', colonies('CHAIN ISLETS'))]],
    ['ruleSeabirds (not points)', ruleSeabirds, [f('data/seabird-colonies.geojson', colonies('CHAIN ISLETS', sq()))], [f('data/seabird-colonies.geojson', colonies('CHAIN ISLETS'))]],
    ['ruleDensityCells (a cell without a species)', ruleDensityCells, [f('data/whale-density.geojson', cells({ dalls_n: null }))], [f('data/whale-density.geojson', cells())]],
    ['ruleDensityCells (a cell larger than the grid)', ruleDensityCells, [f('data/whale-density.geojson', cells({ km2: 40 }))], [f('data/whale-density.geojson', cells())]],
    ['ruleSrkwHabitat (two features)', ruleSrkwHabitat, [f('data/srkw-habitat.geojson', fc([srkw(), srkw()]))], [f('data/srkw-habitat.geojson', fc([srkw()]))]],
    ['ruleSrkwHabitat (another status)', ruleSrkwHabitat, [f('data/srkw-habitat.geojson', fc([srkw({ status: 'Proposed in a draft' })]))], [f('data/srkw-habitat.geojson', fc([srkw()]))]],
    ['ruleCrimsVintage (years not in the credits)', (files) => ruleCrimsVintage(files.slice(0, 2), files[2].text), [f('data/herring-spawn.geojson', herringFc(1937, 1986)), f('data/eelgrass.geojson', eelFc(1998)), f('x.html', 'the herring spawn records run from 1937 to 1980 and the eelgrass here was mapped in 1998')], [f('data/herring-spawn.geojson', herringFc(1937, 1986)), f('data/eelgrass.geojson', eelFc(1998)), f('x.html', 'the herring spawn records run from 1937 to 1986 and the eelgrass here was mapped in 1998')]],
    ['ruleWhaleRules (a distance changed in the density paragraph)', (files) => ruleWhaleRules(files[0].text, files[1].text), [f('x.html', whaleHtml.replace(/<p><strong>Whale and porpoise density\.<\/strong>[^]*$/, `<p><strong>Whale and porpoise density.</strong> ${WHALE_RULES_TEXT.replace('100 m', '50 m')}</p></section>`)), f('x.js', whaleJs)], [f('x.html', whaleHtml), f('x.js', whaleJs)]],
    ['ruleWhaleRules (a link missing)', (files) => ruleWhaleRules(files[0].text, files[1].text), [f('x.html', whaleHtml.replace(WHALE_LINKS[1], 'https://example.org/')), f('x.js', whaleJs)], [f('x.html', whaleHtml), f('x.js', whaleJs)]],
    ['ruleWhaleRules (the code constant changed)', (files) => ruleWhaleRules(files[0].text, files[1].text), [f('x.html', whaleHtml), f('x.js', whaleJs.replace('at least 100 m', 'at least 10 m'))], [f('x.html', whaleHtml), f('x.js', whaleJs)]],
    ['ruleWhaleRulesInCode (panel note without the distances)', (files) => ruleWhaleRulesInCode(files[0].text, files[1].text), [f('x.js', whaleCodeJs.replace("A model. ${WHALE_RULES}", 'A model.')), f('x.js', whaleDataJs)], [f('x.js', whaleCodeJs), f('x.js', whaleDataJs)]],
    ['ruleWhaleRulesInCode (popup without the distances)', (files) => ruleWhaleRulesInCode(files[0].text, files[1].text), [f('x.js', whaleCodeJs.replace("box.append(el('p', WHALE_RULES))", '')), f('x.js', whaleDataJs)], [f('x.js', whaleCodeJs), f('x.js', whaleDataJs)]],
    ['ruleWhaleRulesInCode (density info without the distances)', (files) => ruleWhaleRulesInCode(files[0].text, files[1].text), [f('x.js', whaleCodeJs), f('x.js', whaleDataJs.replace('export function cetaceanInfo(p, key) {\n  return { lines: [WHALE_RULES] }', 'export function cetaceanInfo(p, key) {\n  return { lines: [] }'))], [f('x.js', whaleCodeJs), f('x.js', whaleDataJs)]],
    ['ruleMarineCredits (no legacy statement)', (files) => ruleMarineCredits(files[0].text, files[1].text), [f('x.html', marineHtml.replace('legacy dataset that began in 1979', 'dataset')), f('x.js', marineJs)], [f('x.html', marineHtml), f('x.js', marineJs)]],
    ['ruleMarineCredits (no federal licence statement)', (files) => ruleMarineCredits(files[0].text, files[1].text), [f('x.html', marineHtml.replace(OGL_CANADA_STATEMENT, 'Thanks.')), f('x.js', marineJs)], [f('x.html', marineHtml), f('x.js', marineJs)]],
    ['ruleMarineCredits (no model date in the density credit)', (files) => ruleMarineCredits(files[0].text, files[1].text), [f('x.html', marineHtml.replace('A model of summer 2018, not where animals are now.', 'A model.')), f('x.js', marineJs)], [f('x.html', marineHtml), f('x.js', marineJs)]],
    ['ruleMarineCredits (a source without its credit)', (files) => ruleMarineCredits(files[0].text, files[1].text), [f('x.html', marineHtml), f('x.js', marineJs.replace("src('ov-herring', CRIMS_ATTRIB)", "src('ov-herring', USGS_ATTRIB)"))], [f('x.html', marineHtml), f('x.js', marineJs)]],
    ['ruleMarineCredits (the credit does not name its licence)', (files) => ruleMarineCredits(files[0].text, files[1].text), [f('x.html', marineHtml), f('x.js', marineJs.replace('(${OGL_CANADA_LINK})', ''))], [f('x.html', marineHtml), f('x.js', marineJs)]],
    ['ruleMarinePlain (em dash)', (files) => ruleMarinePlain(files.map((x) => x.text)), [f('x', 'old data — not current')], [f('x', 'old data, not current')]],
    ['ruleMarinePlain (semicolon)', (files) => ruleMarinePlain(files.map((x) => x.text)), [f('x', 'old data; not current')], [f('x', 'old data, not current')]],
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
  report(...pair(ruleMarineFiles(files), `marine life and protection: ${MARINE_FILES.length} data files, valid GeoJSON, no empty shapes, every coordinate inside the area the map reaches`))
  report(...pair(ruleProtectedAreas(files), 'protected marine areas: marine zones with a name and a type, a no-take code only where CPCAD gives one, Race Rocks present, no rockfish conservation area'))
  report(...pair(ruleSrkwHabitat(files), 'killer whale critical habitat: one final or proposed Southern Resident area'))
  report(...pair(ruleDensityCells(files), 'whale and porpoise density: every cell has an area and, for all three species, the model number and its uncertainty'))
  report(...pair(ruleSeabirds(files), 'seabird colonies: points, enough of them, none named for a First Nation'))
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
  const overlaysJs = byPath['js/overlays.js']?.text || '', flowJs = byPath['js/flow.js']?.text || ''
  const dataJs = byPath['js/overlays-data.js']?.text || ''
  report(...pair(ruleWhaleRules(html, dataJs), 'whales: the vessel distances are in the code and in the credits word for word, with links to the Transport Canada bulletin and the Marine Mammal Regulations'))
  report(...pair(ruleWhaleRulesInCode(overlaysJs, dataJs), 'whales: the panel notes of the critical habitat and the density model, and their popups, carry the vessel distances'))
  report(...pair(ruleMarineCredits(html, overlaysJs), 'marine life and protection: the credits and the panel say what each layer is, how old it is and that it is not for navigation, and every source carries its credit on the map'))
  report(...pair(ruleCrimsVintage(files, textOf(credits)), 'coastal habitat: the survey years in the credits are the years in the data (herring spawn records, eelgrass mapping)'))
  report(...pair(ruleCurrentsCredit(html, overlaysJs), 'sea currents carry the Environment and Climate Change Canada credit on the map and say the model is experimental and not for navigation'))
  report(...pair(ruleWindCredit(html, overlaysJs), 'wind carries the Environment and Climate Change Canada credit on the map, says it is a forecast and not for navigation, and is named in the privacy note'))
  report(...pair(ruleScalarCredit(html, overlaysJs), 'sea temperature and sea saltiness carry the Environment and Climate Change Canada credit on the map and say the model is experimental and not for navigation'))
  report(...pair(ruleTidesCredit(html, overlaysJs), 'tides and tidal currents carry the NOAA/NOS/CO-OPS attribution, say predictions are not for navigation and that the curves are not official NOAA material'))
  report(...pair(ruleSeafloorCredit(html, overlaysJs), 'seafloor depth says it comes from ETOPO1, how coarse that is and that it is not for navigation, and is a colour relief on its own capped source'))
  report(...pair(ruleHeldOcean(scanned.filter((f) => /^(index\.html$|js\/|css\/)/.test(f.path))), 'no held ocean data in the code or the page (Canadian Hydrographic Service data, conservation areas, shellfish closures, haulouts, whale sighting feeds, ship tracking)'))
  report(flowJs.includes('motionQuery') && flowJs.includes('visibilitychange') && flowJs.includes('cancelAnimationFrame') && flowJs.includes("'movestart'"), 'the particle loop of sea currents and wind honours reduced motion, stops when the tab is hidden and while the map moves')
  report(!byPath['js/currents.js'] && /createFlow/.test(overlaysJs) && (overlaysJs.match(/createFlow\(/g) || []).length === 1 && !/new Path2D/.test(overlaysJs), 'sea currents and wind use one particle engine (js/flow.js), made once, with no second copy of it in overlays.js')
  report(overlaysJs.includes('Contains information licenced under the <a href="${ECCC_LICENCE}" target="_blank" rel="noopener">Data Server End-use Licence</a> of Environment and Climate Change Canada.') && overlaysJs.includes("const ECCC_LICENCE = 'https://eccc-msc.github.io/open-data/licence/readme_en/'"), 'on-map attribution carries the Environment and Climate Change Canada licence statement and a link to the licence')
  const missingOverlay = OVERLAY_STATEMENTS.filter((t) => !creditsText.includes(t))
  report(missingOverlay.length === 0, 'credits carry the Environment Canada, USGS, ecoregion and industry source statements word for word', missingOverlay.join(' | '))

  const sources = byPath['data/SOURCES.md']?.text || ''
  report([...LAYER_FILES.filter((n) => n !== 'pins'), ...MARINE_FILES].every((n) => sources.includes(`${n}.geojson`)), 'data/SOURCES.md lists every data file')
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
    // Both modules are copied under their own names into a folder that says they are ES modules, because flow.js imports overlays-data.js.
    writeFileSync(join(dir, 'package.json'), '{"type":"module"}')
    copyFileSync(join(ROOT, 'js/overlays-data.js'), join(dir, 'overlays-data.js'))
    copyFileSync(join(ROOT, 'js/flow.js'), join(dir, 'flow.js'))
    const D = await import(pathToFileURL(join(dir, 'overlays-data.js')).href)
    const F = await import(pathToFileURL(join(dir, 'flow.js')).href)
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
    const w1 = D.hourWindow(ct, Date.parse('2026-10-22T04:20:00Z'))
    report(w1.times.length === 13 && w1.times[w1.at] === '2026-10-22T04:00:00Z' && w1.at === 0 && w1.times.at(-1) === '2026-10-22T16:00:00Z', 'sea currents: the first hour is the latest one not after now, and Play covers the 13 hours from there', JSON.stringify(w1))
    const wEarly = D.hourWindow(ct, Date.parse('2026-10-20T00:00:00Z')), wLate = D.hourWindow(ct, Date.parse('2026-10-25T00:00:00Z'))
    report(wEarly.times[0] === ct[0] && wEarly.at === 0 && wLate.times.length === 13 && wLate.times[wLate.at] === ct.at(-1) && wLate.times.at(-1) === ct.at(-1), 'sea currents: before the range it starts at the first hour, after it the window moves back to end at the last hour')
    const cu = D.currentsUrl('X', '2026-10-22T05:00:00Z'), cv = D.currentsUrl('Y', '2026-10-22T05:00:00Z')
    report(cu.startsWith('https://geo.weather.gc.ca/geomet?') && cu.includes('request=GetCoverage') && cu.includes('coverageid=CIOPS-SalishSea_500m_SeaWaterVelocityX_0.5m') && cv.includes('coverageid=CIOPS-SalishSea_500m_SeaWaterVelocityY_0.5m') && cu.includes('format=image%2Ftiff') && cu.includes('scalefactor=0.5') && cv.includes('scalefactor=0.5') && cu.includes('subset=x%28-124.5%2C-122.6%29') && cu.includes('subset=y%2847.8%2C49.2%29') && cu.includes('time=2026-10-22T05%3A00%3A00Z') && threw(() => D.currentsUrl('Z', '2026-10-22T05:00:00Z')) && threw(() => D.currentsUrl('X', 'soon')), 'sea currents: a request names the velocity layer, the time and the box, asks for every second cell of the grid (scalefactor 0.5, a quarter of the bytes), and refuses an unknown axis or a bad time')
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

    // The same speed on the screen at every zoom: the field of the same current over a view twice as close has twice the
    // pixels for each metre, and scaling each field by its own typical pixels per metre gives the same pixels per second.
    const fz = D.screenField(eastAll, 80, 80, 10, lattice(5, 5, 20, (x, y) => [0.2 + x * 0.005, 51 - y * 0.0025]))
    const k1 = 60 / D.fieldScale(fe), k2 = 60 / D.fieldScale(fz)
    report(Math.abs(D.fieldScale(fz) / D.fieldScale(fe) - 2) < 0.02 && Math.abs(fe.vx[o] * k1 - 30) < 0.5 && Math.abs(fz.vx[o] * k2 - 30) < 0.5 && Number.isNaN(D.fieldScale(landOnly)), 'sea currents: scaled by the typical pixels per metre of the view, 0.5 m/s moves at 30 px a second at two zooms that differ by a factor of two, and a field with no flow has no scale', JSON.stringify([D.fieldScale(fe), D.fieldScale(fz), fe.vx[o] * k1, fz.vx[o] * k2]))
    // The tilt is kept: where the screen shows more ground for each pixel (far away) the picture still moves slower than near.
    const far = (y) => 1 + (80 - y) / 80 // degrees for a pixel: twice as many at the top of the screen as at the bottom
    const ftl = D.screenField(eastAll, 80, 80, 10, lattice(5, 5, 20, (x, y) => [0.2 + x * 0.01 * far(y), 51 - y * 0.005 * far(y)]))
    const rowSpeed = (row) => Math.hypot(ftl.vx[row * ftl.cols + 4], ftl.vy[row * ftl.cols + 4])
    report(rowSpeed(7) > rowSpeed(1) * 1.2 && Number.isFinite(D.fieldScale(ftl)), 'sea currents: with a tilted view, ground far away gives a slower picture than ground near, and one scale is still found', JSON.stringify([rowSpeed(1), rowSpeed(7), D.fieldScale(ftl)]))

    // The readout for a click on the sea
    const cw = D.compassWord
    report(cw(0) === 'north' && cw(44) === 'north-east' && cw(90) === 'east' && cw(135) === 'south-east' && cw(180) === 'south' && cw(225) === 'south-west' && cw(270) === 'west' && cw(315) === 'north-west' && cw(359) === 'north' && cw(-45) === 'north-west' && cw(22.4) === 'north' && cw(22.6) === 'north-east' && cw(405) === 'north-east', 'sea currents readout: a bearing in degrees is named by its nearest compass point, with wrap-around', [0, 44, 90, 135, 180, 225, 270, 315, 359, -45, 405].map(cw).join(','))
    const ro = D.currentReadout([0.3, 0.4]), re = D.currentReadout([0.5, 0]), rs = D.currentReadout([0, -0.5]), rq = D.currentReadout([0.01, -0.01])
    report(near(ro.ms, 0.5) && Math.abs(ro.knots - 0.9719) < 0.001 && ro.toward === 'north-east' && re.toward === 'east' && rs.toward === 'south' && rq.still && rq.toward === null && !ro.still && threw(() => D.currentReadout([NaN, 0])), 'sea currents readout: speed in m/s and knots (1 knot is 1852 m an hour), the point the water flows toward, almost still has no direction, and a value that is not a number is refused', JSON.stringify([ro, re, rs, rq]))

    // wind
    const wh = '2026-10-22T06:00:00Z/2026-10-24T06:00:00Z/PT1H'
    const wtimes = D.windTimes(xml('HRDPS.CONTINENTAL_WSPD', wh))
    report(wtimes.length === 49 && wtimes[0] === '2026-10-22T06:00:00Z' && wtimes.at(-1) === '2026-10-24T06:00:00Z' && threw(() => D.windTimes(xml('CIOPS-SalishSea_500m_SeaWaterVelocity_0.5m', wh))) && threw(() => D.windTimes(xml('HRDPS.CONTINENTAL_WSPD', '2026-10-22T06:00:00Z/2026-10-24T06:00:00Z/P1D'))), 'wind: the 49 hours are read from the wind speed layer and not from a sibling, and an unreadable step is refused')
    const wwin = D.hourWindow(wtimes, Date.parse('2026-10-22T11:20:00Z'))
    report(wwin.times.length === 13 && wwin.times[wwin.at] === '2026-10-22T11:00:00Z' && wwin.times[0] === '2026-10-22T11:00:00Z' && wwin.times.at(-1) === '2026-10-22T23:00:00Z' && D.hourWindow(wtimes, Date.parse('2026-10-22T04:00:00Z')).times[0] === '2026-10-22T06:00:00Z', 'wind: Play covers the 13 hours from the latest hour not after now, and starts at the first hour on offer if now is before it')
    const wsU = D.windUrl('speed', '2026-10-22T11:00:00Z'), wdU = D.windUrl('direction', '2026-10-22T11:00:00Z')
    report(wsU.startsWith('https://geo.weather.gc.ca/geomet?') && wsU.includes('request=GetCoverage') && wsU.includes('coverageid=HRDPS.CONTINENTAL_WSPD') && wdU.includes('coverageid=HRDPS.CONTINENTAL_WD&') && wsU.includes('format=image%2Ftiff') && wsU.includes('scalesize=x%2857%29%2Cy%2862%29') && wsU.includes('subset=x%28-124.5%2C-122.6%29') && wsU.includes('subset=y%2847.8%2C49.2%29') && wsU.includes('time=2026-10-22T11%3A00%3A00Z') && threw(() => D.windUrl('u', '2026-10-22T11:00:00Z')) && threw(() => D.windUrl('speed', 'soon')), 'wind: a request names the speed or direction layer, the time, the box and the number of cells, and refuses an unknown part or a bad time')
    // The direction is where the wind blows FROM, clockwise from north: a wind from 270 (west) blows east. Columns: from 270, 0, 90, 180 and 45, at 5 m/s.
    const fromDeg = [270, 0, 90, 180, 45]
    const windTiff = (f) => tiff({ w: 5, h: 4, values: cells(f), scale: [1, 1], tie: [0, 52], rows: 4 })
    const speedTiff = windTiff((x, y) => (y === 0 ? 5 : [NaN, 1e20, 5, 0, -1][x]))
    const directionTiff = windTiff((x, y) => (y === 0 ? fromDeg[x] : [90, 90, 1e20, 0, 90][x]))
    const wg = D.windGrid(D.readGeoTiff(speedTiff), D.readGeoTiff(directionTiff))
    const wc = (x, y) => [wg.u[y * 5 + x], wg.v[y * 5 + x]]
    const s45 = 5 * Math.sin(Math.PI / 4)
    report(near(wc(0, 0)[0], 5) && Math.abs(wc(0, 0)[1]) < 1e-5 && Math.abs(wc(1, 0)[0]) < 1e-5 && near(wc(1, 0)[1], -5) && near(wc(2, 0)[0], -5) && near(wc(3, 0)[1], 5) && near(wc(4, 0)[0], -s45) && near(wc(4, 0)[1], -s45), 'wind: a wind from the west (270) blows east, from the north (0) blows south, from the east (90) blows west, from the south (180) blows north, from the north-east (45) blows south-west', JSON.stringify([0, 1, 2, 3, 4].map((x) => wc(x, 0).map((v) => +v.toFixed(3)))))
    report(sameValues([...wg.sea], cells((x, y) => (y === 0 ? 1 : [0, 0, 0, 1, 0][x]))) && wc(3, 1)[0] === 0 && wc(3, 1)[1] === 0 && threw(() => D.windGrid(D.readGeoTiff(speedTiff), D.readGeoTiff(tiff({ w: 5, h: 4, values: cells(() => 1), scale: [1, 1], tie: [0, 51], rows: 4 })))), 'wind: no number, a fill value, a missing direction and a negative speed are no data, an exactly calm cell is data (wind blows over land, so zero is not land), and two grids that do not match are refused')
    const gridAt = (lng, lat) => D.seaVelocity(wg, lng, lat)
    report(near(gridAt(0.5, 51.5)[0], 5) && near(gridAt(2.5, 51.5)[0], -5) && gridAt(2.5, 49.5) === null && gridAt(7, 51.5) === null && near(gridAt(1, 51.5)[0], 2.5) && near(gridAt(1, 51.5)[1], -2.5), 'wind: the same bilinear lookup serves the wind, the components are blended (not the directions), and a place outside the grid has none', JSON.stringify([gridAt(0.5, 51.5), gridAt(1, 51.5)]))
    const westWind = D.windGrid(D.readGeoTiff(windTiff(() => 5)), D.readGeoTiff(windTiff(() => 270)))
    const fw = D.screenField(westWind, 80, 80, 10, flat)
    report(fw.list.length === 81 && fw.vx[o] > 0 && Math.abs(fw.vy[o]) < 1e-3 * fw.vx[o] && Math.abs(fw.speed[o] - 5) < 1e-3 && Math.abs(fw.vx[o] / (5 / (111320 * Math.cos(51 * Math.PI / 180) * perPixelLng)) - 1) < 0.01, 'wind: a wind from the west moves right on a north-up screen at the wind speed', JSON.stringify([fw.vx[o], fw.vy[o], fw.speed[o], fw.list.length]))

    // The look of the particles: dark enough to read on the pale sea of the basemap, darker where the flow is faster
    const SEA = [194, 200, 202]
    const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4 }; return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]) }
    const rgba = (t) => t.match(/[\d.]+/g).map(Number)
    const contrastOn = (colour) => { const [r, g, b, a] = rgba(colour), c = [r, g, b].map((v, i) => v * a + SEA[i] * (1 - a)), [hi, lo] = [lum(c), lum(SEA)].sort((p, q) => q - p); return (hi + 0.05) / (lo + 0.05) }
    const ramp = (kind) => F.FLOW_PROFILES[kind].bands.map((b) => contrastOn(b.colour))
    const readable = (kind) => { const r = ramp(kind), b = F.FLOW_PROFILES[kind].bands; return r.every((c) => c >= 3.5) && r.every((c, i) => i === 0 || c > r[i - 1]) && b[0].from === 0 && b.every((x, i) => i === 0 || x.from > b[i - 1].from) }
    report(readable('currents') && readable('wind') && contrastOn('rgba(214, 240, 248, 0.45)') < 3.5 && contrastOn('rgba(255, 255, 255, 1)') < 3.5, 'particles: every speed band of the currents and the wind has a contrast of at least 3.5 to 1 against the basemap sea (the old white and pale cyan had 1.2 to 1.9) and the bands get darker with speed', JSON.stringify([ramp('currents').map((x) => +x.toFixed(1)), ramp('wind').map((x) => +x.toFixed(1))]))
    report(F.FLOW_PROFILES.currents.pxPerMs === 60 && F.FLOW_PROFILES.wind.pxPerMs > 0 && F.FLOW_PROFILES.currents.bands[0].colour !== F.FLOW_PROFILES.wind.bands[0].colour && rgba(F.FLOW_PROFILES.currents.bands[0].colour)[2] > rgba(F.FLOW_PROFILES.currents.bands[0].colour)[0] && rgba(F.FLOW_PROFILES.wind.bands[0].colour)[0] > rgba(F.FLOW_PROFILES.wind.bands[0].colour)[1], 'particles: the currents are drawn in blue and the wind in purple, so the two are not mixed up, and a current of 0.5 m/s moves at 30 px a second')

    // sea temperature and saltiness (one picture for each hour, from the same model as the currents)
    const tAt = (kind, h) => xml(D.SCALARS[kind].layer, h)
    const tHours = '2026-10-22T07:00:00Z/2026-10-24T06:00:00Z/PT1H'
    const tTimes = D.scalarTimes('temperature', tAt('temperature', tHours))
    report(tTimes.length === 48 && tTimes[0] === '2026-10-22T07:00:00Z' && tTimes.at(-1) === '2026-10-24T06:00:00Z' && threw(() => D.scalarTimes('temperature', tAt('salinity', tHours))) && threw(() => D.scalarTimes('salinity', xml('CIOPS-SalishSea_500m_SeaWaterVelocity_0.5m', tHours))) && threw(() => D.scalarTimes('salinity', tAt('salinity', '2026-10-22T07:00:00Z/2026-10-24T06:00:00Z/P1D'))) && threw(() => D.scalarTimes('wave', tHours)), 'sea temperature and saltiness: the 48 hours are read from their own layer and not a sibling, an unreadable step and an unknown layer are refused')
    const tNow = Date.parse('2026-10-22T12:40:00Z')
    report(D.scalarHour(tTimes, null, tNow) === '2026-10-22T12:00:00Z' && D.scalarHour(tTimes, null, Date.parse('2026-10-20T00:00:00Z')) === tTimes[0] && D.scalarHour(tTimes, null, Date.parse('2026-10-30T00:00:00Z')) === tTimes.at(-1), 'sea temperature and saltiness: with no sea currents the hour shown is the latest hour not after now (the first hour on offer before the range, the last after it)')
    report(D.scalarHour(tTimes, '2026-10-22T18:00:00Z', tNow) === '2026-10-22T18:00:00Z' && D.scalarHour(tTimes, '2026-10-21T19:00:00Z', tNow) === tTimes[0] && D.scalarHour(tTimes, '2026-10-22T18:20:00Z', tNow) === '2026-10-22T18:00:00Z' && D.nearestHour(tTimes, '2026-10-22T08:30:00Z') === '2026-10-22T08:00:00Z' && threw(() => D.nearestHour([], '2026-10-22T08:00:00Z')) && threw(() => D.nearestHour(tTimes, 'soon')), 'sea temperature and saltiness: with the sea currents on, the hour shown is the hour of the currents (the nearest one on offer when the currents have an hour this layer lacks)')
    const iu = D.scalarImageUrl('temperature', '2026-10-22T13:00:00Z'), su = D.scalarImageUrl('salinity', '2026-10-22T13:00:00Z')
    report(iu.startsWith('https://geo.weather.gc.ca/geomet?') && iu.includes('request=GetMap') && iu.includes('layers=CIOPS-SalishSea_500m_SeaWaterPotentialTemp_0.5m') && iu.includes('styles=SEA_TEMPSURF-DEFAULT') && iu.includes('crs=EPSG%3A3857') && iu.includes('width=720') && iu.includes('height=767') && iu.includes('transparent=true') && iu.includes('time=2026-10-22T13%3A00%3A00Z') && su.includes('layers=CIOPS-SalishSea_500m_SeaWaterSalinity_0.5m') && su.includes('styles=SEA_SALT-COASTAL') && threw(() => D.scalarImageUrl('temperature', 'soon')) && threw(() => D.scalarImageUrl('wind', '2026-10-22T13:00:00Z')), 'sea temperature and saltiness: a picture request names the layer, its colour style, web Mercator, the map area at 720 x 767 pixels and one hour, and refuses a bad hour or layer')
    report(D.scalarCapabilitiesUrl('temperature').includes('LAYER=CIOPS-SalishSea_500m_SeaWaterPotentialTemp_0.5m') && !D.scalarCapabilitiesUrl('salinity').includes('LAYERS=') && D.scalarCapabilitiesUrl('salinity').includes('LAYER=CIOPS-SalishSea_500m_SeaWaterSalinity_0.5m'), 'sea temperature and saltiness: the hours are asked for with the layer-specific description (a few KB, not the whole service)')
    const fi = D.scalarInfoUrl('temperature', -123.2, 48.35, '2026-10-22T13:00:00Z')
    report(fi.includes('request=GetFeatureInfo') && fi.includes('info_format=application%2Fjson') && fi.includes('width=3') && fi.includes('height=3') && fi.includes('i=1') && fi.includes('j=1') && fi.includes('bbox=48.34000%2C-123.21000%2C48.36000%2C-123.19000') && fi.includes('query_layers=CIOPS-SalishSea_500m_SeaWaterPotentialTemp_0.5m') && threw(() => D.scalarInfoUrl('temperature', -100, 48.35, '2026-10-22T13:00:00Z')) && threw(() => D.scalarInfoUrl('salinity', -123.2, 48.35, 'soon')), 'sea temperature and saltiness: the value at a place is asked for with a 3 x 3 pixel request around it (latitude first, as WMS 1.3.0 wants), and a place outside the map is refused')
    const reply = (value) => ({ type: 'FeatureCollection', features: [{ properties: { value, class: '283.95 - 290.35', time: '2026-10-22T13:00:00Z' } }] })
    const kt = D.scalarReading('temperature', reply(284.66406)), ks = D.scalarReading('salinity', reply(29.919922))
    report(near(kt, 11.51406) && near(ks, 29.919922) && D.scalarText('temperature', kt) === '11.5 °C' && D.scalarText('salinity', ks) === '29.9 psu' && D.scalarText('temperature', 9.04) === '9.0 °C' && D.scalarReading('temperature', {}) === null && D.scalarReading('temperature', { features: [] }) === null && D.scalarReading('temperature', reply(0)) === null && D.scalarReading('temperature', reply(1e20)) === null && D.scalarReading('salinity', reply(-1)) === null && D.scalarReading('salinity', reply(60)) === null && D.scalarReading('salinity', reply('29.9')) === null && D.scalarReading('salinity', null) === null && threw(() => D.scalarText('salinity', NaN)), 'sea temperature and saltiness readout: kelvin becomes degrees Celsius, saltiness stays in psu, one decimal, and land (an empty reply), a fill value or a value that is not believable gives no reading')
    const T = D.SCALES.temperature, S = D.SCALES.salinity
    const increasing = (scale) => scale.every((p, i) => i === 0 || p[0] > scale[i - 1][0]) && scale.every((p) => p[1].length === 3 && p[1].every((c) => Number.isInteger(c) && c >= 0 && c <= 255))
    report(increasing(T) && increasing(S) && D.SCALE_TICKS.temperature[0] >= T[0][0] && D.SCALE_TICKS.temperature.at(-1) <= T.at(-1)[0] && D.SCALE_TICKS.salinity[0] >= S[0][0] && D.SCALE_TICKS.salinity.at(-1) <= S.at(-1)[0], 'sea temperature and saltiness keys: the measured colours are in order of value, with whole-number channels, and the ticks written under each key lie inside them')
    const c10 = D.scaleColour(T, 10), c9 = D.scaleColour(T, 9), cLow = D.scaleColour(T, 0), cHigh = D.scaleColour(T, 40)
    report(sameValues(c10, [45, 231, 208]) && sameValues(c9, [37, 203, 216]) && sameValues(cLow, T[0][1]) && sameValues(cHigh, T.at(-1)[1]) && sameValues(D.scaleColour(S, 24), [2, 253, 252]) && sameValues(D.scaleColour(S, 10), [0, 0, 167]) && sameValues(D.scaleColour(S, 40), S.at(-1)[1]) && threw(() => D.scaleColour(T, NaN)) && threw(() => D.scaleColour([], 1)), 'sea temperature and saltiness keys: the colour at a value is read from the measured points, in between by straight lines, and the end colour beyond them', JSON.stringify([c10, c9]))
    const grad = D.scaleGradient(T, 6, 18)
    report(grad.startsWith('linear-gradient(to right, rgb(14, 118, 239) 0%') && grad.endsWith('rgb(253, 247, 1) 100%)') && (grad.match(/rgb\(/g) || []).length === T.length && !/NaN|undefined/.test(grad), 'sea temperature and saltiness keys: the gradient under each box runs from the first to the last value with a stop at each measured point')

    // tides and tidal currents (NOAA CO-OPS predictions)
    const tNowMs = Date.parse('2026-10-22T12:00:00Z')
    report(D.TIDE_STATIONS.map((x) => x.id).join(',') === '9444090,9449880,PUG1640,PUG1636,PUG1718,PCT1391,PCT1416' && new Set(D.TIDE_STATIONS.map((x) => x.id)).size === 7 && D.TIDE_STATIONS.filter((x) => x.kind === 'level').length === 2 && D.TIDE_STATIONS.every((x) => D.REGION[0] <= x.coords[0] && x.coords[0] <= D.REGION[2] && D.REGION[1] <= x.coords[1] && x.coords[1] <= D.REGION[3] && x.name && x.short) && D.tideFeatures().features.length === 7 && D.tideFeatures().features.every((f) => f.geometry.type === 'Point' && f.properties.id && f.properties.short) && D.tideStation('PCT1416').series === false && D.tideStation('PCT1391').series === false && D.tideStation('PUG1718').series === true && D.tideStation('nope') === null, 'tides: two water level stations (Port Angeles, Friday Harbor) and five current stations (Race Rocks, Discovery Island, Haro Strait, Trial Island, Cattle Point), each with a name and a place inside the map; the two that give only slack and maximum times have no series')
    const lvl = D.tideStation('9444090'), cur = D.tideStation('PUG1640'), sub = D.tideStation('PCT1416')
    const lu = D.tideUrls(lvl, tNowMs), cu2 = D.tideUrls(cur, tNowMs), su2 = D.tideUrls(sub, tNowMs)
    const all = [lu.events, lu.series, cu2.events, cu2.series, su2.events]
    report(all.every((u) => u.startsWith('https://api.tidesandcurrents.noaa.gov/api/prod/datagetter?') && u.includes('application=greater-victoria-map') && u.includes('format=json') && u.includes('time_zone=gmt') && u.includes('begin_date=20261022+04%3A00') && u.includes('end_date=20261023+18%3A00')) && lu.events.includes('product=predictions') && lu.events.includes('interval=hilo') && lu.events.includes('datum=MLLW') && lu.events.includes('units=metric') && lu.events.includes('station=9444090') && lu.series.includes('interval=30') && cu2.events.includes('product=currents_predictions') && cu2.events.includes('interval=MAX_SLACK') && cu2.events.includes('units=english') && cu2.series.includes('interval=30') && su2.series === null && threw(() => D.tideUrls({ id: 'PUG1640; drop', kind: 'current' })) && threw(() => D.tideUrls(null)), 'tides: a request names NOAA, the application, UTC times from 8 hours before now to 30 hours after, the highs and lows or the slacks and maximums and, where NOAA gives one, a series every 30 minutes (none for a station that gives only events), and refuses an unknown station')
    const levelEvents = { predictions: [{ t: '2026-10-22 20:10', v: '2.029', type: 'H' }, { t: '2026-10-22 13:21', v: '0.606', type: 'L' }, { t: '2026-10-22 06:55', v: '1.512', type: 'H' }, { t: '2026-10-22 02:14', v: '1.223', type: 'L' }, { t: '2026-10-23 02:37', v: '0.912', type: 'L' }, { t: 'bad', v: '1', type: 'H' }, { t: '2026-10-23 08:05', v: 'x', type: 'H' }] }
    const wave = (n, f) => Array.from({ length: n }, (_, i) => f(i, Date.UTC(2026, 9, 22, 4, 0) + i * 1800e3))
    const stamp = (ms) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ')
    const levelSeries = { predictions: wave(77, (i, ms) => ({ t: stamp(ms), v: String((1.4 + 0.6 * Math.sin(i / 4)).toFixed(3)) })) }
    const nl = D.normaliseTide(lvl, levelEvents, levelSeries)
    report(nl.kind === 'level' && nl.events.length === 5 && nl.events.map((e) => e.type).join() === 'low,high,low,high,low' && nl.events.every((e, i) => i === 0 || e.ms > nl.events[i - 1].ms) && near(nl.events[1].value, 1.512) && nl.events[0].ms === Date.UTC(2026, 9, 22, 2, 14) && nl.series.length === 77 && D.normaliseTide(lvl, levelEvents, null).series === null && D.normaliseTide(lvl, levelEvents, levelEvents).series === null && D.normaliseTide(lvl, levelEvents, { predictions: levelSeries.predictions.slice(0, 10) }).series === null && threw(() => D.normaliseTide(lvl, { error: { message: 'The station is not a valid station' } })) && threw(() => D.normaliseTide(lvl, {})) && threw(() => D.normaliseTide(lvl, { predictions: [] })) && threw(() => D.normaliseTide(lvl, { predictions: [{ t: 'bad', v: '1', type: 'H' }] })), 'tides: water level replies are read to times (UTC) and heights in metres, sorted, with rows that do not parse dropped, a series only when it has enough points and no event types, and an error reply, an empty reply or a reply of garbage refused')
    const cpRow = (Type, Time, v, extra = {}) => ({ ...(Type ? { Type } : {}), meanFloodDir: 91, Bin: '18', meanEbbDir: 268, Time, Depth: '60', Velocity_Major: v, ...extra })
    const currentEvents = { current_predictions: { units: 'feet, knots', cp: [cpRow('ebb', '2026-10-22 13:07', -1.76), cpRow('slack', '2026-10-22 17:09', -0), cpRow('flood', '2026-10-22 19:30', 0.93), cpRow('slack', '2026-10-22 23:10', 0), cpRow('ebb', '2026-10-23 01:18', -1.67), cpRow('wobble', '2026-10-23 03:00', 1)] } }
    const currentSeries = { current_predictions: { cp: wave(77, (i, ms) => cpRow(null, stamp(ms), Math.round(Math.sin(i / 4) * 150) / 100)) } }
    const nc = D.normaliseTide(cur, currentEvents, currentSeries)
    report(nc.kind === 'current' && nc.events.map((e) => e.type).join() === 'ebb,slack,flood,slack,ebb' && Object.is(nc.events[1].value, 0) && nc.events[0].value === -1.76 && nc.feet === 60 && nc.floodDir === 91 && nc.ebbDir === 268 && nc.bin === '18' && nc.series.length === 77 && D.normaliseTide(cur, currentEvents, currentEvents).series === null && D.normaliseTide(cur, currentEvents, null).series === null && D.normaliseTide({ ...cur, id: 'PCT1416' }, { current_predictions: { cp: [cpRow('slack', '2026-10-22 08:11', 0, { Depth: null, Bin: '1' })] } }).feet === null && threw(() => D.normaliseTide(cur, { error: { message: 'x' } })), 'tides: current replies are read to times, signed knots (ebb below zero, slack exactly zero), the depth in feet, the flood and ebb directions and the bin, an unknown event type is dropped, and a reply of events only gives no series')
    const nxt = D.tideNext(nl, tNowMs), nxc = D.tideNext(nc, tNowMs), onTheDot = D.tideNext(nl, Date.UTC(2026, 9, 22, 13, 21))
    report(nxt.high.ms === Date.UTC(2026, 9, 22, 20, 10) && nxt.low.ms === Date.UTC(2026, 9, 22, 13, 21) && nxc.ebb.ms === Date.UTC(2026, 9, 22, 13, 7) && nxc.slack.ms === Date.UTC(2026, 9, 22, 17, 9) && nxc.flood.ms === Date.UTC(2026, 9, 22, 19, 30) && onTheDot.low.ms === Date.UTC(2026, 9, 23, 2, 37) && D.tideNext(nl, Date.UTC(2026, 9, 24)).high === null, 'tides: the next high and low, or the next slack, flood and ebb, are the first of each kind after now (an event at this very minute is not next), and none is said to be none')
    const line = [{ ms: 0, v: 0 }, { ms: 1000, v: 10 }, { ms: 3000, v: 30 }]
    report(D.valueAt(line, 500) === 5 && D.valueAt(line, 2000) === 20 && D.valueAt(line, 0) === 0 && D.valueAt(line, 3000) === 30 && D.valueAt(line, -1) === null && D.valueAt(line, 3001) === null && D.valueAt([], 1) === null, 'tides: a value between two points of a series is found by a straight line, and there is none outside it')
    const from = tNowMs - 3 * 3600e3, to = tNowMs + 21 * 3600e3
    const cs = D.tideCurve(nl, from, to)
    report(!cs.drawn && cs.points[0].ms === from && cs.points.at(-1).ms === to && cs.points.length > 40 && cs.points.every((p, i) => i === 0 || p.ms > cs.points[i - 1].ms) && near(cs.points[0].v, D.valueAt(nl.series, from)), 'tides: a curve from NOAA\'s own series runs from three hours before now to 21 hours after, from points of that series, with the ends found on it')
    const ev = { kind: 'current', series: null, events: [{ ms: 0, type: 'slack', value: 0 }, { ms: 3600e3, type: 'ebb', value: -1.6 }, { ms: 7200e3, type: 'slack', value: 0 }, { ms: 10800e3, type: 'flood', value: 1 }] }
    const ce = D.tideCurve(ev, 0, 10800e3), vAt = (ms) => ce.points.find((p) => p.ms === ms)?.v
    report(ce.drawn && ce.points.length === 19 && Math.abs(vAt(0)) < 1e-9 && Math.abs(vAt(3600e3) + 1.6) < 1e-9 && Math.abs(vAt(1800e3) + 0.8) < 1e-9 && Math.abs(vAt(5400e3) + 0.8) < 1e-9 && Math.abs(vAt(10800e3) - 1) < 1e-9 && D.tideCurve(ev, -7200e3, -3600e3).points.length === 0 && D.tideCurve(ev, 12000e3, 14000e3).points.length === 0, 'tides: a station with no series is drawn between its events, easing from each to the next (halfway between slack and a 1.6 knot ebb is 0.8 knots), and nothing is drawn where there is no event to draw from')
    const geo = D.curveGeometry(cs.points, 'level', { from, to, now: tNowMs })
    const gc = D.curveGeometry([{ ms: from, v: -1.5 }, { ms: tNowMs, v: 0 }, { ms: to, v: 1 }], 'current', { from, to, now: tNowMs })
    report(geo.d.startsWith('M8 ') && (geo.d.match(/L/g) || []).length === cs.points.length - 1 && geo.nowX === 38.5 && geo.nowY != null && Math.abs(geo.nowValue - D.valueAt(cs.points, tNowMs)) < 1e-9 && geo.zeroY === null && geo.y(geo.max) < geo.y(geo.min) && gc.zeroY != null && Math.abs((gc.zeroY - gc.top) - (gc.bottom - gc.zeroY)) < 0.2 && gc.y(1) < gc.zeroY && gc.y(-1.5) > gc.zeroY && threw(() => D.curveGeometry([{ ms: 0, v: 1 }], 'level', { from: 0, to: 1, now: 0 })), 'tides: the drawing puts "now" at three 24ths of the way across, a higher height higher up, a current about a zero line with flood above it and ebb below it, and refuses a curve of one point')
    const ticks = D.curveTicks(from, to)
    report(ticks.length === 4 && sameValues(ticks.map((t) => t.hour).sort((a, b) => a - b), [0, 6, 12, 18]) && ticks.every((t) => t.ms >= from && t.ms <= to && new Date(t.ms).getUTCMinutes() === 0), 'tides: the axis of a 24 hour curve is marked at midnight, 6, noon and 18, Pacific time')
    const clockNow = Date.parse('2026-10-22T19:00:00Z')
    report(D.tideClock(Date.parse('2026-10-22T21:09:00Z'), clockNow) === '2:09 p.m.' && D.tideClock(Date.parse('2026-10-23T12:05:00Z'), clockNow) === 'Oct 23, 5:05 a.m.' && D.tideClock(Date.parse('2026-10-22T08:00:00Z'), clockNow) === '1:00 a.m.' && D.tideClock(Date.parse('2026-10-22T08:00:00Z'), Date.parse('2026-10-23T08:00:00Z')) === 'Oct 22, 1:00 a.m.', 'tides: a time is shown in Pacific time, as the clock alone for today and with the date for another day')

    // seafloor depth
    const dx = D.depthExpression()
    const elev = dx.slice(3).filter((_, i) => i % 2 === 0), cols = dx.slice(3).filter((_, i) => i % 2 === 1)
    const alpha = (c) => Number(c.match(/,([\d.]+)\)$/)[1])
    report(dx[0] === 'interpolate' && dx[2][0] === 'elevation' && elev.every((v, i) => i === 0 || v > elev[i - 1]) && elev[0] === -300 && elev.at(-1) === 0 && alpha(cols.at(-1)) === 0 && alpha(cols.at(-2)) === 0 && elev.at(-2) === -D.DEPTH_FADE_FROM && cols.slice(0, -2).every((c) => alpha(c) === 1) && cols.every((c) => /^rgba\(\d+,\d+,\d+,[\d.]+\)$/.test(c)), 'seafloor: the colour ramp runs by elevation from the deepest colour up, and is transparent at the waterline and above and down to 10 m, then fades in to the first colour')
    const dsLum = D.DEPTH_STOPS.map((p) => lum(p[1]))
    report(D.DEPTH_STOPS.every((p, i) => i === 0 || p[0] > D.DEPTH_STOPS[i - 1][0]) && dsLum.every((l, i) => i === 0 || l < dsLum[i - 1]) && D.DEPTH_STOPS[0][0] > D.DEPTH_FADE_FROM && D.DEPTH_TICKS.every((t) => D.DEPTH_STOPS.some((p) => p[0] === t)) && D.depthGradient().startsWith('linear-gradient(to right, rgba(150, 202, 222, 0) 0%') && D.depthGradient().endsWith('rgb(32, 66, 128) 100%)'), 'seafloor: the colours get darker with depth, the ticks of the key are depths that have a colour, and the key fades in from nothing')

    // marine life and protection
    report(D.tidyName('RACE ROCKS ECOLOGICAL RESERVE') === 'Race Rocks Ecological Reserve' && D.tidyName('SAYSUTSHUN (NEWCASTLE ISLAND MARINE) PARK') === 'Saysutshun (Newcastle Island Marine) Park' && D.tidyName('BAY OF FUNDY') === 'Bay of Fundy' && D.tidyName('Gulf Islands National Park Reserve Of Canada') === 'Gulf Islands National Park Reserve Of Canada' && D.tidyName('SANDHEADS (8 Dolphs)') === 'SANDHEADS (8 Dolphs)' && D.tidyName('  ') === null && D.tidyName(null) === null, 'marine layers: a name published in capitals is shown in capitals and small letters, a name with small letters already is left as published, and a blank name is none')
    const rr = D.protectedInfo({ name: 'RACE ROCKS ECOLOGICAL RESERVE', type: 'Ecological Reserve', owner: 'Government of British Columbia', year: 1980, no_take: 1 })
    const gs = D.protectedInfo({ name: 'GOLDSTREAM PARK', type: 'A - Park', owner: 'Government of British Columbia', year: 1958, no_take: null })
    const nt = (code) => D.protectedInfo({ name: 'X', type: 'Park', owner: 'Y', year: 2000, no_take: code }).lines.some((l) => /No-take/.test(l))
    report(rr.title === 'Race Rocks Ecological Reserve' && rr.tag === 'ecological reserve' && rr.lines.includes('Owner: Government of British Columbia.') && rr.lines.includes('Established 1980.') && rr.lines.includes('No-take area, as reported to CPCAD: all of it.') && gs.tag === 'park (class A)' && !gs.lines.some((l) => /No-take/.test(l)) && nt(1) && nt(2) && nt(3) && !nt(0) && !nt(4) && !nt(null) && rr.source.includes(OGL_CANADA_STATEMENT) && D.protectedInfo({}).title === 'Protected marine area' && !D.protectedInfo({ name: 'X', year: 0 }).lines.some((l) => /Established/.test(l)), 'protected marine areas: the popup gives name, type, owner, year and the no-take line only where CPCAD gives one, with the Open Government Licence statement', JSON.stringify(rr))
    const srkwI = D.srkwInfo({ status: 'Final/Proposed' })
    report(srkwI.title === 'Southern Resident killer whale critical habitat' && srkwI.lines.includes(D.WHALE_RULES) && srkwI.lines.some((l) => /not a sighting/.test(l)) && srkwI.source.includes('For general guidance only') && srkwI.source.includes(OGL_CANADA_STATEMENT) && D.WHALE_RULES === WHALE_RULES_TEXT && D.WHALE_RULE_LINKS.map((l) => l.href).join() === WHALE_LINKS.join(), 'critical habitat: the popup says it is a boundary and not a sighting, gives the vessel distances word for word and the Open Government Licence statement, and "for general guidance only"')
    report(near(D.cetaceanDensity(0.61, 7.25), 0.61 / 7.25 * 100) && D.cetaceanDensity(2.5, 25) === 10 && threw(() => D.cetaceanDensity(1, 0)) && threw(() => D.cetaceanDensity(-1, 5)) && threw(() => D.cetaceanDensity(NaN, 5)), 'whale and porpoise density: animals per 100 km2 is the model number over the cell area, and a bad number or area is refused')
    const cell = (over = {}) => ({ geometry: { type: 'Polygon', coordinates: [] }, properties: { km2: 10, humpback_n: 1, humpback_cv: 0.5, harbour_n: 5, harbour_cv: 0.6, dalls_n: 2, dalls_cv: 0.4, ...over } })
    const cc = D.cetaceanCells({ features: [cell(), cell({ dalls_n: null }), cell({ km2: 0 }), { ...cell(), geometry: null }, cell({ humpback_n: -1 }), cell({ harbour_cv: 'x' })] })
    report(cc.features.length === 1 && near(cc.features[0].properties.d_humpback, 10) && near(cc.features[0].properties.d_harbour, 50) && near(cc.features[0].properties.d_dalls, 20) && threw(() => D.cetaceanCells({})), 'whale and porpoise density: a cell without an area, a shape or all three species is dropped, and the density of each species is added')
    const spread = Array.from({ length: 15 }, (_, i) => i + 1)
    report(sameValues(D.densityBreaks(spread), [4, 7, 10, 13]) && sameValues(D.densityBreaks(Array.from({ length: 223 }, (_, i) => i * i / 1000)), [1.9, 7.9, 18, 32]) && sameValues(D.densityBreaks([5, 5, 5, 5, 5, 5]), [5]) && sameValues(D.densityBreaks([0, 0, 0, 0, 0, 0, 7, 8, 9, 10]), [7, 9]) && threw(() => D.densityBreaks([1, 2, 3])) && D.densityBreaks(spread).every((b, i, a) => i === 0 || b > a[i - 1]), 'whale and porpoise density: the class limits are at equal shares of the cells, shown to two figures, strictly rising, and fewer when the values do not spread')
    report(D.densityClass(3, [4, 7, 10, 13]) === 0 && D.densityClass(4, [4, 7, 10, 13]) === 1 && D.densityClass(12.9, [4, 7, 10, 13]) === 3 && D.densityClass(13, [4, 7, 10, 13]) === 4 && D.densityClass(100, [4, 7, 10, 13]) === 4 && D.densityClass(5, [5]) === 1, 'whale and porpoise density: a value falls in the class above the highest limit it reaches')
    const dExpr = D.densityExpression('d_humpback', [4, 7, 10, 13])
    report(dExpr[0] === 'step' && dExpr[1][1] === 'd_humpback' && dExpr.length === 3 + 8 && dExpr[2] === D.DENSITY_COLOURS[0] && dExpr[3] === 4 && dExpr.at(-1) === D.DENSITY_COLOURS[4] && D.densityExpression('d_x', [5]).length === 5 && threw(() => D.densityExpression('d_x', [1, 2, 3, 4, 5])), 'whale and porpoise density: the colour expression is a step on the density of the species, with one more colour than limits')
    const dc = D.DENSITY_COLOURS.map((c) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16))), sea = [194, 200, 202]
    const over = dc.map((c) => c.map((v, k) => Math.round(v * 0.75 + sea[k] * 0.25))), gap = (a, b) => Math.max(...a.map((v, k) => Math.abs(v - b[k])))
    report(D.DENSITY_COLOURS.length === D.CETACEAN_CLASSES && dc.every((c, i) => i === 0 || lum(c) < lum(dc[i - 1])) && over.every((c, i) => i === 0 || gap(c, over[i - 1]) >= 20) && gap(over[0], sea) >= 12, 'whale and porpoise density: the five colours get darker, each differs from the one before by 20 of 255 or more at 0.75 opacity, and the lightest still shows against the basemap sea')
    const grad5 = D.stepGradient(D.DENSITY_COLOURS)
    report(grad5.startsWith(`linear-gradient(to right, ${D.DENSITY_COLOURS[0]} 0%, ${D.DENSITY_COLOURS[0]} 20%, `) && grad5.endsWith(`${D.DENSITY_COLOURS[4]} 80%, ${D.DENSITY_COLOURS[4]} 100%)`) && (grad5.match(/#/g) || []).length === 10, 'whale and porpoise density: the key is five blocks, one colour each')
    report(D.fmt2(0.0123) === '0.012' && D.fmt2(3.456) === '3.5' && D.fmt2(1234.5) === '1,200' && D.fmt2(7.25) === '7.3' && D.fmt2(0.00010892857) === '0.00011', 'whale and porpoise density: numbers are shown to two figures, with the thousands separator')
    const cp = { km2: 7.25, humpback_n: 0.61, humpback_cv: 0.67, harbour_n: 3.63, harbour_cv: 0.59, dalls_n: 1, dalls_cv: 0.45 }
    const ci = D.cetaceanInfo(cp, 'humpback'), cd = D.cetaceanInfo(cp, 'dalls'), ch = D.cetaceanInfo(cp, 'harbour')
    report(ci.title === 'Humpback whale: modelled summer numbers' && ci.tag === 'model of summer 2018 surveys' && ci.lines[0] === 'The model predicts about 0.61 humpback whales in this cell (Nhat, for a cell of 7.3 km²).' && ci.lines[1] === 'That is about 8.4 per 100 km².' && ci.lines[2] === 'Uncertainty (CV): 0.67. Higher means less certain.' && /July to early September 2018/.test(ci.lines[3]) && /not where animals are now/.test(ci.lines[3]) && ci.lines.at(-1) === D.WHALE_RULES && ci.source.includes(OGL_CANADA_STATEMENT) && cd.lines[0].includes('about 1 Dall’s porpoise in this cell') && ch.lines[0].includes('harbour porpoises') && ch.lines[2].includes('0.59') && threw(() => D.cetaceanInfo(cp, 'orca')) && threw(() => D.cetaceanInfo({ km2: 5 }, 'humpback')), 'whale and porpoise density: the popup gives the species, the model number as the service names it (Nhat), the density, the uncertainty, the survey months and year, that it is not where animals are now, and the vessel distances', JSON.stringify(ci.lines))
    const ki = D.kelpInfo({ species: 'Bull Kelp', density: 'Low' }), kn = D.kelpInfo({ species: null, density: null })
    const ei = D.eelgrassInfo({ year: 1998 }), hi = D.herringInfo({ magnitude: 'Very Large', consistency: 'Consistent', first_year: 1937, last_year: 1986 }), hn = D.herringInfo({ magnitude: null, consistency: null, first_year: null, last_year: null }), si = D.seabirdInfo({ name: 'CHAIN ISLETS' })
    report(ki.title === 'Bull kelp bed' && ki.lines[0] === 'Density recorded: low.' && kn.title === 'Kelp bed' && kn.lines.length === 1 && ei.lines[0] === 'Mapped in 1998.' && hi.lines.includes('The records run from 1937 to 1986.') && hi.lines.includes('Spawn magnitude recorded: very large.') && hi.lines.includes('Spawning here was recorded as consistent.') && hn.lines.length === 1 && si.title === 'Chain Islets' && si.lines.some((l) => /easily disturbed/.test(l)) && [ki, kn, ei, hi, hn, si].every((i) => i.source.includes('legacy survey that began in 1979') && i.source.includes(OGL_BC_STATEMENT) && i.lines.some((l) => /1979|old|may have changed|not this year|out of date/i.test(l))), 'coastal habitat: every popup says the survey is old (began in 1979) and carries the Open Government Licence – British Columbia statement, and a field the survey leaves blank is not said')
    report(D.marineMessage('kelp', new Array(1118).fill({})) === '1,118 kelp beds.' && D.marineMessage('kelp', [{}]) === '1 kelp bed.' && D.marineMessage('eelgrass', [{ properties: { year: 1998 } }]).includes('mapped in 1998') && D.marineMessage('herring', [{ properties: { first_year: 1937, last_year: 1986 } }, { properties: { first_year: 1950, last_year: 1966 } }]).includes('between 1937 and 1986') && /^81 seabird colonies/.test(D.marineMessage('seabirds', new Array(81).fill({}))) && /^22 marine zones of protected areas/.test(D.marineMessage('protected', new Array(22).fill({}))) && D.marineMessage('srkw', [{}]) === 'Shown for the area this map reaches.' && threw(() => D.marineMessage('orcas', [])), 'marine layers: the status line gives the count with a thousands separator and the years found in the data, and leaves the reading notes to the notes')
    report(Object.keys(D.MARINE_FILES).join() === 'protected,srkw,cetaceans,kelp,eelgrass,herring,seabirds' && Object.values(D.MARINE_FILES).every((v) => /^data\/[a-z-]+\.geojson$/.test(v)) && Object.values(D.MARINE_FILES).map((v) => v.slice(5, -8)).join() === MARINE_FILES.join(), 'marine layers: seven data files, each a relative path in data/, the same files this check looks at')
    const plain = [D.WHALE_RULES, ...D.WHALE_RULE_LINKS.map((l) => l.label), ci, cd, ch, ki, kn, ei, hi, hn, si, rr, gs, srkwI].flatMap((x) => (typeof x === 'string' ? [x] : [x.title, x.tag, x.source, ...(x.lines || [])].filter(Boolean)))
    report(ruleMarinePlain(plain).length === 0 && ruleMarinePlain([D.marineMessage('kelp', [{}]), D.marineMessage('herring', []), D.marineMessage('seabirds', []), D.marineMessage('protected', []), D.marineMessage('srkw', []), D.marineMessage('eelgrass', [])]).length === 0, 'marine layers: the text of every popup and status line has no em dash and no semicolon', ruleMarinePlain(plain).join(' | '))

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
