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
// and api.tidesandcurrents.noaa.gov (tides and tidal currents, after a station is clicked). The Canadian Hydrographic Service is
// asked for two things only, live from the visitor's browser: nonna-geoserver.data.chs-shc.ca (seafloor depth, while its box is
// ticked) and api-iwls.dfo-mpo.gc.ca (the Victoria Harbour gauge, after its dot is clicked).
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
  'nonna-geoserver.data.chs-shc.ca', 'api-iwls.dfo-mpo.gc.ca', // the Canadian Hydrographic Service: seafloor depth tiles and the Victoria Harbour gauge, fetched live
  'tides.gc.ca', 'api-proxy.edh-cde.dfo-mpo.gc.ca', // its licence agreement and station page, and the NONNA licence PDF: links, never fetched
  'datacube.services.geo.ca', // Natural Resources Canada's datacube: the air photos and the land cover, fetched while their boxes are ticked
  'www.arcgis.com', 'storage.googleapis.com', 'glad.earthengine.app', // the City of Victoria's tree canopy items and Global Forest Change's pages: links, never fetched
]
// Third-party hosts the page fetches from once a box is ticked. Each must be named in the privacy note.
const FETCH_HOSTS = ['s3.amazonaws.com', 'api.weather.gc.ca', 'geo.weather.gc.ca', 'earthquake.usgs.gov', 'api.gbif.org', 'api.tidesandcurrents.noaa.gov', 'nonna-geoserver.data.chs-shc.ca', 'api-iwls.dfo-mpo.gc.ca', 'datacube.services.geo.ca']
// The two Canadian Hydrographic Service notices, word for word from the licences (the IWLS licence at https://tides.gc.ca/en/licence-agreement,
// dated 2023-08-14, and the NONNA licence PDF), with the place for the user's name filled in. Read on 2026-10-22. The IWLS notice has no
// full stop at its end in the licence. They are kept here apart from js/overlays-data.js so that a change to either shows as a failure.
const IWLS_NOTICE_TEXT = 'This product is not to be used for navigation. This product was made by or for the User Darren Zal and contains intellectual property (Data) of the Canadian Hydrographic Service of the Department of Fisheries and Oceans. The copyrights in the Data are and remain the property of His Majesty the King in Right of Canada and shall not be sold, licensed, leased, assigned or given to a third party. The incorporation of the Data in this product does not constitute an endorsement or an approval of this product by the Canadian Hydrographic Service, the Department of Fisheries and Oceans or His Majesty the King in Right of Canada'
const NONNA_NOTICE_TEXT = 'This product was made by Darren Zal and contains intellectual property of the Canadian Hydrographic Service (CHS) of the Department of Fisheries and Oceans. This product does not meet the requirements of the Navigation Safety Regulations, 2020 under the Canada Shipping Act, 2001. Charts and publications issued by or on the authority of CHS must be used to meet the requirements of those regulations. The copyright in the data are and remain the property of His Majesty the King in Right of Canada and shall not be sold, licensed, leased, assigned or given to a third party. The incorporation of CHS data in this product does not constitute an endorsement or an approval of this product by the Canadian Hydrographic Service, the Department of Fisheries and Oceans or His Majesty the King in Right of Canada.'
const IWLS_LICENCE_URL = 'https://tides.gc.ca/en/licence-agreement'
const NONNA_LICENCE_URL = 'https://api-proxy.edh-cde.dfo-mpo.gc.ca/catalogue/records/d3881c4c-650d-4070-bf9b-1e00aabf0a1d/attachments/CHS_NONNA_LICENCE-LICENCE_NONNA_DU_SHC.pdf'
const OVERLAY_IDS = ['radar', 'currents', 'wind', 'temperature', 'salinity', 'tides', 'seafloor', 'alerts', 'aqhi', 'conditions', 'water', 'quakes', 'life', 'ecoregions', 'industry', 'protected', 'srkw', 'rkw', 'cetaceans', 'kelp', 'eelgrass', 'herring', 'seabirds']
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

// Seafloor depth says where its depths come from (the Canadian Hydrographic Service's NONNA in Canadian waters, ETOPO1 elsewhere), how
// coarse the ETOPO1 grid is and that they are not for navigation. ETOPO1 is drawn as a colour relief from an elevation source of its
// own on the existing tile address, and NONNA as raster tiles asked for by a protocol of the page, over it.
function ruleSeafloorCredit(html, js) {
  const out = []
  const para = html.split(/<\/p>|<\/li>/).filter((p) => p.includes('<strong>Seafloor depth</strong>')).map(textOf)[0]
  if (!para) out.push('the credits have no Seafloor depth paragraph')
  else {
    if (!/ETOPO1/.test(para)) out.push('the seafloor credit does not name ETOPO1')
    if (!/1 arc-minute/.test(para)) out.push('the seafloor credit does not say how coarse the grid is')
    if (!/not for navigation/i.test(para)) out.push('the seafloor credit does not say it is not for navigation')
    if (!/Canadian Hydrographic Service/.test(para) || !/NONNA/.test(para)) out.push('the seafloor credit does not name the Canadian Hydrographic Service and NONNA')
  }
  if (!/const SEAFLOOR_ATTRIB = [^\n]*ETOPO1[^\n]*not for navigation/.test(js)) out.push('the on-map seafloor credit does not name ETOPO1 and say not for navigation')
  if (!/const NONNA_ATTRIB = [^\n]*Canadian Hydrographic Service[^\n]*not for navigation/.test(js)) out.push('the on-map NONNA credit does not name the Canadian Hydrographic Service and say not for navigation')
  if (!/type: 'color-relief'/.test(js) || !/maxzoom: SEAFLOOR_MAX_ZOOM/.test(js)) out.push('the seafloor layer is not a colour relief on a source with a maximum zoom')
  if (!/type: 'raster'[^\n]*tiles: \[`nonna:\/\//.test(js) || !/addProtocol\?*\.?\('nonna'/.test(js)) out.push('the NONNA tiles are not raster tiles asked for by the nonna protocol')
  return out
}

// The Canadian Hydrographic Service (CHS) licences ask for a notice "in a prominent location" on a product made from their data. The
// two notices are in the credits and the README word for word, in the panel under the layer while it is on, and in the gauge popup,
// the credits and the notes say this is a non-commercial demo (the IWLS licence bars derivative products made for commercial purposes),
// and the licences are recorded with their addresses and the date they were read.
function ruleChsNotices({ html, js, readme, sources }) {
  const out = []
  const flat = (t) => t.replace(/\s+/g, ' ')
  const credits = flat(textOf(html.slice(html.indexOf('id="credits"'))))
  for (const [name, text] of [['IWLS', IWLS_NOTICE_TEXT], ['NONNA', NONNA_NOTICE_TEXT]]) {
    if (!credits.includes(text)) out.push(`the credits do not carry the ${name} notice word for word`)
    if (!flat(readme).includes(text)) out.push(`the README does not carry the ${name} notice word for word`)
  }
  for (const id of ['seafloor-chs-notice', 'tides-chs-notice']) {
    const m = html.match(new RegExp(`<p[^>]*id="${id}"[^>]*>`))
    if (!m) out.push(`the panel has no ${id} paragraph`)
    else if (!/\bhidden\b/.test(m[0])) out.push(`${id} is not hidden until its layer is on`)
    if (!new RegExp(`ui: \\[[^\\]]*'${id}'`).test(js)) out.push(`${id} is not shown and hidden with its layer`)
  }
  if (!/\$\('seafloor-chs-notice'\)\.textContent = NONNA_NOTICE/.test(js)) out.push('the NONNA notice is not written into the panel')
  if (!/\$\('tides-chs-notice'\)\.textContent = IWLS_NOTICE/.test(js)) out.push('the IWLS notice is not written into the panel')
  if (!js.includes("line(IWLS_NOTICE, 'src notice')") || !js.includes("el('p', IWLS_NOTICE, 'src notice')")) out.push('the gauge popup does not carry the IWLS notice, both when its levels load and when they do not')
  if (!/non-commercial demo/.test(credits)) out.push('the credits do not say this is a non-commercial demo')
  if (!/non-commercial demo/.test(sources)) out.push('data/SOURCES.md does not say this is a non-commercial demo')
  for (const url of [IWLS_LICENCE_URL, NONNA_LICENCE_URL]) {
    if (!html.includes(url)) out.push(`the credits do not link the licence ${url.slice(0, 50)}`)
    if (!sources.includes(url)) out.push(`data/SOURCES.md does not record the licence ${url.slice(0, 50)}`)
  }
  if (!/read 2026-10-22/.test(sources) || !/not for navigation/i.test(sources)) out.push('data/SOURCES.md does not say when the licences were read and that the data is not for navigation')
  return out
}
// No copy of any CHS data is kept: nothing about it in data/ or raw/ (the notes in data/SOURCES.md apart), and the fetch script
// does not ask either service for anything.
function ruleChsNotStored(files) {
  const out = []
  for (const f of files) {
    if (/^(data|raw)\//.test(f.path) && f.path !== 'data/SOURCES.md' && /nonna|iwls|chs|hydrograph|bathym|\.tiff?$/i.test(f.path)) out.push(`a file that may hold Canadian Hydrographic Service data: ${f.path}`)
    if (f.path === 'scripts/fetch-layers.sh' && f.text != null && /nonna-geoserver|api-iwls/.test(f.text)) out.push('the fetch script asks a Canadian Hydrographic Service server for data')
  }
  return out
}

// The Canadian Hydrographic Service (CHS) and Fisheries and Oceans (DFO) are used for the two things the owner accepted licences for, and
// nothing else: the NONNA depth tiles (two layers, NONNA 100 and NONNA 10) and the one IWLS station (Victoria Harbour, three time series).
// So in the code and the page, no URL on a CHS or DFO host except the two roots (each once, where it is defined), the three licence and
// station links, which are links and never fetched. Each root is used once, to build the tile address or the station address. The layers,
// the station and the time series are pinned to the ones accepted, so a third endpoint cannot arrive by editing a list.
const CHS_HOST = /(^|\.)(chs-shc\.ca|dfo-mpo\.gc\.ca)$|^tides\.gc\.ca$/
const CHS_ROOTS = { NONNA_HOST: 'https://nonna-geoserver.data.chs-shc.ca', IWLS_API: 'https://api-iwls.dfo-mpo.gc.ca/api/v1/stations' }
const CHS_LINKS = ['https://tides.gc.ca/en/licence-agreement', 'https://tides.gc.ca/en/stations/', NONNA_LICENCE_URL]
function ruleChsUses(files) {
  const out = [], code = files.filter((f) => f.text != null && /^(index\.html$|js\/)/.test(f.path))
  for (const f of code) {
    for (const u of f.text.match(URL_RE) || []) {
      let host
      try { host = new URL(u).host } catch { continue }
      if (!CHS_HOST.test(host)) continue
      if (Object.values(CHS_ROOTS).includes(u) || CHS_LINKS.some((l) => u.startsWith(l))) continue
      out.push(`${f.path} uses a Canadian Hydrographic Service or Fisheries and Oceans address that is neither the NONNA tiles nor the Victoria Harbour gauge: ${u.slice(0, 80)}`)
    }
  }
  const all = code.map((f) => f.text).join('\n'), data = code.find((f) => f.path === 'js/overlays-data.js')?.text ?? ''
  for (const [name, root] of Object.entries(CHS_ROOTS)) {
    if (!data.includes(`export const ${name} = '${root}'`)) out.push(`${name} is not defined as ${root} in js/overlays-data.js`)
    const uses = (all.match(new RegExp(`\\b${name}\\b`, 'g')) || []).length
    if (uses !== 2) out.push(`${name} is named ${uses} times in the code, expected 2 (its definition and the one address built from it)`)
  }
  if (!data.includes("export const NONNA_LAYERS = { 100: 'NONNA 100', 10: 'NONNA 10' }")) out.push('NONNA_LAYERS is not exactly the two accepted layers, NONNA 100 and NONNA 10')
  const stations = data.match(/^\s*\{ id: '[^']*'[^\n]*source: 'chs'/gm) || [], ids = data.match(/chsId: '[0-9a-f]+'/g) || []
  if (stations.length !== 1 || ids.length !== 1 || ids[0] !== "chsId: '5cebf1df3d0f4a073c4bbd1e'") out.push(`CHS stations in the list: expected only Victoria Harbour (5cebf1df3d0f4a073c4bbd1e), found ${ids.join(' ') || 'none'}`)
  const iwls = data.slice(data.indexOf('export function iwlsUrls'), data.indexOf('function iwlsRows')), codes = [...iwls.matchAll(/\burl\('([\w-]+)'/g)].map((m) => m[1]).sort().join()
  if (codes !== 'wlo,wlp,wlp-hilo') out.push(`IWLS time series asked for: expected wlo, wlp and wlp-hilo, found ${codes || 'none'}`)
  return out
}

// Held ocean data stays out of the code and the page: DFO conservation areas and shellfish closures, seal haulouts, whale sighting
// feeds and AIS. Canadian Hydrographic Service data was held until 2026-10-22, when its owner accepted its licences for two uses, which
// ruleChsNotices and ruleChsNotStored keep to.
const HELD_OCEAN = /rockfish|shellfish|haulout|acartia|obis\.org|inaturalist|aisstream|whalemuseum|orcanetwork/i
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

// ---- marine life and protection: eight files cut at the edge of the area the map reaches (not at the demo box, which would draw a
// straight edge through open water), none of which shows where an animal is now
const MARINE_FILES = ['marine-protected', 'srkw-habitat', 'whale-density', 'kelp', 'eelgrass', 'herring-spawn', 'seabird-colonies', 'rkw-important-area']
const SEA_REGION = [-124.4, 47.9, -122.7, 49.1]
// The vessel distances, said wherever whales appear. This copy is kept apart from the one in js/overlays-data.js so that a change in one is caught.
const WHALE_RULES_TEXT = 'Vessels must stay at least 1,000 m from Southern Resident killer whales from June 1, 2026 to May 31, 2027, at least 200 m from all other killer whales and at least 100 m from all other whales, dolphins and porpoises. Some exceptions apply.'
// The meaning of no-take in the CPCAD user manual (2025), as a popup with all or part no-take gives it. Read 2026-10-23, kept here apart from js/overlays-data.js so that a change shows as a failure.
const NO_TAKE_MEANING_TEXT = "CPCAD's meaning of no-take: the taking of living or dead natural resources, inclusive of all methods of fishing, extraction, dumping, dredging and construction, is strictly prohibited."
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
// The important area for Southern Resident killer whales is the one expert-drawn polygon for June to October, rated high, and a small file.
function ruleRkwArea(files) {
  const { fc, error } = marineJson(files, 'rkw-important-area')
  if (error) return [error]
  const out = [], f = fc.features[0]
  if (fc.features.length !== 1) out.push(`${fc.features.length} features, expected one`)
  else {
    if (f.properties?.seasonal !== 'June to October') out.push(`the season is "${f.properties?.seasonal}", the popup and the notes say June to October`)
    if (f.properties?.score !== 'H') out.push(`the score is "${f.properties?.score}", the popup says experts rated it high`)
    if (f.geometry?.type !== 'Polygon') out.push('the feature is not one polygon')
    if (Object.keys(f.properties || {}).sort().join() !== 'score,seasonal') out.push('the feature keeps fields the popup does not use')
  }
  const size = files.find((x) => x.path === 'data/rkw-important-area.geojson')?.size ?? 0
  if (size > 100000) out.push(`${size} bytes, expected a simplified shape under 100 KB`)
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
  for (const name of ['Southern Resident killer whale critical habitat.', 'Killer whale important area.', 'Whale and porpoise density.']) {
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
  if (!/\$\('rkw-note'\)\.textContent = `[^`]*\$\{WHALE_RULES\}`/.test(overlaysJs)) out.push('the panel note of the important area does not carry the vessel distances')
  if (!/\$\('cetaceans-note'\)\.textContent = `[^`]*\$\{WHALE_RULES\}`/.test(overlaysJs)) out.push('the panel note of the density model does not carry the vessel distances')
  if (!/box\.append\(el\('p', WHALE_RULES\)\)/.test(overlaysJs)) out.push('the popup of a whale layer does not end with the vessel distances')
  const info = (name) => (dataJs.match(new RegExp(`export function ${name}\\([\\s\\S]*?\\n}\\n`)) || [''])[0]
  for (const name of ['srkwInfo', 'rkwInfo', 'cetaceanInfo']) if (!info(name).includes('WHALE_RULES')) out.push(`${name} does not carry the vessel distances`)
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
  need(find('Killer whale important area.'), 'Killer whale important area', [[/drew by hand/, 'that experts drew it by hand'], [/not a sighting/, 'that it is not a sighting'], [/does not show where the whales are now/, 'that it does not show where the whales are now'], [/no added management/, 'that it carries no added management']])
  need(find('Whale and porpoise density.'), 'Whale and porpoise density', [[/summer 2018/, 'summer 2018'], [/not where animals are now/, 'that it is not where animals are now'], [/Nhat/, 'what Nhat is'], [/Canadian waters only/, 'that it covers Canadian waters only']])
  need(find('Coastal habitat (kelp beds'), 'Coastal habitat', [[/legacy dataset that began in 1979/, 'that CRIMS is a legacy dataset that began in 1979'], [/only updated now and then/, 'that it was only updated now and then'], [/no plans to update/, 'that there are no plans to update it'], [new RegExp(OGL_BC_STATEMENT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'the Open Government Licence – British Columbia statement']])
  const federal = find('Federal data in the marine layers above')
  if (!federal || !federal.includes(OGL_CANADA_STATEMENT)) out.push('the credits do not carry the Open Government Licence – Canada statement for the federal marine data')
  const panel = textOf(html)
  if (!panel.includes('Nothing here shows where an animal is now. Not for navigation.')) out.push('the panel does not say that nothing in Marine life and protection shows where an animal is now')
  if (!/\(CRIMS\)\. It is a legacy survey that began in 1979 and was only updated now and then, so it is not a current record\./.test(panel)) out.push('the panel does not say that CRIMS is a legacy survey from 1979 and not a current record')
  const attribLine = (attr) => (js.match(new RegExp(`const ${attr} = [^\\n]*`)) || [''])[0]
  const attribs = { PROTECTED_ATTRIB: /CPCAD[\s\S]*OGL_CANADA_LINK/, SRKW_ATTRIB: /critical habitat[\s\S]*OGL_CANADA_LINK/, RKW_ATTRIB: /important area[\s\S]*OGL_CANADA_LINK/, CETACEANS_ATTRIB: /Whale and porpoise model[\s\S]*OGL_CANADA_LINK/, CRIMS_ATTRIB: /CRIMS[\s\S]*legacy survey from 1979[\s\S]*OGL_BC_LINK/ }
  for (const [attr, re] of Object.entries(attribs)) if (!re.test(attribLine(attr))) out.push(`${attr} does not credit its data and name its licence`)
  for (const [src, attr] of [['ov-protected', 'PROTECTED_ATTRIB'], ['ov-srkw', 'SRKW_ATTRIB'], ['ov-rkw', 'RKW_ATTRIB'], ['ov-cetaceans', 'CETACEANS_ATTRIB'], ['ov-kelp', 'CRIMS_ATTRIB'], ['ov-eelgrass', 'CRIMS_ATTRIB'], ['ov-herring', 'CRIMS_ATTRIB'], ['ov-seabirds', 'CRIMS_ATTRIB']]) {
    if (!new RegExp(`src\\('${src}', ${attr}\\)`).test(js)) out.push(`the ${src} source does not carry ${attr}`)
  }
  return out
}
// Reader-facing text of the marine layers is plain: no em dash and no semicolon.
function ruleMarinePlain(texts) {
  return texts.filter((t) => /[—;]/.test(t)).map((t) => `an em dash or semicolon in: ${t.slice(0, 70)}`)
}


// ---- change over time: seven boxes that share one time slider (js/timeline.js), their data files and their credits
const TIME_IDS = ['herringyears', 'aerials', 'sei', 'sei2014', 'landcover', 'canopy', 'forestloss']
const TIME_SENTENCE = 'Each box puts its years on one time slider at the bottom of the map, so the layers you tick move through time together. Nothing loads until you tick one.'
// Each data file, the box it is checked against (the herring points are a sea layer, so the area the map reaches), the only properties it may
// carry, and its kind of shape.
const TIME_FILES = {
  'herring-spawn-years': { box: SEA_REGION, props: ['year', 'name', 'spawns', 'index_t', 'no_index', 'length_m', 'method'], shapes: ['Point'] },
  'sei-garry-oak-1994-95': { box: BBOX, props: ['class', 'sub', 'also'], shapes: ['Polygon', 'MultiPolygon'] },
  'sei-garry-oak-2002': { box: BBOX, props: ['class', 'sub', 'also', 'dist'], shapes: ['Polygon', 'MultiPolygon'] },
  'sei-garry-oak-2014': { box: BBOX, props: ['class', 'sub', 'also', 'tenths'], shapes: ['Polygon', 'MultiPolygon'] },
}
const TIME_PICTURES = ['canopy-2013.png', 'canopy-2019.png', 'canopy-2023.png', 'forest-loss.png', 'landcover-2010-2020.png']
const PICTURE_LIMIT = 1024 * 1024
// The map shows no First Nations content until Darren decides how (F6.4 of the round 3 data notes).
const FIRST_NATION_NAME = /tsawwassen|tsawout|native friendship/i
const OGL_VICTORIA_STATEMENT = 'Contains information licensed under the Open Government Licence – City of Victoria.'

// Boxes: every layer that changes over time has a box, off at load, the air photos have no Swipe box, and the time slider is hidden.
const AERIAL_SWIPE_SENTENCE = 'With no other layer on the time slider, a line splits the map: 1932 on its left and 1950 on its right.'
function ruleTimeBoxes(html) {
  const out = []
  for (const id of TIME_IDS) {
    const m = html.match(new RegExp(`<input[^>]*data-time="${id}"[^>]*>`))
    if (!m) out.push(`no box for ${id}`)
    else if (/\bchecked\b/.test(m[0])) out.push(`${id} is on by default`)
  }
  // The air photos get the swipe when they are alone on the slider, as the ecosystems do, so they have no Swipe box, and their note says so.
  if (/id="aerials-swipe"/.test(html)) out.push('a Swipe box under the air photos, which get the swipe when alone on the slider')
  if (!textOf(html).includes(AERIAL_SWIPE_SENTENCE)) out.push('the air photo note does not say that a line splits the map')
  if (!/<section id="timebar" hidden/.test(html)) out.push('the time slider is not hidden at load')
  if (!/<p id="time-paused" hidden>/.test(html)) out.push('the reduced motion note of the time slider is not hidden at load')
  if (!/<input type="range" id="time-slider"[^>]*aria-label="Year"/.test(html)) out.push('the time slider has no range input with a label')
  if (!/<label id="time-speed-box">Speed <select id="time-speed">[^]*?<option value="1" selected>/.test(html)) out.push('Play has no speed box that starts at 1x')
  if (!textOf(html).includes(TIME_SENTENCE)) out.push('the Change over time sentence is missing')
  return out
}
// Data files: each a feature collection with shapes inside its box, only the properties the popups use, sensible years, and no place named
// for a First Nation. The positive twins: the 2002 file has disturbed patches with their kind, and the 2014 mapping lies in the west only.
function ruleTimeFiles(files) {
  const out = []
  for (const [name, spec] of Object.entries(TIME_FILES)) {
    const { fc, error } = marineJson(files, name)
    if (error) { out.push(error); continue }
    if (!fc.features.length) { out.push(`${name}: no features`); continue }
    const bad = { n: 0 }
    for (const [i, x] of fc.features.entries()) {
      if (!x.geometry) { out.push(`${name}: feature ${i} has no shape`); continue }
      if (!spec.shapes.includes(x.geometry.type)) out.push(`${name}: feature ${i} is a ${x.geometry.type}`)
      coordsIn(x.geometry.coordinates, bad, spec.box)
      const p = x.properties || {}
      const extra = Object.keys(p).filter((k) => !spec.props.includes(k))
      if (extra.length) out.push(`${name}: feature ${i} carries ${extra.join(', ')}`)
      if (FIRST_NATION_NAME.test(String(p.name ?? ''))) out.push(`${name}: feature ${i} is named for a First Nation`)
      if (name === 'herring-spawn-years' && (!Number.isInteger(p.year) || p.year < 1951 || p.year > 2026 || !(p.index_t === null || p.index_t > 0))) out.push(`${name}: feature ${i} has year ${p.year} and index ${p.index_t}`)
    }
    if (bad.n) out.push(`${name}: ${bad.n} coordinates outside its box`)
    if (name === 'sei-garry-oak-2002' && !fc.features.some((x) => x.properties?.class === 'NS' && x.properties.dist)) out.push('sei-garry-oak-2002: no disturbed patch with its kind of disturbance')
    if (name === 'sei-garry-oak-2014') { const east = { n: 0 }; for (const x of fc.features) if (x.geometry) coordsIn(x.geometry.coordinates, east, [-180, -90, -123.515, 90]); if (east.n) out.push(`sei-garry-oak-2014: ${east.n} coordinates east of -123.515, where its notes say it has none`) }
  }
  for (const pic of TIME_PICTURES) {
    const f = files.find((x) => x.path === `data/${pic}`)
    if (!f) out.push(`data/${pic} is missing`)
    else if (f.size > PICTURE_LIMIT) out.push(`data/${pic} is ${f.size} bytes, over 1 MB`)
  }
  return out
}
// Credits: each layer has a paragraph that says what it is and carries its licence statement word for word, and each source on the map carries
// its credit with its licence.
function ruleTimeCredits(html, js) {
  const out = []
  const paras = html.split(/<\/p>|<\/li>/).map(textOf)
  const need = (name, tests) => {
    const para = paras.find((p) => p.includes(name))
    if (!para) { out.push(`the credits have no ${name} paragraph`); return }
    for (const [t, what] of tests) if (!(typeof t === 'string' ? para.includes(t) : t.test(para))) out.push(`the ${name} credit does not say ${what}`)
  }
  need('Change over time (each box', [[/share one time slider/, 'that the layers share one slider'], [/readout under the slider says which year each layer is showing/, 'that the readout says the year of each layer']])
  need('Herring spawn by year.', [[OGL_CANADA_STATEMENT, 'the Open Government Licence – Canada statement'], [/herring season, from July to June/, 'what a year is'], [/relative index of spawning biomass and a minimum estimate/, 'what the index is'], [/surveys changed/, 'that the surveys changed']])
  need('Air photos, 1932 and 1950.', [[OGL_CANADA_STATEMENT, 'the Open Government Licence – Canada statement'], [/National Air Photo Library/, 'where the photos come from'], [/may not line up exactly/, 'that the years may not line up']])
  need('Garry oak and other sensitive ecosystems.', [[OGL_BC_STATEMENT, 'the Open Government Licence – British Columbia statement'], [/no Garry oak class/, 'that the inventory has no Garry oak class'], [/1994 and 1995 from air photos of 1992/, 'when the first mapping was made']])
  need('Land cover, 2010, 2015 and 2020.', [[OGL_CANADA_STATEMENT, 'the Open Government Licence – Canada statement'], [/30 m cells/, 'its cell size']])
  need('Tree canopy from LiDAR, 2013, 2019 and 2023.', [[OGL_VICTORIA_STATEMENT, 'the Open Government Licence – City of Victoria statement'], [/draft/, 'that the 2023 file is a draft'], [/City of Victoria only/, 'that it covers the City of Victoria only'], [/unit is not stated/, 'that the values are not shown because their unit is not stated']])
  need('Forest loss, 2001 to 2025.', [[/Hansen\/UMD\/Google\/USGS\/NASA/, 'the credit Global Forest Change asks for'], [/CC BY 4\.0/, 'its licence'], [/Changes made here/, 'the changes made, as CC BY 4.0 asks'], [/High-Resolution Global Maps of 21st-Century Forest Cover Change/, 'the citation its makers ask for'], [/not single street trees/, 'what it cannot see']])
  const attribLine = (attr) => (js.match(new RegExp(`const ${attr} = [^\\n]*`)) || [''])[0]
  const attribs = { HERRING_YEARS_ATTRIB: /Fisheries and Oceans Canada[\s\S]*OGL_CANADA_LINK/, AERIAL_ATTRIB: /National Air Photo Library[\s\S]*OGL_CANADA_LINK/, LANDCOVER_ATTRIB: /Natural Resources Canada[\s\S]*OGL_CANADA_LINK/, SEI_ATTRIB: /Province of British Columbia[\s\S]*OGL_BC_LINK/, CANOPY_ATTRIB: /City of Victoria[\s\S]*OGL_VICTORIA_LINK/, LOSS_ATTRIB: /Hansen\/UMD\/Google\/USGS\/NASA[\s\S]*CC BY 4\.0/ }
  for (const [attr, re] of Object.entries(attribs)) if (!re.test(attribLine(attr))) out.push(`${attr} does not credit its data and name its licence`)
  const sources = [["geo('tl-herringyears', HERRING_YEARS_ATTRIB)", 'herring'], ["geo(`tl-sei-${v}`, SEI_ATTRIB)", 'the 1994-95 and 2002 inventory'], ["geo('tl-sei-2014', SEI_ATTRIB)", 'the 2014 mapping'], ["geo('tl-forestloss-credit', LOSS_ATTRIB)", 'forest loss'], ["geo('tl-canopy-credit', CANOPY_ATTRIB)", 'the tree canopy'], ['attribution: AERIAL_ATTRIB', 'the air photos'], ["geo('tl-landcover-credit', LANDCOVER_ATTRIB)", 'land cover']]
  for (const [code, what] of sources) if (!js.includes(code)) out.push(`the source of ${what} does not carry its credit`)
  return out
}
// The time slider: Play is off under reduced motion and starts only when pressed, waits while the tab is hidden, and its readout is not read out while it plays.
function ruleTimeControl(js) {
  const out = []
  if (!/let axis = \[\], at = -1, playing = false/.test(js)) out.push('Play is not off when the page opens')
  if (!/playing = !!on && !motionQuery\.matches/.test(js)) out.push('Play can start under reduced motion')
  if (!/play\.disabled = reduced/.test(js)) out.push('the Play button is not disabled under reduced motion')
  if (!/document\.hidden\) return/.test(js) || !/addEventListener\('visibilitychange'/.test(js)) out.push('Play does not wait while the tab is hidden')
  if (!/setAttribute\('aria-live', playing \? 'off' : 'polite'\)/.test(js)) out.push('the readout is read out while Play runs')
  if (/setInterval/.test(js)) out.push('the time slider uses a timer that runs by itself')
  if (!/two = axis\.length <= 2/.test(js) || !/play\.hidden = speedBox\.hidden = track\.hidden = two/.test(js)) out.push('with two steps the slider still shows Play, its speed and the slider')
  return out
}

const RULES = { ruleForbiddenNames, rulePrivacy, ruleExternalRefs, rulePins, ruleSize, ruleDroppedProviders, ruleFlowDirection, ruleFlowCanals, ruleEcccLicence, ruleCurrentsCredit, ruleWindCredit, ruleScalarCredit, ruleTidesCredit, ruleSeafloorCredit, ruleChsNotices, ruleChsNotStored, ruleChsUses, ruleHeldOcean, rulePrivacyHosts, ruleOverlayBoxes, ruleIndustry, ruleMarineFiles, ruleProtectedAreas, ruleSeabirds, ruleDensityCells, ruleSrkwHabitat, ruleRkwArea, ruleCrimsVintage, ruleWhaleRules, ruleWhaleRulesInCode, ruleMarineCredits, ruleMarinePlain, ruleTimeBoxes, ruleTimeFiles, ruleTimeCredits, ruleTimeControl }

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
  const floorHtml = '<p><strong>Seafloor depth</strong> (off until you switch it on). From the Canadian Hydrographic Service (NONNA) in Canadian waters and from the ETOPO1 grid elsewhere. Its cells are 1 arc-minute. It is not for navigation.</p>'
  const floorJs = "const SEAFLOOR_ATTRIB = 'Seafloor depth: ETOPO1, NOAA (coarse, not for navigation)'\nconst NONNA_ATTRIB = `Seafloor depth in Canadian waters: Canadian Hydrographic Service (NONNA, not for navigation)`\nmap.addSource('seafloor', { maxzoom: SEAFLOOR_MAX_ZOOM }); map.addLayer({ id: 'seafloor', type: 'color-relief' })\nmap.addSource(`nonna-${res}`, { type: 'raster', tiles: [`nonna://${res}/{z}/{x}/{y}`] })\naddProtocol?.('nonna', loadNonnaTile)"
  // Canadian Hydrographic Service fixtures
  const chsHtml = `<p id="seafloor-chs-notice" hidden></p><p id="tides-chs-notice" hidden></p><section id="credits"><p>This is a non-commercial demo. ${IWLS_NOTICE_TEXT}</p><p>${NONNA_NOTICE_TEXT}</p><p><a href="${IWLS_LICENCE_URL}">IWLS licence</a> <a href="${NONNA_LICENCE_URL}">NONNA licence</a></p></section>`
  const chsJs = "ui: ['seafloor-chs-notice']\nui: ['tides-chs-notice']\n$('seafloor-chs-notice').textContent = NONNA_NOTICE\n$('tides-chs-notice').textContent = IWLS_NOTICE\nline(IWLS_NOTICE, 'src notice')\nel('p', IWLS_NOTICE, 'src notice')"
  const chsReadme = `The notices: ${IWLS_NOTICE_TEXT} and ${NONNA_NOTICE_TEXT}`
  const chsSources = `Both read 2026-10-22, not for navigation. This is a non-commercial demo. ${IWLS_LICENCE_URL} ${NONNA_LICENCE_URL}`
  // The two accepted CHS uses as the code has them: the NONNA tiles (two layers) and the Victoria Harbour gauge (three time series)
  const usesJs = "export const NONNA_HOST = 'https://nonna-geoserver.data.chs-shc.ca'\nexport const NONNA_LAYERS = { 100: 'NONNA 100', 10: 'NONNA 10' }\nexport const nonnaTileUrl = () => `${NONNA_HOST}/geoserver/x`\nexport const IWLS_API = 'https://api-iwls.dfo-mpo.gc.ca/api/v1/stations'\nconst TIDE_STATIONS = [\n  { id: '9444090', kind: 'level', source: 'noaa' },\n  { id: '07120', kind: 'level', source: 'chs', chsId: '5cebf1df3d0f4a073c4bbd1e' },\n]\nexport function iwlsUrls() { const url = () => `${IWLS_API}/x`; return { hilo: url('wlp-hilo'), observed: url('wlo'), predicted: url('wlp') } }\nfunction iwlsRows() {}\nconst LICENCE = 'https://tides.gc.ca/en/licence-agreement'"
  const usesFiles = (js) => [f('index.html', '<a href="https://tides.gc.ca/en/licence-agreement">licence</a>'), f('js/overlays-data.js', js), f('js/overlays.js', 'const href = `https://tides.gc.ca/en/stations/${id}`')]
  const chsRule = (files) => ruleChsNotices({ html: files[0].text, js: files[1].text, readme: files[2].text, sources: files[3].text })
  const chsFiles = (over = {}) => [f('x.html', over.html ?? chsHtml), f('x.js', over.js ?? chsJs), f('README.md', over.readme ?? chsReadme), f('SOURCES.md', over.sources ?? chsSources)]
  // Marine life and protection fixtures
  const fc = (features) => JSON.stringify({ type: 'FeatureCollection', features })
  const sq = (b = [-123.5, 48.3, -123.4, 48.4]) => ({ type: 'Polygon', coordinates: [[[b[0], b[1]], [b[2], b[1]], [b[2], b[3]], [b[0], b[1]]]] })
  const area = (name, over = {}) => ({ type: 'Feature', geometry: sq(), properties: { name, type: 'Ecological Reserve', owner: 'Government of British Columbia', year: 1980, no_take: 1, ...over } })
  const protectedFc = (over = {}, first = 'RACE ROCKS ECOLOGICAL RESERVE') => fc(Array.from({ length: 20 }, (_, i) => area(i ? `AREA ${i}` : first, i === 1 ? over : {})))
  const colonies = (name, geometry = { type: 'Point', coordinates: [-123.5, 48.4] }) => fc(Array.from({ length: 40 }, (_, i) => ({ type: 'Feature', geometry, properties: { name: i === 3 ? name : `COLONY ${i}` } })))
  const cells = (over = {}) => fc(Array.from({ length: 220 }, (_, i) => ({ type: 'Feature', geometry: sq(), properties: { km2: 25, humpback_n: 0.5, humpback_cv: 0.5, harbour_n: 3, harbour_cv: 0.5, dalls_n: 1, dalls_cv: 0.5, ...(i === 5 ? over : {}) } })))
  const srkw = (over = {}) => ({ type: 'Feature', geometry: sq(), properties: { status: 'Final/Proposed', area_km2: 7497, ...over } })
  const rkw = (over = {}) => ({ type: 'Feature', geometry: sq(), properties: { seasonal: 'June to October', score: 'H', ...over } })
  const herringFc = (a, b) => fc([{ type: 'Feature', geometry: { type: 'LineString', coordinates: [[-123.4, 48.4], [-123.3, 48.4]] }, properties: { first_year: a, last_year: b } }])
  const eelFc = (y) => fc([{ type: 'Feature', geometry: sq(), properties: { year: y } }])
  const marineSet = (kind) => MARINE_FILES.flatMap((n, i) => {
    const path = `data/${n}.geojson`
    if (i !== 2) return [f(path, fc([{ type: 'Feature', geometry: sq(), properties: {} }]))]
    return kind === 'missing' ? [] : [f(path, fc([{ type: 'Feature', geometry: kind === 'null' ? null : sq(kind === 'outside' ? [-120, 40, -119, 41] : undefined), properties: {} }]))]
  })
  const whaleHtml = `<section id="credits"><p><strong>Southern Resident killer whale critical habitat.</strong> ${WHALE_RULES_TEXT} Rules: <a href="${WHALE_LINKS[0]}">Transport Canada Ship Safety Bulletin 08/2026</a> and <a href="${WHALE_LINKS[1]}">Marine Mammal Regulations, Schedule VI</a>.</p><p><strong>Killer whale important area.</strong> ${WHALE_RULES_TEXT}</p><p><strong>Whale and porpoise density.</strong> ${WHALE_RULES_TEXT}</p></section>`
  const whaleJs = `export const WHALE_RULES = '${WHALE_RULES_TEXT}'`
  const whaleCodeJs = "$('srkw-note').textContent = `The area. ${WHALE_RULES}`\n$('rkw-note').textContent = `The important area. ${WHALE_RULES}`\n$('cetaceans-note').textContent = `A model. ${WHALE_RULES}`\nbox.append(el('p', WHALE_RULES))"
  const whaleDataJs = 'export function srkwInfo(p) {\n  return { lines: [WHALE_RULES] }\n}\nexport function rkwInfo(p) {\n  return { lines: [WHALE_RULES] }\n}\nexport function cetaceanInfo(p, key) {\n  return { lines: [WHALE_RULES] }\n}\n'
  const marineHtml = `<p><strong>Marine life and protection</strong> (each box off until you switch it on). None shows where an animal is now. Not for navigation. Each loads one file from this site.</p><p><strong>Protected marine areas.</strong> From CPCAD. Only the marine zone of each area is shown. The no-take line is the Marine Resource Use field.</p><p><strong>Killer whale important area.</strong> Experts drew by hand an area, not a sighting. It does not show where the whales are now and carries no added management.</p><p><strong>Whale and porpoise density.</strong> A model of summer 2018, not where animals are now. Nhat is the model's number. Canadian waters only.</p><p><strong>Coastal habitat</strong> (kelp beds, eelgrass, herring spawn and seabird colonies). Contains information licensed under the Open Government Licence – British Columbia. CRIMS is a legacy dataset that began in 1979 and was only updated now and then, and the Province has no plans to update it.</p><p><strong>Federal data in the marine layers above</strong> (protected areas). ${OGL_CANADA_STATEMENT}</p><p>Nothing here shows where an animal is now. Not for navigation.</p><p>Coastal habitat comes from the Province's Coastal Resource Information Management System (CRIMS). It is a legacy survey that began in 1979 and was only updated now and then, so it is not a current record.</p>`
  const marineJs = "const PROTECTED_ATTRIB = `Protected areas: CPCAD (${OGL_CANADA_LINK})`\nconst SRKW_ATTRIB = `Killer whale critical habitat: DFO (${OGL_CANADA_LINK})`\nconst RKW_ATTRIB = `Killer whale important area: DFO (${OGL_CANADA_LINK})`\nconst CETACEANS_ATTRIB = `Whale and porpoise model: DFO (${OGL_CANADA_LINK})`\nconst CRIMS_ATTRIB = `Coastal habitat: CRIMS, a legacy survey from 1979 (${OGL_BC_LINK})`\nsrc('ov-protected', PROTECTED_ATTRIB)\nsrc('ov-srkw', SRKW_ATTRIB)\nsrc('ov-rkw', RKW_ATTRIB)\nsrc('ov-cetaceans', CETACEANS_ATTRIB)\nsrc('ov-kelp', CRIMS_ATTRIB)\nsrc('ov-eelgrass', CRIMS_ATTRIB)\nsrc('ov-herring', CRIMS_ATTRIB)\nsrc('ov-seabirds', CRIMS_ATTRIB)"
  // Change over time fixtures
  const timeHtml = (checked = false, over = {}) => TIME_IDS.map((id) => `<input type="checkbox" data-time="${id}"${checked ? ' checked' : ''}>`).join('') + (over.note ?? `<p id="aerials-note" hidden>${AERIAL_SWIPE_SENTENCE}</p>`) + (over.bar ?? '<section id="timebar" hidden aria-label="Time slider"><label id="time-speed-box">Speed <select id="time-speed"><option value="0.5">0.5x</option><option value="1" selected>1x</option></select></label><input type="range" id="time-slider" min="0" max="0" step="1" value="0" aria-label="Year"><p id="time-paused" hidden>x</p></section>') + `<p>${over.sentence ?? TIME_SENTENCE}</p>`
  const tf = (name, features) => f(`data/${name}.geojson`, fc(features))
  const pointF = (props, c = [-123.4, 48.5]) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: c }, properties: props })
  const polyF = (props, b) => ({ type: 'Feature', geometry: sq(b), properties: props })
  const timeSet = (over = {}) => [
    tf('herring-spawn-years', [pointF({ year: 1951, name: 'Boat Hrbr', spawns: 1, index_t: 11.1, no_index: 0, length_m: 91, method: 'Surface', ...over.herring })]),
    tf('sei-garry-oak-1994-95', [polyF({ class: 'WD', sub: null, also: null })]),
    tf('sei-garry-oak-2002', [polyF({ class: 'WD', sub: null, also: null, dist: null }), polyF({ class: over.ns ?? 'NS', sub: null, also: null, dist: 'Cleared/Logged' })]),
    tf('sei-garry-oak-2014', [polyF({ class: 'WD', sub: 'co', also: null, tenths: 8 }, over.west ?? [-123.7, 48.3, -123.6, 48.4])]),
    ...TIME_PICTURES.map((pic) => ({ path: `data/${pic}`, text: null, size: pic === over.bigPicture ? 2e6 : 3e5 })),
  ]
  const timeCreditsHtml = `<p><strong>Change over time</strong> (each box off until you switch it on). The layers in this section share one time slider. The readout under the slider says which year each layer is showing.</p><p><strong>Herring spawn by year.</strong> A year is DFO's herring season, from July to June. DFO describes it as a relative index of spawning biomass and a minimum estimate, and its surveys changed. ${OGL_CANADA_STATEMENT}</p><p><strong>Air photos, 1932 and 1950.</strong> National Air Photo Library. They may not line up exactly. ${OGL_CANADA_STATEMENT}</p><p><strong>Garry oak and other sensitive ecosystems.</strong> Surveyed in 1994 and 1995 from air photos of 1992. The inventory has no Garry oak class. ${OGL_BC_STATEMENT}</p><p><strong>Land cover, 2010, 2015 and 2020.</strong> 30 m cells. ${OGL_CANADA_STATEMENT}</p><p><strong>Tree canopy from LiDAR, 2013, 2019 and 2023.</strong> No values, because their unit is not stated. The 2023 file is a draft. City of Victoria only. ${OGL_VICTORIA_STATEMENT}</p><p><strong>Forest loss, 2001 to 2025.</strong> High-Resolution Global Maps of 21st-Century Forest Cover Change. Source: Hansen/UMD/Google/USGS/NASA. CC BY 4.0. Changes made here: clipped. It sees forest clearing, not single street trees.</p>`
  const timeCreditsJs = "const HERRING_YEARS_ATTRIB = `Herring spawn by year: Fisheries and Oceans Canada (${OGL_CANADA_LINK})`\nconst AERIAL_ATTRIB = `Air photos: National Air Photo Library (${OGL_CANADA_LINK})`\nconst LANDCOVER_ATTRIB = `Land cover: Natural Resources Canada (${OGL_CANADA_LINK})`\nconst SEI_ATTRIB = `Sensitive ecosystems: Province of British Columbia (${OGL_BC_LINK})`\nconst CANOPY_ATTRIB = `Tree canopy: City of Victoria (${OGL_VICTORIA_LINK})`\nconst LOSS_ATTRIB = `Forest loss: Hansen/UMD/Google/USGS/NASA (CC BY 4.0)`\ngeo('tl-herringyears', HERRING_YEARS_ATTRIB)\ngeo(`tl-sei-${v}`, SEI_ATTRIB)\ngeo('tl-sei-2014', SEI_ATTRIB)\ngeo('tl-forestloss-credit', LOSS_ATTRIB)\ngeo('tl-canopy-credit', CANOPY_ATTRIB)\n{ attribution: AERIAL_ATTRIB }\ngeo('tl-landcover-credit', LANDCOVER_ATTRIB)"
  const timeControlJs = "let axis = [], at = -1, playing = false, timer = 0\nplaying = !!on && !motionQuery.matches && axis.length > 1\nplay.disabled = reduced || axis.length < 2\nif (mine !== token || !playing || document.hidden) return\ndocument.addEventListener('visibilitychange', () => {})\nlines.setAttribute('aria-live', playing ? 'off' : 'polite')\nconst reduced = motionQuery.matches, two = axis.length <= 2\nplay.hidden = speedBox.hidden = track.hidden = two"
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
    ['ruleSeafloorCredit (no Canadian Hydrographic Service credit)', (files) => ruleSeafloorCredit(files[0].text, files[1].text), [f('x.html', floorHtml.replace('From the Canadian Hydrographic Service (NONNA) in Canadian waters and from', 'From')), f('x.js', floorJs)], [f('x.html', floorHtml), f('x.js', floorJs)]],
    ['ruleSeafloorCredit (on-map NONNA credit)', (files) => ruleSeafloorCredit(files[0].text, files[1].text), [f('x.html', floorHtml), f('x.js', floorJs.replace('Canadian Hydrographic Service (NONNA, not for navigation)', 'NONNA'))], [f('x.html', floorHtml), f('x.js', floorJs)]],
    ['ruleSeafloorCredit (NONNA layer)', (files) => ruleSeafloorCredit(files[0].text, files[1].text), [f('x.html', floorHtml), f('x.js', floorJs.replace('tiles: [`nonna://', 'tiles: [`https://'))], [f('x.html', floorHtml), f('x.js', floorJs)]],
    ['ruleSeafloorCredit (NONNA protocol)', (files) => ruleSeafloorCredit(files[0].text, files[1].text), [f('x.html', floorHtml), f('x.js', floorJs.replace("addProtocol?.('nonna', loadNonnaTile)", ''))], [f('x.html', floorHtml), f('x.js', floorJs)]],
    ['ruleChsNotices (IWLS notice in the credits)', chsRule, chsFiles({ html: chsHtml.replace('is not to be used for navigation', 'is to be used for navigation') }), chsFiles()],
    ['ruleChsNotices (NONNA notice in the README)', chsRule, chsFiles({ readme: chsReadme.replace('Darren Zal and contains intellectual property of the Canadian', 'someone and contains intellectual property of the Canadian') }), chsFiles()],
    ['ruleChsNotices (panel notice not hidden)', chsRule, chsFiles({ html: chsHtml.replace('<p id="tides-chs-notice" hidden>', '<p id="tides-chs-notice">') }), chsFiles()],
    ['ruleChsNotices (panel notice missing)', chsRule, chsFiles({ html: chsHtml.replace('<p id="seafloor-chs-notice" hidden></p>', '') }), chsFiles()],
    ['ruleChsNotices (panel notice not written)', chsRule, chsFiles({ js: chsJs.replace("$('seafloor-chs-notice').textContent = NONNA_NOTICE", '') }), chsFiles()],
    ['ruleChsNotices (panel notice not tied to its layer)', chsRule, chsFiles({ js: chsJs.replace("ui: ['tides-chs-notice']", '') }), chsFiles()],
    ['ruleChsNotices (popup notice)', chsRule, chsFiles({ js: chsJs.replace("line(IWLS_NOTICE, 'src notice')", '') }), chsFiles()],
    ['ruleChsNotices (failed popup notice)', chsRule, chsFiles({ js: chsJs.replace("el('p', IWLS_NOTICE, 'src notice')", '') }), chsFiles()],
    ['ruleChsNotices (non-commercial, credits)', chsRule, chsFiles({ html: chsHtml.replace('non-commercial demo', 'demo') }), chsFiles()],
    ['ruleChsNotices (non-commercial, sources)', chsRule, chsFiles({ sources: chsSources.replace('non-commercial demo', 'demo') }), chsFiles()],
    ['ruleChsNotices (licence in the sources)', chsRule, chsFiles({ sources: chsSources.replace(NONNA_LICENCE_URL, '') }), chsFiles()],
    ['ruleChsNotices (licence in the credits)', chsRule, chsFiles({ html: chsHtml.replace(IWLS_LICENCE_URL, 'https://tides.gc.ca/en/') }), chsFiles()],
    ['ruleChsNotices (date read)', chsRule, chsFiles({ sources: chsSources.replace('read 2026-10-22', 'read') }), chsFiles()],
    ['ruleChsNotStored (data file)', ruleChsNotStored, [f('data/nonna-100.geojson', '{}')], [f('data/streams.geojson', '{}'), f('data/SOURCES.md', 'NONNA')]],
    ['ruleChsNotStored (raster)', ruleChsNotStored, [f('data/seabed.tif', '')], [f('data/streams.geojson', '{}')]],
    ['ruleChsNotStored (fetch script)', ruleChsNotStored, [f('scripts/fetch-layers.sh', 'curl https://nonna-geoserver.data.chs-shc.ca/x')], [f('scripts/fetch-layers.sh', 'curl https://openmaps.gov.bc.ca/x')]],
    ['ruleChsUses (third NONNA endpoint)', ruleChsUses, usesFiles(usesJs + "\nfetch('https://nonna-geoserver.data.chs-shc.ca/geoserver/wfs?request=GetFeature')"), usesFiles(usesJs)],
    ['ruleChsUses (third IWLS endpoint)', ruleChsUses, usesFiles(usesJs + "\nfetch('https://api-iwls.dfo-mpo.gc.ca/api/v1/stations/5cebf1df3d0f4a073c4bbd1e/metadata')"), usesFiles(usesJs)],
    ['ruleChsUses (another CHS or DFO host)', ruleChsUses, usesFiles(usesJs + "\nfetch('https://api.chs-shc.ca/charts')"), usesFiles(usesJs)],
    ['ruleChsUses (a root used a third time)', ruleChsUses, usesFiles(usesJs + "\nfetch(`${IWLS_API}/other`)"), usesFiles(usesJs)],
    ['ruleChsUses (NONNA root changed)', ruleChsUses, usesFiles(usesJs.replace("NONNA_HOST = 'https://nonna-geoserver.data.chs-shc.ca'", "NONNA_HOST = 'https://nonna-geoserver.data.chs-shc.ca/geoserver'")), usesFiles(usesJs)],
    ['ruleChsUses (third NONNA layer)', ruleChsUses, usesFiles(usesJs.replace("10: 'NONNA 10' }", "10: 'NONNA 10', 1: 'NONNA 1' }")), usesFiles(usesJs)],
    ['ruleChsUses (second CHS station)', ruleChsUses, usesFiles(usesJs.replace("\n]", "\n  { id: '07130', kind: 'level', source: 'chs', chsId: '5cebf1df3d0f4a073c4bbd20' },\n]")), usesFiles(usesJs)],
    ['ruleChsUses (other station id)', ruleChsUses, usesFiles(usesJs.replace('5cebf1df3d0f4a073c4bbd1e', '5cebf1df3d0f4a073c4bbd20')), usesFiles(usesJs)],
    ['ruleChsUses (fourth time series)', ruleChsUses, usesFiles(usesJs.replace("predicted: url('wlp') }", "predicted: url('wlp'), more: url('wlf') }")), usesFiles(usesJs)],
    ['ruleHeldOcean', ruleHeldOcean, [f('js/a.js', "const u = 'rockfish'")], [f('js/a.js', "const u = 'api-iwls.dfo-mpo.gc.ca'")]],
    ['ruleHeldOcean (tides)', ruleHeldOcean, [f('js/a.js', "const u = 'acartia.io'")], [f('js/a.js', "const u = 'api.tidesandcurrents.noaa.gov'")]],
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
    ['ruleRkwArea (two features)', ruleRkwArea, [f('data/rkw-important-area.geojson', fc([rkw(), rkw()]))], [f('data/rkw-important-area.geojson', fc([rkw()]))]],
    ['ruleRkwArea (another season)', ruleRkwArea, [f('data/rkw-important-area.geojson', fc([rkw({ seasonal: 'All year' })]))], [f('data/rkw-important-area.geojson', fc([rkw()]))]],
    ['ruleRkwArea (another score)', ruleRkwArea, [f('data/rkw-important-area.geojson', fc([rkw({ score: 'L' })]))], [f('data/rkw-important-area.geojson', fc([rkw()]))]],
    ['ruleRkwArea (a field the popup does not use)', ruleRkwArea, [f('data/rkw-important-area.geojson', fc([rkw({ expert: 'x' })]))], [f('data/rkw-important-area.geojson', fc([rkw()]))]],
    ['ruleRkwArea (an unsimplified shape)', ruleRkwArea, [f('data/rkw-important-area.geojson', fc([rkw()]) + ' '.repeat(120000))], [f('data/rkw-important-area.geojson', fc([rkw()]))]],
    ['ruleWhaleRules (the important area paragraph without the distances)', (files) => ruleWhaleRules(files[0].text, files[1].text), [f('x.html', whaleHtml.replace('<p><strong>Killer whale important area.</strong> ' + WHALE_RULES_TEXT + '</p>', '<p><strong>Killer whale important area.</strong> Nothing.</p>')), f('x.js', whaleJs)], [f('x.html', whaleHtml), f('x.js', whaleJs)]],
    ['ruleWhaleRulesInCode (important area info without the distances)', (files) => ruleWhaleRulesInCode(files[0].text, files[1].text), [f('x.js', whaleCodeJs), f('x.js', whaleDataJs.replace('export function rkwInfo(p) {\n  return { lines: [WHALE_RULES] }', 'export function rkwInfo(p) {\n  return { lines: [] }'))], [f('x.js', whaleCodeJs), f('x.js', whaleDataJs)]],
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
    ['ruleTimeBoxes (on by default)', (files) => ruleTimeBoxes(files[0].text), [f('x.html', timeHtml(true))], [f('x.html', timeHtml())]],
    ['ruleTimeBoxes (a Swipe box under the air photos)', (files) => ruleTimeBoxes(files[0].text), [f('x.html', timeHtml(false, { note: `<label class="sub" id="aerials-controls" hidden><input type="checkbox" id="aerials-swipe"> <span>Swipe</span></label><p id="aerials-note" hidden>${AERIAL_SWIPE_SENTENCE}</p>` }))], [f('x.html', timeHtml())]],
    ['ruleTimeBoxes (no swipe sentence for the air photos)', (files) => ruleTimeBoxes(files[0].text), [f('x.html', timeHtml(false, { note: '<p id="aerials-note" hidden>The photos.</p>' }))], [f('x.html', timeHtml())]],
    ['ruleTimeBoxes (slider shown at load)', (files) => ruleTimeBoxes(files[0].text), [f('x.html', timeHtml(false, { bar: '<section id="timebar" aria-label="Time slider"><label id="time-speed-box">Speed <select id="time-speed"><option value="1" selected>1x</option></select></label><input type="range" id="time-slider" aria-label="Year"><p id="time-paused" hidden>x</p></section>' }))], [f('x.html', timeHtml())]],
    ['ruleTimeBoxes (no speed box)', (files) => ruleTimeBoxes(files[0].text), [f('x.html', timeHtml(false, { bar: '<section id="timebar" hidden aria-label="Time slider"><input type="range" id="time-slider" aria-label="Year"><p id="time-paused" hidden>x</p></section>' }))], [f('x.html', timeHtml())]],
    ['ruleTimeBoxes (no sentence)', (files) => ruleTimeBoxes(files[0].text), [f('x.html', timeHtml(false, { sentence: 'Layers.' }))], [f('x.html', timeHtml())]],
    ['ruleTimeFiles (a herring year out of range)', ruleTimeFiles, timeSet({ herring: { year: 1940 } }), timeSet()],
    ['ruleTimeFiles (a place named for a First Nation)', ruleTimeFiles, timeSet({ herring: { name: 'Tsawwassen Causeway' } }), timeSet()],
    ['ruleTimeFiles (a property the popups do not use)', ruleTimeFiles, timeSet({ herring: { contact: 'x' } }), timeSet()],
    ['ruleTimeFiles (no disturbed patch in 2002)', ruleTimeFiles, timeSet({ ns: 'WD' }), timeSet()],
    ['ruleTimeFiles (the 2014 mapping in the east)', ruleTimeFiles, timeSet({ west: [-123.4, 48.4, -123.3, 48.5] }), timeSet()],
    ['ruleTimeFiles (a picture over 1 MB)', ruleTimeFiles, timeSet({ bigPicture: 'canopy-2019.png' }), timeSet()],
    ['ruleTimeCredits (no Victoria statement)', (files) => ruleTimeCredits(files[0].text, files[1].text), [f('x.html', timeCreditsHtml.replace(OGL_VICTORIA_STATEMENT, 'Thanks.')), f('x.js', timeCreditsJs)], [f('x.html', timeCreditsHtml), f('x.js', timeCreditsJs)]],
    ['ruleTimeCredits (no Hansen credit)', (files) => ruleTimeCredits(files[0].text, files[1].text), [f('x.html', timeCreditsHtml.replace('Hansen/UMD/Google/USGS/NASA', 'UMD')), f('x.js', timeCreditsJs)], [f('x.html', timeCreditsHtml), f('x.js', timeCreditsJs)]],
    ['ruleTimeCredits (an on-map credit without its licence)', (files) => ruleTimeCredits(files[0].text, files[1].text), [f('x.html', timeCreditsHtml), f('x.js', timeCreditsJs.replace('Province of British Columbia (${OGL_BC_LINK})', 'Province of British Columbia'))], [f('x.html', timeCreditsHtml), f('x.js', timeCreditsJs)]],
    ['ruleTimeCredits (a source without its credit)', (files) => ruleTimeCredits(files[0].text, files[1].text), [f('x.html', timeCreditsHtml), f('x.js', timeCreditsJs.replace("geo('tl-landcover-credit', LANDCOVER_ATTRIB)", "geo('tl-landcover-credit', null)"))], [f('x.html', timeCreditsHtml), f('x.js', timeCreditsJs)]],
    ['ruleTimeControl (Play under reduced motion)', (files) => ruleTimeControl(files[0].text), [f('x.js', timeControlJs.replace('!!on && !motionQuery.matches', '!!on'))], [f('x.js', timeControlJs)]],
    ['ruleTimeControl (Play on at load)', (files) => ruleTimeControl(files[0].text), [f('x.js', timeControlJs.replace('playing = false', 'playing = true'))], [f('x.js', timeControlJs)]],
    ['ruleTimeControl (Play shown with two steps)', (files) => ruleTimeControl(files[0].text), [f('x.js', timeControlJs.replace('play.hidden = speedBox.hidden = track.hidden = two', 'speedBox.hidden = two'))], [f('x.js', timeControlJs)]],
    ['ruleTimeControl (a hidden tab keeps playing)', (files) => ruleTimeControl(files[0].text), [f('x.js', timeControlJs.replace(' || document.hidden', ''))], [f('x.js', timeControlJs)]],
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
  report(...pair(ruleRkwArea(files), 'killer whale important area: one polygon that experts drew for June to October and rated high, with only the fields the popup uses, simplified to under 100 KB'))
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
  // Changing a layer's dash array makes MapLibre rebuild its tiles in a worker, so a step must change only opacity. Each step is a layer of its own.
  report(!/setPaintProperty\([^)]*['"]line-dasharray['"]/.test(app) && /FLOW_LAYERS\[next\], 'line-opacity'/.test(app) && /FLOW_SEQUENCE\.forEach\(\(dash, i\) => map\.addLayer/.test(app), 'creek Flow: a step changes the opacity of one of 14 layers, each with a fixed dash array, and never sets a dash array (which would make MapLibre rebuild the creek tiles at every step)')
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
  const timeLayersJs = byPath['js/time-layers.js']?.text || '', timelineJs = byPath['js/timeline.js']?.text || ''
  report(...pair(ruleTimeBoxes(html), 'change over time: every layer has a box, all off by default, no Swipe box and a note that a line splits the map for the air photos, the time slider hidden at load, and the section sentence present'))
  report(...pair(ruleTimeFiles(files), `change over time: ${Object.keys(TIME_FILES).length} data files inside their boxes with only the fields the popups use, sensible years, no place named for a First Nation, disturbed patches in 2002, the 2014 mapping in the west only, and ${TIME_PICTURES.length} pictures under 1 MB each`))
  report(...pair(ruleTimeCredits(html, timeLayersJs), 'change over time: the credits say what each layer is and carry its licence statement word for word, and every source on the map carries its credit and licence'))
  report(...pair(ruleTimeControl(timelineJs), 'change over time: Play is off at load and under reduced motion, waits while the tab is hidden, and its readout is not read out while it plays'))
  report(...pair(ruleCurrentsCredit(html, overlaysJs), 'sea currents carry the Environment and Climate Change Canada credit on the map and say the model is experimental and not for navigation'))
  report(...pair(ruleWindCredit(html, overlaysJs), 'wind carries the Environment and Climate Change Canada credit on the map, says it is a forecast and not for navigation, and is named in the privacy note'))
  report(...pair(ruleScalarCredit(html, overlaysJs), 'sea temperature and sea saltiness carry the Environment and Climate Change Canada credit on the map and say the model is experimental and not for navigation'))
  report(...pair(ruleTidesCredit(html, overlaysJs), 'tides and tidal currents carry the NOAA/NOS/CO-OPS attribution, say predictions are not for navigation and that the curves are not official NOAA material'))
  report(...pair(ruleSeafloorCredit(html, overlaysJs), 'seafloor depth says it comes from the Canadian Hydrographic Service (NONNA) in Canadian waters and from ETOPO1 elsewhere, how coarse ETOPO1 is and that it is not for navigation, and is a colour relief on its own capped source under raster tiles asked for by a protocol of the page'))
  report(...pair(ruleHeldOcean(scanned.filter((f) => /^(index\.html$|js\/|css\/)/.test(f.path))), 'no held ocean data in the code or the page (conservation areas, shellfish closures, haulouts, whale sighting feeds, ship tracking)'))
  report(...pair(ruleChsNotStored(files), 'no copy of Canadian Hydrographic Service data in data/ or raw/, and the fetch script does not ask its servers for any'))
  report(...pair(ruleChsUses(scanned), 'the Canadian Hydrographic Service is used for the NONNA depth tiles (two layers) and the Victoria Harbour gauge (one station, three time series) and for nothing else'))
  report(flowJs.includes('motionQuery') && flowJs.includes('visibilitychange') && flowJs.includes('cancelAnimationFrame') && flowJs.includes("'movestart'"), 'the particle loop of sea currents and wind honours reduced motion, stops when the tab is hidden and while the map moves')
  report(!byPath['js/currents.js'] && /createFlow/.test(overlaysJs) && (overlaysJs.match(/createFlow\(/g) || []).length === 1 && !/new Path2D/.test(overlaysJs), 'sea currents and wind use one particle engine (js/flow.js), made once, with no second copy of it in overlays.js')
  report(overlaysJs.includes('Contains information licenced under the <a href="${ECCC_LICENCE}" target="_blank" rel="noopener">Data Server End-use Licence</a> of Environment and Climate Change Canada.') && overlaysJs.includes("const ECCC_LICENCE = 'https://eccc-msc.github.io/open-data/licence/readme_en/'"), 'on-map attribution carries the Environment and Climate Change Canada licence statement and a link to the licence')
  const missingOverlay = OVERLAY_STATEMENTS.filter((t) => !creditsText.includes(t))
  report(missingOverlay.length === 0, 'credits carry the Environment Canada, USGS, ecoregion and industry source statements word for word', missingOverlay.join(' | '))

  const sources = byPath['data/SOURCES.md']?.text || ''
  report([...LAYER_FILES.filter((n) => n !== 'pins'), ...MARINE_FILES, ...Object.keys(TIME_FILES)].every((n) => sources.includes(`${n}.geojson`)) && TIME_PICTURES.every((n) => sources.includes(n)), 'data/SOURCES.md lists every data file')
  const licence = byPath['LICENSE']?.text || ''
  report(licence.startsWith('MIT License') && licence.includes('Copyright (c) 2026 Darren Zal') && licence.includes('Permission is hereby granted, free of charge'), 'LICENSE is the MIT licence with the Darren Zal copyright line')
  const readme = byPath['README.md']?.text || ''
  report(/MIT[^.]*covers the code only/.test(readme) && readme.includes('data/SOURCES.md'), 'README says the MIT licence covers the code only and points to data/SOURCES.md for the data')
  report(...pair(ruleChsNotices({ html, js: overlaysJs, readme, sources }), 'Canadian Hydrographic Service: both licence notices are in the credits and the README word for word, under their layer in the panel while it is on and in the gauge popup, the credits and the notes say this is a non-commercial demo, and both licences are recorded with their addresses and the date they were read'))
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
    copyFileSync(join(ROOT, 'js/time-data.js'), join(dir, 'time-data.js'))
    const D = await import(pathToFileURL(join(dir, 'overlays-data.js')).href)
    const F = await import(pathToFileURL(join(dir, 'flow.js')).href)
    const T = await import(pathToFileURL(join(dir, 'time-data.js')).href)
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
    // The browsers write a time differently for en-CA. Safari says "Oct 23 at 6 AM PDT" where Chrome says "Oct 23, 6 a.m. PDT" (found 2026-10-23 in WebKit), so
    // the page puts the text together from the parts. A stand-in for Safari's Intl gives Safari's parts, and the text must come out as Chrome's.
    const RealFormat = Intl.DateTimeFormat
    const safariParts = [{ type: 'month', value: 'Oct' }, { type: 'literal', value: ' ' }, { type: 'day', value: '23' }, { type: 'literal', value: ' at ' }, { type: 'hour', value: '6' }, { type: 'literal', value: ':' }, { type: 'minute', value: '07' }, { type: 'literal', value: ' ' }, { type: 'dayPeriod', value: 'AM' }, { type: 'literal', value: ' ' }, { type: 'timeZoneName', value: 'PDT' }]
    Intl.DateTimeFormat = function () { return { formatToParts: () => safariParts, format: () => 'Oct 23 at 6:07 AM PDT' } }
    let safari
    try { safari = [D.pacificTime('2026-10-23T13:07:00Z'), D.pacificHour('2026-10-23T13:07:00Z'), D.pacificHourLabel(Date.parse('2026-10-23T13:07:00Z'))] } finally { Intl.DateTimeFormat = RealFormat }
    report(safari[0] === 'Oct 23, 6:07 a.m. PDT' && safari[1] === 'Oct 23, 6 a.m. PDT' && safari[2] === '6 a.m.' && D.pacificHourLabel(Date.parse('2026-10-22T19:00:00Z')) === '12 p.m.' && D.pacificHourLabel(Date.parse('2026-10-22T07:00:00Z')) === '12 a.m.', 'times: the text of a time is put together from the parts the browser gives, so Safari\'s "Oct 23 at 6:07 AM PDT" is shown as "Oct 23, 6:07 a.m. PDT", and the axis hours of a tide curve read "6 a.m.", "12 p.m." and "12 a.m."', JSON.stringify(safari))

    // Asking the GeoMet server: a time limit on each try, one more try after a short wait, and plain words for the status line.
    {
      const aborted = (signal) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true }))
      const reply = (body, { status = 200, type = 'image/tiff', stall = false, signal } = {}) => ({ ok: status < 400, status, headers: { get: () => type }, arrayBuffer: () => (stall ? aborted(signal) : Promise.resolve(body)), text: () => Promise.resolve(body), blob: () => Promise.resolve(body) })
      // A fetch that plays the replies in order: 'hang' never answers, 'stall' answers and then never finishes the body, an Error is a broken connection.
      const player = (script) => { const calls = []; const f = (url, { signal }) => { calls.push(url); const next = script[Math.min(calls.length - 1, script.length - 1)]; if (next === 'hang') return aborted(signal); if (next instanceof Error) return Promise.reject(next); if (next === 'stall') return Promise.resolve(reply('x', { stall: true, signal })); return Promise.resolve(typeof next === 'function' ? next(signal) : next) }; f.calls = calls; return f }
      const fast = { tryMs: 40, slowMs: 15, waitMs: 5 }
      const ask = async (script, extra = {}, as = 'arrayBuffer') => { const fetchImpl = player(script), said = []; try { const body = await D.geometGet('https://geo.weather.gc.ca/geomet?x', as, { ...fast, fetchImpl, say: (k) => said.push(k), ...extra }); return { body, said, calls: fetchImpl.calls.length } } catch (e) { return { error: e, said, calls: fetchImpl.calls.length } } }
      const good = await ask([reply('ok')])
      report(good.body === 'ok' && good.calls === 1 && good.said.length === 0, 'GeoMet requests: a reply that comes at once is returned after one try, and the status line is not touched')
      const hung = await ask(['hang', reply('ok')])
      report(hung.body === 'ok' && hung.calls === 2 && hung.said.join() === 'slow,retry', 'GeoMet requests: a first try that never answers is cut off at its time limit and tried once more after a wait, and the status line is told it is slow and then that a second try starts', JSON.stringify(hung.said))
      const refused = await ask([reply('', { status: 503 }), reply('ok')])
      const broken = await ask([new TypeError('Failed to fetch'), reply('ok')])
      const tooMany = await ask([reply('', { status: 429 }), reply('ok')])
      report(refused.body === 'ok' && refused.calls === 2 && broken.body === 'ok' && broken.calls === 2 && tooMany.body === 'ok' && tooMany.calls === 2 && refused.said.join() === 'retry', 'GeoMet requests: a busy or broken server (HTTP 503 or 429) or a broken connection is tried once more')
      const down = await ask(['hang', 'hang'])
      const downErr = await ask([new TypeError('Failed to fetch'), new TypeError('Failed to fetch')])
      const sick = await ask([reply('', { status: 503 }), reply('', { status: 502 })])
      report(down.calls === 2 && down.error?.reason === 'down' && downErr.calls === 2 && downErr.error?.reason === 'down' && sick.calls === 2 && sick.error?.reason === 'error' && sick.error.status === 502, 'GeoMet requests: after two failed tries it stops, saying whether the server did not answer (down) or sent an error', JSON.stringify([down.error?.reason, downErr.error?.reason, sick.error?.reason]))
      const missing = await ask([reply('', { status: 404 }), reply('ok')])
      const wrong = await ask([reply('<ServiceException/>', { type: 'text/xml' }), reply('ok')], { type: /image\/tiff/i })
      report(missing.calls === 1 && missing.error?.reason === 'error' && missing.error.status === 404 && wrong.calls === 1 && wrong.error?.reason === 'wrong' && !(await ask([reply('ok')], { type: /image\/tiff/i })).error, 'GeoMet requests: a request the server refuses for its own sake (HTTP 404) or answers with the wrong kind of file is not tried twice, and the right kind passes the check')
      // A busy page: the limit's timer runs late, after the answer has come and before it is handled. The answer is handled, and a request that really never answers is still cut off.
      const busyFetch = (url, { signal }) => new Promise((resolve, reject) => { setTimeout(() => resolve(reply('ok')), 30); signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true }) })
      const spin = (ms) => { const t = performance.now(); while (performance.now() - t < ms) { /* a page that is busy drawing */ } }
      const busyAsk = (extra) => { const p = D.geometGet('u', 'arrayBuffer', { tryMs: 20, slowMs: 1000, waitMs: 5, busyMs: 15, graceMs: 120, fetchImpl: busyFetch, ...extra }).then((body) => ({ body }), (error) => ({ error })); spin(70); return p }
      const busy = await busyAsk({})
      const noGrace = await busyAsk({ busyMs: 1e9 })
      const quick = await ask([reply('ok')], { tryMs: 1000, busyMs: 15, graceMs: 120 })
      report(busy.body === 'ok' && noGrace.body !== 'ok' && quick.body === 'ok' && (await ask(['hang', 'hang'], { busyMs: 15, graceMs: 20 })).error?.reason === 'down', 'GeoMet requests: a time limit whose timer runs late (the page was busy) is not taken as the server being slow, the answer waiting to be handled gets a moment more, and a request that never answers is still cut off', JSON.stringify([busy, noGrace.error?.reason]))
      const stalled = await ask(['stall', reply('ok')])
      report(stalled.body === 'ok' && stalled.calls === 2, 'GeoMet requests: the time limit covers the reply to its last byte, so a body that stalls is cut off and tried again')
      const ac = new AbortController(), fetchImpl = player(['hang', reply('ok')]), cancelled = D.geometGet('https://geo.weather.gc.ca/geomet?x', 'arrayBuffer', { ...fast, tryMs: 1000, fetchImpl, signal: ac.signal }).then(() => null, (e) => e)
      setTimeout(() => ac.abort(), 10)
      const cancelErr = await cancelled
      const early = new AbortController(); early.abort()
      const earlyErr = await D.geometGet('https://geo.weather.gc.ca/geomet?x', 'text', { ...fast, fetchImpl: player([reply('ok')]), signal: early.signal }).then(() => null, (e) => e)
      report(cancelErr?.reason === 'cancelled' && fetchImpl.calls.length === 1 && earlyErr?.reason === 'cancelled', 'GeoMet requests: unticking the box (the caller\'s signal) stops the request and the second try at once')
      const badWay = await D.geometGet('u', 'json', {}).then(() => null, (e) => e)
      report(!!badWay?.message.includes('text, arrayBuffer or blob'), 'GeoMet requests: a way of reading the reply that is not one of the three is refused')
      report(D.GEOMET_TRY_MS === 15000 && D.GEOMET_SLOW_MS < D.GEOMET_TRY_MS && D.GEOMET_WAIT_MS <= 2000 && D.GEOMET_BUSY_MS === 1000 && D.GEOMET_GRACE_MS === 1000 && D.geometWhy({ reason: 'down' }) === ' Environment Canada’s server is not answering.' && D.geometWhy({ reason: 'error', status: 503 }) === ' Environment Canada’s server sent an error.' && D.geometWhy({ reason: 'wrong' }) === ' Environment Canada’s server sent an error.' && D.geometWhy({ reason: 'cancelled' }) === '' && D.geometWhy(new Error('x')) === '' && !/[;—]/.test(D.GEOMET_SLOW_LINE + D.GEOMET_RETRY_LINE), 'GeoMet requests: each try has 15 s, the status line says slow after 6 s, the wait is under 2 s, and the sentences added to a failure are plain')
    }

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

    // Between two hours the field is blended, as a vector, so Play changes smoothly. The east flow of 0.5 m/s at one hour and the west flow at the next.
    const westAll = D.currentsGrid(D.readGeoTiff(tiff({ w: 5, h: 4, values: cells(() => -0.5), scale: [1, 1], tie: [0, 52], rows: 4 })), D.readGeoTiff(tiff({ w: 5, h: 4, values: cells(() => 1e-9), scale: [1, 1], tie: [0, 52], rows: 4 })))
    const fwest = D.screenField(westAll, 80, 80, 10, flat), mixed = [0, 0, 0], pure = [0, 0, 0]
    const blendAt = (a, b, t) => (D.fieldBlendAt(a, b, t, 25, 25, mixed) ? [...mixed] : null)
    const sameAs = (v, f) => { D.fieldAt(f, 25, 25, pure); return v && v.every((x, i) => Math.abs(x - pure[i]) < 1e-4 * Math.max(1, Math.abs(pure[i]))) }
    report(Math.abs(fe.ux[o] - 0.5) < 1e-6 && Math.abs(fwest.ux[o] + 0.5) < 1e-6 && Math.abs(fe.uy[o]) < 1e-6 && fe.vecs.length === 4 && fe.vecs[2] === fe.ux, 'sea currents: the screen field keeps the flow itself (east and north in m/s) beside the pixels a second, so two hours can be mixed', JSON.stringify([fe.ux[o], fwest.ux[o]]))
    report(sameAs(blendAt(fe, fwest, 0), fe) && sameAs(blendAt(fe, fwest, 1), fwest) && sameAs(blendAt(fe, fe, 0.37), fe), 'Play blend: at the start of the step the field is the hour shown, at the end the hour after it, and a blend of an hour with itself changes nothing')
    const quarterWay = blendAt(fe, fwest, 0.25), halfWay = blendAt(fe, fwest, 0.5)
    report(Math.abs(quarterWay[0] / (0.5 * wantX) - 1) < 0.01 && Math.abs(quarterWay[2] - 0.25) < 1e-6 && Math.abs(halfWay[0]) < 1e-3 * wantX && halfWay[2] < 1e-6, 'Play blend: the flow is mixed as a vector, so water that turns round between the hours slows to a stop halfway and does not jump (a quarter of the way it is 0.25 m/s at half the pixels, halfway it is 0, where mixing the two speeds would give 0.5)', JSON.stringify([quarterWay, halfWay]))
    const toLand = blendAt(fe, landOnly, 0.5), fromLand = blendAt(landOnly, fe, 0.5)
    report(sameAs(toLand, fe) && sameAs(fromLand, fe) && blendAt(landOnly, landOnly, 0.5) === null && !D.fieldBlendAt(fe, fwest, 0.5, -20, 10, mixed) && !D.fieldBlendAt(fe, fwest, 0.5, 500, 10, mixed), 'Play blend: where only one of the two hours has flow that hour is used, where neither has any there is none, and off the field there is none')
    const speeds = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1].map((t) => blendAt(fe, fwest, t)[2]), xs = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1].map((t) => blendAt(fe, fwest, t)[0])
    report(xs.every((x, i) => i === 0 || x < xs[i - 1]) && Math.max(...xs.slice(1).map((x, i) => Math.abs(x - xs[i]))) < 0.11 * Math.abs(xs[0] - xs.at(-1)) && speeds.every((v) => v <= 0.5 + 1e-6), 'Play blend: the pixels a second change by the same small step for every tenth of the way, from the first hour to the next, without a jump')
    // The creek Flow rests after a step for twice as long as the redraw took, up to 5 s, and a bad number gives no rest.
    report(D.flowRestMs(20) === 40 && D.flowRestMs(800) === 1600 && D.flowRestMs(6000) === 5000 && D.flowRestMs(0) === 0 && D.flowRestMs(-5) === 0 && D.flowRestMs(NaN) === 0 && D.flowRestMs(Infinity) === 0 && D.flowRestMs(undefined) === 0, 'creek Flow: after a step the loop rests twice as long as the redraw took (up to 5 s), so a slow device is not kept drawing, and a bad number gives no rest')

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

    // The Night look: light trails on a dark map, and the basemap's colours darkened.
    const lumOf = (c) => lum(c.slice(0, 3))
    const contrastBetween = (a, b) => { const [hi, lo] = [lumOf(a), lumOf(b)].sort((p, q) => q - p); return (hi + 0.05) / (lo + 0.05) }
    const nightContrastOn = (colour) => { const [r, g, b, a] = rgba(colour), c = [r, g, b].map((v, i) => v * a + D.NIGHT_SEA[i] * (1 - a)); return contrastBetween(c, D.NIGHT_SEA) }
    const nightBands = (kind) => F.FLOW_PROFILES[kind].night.bands
    const nightRamp = (kind) => nightBands(kind).map((b) => nightContrastOn(b.colour))
    const brighterWithSpeed = (kind) => nightRamp(kind).every((c, i, all) => i === 0 || c > all[i - 1]) && nightBands(kind).every((b, i, all) => b.width >= 1 && b.width <= 2 && (i === 0 || (b.from > all[i - 1].from && b.width >= all[i - 1].width)))
    report(['currents', 'wind'].every((k) => nightRamp(k).every((c) => c >= 7) && brighterWithSpeed(k) && F.FLOW_PROFILES[k].night.keep > F.FLOW_PROFILES[k].keep * 1.5 && F.FLOW_PROFILES[k].night.keep > 0.3 && F.FLOW_PROFILES[k].night.keep < 0.6) && nightContrastOn('rgba(30, 30, 30, 0.9)') < 3 && F.FLOW_PROFILES.currents.night.bands.length === F.FLOW_PROFILES.currents.bands.length, 'Night look: every speed band of the currents and the wind is a pale trail with a contrast of at least 7 to 1 against the dark sea, brighter and thicker (1 to 2 px) with speed, and the trails last longer than by day (47% of a trail is left a second later, against 25% by day)', JSON.stringify([nightRamp('currents').map((x) => +x.toFixed(1)), nightRamp('wind').map((x) => +x.toFixed(1))]))
    const pr = (c) => { const m = c.match(/[\d.]+/g).map(Number); return [...m.slice(0, 3), m[3] ?? 1] }
    const nightGround = D.nightColour([242, 243, 240, 1], 'ground'), nightSea = D.nightColour([194, 200, 202, 1], 'sea')
    report(sameValues(nightGround, [...D.NIGHT_GROUND, 1]) && sameValues(nightSea, [...D.NIGHT_SEA, 1]) && lumOf(nightSea) < lumOf(nightGround) && lumOf(nightGround) < 0.03 && lumOf(nightSea) < 0.03 && D.nightColour([10, 20, 30, 0.4], 'ground')[3] === 0.4 && threw(() => D.nightColour([0, 0, 0, 1], 'shiny')), 'Night look: the ground and the sea get set dark colours (the sea the darker and bluer of the two), the alpha is kept, and an unknown role is refused')
    // The text colours of the pale basemap as read on 2026-10-22: black and dark grey place names and road names, mid grey for waterways and paths, blue for water names.
    const texts = [[0, 0, 0], [51, 51, 51], [102, 102, 102], [158, 158, 158], [168, 168, 168], [73, 94, 145]], nightTexts = texts.map((c) => D.nightColour([...c, 1], 'text'))
    const halos = [[255, 255, 255, 0.7], [255, 255, 255, 1], [248, 244, 240, 1]].map((c) => D.nightColour(c, 'halo'))
    report(nightTexts.every((c) => contrastBetween(c, nightGround) >= 4.5) && nightTexts.slice(0, 3).every((c) => contrastBetween(c, nightGround) >= 7) && lumOf(nightTexts[0]) > lumOf(nightTexts[1]) && lumOf(nightTexts[1]) > lumOf(nightTexts[2]) && lumOf(nightTexts[2]) > lumOf(nightTexts[3]) && halos.every((h) => lumOf(h) < lumOf(nightGround)) && halos[0][3] === 0.7 && texts.every((c, i) => contrastBetween(nightTexts[i], halos[1]) >= 4.5), 'Night look: place and road names turn light (a contrast of at least 7 to 1 against the dark ground, 4.5 to 1 for the faintest greys), keep their order of brightness, and their white halos turn darker than the ground with their transparency kept', JSON.stringify(nightTexts.map((c) => +contrastBetween(c, nightGround).toFixed(1))))
    // Features keep their relation to the land: what was darker than the land is lighter than the nightGround, the white of a road is lighter than the nightGround, and nothing is brighter than a label.
    const feats = { park: [230, 233, 229], wood: [220, 224, 220], building: [234, 234, 229], casing: [213, 213, 213], boundary: [179, 179, 179], road: [255, 255, 255] }
    const nf = Object.fromEntries(Object.entries(feats).map(([k, c]) => [k, D.nightColour([...c, 1], 'feature')]))
    report(Object.values(nf).every((c) => c.slice(0, 3).every((x) => Number.isInteger(x) && x >= 0 && x <= 255) && lumOf(c) < lumOf(nightTexts[2])) && lumOf(nf.road) > lumOf(nightGround) && lumOf(nf.boundary) > lumOf(nf.casing) && lumOf(nf.casing) > lumOf(nf.wood) && lumOf(nf.wood) > lumOf(nf.park) && lumOf(nf.park) > lumOf(nf.building) * 0.99 && lumOf(nf.boundary) > lumOf(nightGround) * 2, 'Night look: the colours of roads, parks, buildings and boundaries keep their order and none outshines a label (what was darker than the land is lighter than the ground, a boundary is about twice as bright as the ground, a white road is lighter than it)', JSON.stringify(Object.fromEntries(Object.entries(nf).map(([k, c]) => [k, c.join()]))))
    // A style's colours are changed where they are colours and nowhere else, in any expression.
    const parseStub = (c) => (c === '#fff' ? [255, 255, 255, 1] : c === 'hsla(0,0%,85%,0.53)' ? [217, 217, 217, 0.53] : null)
    const ramp3 = ['interpolate', ['linear'], ['zoom'], 5.8, 'hsla(0,0%,85%,0.53)', 6, '#fff'], darkened = D.nightValue(ramp3, 'feature', parseStub)
    report(darkened[0] === 'interpolate' && sameValues(darkened[1], ['linear']) && sameValues(darkened[2], ['zoom']) && darkened[3] === 5.8 && darkened[5] === 6 && /^rgba\(\d+, \d+, \d+, 0\.53\)$/.test(darkened[4]) && /^rgba\(\d+, \d+, \d+, 1\)$/.test(darkened[6]) && D.nightValue('match', 'text', parseStub) === 'match' && D.nightValue('rgb(1, 2, 3)', 'text', () => null) === 'rgb(1, 2, 3)' && D.nightValue(4, 'text', parseStub) === 4 && D.nightValue(null, 'text', parseStub) === null && pr(D.nightValue('#fff', 'halo', parseStub))[0] < 40, 'Night look: a style colour or an expression holding colours is darkened where there are colours (with the alpha kept) and the operators, numbers and words in it stay as they were')
    const lay = (type, sourceLayer) => ({ type, 'source-layer': sourceLayer })
    report(D.nightRole(lay('background'), 'background-color') === 'ground' && D.nightRole(lay('fill', 'water'), 'fill-color') === 'sea' && D.nightRole(lay('line', 'waterway'), 'line-color') === 'waterline' && D.nightRole(lay('symbol', 'place'), 'text-color') === 'text' && D.nightRole(lay('symbol', 'place'), 'text-halo-color') === 'halo' && D.nightRole(lay('fill', 'park'), 'fill-color') === 'feature' && D.nightRole(lay('line', 'transportation'), 'line-color') === 'feature', 'Night look: each colour of a layer has its role: ground, sea, waterway, text, halo or feature')

    // sea temperature and saltiness (one picture for each hour, from the same model as the currents)
    const tAt = (kind, h) => xml(D.SCALARS[kind].layer, h)
    const tHours = '2026-10-22T07:00:00Z/2026-10-24T06:00:00Z/PT1H'
    const tTimes = D.scalarTimes('temperature', tAt('temperature', tHours))
    report(tTimes.length === 48 && tTimes[0] === '2026-10-22T07:00:00Z' && tTimes.at(-1) === '2026-10-24T06:00:00Z' && threw(() => D.scalarTimes('temperature', tAt('salinity', tHours))) && threw(() => D.scalarTimes('salinity', xml('CIOPS-SalishSea_500m_SeaWaterVelocity_0.5m', tHours))) && threw(() => D.scalarTimes('salinity', tAt('salinity', '2026-10-22T07:00:00Z/2026-10-24T06:00:00Z/P1D'))) && threw(() => D.scalarTimes('wave', tHours)), 'sea temperature and saltiness: the 48 hours are read from their own layer and not a sibling, an unreadable step and an unknown layer are refused')
    const tNow = Date.parse('2026-10-22T12:40:00Z')
    report(D.scalarHour(tTimes, null, tNow) === '2026-10-22T12:00:00Z' && D.scalarHour(tTimes, null, Date.parse('2026-10-20T00:00:00Z')) === tTimes[0] && D.scalarHour(tTimes, null, Date.parse('2026-10-30T00:00:00Z')) === tTimes.at(-1), 'sea temperature and saltiness: with no sea currents the hour shown is the latest hour not after now (the first hour on offer before the range, the last after it)')
    report(D.scalarHour(tTimes, '2026-10-22T18:00:00Z', tNow) === '2026-10-22T18:00:00Z' && D.scalarHour(tTimes, '2026-10-21T19:00:00Z', tNow) === tTimes[0] && D.scalarHour(tTimes, '2026-10-22T18:20:00Z', tNow) === '2026-10-22T18:00:00Z' && D.nearestHour(tTimes, '2026-10-22T08:30:00Z') === '2026-10-22T08:00:00Z' && threw(() => D.nearestHour([], '2026-10-22T08:00:00Z')) && threw(() => D.nearestHour(tTimes, 'soon')), 'sea temperature and saltiness: with the sea currents on, the hour shown is the hour of the currents (the nearest one on offer when the currents have an hour this layer lacks)')
    report(D.scalarCapabilitiesUrl('temperature').includes('LAYER=CIOPS-SalishSea_500m_SeaWaterPotentialTemp_0.5m') && !D.scalarCapabilitiesUrl('salinity').includes('LAYERS=') && D.scalarCapabilitiesUrl('salinity').includes('LAYER=CIOPS-SalishSea_500m_SeaWaterSalinity_0.5m'), 'sea temperature and saltiness: the hours are asked for with the layer-specific description (a few KB, not the whole service)')
    const tu = D.scalarUrl('temperature', '2026-10-22T13:00:00Z'), su = D.scalarUrl('salinity', '2026-10-22T13:00:00Z'), cuX = D.currentsUrl('X', '2026-10-22T13:00:00Z')
    report(tu.startsWith('https://geo.weather.gc.ca/geomet?') && tu.includes('request=GetCoverage') && tu.includes('coverageid=CIOPS-SalishSea_500m_SeaWaterPotentialTemp_0.5m') && su.includes('coverageid=CIOPS-SalishSea_500m_SeaWaterSalinity_0.5m') && tu.includes('format=image%2Ftiff') && tu.includes('scalefactor=0.5') && tu.includes('subset=x%28-124.5%2C-122.6%29') && tu.includes('subset=y%2847.8%2C49.2%29') && tu.includes('time=2026-10-22T13%3A00%3A00Z') && tu.replace(/coverageid=[^&]*/, '') === cuX.replace(/coverageid=[^&]*/, '') && threw(() => D.scalarUrl('temperature', 'soon')) && threw(() => D.scalarUrl('wind', '2026-10-22T13:00:00Z')), 'sea temperature and saltiness: an hour is one coverage request, the same box and size as a component of the sea currents (so it goes through the same reader), and a bad hour or layer is refused')
    // The numbers: a grid of 0.1 degree cells over the box of the currents (west -124.5, north 49.2), with land, a fill value and nothing as the three ways land is marked.
    const SC = { w: 19, h: 14, scale: [0.1, 0.1], tie: [-124.5, 49.2], rows: 7 }
    const cellAt = (f) => Array.from({ length: SC.w * SC.h }, (_, i) => f(i % SC.w, Math.floor(i / SC.w)))
    const tempTiff = (f) => D.readGeoTiff(tiff({ ...SC, values: cellAt(f) }))
    const gT = D.scalarGrid('temperature', tempTiff((x, y) => (x < 3 ? [0, 1e20, NaN, 0][y % 4] : 284.65 + x * 0.1)))
    report(gT.kind === 'temperature' && Math.abs(gT.v[5] - (284.65 + 0.5 - 273.15)) < 1e-4 && gT.sea[5] === 1 && gT.sea[0] === 0 && gT.sea[1] === 0 && gT.sea[SC.w] === 0 && gT.sea[SC.w * 2] === 0 && [...gT.sea].filter(Boolean).length === 16 * 14 && gT.width === 19 && gT.height === 14 && D.scalarGrid('temperature', tempTiff(() => 249.9 + 0.2)).sea[0] === 1 && threw(() => D.scalarGrid('temperature', tempTiff(() => 249))) && threw(() => D.scalarGrid('temperature', tempTiff(() => 331))), 'sea temperature: kelvin becomes degrees Celsius, zero (land), a fill value and NaN are no data, and values outside 250 to 330 kelvin are not believed', JSON.stringify([gT.v[5], [...gT.sea].filter(Boolean).length]))
    const gS = D.scalarGrid('salinity', tempTiff((x) => (x === 0 ? 0 : x === 1 ? 46 : x === 2 ? -1 : 29.9)))
    report(Math.abs(gS.v[5] - 29.9) < 1e-4 && gS.sea[5] === 1 && gS.sea[0] === 0 && gS.sea[1] === 0 && gS.sea[2] === 0 && [...gS.sea].filter(Boolean).length === 16 * 14, 'sea saltiness: the numbers are psu as they come, and zero, a number above 45 and a negative one are no data', JSON.stringify([...gS.sea].filter(Boolean).length))
    const small = D.readGeoTiff(tiff({ w: 5, h: 5, values: Array(25).fill(284), scale: [0.1, 0.1], tie: [-124.5, 49.2], rows: 5 }))
    report(threw(() => D.scalarGrid('temperature', small)) && threw(() => D.scalarGrid('salinity', tempTiff((x, y) => (x === 0 && y === 0 ? 30 : 0)))) && threw(() => D.scalarGrid('wind', tempTiff(() => 1))), 'sea temperature and saltiness: a grid that does not cover the map area (a picture would land in the wrong place), a grid with hardly any sea and a wrong layer are refused')
    const gA = D.scalarGrid('temperature', tempTiff((x) => (x === 10 ? 284.15 : x === 11 ? 285.15 : 0 + (x < 10 ? 283.15 : 286.15)))) // 10, 11 degrees at columns 10 and 11
    const lngOf = (col) => -124.5 + (col + 0.5) * 0.1, latOf = (row) => 49.2 - (row + 0.5) * 0.1
    const close = (a, b) => Math.abs(a - b) < 1e-4
    report(close(D.scalarAt(gA, lngOf(10), latOf(3)), 11) && close(D.scalarAt(gA, lngOf(11), latOf(3)), 12) && close(D.scalarAt(gA, (lngOf(10) + lngOf(11)) / 2, latOf(3)), 11.5) && D.scalarAt(gA, -130, 48.5) === null && D.scalarAt(gT, lngOf(0), latOf(2)) === null && D.scalarAt(gT, lngOf(5), latOf(2)) !== null, 'sea temperature and saltiness readout: the value at a place is read between the cell centres of the grid, there is none on land or outside it', JSON.stringify([D.scalarAt(gA, lngOf(10), latOf(3)), D.scalarAt(gA, (lngOf(10) + lngOf(11)) / 2, latOf(3))]))
    report(D.scalarText('temperature', 11.51406) === '11.5 °C' && D.scalarText('salinity', 29.919922) === '29.9 psu' && D.scalarText('temperature', 9.04) === '9.0 °C' && threw(() => D.scalarText('salinity', NaN)), 'sea temperature and saltiness readout: one decimal, in °C or psu')

    // The colours: a ramp for each, in CIELAB, the same for every hour.
    const dE = (a, b) => { const p = D.rgbToLab(a), q = D.rgbToLab(b); return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) }
    const rt = (v) => D.rampColour('temperature', v), rsal = (v) => D.rampColour('salinity', v)
    report(sameValues(rt(6), [47, 54, 148]) && sameValues(rt(20), [214, 60, 52]) && sameValues(rt(-5), rt(6)) && sameValues(rt(40), rt(20)) && sameValues(rsal(20), [247, 236, 168]) && sameValues(rsal(34), [66, 38, 120]) && sameValues(rsal(0), rsal(20)) && sameValues(rsal(60), rsal(34)) && threw(() => rt(NaN)) && threw(() => D.rampColour('wind', 1)) && D.SCALE_TICKS.temperature.join() === '6,8,10,12,14,16,18,20' && D.SCALE_TICKS.salinity.join() === '20,22,24,26,28,30,32,34' && D.SCALE_RANGE.temperature.join() === '6,20' && D.SCALE_RANGE.salinity.join() === '20,34', 'sea temperature and saltiness colours: the ramps run from 6 to 20 °C and 20 to 34 psu, stand at their end colours beyond them, refuse a bad value, and have the ticks of their keys')
    // Equal steps in value look about equally different, so there are no bands (a jump) and no dead stretch (no change) in either ramp.
    const quarter = (kind) => { const [lo, hi] = D.SCALE_RANGE[kind], out = []; for (let v = lo; v < hi - 1e-9; v += 0.25) out.push(dE(D.rampColour(kind, v), D.rampColour(kind, v + 0.25))); return out }
    const qT = quarter('temperature'), qS = quarter('salinity')
    report(Math.min(...qT, ...qS) > 0.8 && Math.max(...qT, ...qS) < 8 && Math.max(...qT) / Math.min(...qT) < 4 && qT.length === 56 && qS.length === 56, 'sea temperature and saltiness colours: every quarter step along either ramp changes the colour gently (between 0.8 and 8 units of CIELAB) and by a similar amount all the way, with no band and no dead stretch', JSON.stringify([Math.min(...qT), Math.max(...qT), Math.min(...qS), Math.max(...qS)].map((x) => +x.toFixed(2))))
    // The reason for the change: ECCC's picture spanned 30 degrees and made 9 to 13 one band of green. Here each whole degree of that range is a clearly different colour.
    const degrees = [9, 10, 11, 12, 13].slice(1).map((v, i) => dE(rt(9 + i), rt(v)))
    report(Math.min(...degrees) > 15 && dE(rt(9), rt(13)) > 60, 'sea temperature colours: each whole degree from 9 to 13 °C is a clearly different colour (at least 15 units of CIELAB apart, 9 and 13 more than 60), where the service\'s own picture made the whole range one band of green', JSON.stringify(degrees.map((x) => +x.toFixed(1))))
    const Ls = []; for (let v = 20; v <= 34 + 1e-9; v += 0.5) Ls.push(D.rgbToLab(rsal(v))[0])
    report(Ls.every((l, i) => i === 0 || l < Ls[i - 1]) && Ls[0] > 85 && Ls.at(-1) < 30, 'sea saltiness colours: the ramp gets darker with every step, from pale (fresh) to deep (salty), so more salt always reads as darker')
    const lutT = D.rampLut('temperature'), lutS = D.rampLut('salinity')
    const lutOk = (lut, kind) => { const [lo, hi] = D.SCALE_RANGE[kind]; let worst = 0; for (let i = 0; i < D.RAMP_STEPS; i++) { const want = D.rampColour(kind, lo + (hi - lo) * i / (D.RAMP_STEPS - 1)); worst = Math.max(worst, ...want.map((c, k) => Math.abs(c - lut[i * 3 + k]))) } return worst === 0 && lut.length === D.RAMP_STEPS * 3 }
    report(lutOk(lutT, 'temperature') && lutOk(lutS, 'salinity') && D.rampLut('temperature') === lutT, 'sea temperature and saltiness colours: the 1,024 colours used to paint the picture are the ramp itself, made once')
    const gradT = D.rampGradient('temperature'), gradS = D.rampGradient('salinity')
    const stopsOf = (g) => [...g.matchAll(/rgb\((\d+), (\d+), (\d+)\) ([\d.]+)%/g)].map((m) => [[+m[1], +m[2], +m[3]], +m[4]])
    const stT = stopsOf(gradT), stS = stopsOf(gradS)
    report(stT.length === 29 && stS.length === 29 && stT[0][1] === 0 && stT.at(-1)[1] === 100 && sameValues(stT[0][0], rt(6)) && sameValues(stT.at(-1)[0], rt(20)) && stT.every(([c, at], i) => sameValues(c, rt(6 + i * 0.5)) && Math.abs(at - i / 28 * 100) < 0.06) && stS.every(([c, at], i) => sameValues(c, rsal(20 + i * 0.5)) && Math.abs(at - i / 28 * 100) < 0.06) && gradT.startsWith('linear-gradient(to right, ') && !/NaN|undefined/.test(gradT + gradS) && [['temperature', stT, 6], ['salinity', stS, 20]].every(([kind, st, from]) => st.slice(1).every(([c, ], i) => { const mid = D.rampColour(kind, from + i * 0.5 + 0.25), lerp = st[i][0].map((x, k) => (x + c[k]) / 2); return mid.every((x, k) => Math.abs(x - lerp[k]) <= 2) })), 'sea temperature and saltiness keys: the bar under each box is the ramp, a stop every half degree or psu (29), each the ramp\'s own colour at its place from the first value to the last, and between two stops the browser\'s straight-line mix is within 2 of the ramp in each channel')
    // The picture: a grid over the map area, painted in web Mercator. Row 0 is the north. Land and the cells beyond the coast are clear, and the coast is feathered.
    const pgeo = D.radarGeometry(), PW = 200, PH = Math.round(PW * pgeo.height / pgeo.width)
    const SG = { w: 19, h: 14, scale: [0.1, 0.1], tie: [-124.5, 49.2], rows: 7 }
    const grid2 = (f) => D.scalarGrid('temperature', D.readGeoTiff(tiff({ ...SG, values: Array.from({ length: SG.w * SG.h }, (_, i) => f(i % SG.w, Math.floor(i / SG.w))) })))
    const pix = (pic, x, y) => [...pic.slice((y * PW + x) * 4, (y * PW + x) * 4 + 4)]
    const flatPic = D.scalarPicture(grid2(() => 284.15), pgeo, PW, PH) // 11 degrees everywhere
    const lutNear = (c, kind, v) => { const want = D.rampColour(kind, v); return c.slice(0, 3).every((x, k) => Math.abs(x - want[k]) <= 1) }
    report(pix(flatPic, 100, 100)[3] === 255 && lutNear(pix(flatPic, 100, 100), 'temperature', 11) && lutNear(pix(flatPic, 3, 3), 'temperature', 11) && flatPic.length === PW * PH * 4, 'sea temperature picture: sea at 11 °C is painted in the ramp\'s colour for 11 and fully opaque, and the picture is the size asked for', JSON.stringify(pix(flatPic, 100, 100)))
    const slope = D.scalarPicture(grid2((x, y) => 273.15 + 8 + x * 0.5 - y * 0.1), pgeo, PW, PH) // warmer to the east (0.5 a column), cooler to the south
    const lngAt = (px) => ((px + 0.5) / PW * (pgeo.bbox[2] - pgeo.bbox[0]) + pgeo.bbox[0]) / 20037508.34 * 180
    const latAtPx = (py) => (2 * Math.atan(Math.exp((pgeo.bbox[3] - (py + 0.5) / PH * (pgeo.bbox[3] - pgeo.bbox[1])) / 20037508.34 * Math.PI)) - Math.PI / 2) * 180 / Math.PI
    const want = (px, py) => { const lng = lngAt(px), lat = latAtPx(py), cx = (lng + 124.5) / 0.1 - 0.5, cy = (49.2 - lat) / 0.1 - 0.5; return 8 + cx * 0.5 - cy * 0.1 }
    const spots = [[40, 60], [100, 100], [160, 150], [60, 200], [150, 40]]
    report(spots.every(([x, y]) => lutNear(pix(slope, x, y), 'temperature', want(x, y))) && pix(slope, 150, 40)[0] !== pix(slope, 40, 40)[0] && pix(slope, 100, 30)[1] !== pix(slope, 100, 220)[1], 'sea temperature picture: every pixel has the ramp colour of the value at its own place (east is warmer and the north is the top row), not a blend of colours', JSON.stringify(spots.map(([x, y]) => [+want(x, y).toFixed(2), pix(slope, x, y).join()])))
    const coast = D.scalarPicture(grid2((x) => (x < 9 ? 0 : 284.15)), pgeo, PW, PH) // land in the west half of the grid
    const row = (y) => Array.from({ length: PW }, (_, x) => pix(coast, x, y)[3])
    const alphas = row(100), edge = alphas.findIndex((a) => a > 0), full = alphas.findIndex((a) => a === 255)
    report(alphas.slice(0, edge).every((a) => a === 0) && edge > 0 && full > edge && full - edge >= 3 && alphas.slice(full).every((a) => a === 255) && alphas.slice(edge, full + 1).every((a, i, all) => i === 0 || a >= all[i - 1]), 'sea temperature picture: land is clear, the sea is opaque, and between them the coast is feathered over a few pixels, never a staircase of cells', JSON.stringify([edge, full]))
    const t0 = performance.now(); D.scalarPicture(grid2((x) => 284 + x * 0.1), pgeo, 480, 511); const took = performance.now() - t0
    report(took < 400, 'sea temperature picture: a 480 x 511 picture is made from a grid in well under half a second (the machine here is slower than a phone is likely to be, and busy)', `${took.toFixed(0)} ms`)

    // tides and tidal currents (NOAA CO-OPS predictions)
    const tNowMs = Date.parse('2026-10-22T12:00:00Z')
    report(D.TIDE_STATIONS.map((x) => x.id).join(',') === '9444090,9449880,PUG1640,PUG1636,PUG1718,PCT1391,PCT1416,07120' && new Set(D.TIDE_STATIONS.map((x) => x.id)).size === 8 && D.TIDE_STATIONS.filter((x) => x.kind === 'level').length === 3 && D.TIDE_STATIONS.filter((x) => x.source === 'chs').map((x) => x.id).join() === '07120' && D.TIDE_STATIONS.every((x) => D.REGION[0] <= x.coords[0] && x.coords[0] <= D.REGION[2] && D.REGION[1] <= x.coords[1] && x.coords[1] <= D.REGION[3] && x.name && x.short) && D.tideFeatures().features.length === 8 && D.tideFeatures().features.every((f) => f.geometry.type === 'Point' && f.properties.id && f.properties.short) && D.tideStation('PCT1416').series === false && D.tideStation('PCT1391').series === false && D.tideStation('PUG1718').series === true && D.tideStation('nope') === null, 'tides: three water level stations (Port Angeles and Friday Harbor from NOAA, Victoria Harbour from the Canadian Hydrographic Service) and five current stations (Race Rocks, Discovery Island, Haro Strait, Trial Island, Cattle Point), each with a name and a place inside the map; the two that give only slack and maximum times have no series')
    const lvl = D.tideStation('9444090'), cur = D.tideStation('PUG1640'), sub = D.tideStation('PCT1416')
    const lu = D.tideUrls(lvl, tNowMs), cu2 = D.tideUrls(cur, tNowMs), su2 = D.tideUrls(sub, tNowMs)
    const all = [lu.events, lu.series, cu2.events, cu2.series, su2.events]
    report(all.every((u) => u.startsWith('https://api.tidesandcurrents.noaa.gov/api/prod/datagetter?') && u.includes('application=greater-victoria-map') && u.includes('format=json') && u.includes('time_zone=gmt') && u.includes('begin_date=20261022+04%3A00') && u.includes('end_date=20261023+18%3A00')) && lu.events.includes('product=predictions') && lu.events.includes('interval=hilo') && lu.events.includes('datum=MLLW') && lu.events.includes('units=metric') && lu.events.includes('station=9444090') && lu.series.includes('interval=30') && cu2.events.includes('product=currents_predictions') && cu2.events.includes('interval=MAX_SLACK') && cu2.events.includes('units=english') && cu2.series.includes('interval=30') && su2.series === null && threw(() => D.tideUrls({ id: 'PUG1640; drop', kind: 'current' })) && threw(() => D.tideUrls(null)) && threw(() => D.tideUrls(D.tideStation('07120'))), 'tides: a request names NOAA, the application, UTC times from 8 hours before now to 30 hours after, the highs and lows or the slacks and maximums and, where NOAA gives one, a series every 30 minutes (none for a station that gives only events), and refuses an unknown station and the Canadian Hydrographic Service one')
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
    report(D.DEPTH_STOPS.every((p, i) => i === 0 || p[0] > D.DEPTH_STOPS[i - 1][0]) && dsLum.every((l, i) => i === 0 || l < dsLum[i - 1]) && D.DEPTH_STOPS[0][0] > D.DEPTH_FADE_FROM, 'seafloor: the ETOPO1 colours get darker with depth and begin below the depth where they fade in')

    // Canadian Hydrographic Service (CHS): the notices, the seafloor tiles (NONNA) and the Victoria Harbour gauge (IWLS)
    {
    report(D.IWLS_NOTICE === IWLS_NOTICE_TEXT && D.NONNA_NOTICE === NONNA_NOTICE_TEXT && D.CHS_USER === 'Darren Zal' && !/\[|insert/i.test(D.IWLS_NOTICE + D.NONNA_NOTICE) && D.IWLS_LICENCE_URL === IWLS_LICENCE_URL && D.NONNA_LICENCE_URL === NONNA_LICENCE_URL, 'CHS notices: both are the licences’ own words with the place for the name filled in as Darren Zal, with no placeholder left, and the licence addresses are the ones recorded')
    const ramp = (d) => D.scaleColour(D.NONNA_RAMP, d)
    const measured = [[0.25, [195, 5, 0]], [5.5, [195, 100, 0]], [9.5, [194, 182, 0]], [12.5, [94, 195, 0]], [14.5, [25, 195, 0]], [16.5, [0, 185, 19]], [21, [3, 158, 76]], [29, [9, 103, 190]], [45, [8, 94, 187]], [87.5, [1, 64, 156]]] // the median colour of the service's picture for depths in a bin around each number (its own depth grid said so), 2026-10-22
    const dec = measured.map(([d, c]) => [d, D.nonnaDepth(...c)])
    report(dec.every(([d, got]) => (d < 1 ? got != null && got < 1.2 : got != null && Math.abs(got - d) <= (d < 25 ? 0.5 : 3.5))), 'seafloor (CHS): a colour of the service’s picture is read back to metres, to half a metre down to 25 m and to 3.5 m to 90 m, at the places where its own depth grid and picture were compared', JSON.stringify(dec))
    const trip = [1.5, 3, 7, 12, 18, 25, 40, 75, 150, 250].map((d) => [d, D.nonnaDepth(...ramp(d))])
    report(trip.every(([d, got]) => got != null && Math.abs(got - d) <= (d <= 30 ? 0.3 : d <= 100 ? 1.5 : 20)) && D.nonnaDepth(...ramp(0)) < 0.5 && D.nonnaDepth(...ramp(1000)) > 950, 'seafloor (CHS): the ramp read back gives the depth it was made from (the colours are whole numbers, so the deep end is only good to about 20 m: one step of colour there is 16 to 21 m)', JSON.stringify(trip))
    const landColours = [[148, 83, 0], [160, 50, 0], [173, 32, 0], [186, 23, 0]]
    report(landColours.every((c) => D.nonnaDepth(...c) === null) && D.nonnaDepth(255, 255, 255) === null && D.nonnaDepth(0, 0, 0) === null && D.nonnaDepth(128, 128, 128) === null && D.nonnaDepth(200, 0, 200) === null, 'seafloor (CHS): the browns the service draws for land and heights above chart datum, and white, black, grey and purple, are not a depth')
    const ns = D.NONNA_STOPS
    report(ns.every((p, i) => i === 0 || p[0] > ns[i - 1][0]) && ns.map((p) => lum(p[1])).every((l, i, a) => i === 0 || l < a[i - 1]) && ns[0][0] === D.NONNA_MIN_DEPTH && ns.slice(2).every((p, i) => p[0] === D.DEPTH_STOPS[i][0] && sameValues(p[1], D.DEPTH_STOPS[i][1])) && sameValues(D.nonnaColour(25), D.DEPTH_STOPS[0][1]) && sameValues(D.nonnaColour(300), D.DEPTH_STOPS.at(-1)[1]) && sameValues(D.nonnaColour(1000), D.DEPTH_STOPS.at(-1)[1]) && sameValues(D.nonnaColour(0.5), ns[0][1]), 'seafloor (CHS): the key has the same colours as the ETOPO1 colours from 25 m down, two pale stops above them (1 m and 10 m), and gets darker with depth, so the two sources read as one layer with one key')
    const sea = [194, 200, 202], seaLum = lum(sea)
    report(ns.every((p) => lum(D.nonnaColour(p[0]).map((v, k) => Math.round(v * 0.75 + sea[k] * 0.25))) < seaLum) && ns.every((p) => { const c = D.nonnaColour(p[0]).map((v, k) => Math.round(v * 0.75 + sea[k] * 0.25)); return Math.max(...c.map((v, k) => Math.abs(v - sea[k]))) > 12 && c[2] >= c[0] }), 'seafloor (CHS): at the layer’s opacity every colour of the key is darker and bluer than the basemap’s sea, by more than 12 of 255 in some channel, so a coloured place never reads as lighter than an uncoloured one')
    report(sameValues(D.nonnaGradient(0, 300).match(/rgb\(\d+, \d+, \d+\) [\d.]+%/g).map((x) => x.replace(/^rgb\([^)]*\) /, '')), ['0%', '0.3%', '3.3%', '8.3%', '16.7%', '33.3%', '66.7%', '100%']) && D.NONNA_TICKS.join() === '10,50,100,200,300' && D.NONNA_TICKS.every((t) => D.NONNA_STOPS.some((p) => p[0] === t)), 'seafloor (CHS): the key runs from 0 to 300 m with a stop at each colour, and the numbers under it are depths that have a colour')
    const px = (...cs) => new Uint8ClampedArray(cs.flatMap(([r, g, b, a = 255]) => [r, g, b, a]))
    const tile = px([195, 97, 0], [195, 0, 0], [194, 194, 0, 254], [0, 56, 149], [148, 83, 0], [195, 97, 0, 0], [9, 102, 195], [255, 255, 255])
    const cache = new Map(), n = D.nonnaPaint(tile, sea, 0.75, cache, 4)
    const want = (d) => D.nonnaColour(d).map((v, k) => Math.round(v * 0.75 + sea[k] * 0.25))
    const at = (i) => [...tile.slice(i * 4, i * 4 + 4)]
    report(n === 4 && sameValues(at(0).slice(0, 3), want(D.nonnaDepth(195, 97, 0))) && at(0)[3] === 255 && at(1)[3] === 0 && sameValues(at(2).slice(0, 3), want(D.nonnaDepth(194, 194, 0))) && at(2)[3] === 255 && sameValues(at(3).slice(0, 3), want(D.nonnaDepth(0, 56, 149))) && at(4)[3] === 0 && at(5)[3] === 0 && at(6)[3] === 255 && at(7)[3] === 0 && cache.size === 7 && threw(() => D.nonnaPaint(new Uint8ClampedArray(7), sea, 0.75)) && threw(() => D.nonnaPaint(tile, [1, 2], 0.75, new Map(), 4)) && threw(() => D.nonnaPaint(tile, sea, 0, new Map(), 4)) && threw(() => D.nonnaPaint(tile, sea, 1.5, new Map(), 4)), 'seafloor (CHS): a tile is painted again in place: a depth becomes the key’s colour mixed with the sea at the opacity and made opaque, 0 m, land, an empty pixel and white become clear, a pixel at alpha 254 counts as drawn, and a bad tile, sea colour or opacity is refused')
    // The hairline where two of the service's 0.1 degree sheets meet (a column or row with no data) is filled, and wider gaps are not
    const D1 = [0, 0, 150], row = (gaps) => px(...Array.from({ length: 12 }, (_, x) => (gaps.includes(x) ? [0, 0, 0, 0] : [10 + x, 60, 150])))
    const gap1 = row([5]), gap2 = row([5, 6]), gap3 = row([5, 6, 7]), f1 = D.nonnaFill(gap1, 12), f2 = D.nonnaFill(gap2, 12), f3 = D.nonnaFill(gap3, 12)
    const pr = (a, x) => [...a.slice(x * 4, x * 4 + 4)]
    report(f1 === 1 && sameValues(pr(gap1, 5), [14, 60, 150, 255]) && f2 === 2 && sameValues(pr(gap2, 6), [14, 60, 150, 255]) && f3 === 0 && pr(gap3, 6)[3] === 0, 'seafloor (CHS): a column of no data one or two pixels wide between two drawn pixels is filled from the one before it, and a gap of three is left', JSON.stringify([f1, f2, f3]))
    const col = px(...Array.from({ length: 12 }, (_, i) => (i >= 3 && i <= 5 ? [0, 0, 0, 0] : [10, 60 + i, 150])))
    const f5 = D.nonnaFill(col, 3) // 3 pixels across, 4 rows: row 1 is empty and has data above and below
    report(f5 === 3 && pr(col, 3).join() === '10,60,150,255' && pr(col, 4).join() === '10,61,150,255' && pr(col, 5).join() === '10,62,150,255' && threw(() => D.nonnaFill(col, 5)) && threw(() => D.nonnaFill(new Uint8ClampedArray(7), 1)) && threw(() => D.nonnaFill(col, 0)), 'seafloor (CHS): a row with no data between two rows that have it is filled too, and a width that does not fit the tile is refused')
    // A hairline on the very edge of a tile (its other side is in the next tile) is filled from the line inside it, if the whole line is empty
    const wide = (w, h, fn) => px(...Array.from({ length: w * h }, (_, i) => fn(i % w, Math.floor(i / w))))
    const topGap = wide(6, 6, (x, y) => (y === 0 ? [0, 0, 0, 0] : [20, 60 + y, 150])), top2 = wide(6, 6, (x, y) => (y < 2 ? [0, 0, 0, 0] : [20, 60 + y, 150])), top3 = wide(6, 6, (x, y) => (y < 3 ? [0, 0, 0, 0] : [20, 60 + y, 150]))
    const leftGap = wide(6, 6, (x, y) => (x === 0 ? [0, 0, 0, 0] : [20 + x, 60, 150])), rightGap = wide(6, 6, (x, y) => (x === 5 ? [0, 0, 0, 0] : [20 + x, 60, 150])), bottomGap = wide(6, 6, (x, y) => (y === 5 ? [0, 0, 0, 0] : [20, 60 + y, 150]))
    const halfGap = wide(6, 6, (x, y) => (y === 0 || (y === 1 && x < 4) ? [0, 0, 0, 0] : [20, 60 + y, 150])), landTop = wide(6, 6, (x, y) => (y < 4 ? [0, 0, 0, 0] : [20, 60, 150]))
    const e = [topGap, top2, top3, leftGap, rightGap, bottomGap, halfGap, landTop].map((t) => D.nonnaFill(t, 6))
    const at6 = (t, x, y) => [...t.slice((y * 6 + x) * 4, (y * 6 + x) * 4 + 4)].join()
    report(e[0] === 6 && at6(topGap, 3, 0) === '20,61,150,255' && e[1] === 12 && at6(top2, 3, 0) === '20,62,150,255' && at6(top2, 3, 1) === '20,62,150,255' && e[2] === 0 && at6(top3, 3, 0) === '0,0,0,0' && e[3] === 6 && at6(leftGap, 0, 3) === '21,60,150,255' && e[4] === 6 && at6(rightGap, 5, 2) === '24,60,150,255' && e[5] === 6 && at6(bottomGap, 2, 5) === '20,64,150,255' && e[6] === 0 && at6(halfGap, 5, 0) === '0,0,0,0' && e[7] === 0 && at6(landTop, 2, 3) === '0,0,0,0', 'seafloor (CHS): a hairline of one or two lines along the edge of a tile is filled from the line inside it, but three lines are left, and so are an edge with data in it, a row whose line inside it is mostly empty and the land at the top of a tile', JSON.stringify(e))
    report(D.nonnaTileUrl(100, 11, 707, 321) === 'https://nonna-geoserver.data.chs-shc.ca/geoserver/gwc/service/wmts/rest/nonna:NONNA%20100/raster/EPSG:900913/EPSG:900913:11/321/707?format=image/png' && D.nonnaTileUrl(10, 14, 2, 3).includes('nonna:NONNA%2010/raster/EPSG:900913/EPSG:900913:14/3/2?') && threw(() => D.nonnaTileUrl(50, 1, 1, 1)) && threw(() => D.nonnaTileUrl(100, -1, 0, 0)) && threw(() => D.nonnaTileUrl(100, 1.5, 0, 0)) && threw(() => D.nonnaTileUrl(100, 1, '1/../2', 0)) && D.NONNA_CLOSE_ZOOM === 11 && D.NONNA_MAX_ZOOM[100] === 11 && D.NONNA_MAX_ZOOM[10] === 14, 'seafloor (CHS): a tile address names the service’s standard Web Mercator grid with the row before the column, asks for the 100 m layer up to tile zoom 11 and the 10 m layer to 14, and refuses a layer, zoom, row or column it does not know')
    // The Victoria Harbour gauge
    const gauge = D.tideStation('07120'), iNow = Date.parse('2026-10-22T18:10:00Z')
    const iu = D.iwlsUrls(gauge, iNow)
    const decoded = (u) => new URL(u).searchParams
    report(Object.values(iu).every((u) => u.startsWith('https://api-iwls.dfo-mpo.gc.ca/api/v1/stations/5cebf1df3d0f4a073c4bbd1e/data?')) && decoded(iu.hilo).get('time-series-code') === 'wlp-hilo' && decoded(iu.hilo).get('from') === '2026-10-22T18:10:00Z' && decoded(iu.hilo).get('to') === '2026-10-24T00:10:00Z' && !decoded(iu.hilo).has('resolution') && decoded(iu.observed).get('time-series-code') === 'wlo' && decoded(iu.observed).get('from') === '2026-10-22T15:10:00Z' && decoded(iu.observed).get('to') === '2026-10-22T18:10:00Z' && decoded(iu.observed).get('resolution') === 'FIVE_MINUTES' && decoded(iu.predicted).get('time-series-code') === 'wlp' && decoded(iu.predicted).get('from') === '2026-10-22T15:10:00Z' && decoded(iu.predicted).get('to') === '2026-10-23T15:10:00Z' && decoded(iu.predicted).get('resolution') === 'FIFTEEN_MINUTES' && Object.keys(iu).length === 3 && D.IWLS_SPACING_MS === 400 && threw(() => D.iwlsUrls(D.tideStation('9444090'), iNow)) && threw(() => D.iwlsUrls({ ...gauge, chsId: 'x; drop' }, iNow)) && threw(() => D.iwlsUrls(null)), 'gauge (CHS): a popup makes three requests, the highs and lows for the next 30 hours, the observed levels for the last 3 hours every 5 minutes and the predicted ones from 3 hours before to 21 after every 15 minutes, in UTC, spaced 400 ms apart, and only for this station')
    const row5 = (t, v, extra = {}) => ({ eventDate: t, qcFlagCode: '1', reviewed: false, timeSeriesId: 'x', value: v, ...extra })
    const iHilo = [row5('2026-10-22T20:38:00Z', 2.428), row5('2026-10-23T02:53:00Z', 1.594), row5('2026-10-23T08:28:00Z', 2.033), row5('2026-10-23T14:27:00Z', 1.483), row5('2026-10-23T20:44:00Z', 2.47)]
    const iPred = Array.from({ length: 96 }, (_, i) => row5(new Date(iNow - 3 * 3600e3 + i * 900e3).toISOString().slice(0, 19) + 'Z', 2 + 0.5 * Math.sin(i / 8), { qcFlagCode: '2' }))
    const iObs = Array.from({ length: 36 }, (_, i) => row5(new Date(iNow - 3 * 3600e3 + i * 300e3).toISOString().slice(0, 19) + 'Z', 1.6 + i * 0.02))
    const ng = D.normaliseIwls(gauge, iHilo, iPred, iObs)
    report(ng.kind === 'level' && ng.source === 'chs' && ng.events.map((e) => e.type).join() === 'high,low,high,low,high' && ng.events.every((e, i) => i === 0 || e.ms > ng.events[i - 1].ms) && near(ng.events[0].value, 2.428) && ng.events[0].ms === Date.UTC(2026, 9, 22, 20, 38) && ng.series.length === 96 && ng.observed.length === 36 && near(ng.latest.v, 1.6 + 35 * 0.02) && ng.latest.ms === iNow - 3 * 3600e3 + 35 * 300e3 && ng.latest.reviewed === false && D.tideNext(ng, iNow).high.ms === Date.UTC(2026, 9, 22, 20, 38) && D.tideNext(ng, iNow).low.ms === Date.UTC(2026, 9, 23, 2, 53), 'gauge (CHS): the replies are read to highs and lows told apart by their neighbours (a high stands above the one after it), a series of predicted levels, the observed levels and the newest of them with its time, all in metres above chart datum')
    const iOdd = [row5('2026-10-23T02:53:00Z', 1.594), row5('2026-10-22T20:38:00Z', 2.428), row5('2026-10-23T08:28:00Z', 2.033), row5('bad', 1), row5('2026-10-23T09:00:00Z', 99), row5('2026-10-23T10:00:00Z', 'x'), row5('2026-10-23T11:00:00Z', 1.2, { qcFlagCode: '3' })]
    const od = D.normaliseIwls(gauge, iOdd, null, null)
    const iObs2 = [...iObs.slice(0, 35), row5('2026-10-22T18:10:00Z', 5.5, { qcFlagCode: '3' })]
    // A flagged event is taken out after the highs and lows are told apart, not before: with the 2.4 m high dropped first, the 1.4 m after it would be read as a high
    const flagSeq = [row5('2026-10-23T02:00:00Z', 2.5), row5('2026-10-23T08:00:00Z', 1.2), row5('2026-10-23T14:00:00Z', 2.4, { qcFlagCode: '3' }), row5('2026-10-23T20:00:00Z', 1.4)]
    const fe = D.normaliseIwls(gauge, flagSeq).events
    report(fe.map((e) => `${e.type} ${e.value}`).join() === 'high 2.5,low 1.2,low 1.4' && fe.length === 3 && D.normaliseIwls(gauge, [...flagSeq].reverse()).events.map((e) => e.type).join() === 'high,low,low' && threw(() => D.normaliseIwls(gauge, [row5('2026-10-23T02:00:00Z', 2.5, { qcFlagCode: '3' }), row5('2026-10-23T08:00:00Z', 1.2, { qcFlagCode: '3' })])), 'gauge (CHS): highs and lows are told apart on the whole reply before a questionable reading is dropped (high 2.5, low 1.2, high 2.4 flagged, low 1.4 gives high, low, low and not high, low, high), and a reply of only questionable readings is refused')
    report(od.events.map((e) => e.type).join() === 'high,low,high' && od.events.length === 3 && od.series === null && od.observed.length === 0 && od.latest === null && D.normaliseIwls(gauge, iHilo, iPred.slice(0, 10), null).series === null && D.normaliseIwls(gauge, iHilo, 'no', {}).latest === null && D.normaliseIwls(gauge, iHilo, null, iObs2).latest.v === iObs[34].value && D.normaliseIwls(gauge, iHilo, null, iObs2).observed.length === 35 && threw(() => D.normaliseIwls(gauge, [])) && threw(() => D.normaliseIwls(gauge, null)) && threw(() => D.normaliseIwls(gauge, { error: 'x' })) && threw(() => D.normaliseIwls(gauge, [row5('2026-10-22T20:38:00Z', 2.4)])) && threw(() => D.normaliseIwls(D.tideStation('9444090'), iHilo)), 'gauge (CHS): replies in any order are put in time order, a reading with a bad time, no number, an impossible height or the questionable flag is dropped (so the newest reading shown is never a questionable one), predicted and observed levels are optional, and a reply with no highs and lows, with one only or for another station is refused')
    const gp = D.tideCurve(ng, iNow - 3 * 3600e3, iNow + 21 * 3600e3).points, ob = ng.observed.map((p) => ({ ms: p.ms, v: p.v + 3 }))
    const g1 = D.curveGeometry(gp, 'level', { from: iNow - 3 * 3600e3, to: iNow + 21 * 3600e3, now: iNow }), g2 = D.curveGeometry(gp, 'level', { from: iNow - 3 * 3600e3, to: iNow + 21 * 3600e3, now: iNow, scaleWith: ob })
    report(g2.max >= Math.max(...ob.map((p) => p.v)) && g2.max > g1.max && g2.min === g1.min && g1.d === D.curvePath(gp, g1) && D.curvePath(ob, g2).startsWith('M') && (D.curvePath(ob, g2).match(/L/g) || []).length === ob.length - 1 && g2.y(g2.max) < g2.y(g2.min) && !/NaN|undefined/.test(D.curvePath(ob, g2)), 'gauge (CHS): the observed levels are drawn on the same scale as the predicted ones (the scale takes in both), as a path of their own')
    }

    // marine life and protection
    report(D.tidyName('RACE ROCKS ECOLOGICAL RESERVE') === 'Race Rocks Ecological Reserve' && D.tidyName('SAYSUTSHUN (NEWCASTLE ISLAND MARINE) PARK') === 'Saysutshun (Newcastle Island Marine) Park' && D.tidyName('BAY OF FUNDY') === 'Bay of Fundy' && D.tidyName('Gulf Islands National Park Reserve Of Canada') === 'Gulf Islands National Park Reserve Of Canada' && D.tidyName('SANDHEADS (8 Dolphs)') === 'SANDHEADS (8 Dolphs)' && D.tidyName('  ') === null && D.tidyName(null) === null, 'marine layers: a name published in capitals is shown in capitals and small letters, a name with small letters already is left as published, and a blank name is none')
    const rr = D.protectedInfo({ name: 'RACE ROCKS ECOLOGICAL RESERVE', type: 'Ecological Reserve', owner: 'Government of British Columbia', year: 1980, no_take: 1 })
    const gs = D.protectedInfo({ name: 'GOLDSTREAM PARK', type: 'A - Park', owner: 'Government of British Columbia', year: 1958, no_take: null })
    const nt = (code) => D.protectedInfo({ name: 'X', type: 'Park', owner: 'Y', year: 2000, no_take: code }).lines.some((l) => /No-take/.test(l))
    report(rr.title === 'Race Rocks Ecological Reserve' && rr.tag === 'ecological reserve' && rr.lines.includes('Owner: Government of British Columbia.') && rr.lines.includes('Established 1980.') && rr.lines.includes('No-take, as reported to CPCAD: all of the area.') && rr.lines.includes(NO_TAKE_MEANING_TEXT) && gs.tag === 'park (class A)' && !gs.lines.some((l) => /No-take/.test(l)) && nt(1) && nt(2) && nt(3) && !nt(0) && !nt(4) && !nt(null) && rr.source.includes(OGL_CANADA_STATEMENT) && D.protectedInfo({}).title === 'Protected marine area' && !D.protectedInfo({ name: 'X', year: 0 }).lines.some((l) => /Established/.test(l)), 'protected marine areas: the popup gives name, type, owner, year and the no-take line only where CPCAD gives one, with the Open Government Licence statement', JSON.stringify(rr))
    const ntLines = (code) => D.protectedInfo({ name: 'X', type: 'Park', owner: 'Y', year: 2000, no_take: code }).lines
    report(ntLines(2).includes('No-take, as reported to CPCAD: part of the area.') && ntLines(2).includes(NO_TAKE_MEANING_TEXT) && ntLines(3).includes('No-take, as reported to CPCAD: none of the area.') && !ntLines(3).includes(NO_TAKE_MEANING_TEXT) && [0, 4, null, undefined].every((c) => !ntLines(c).some((l) => /no-take/i.test(l))), 'protected marine areas: no-take is worded as the CPCAD user manual defines it (all, part or none of the area, and what no-take means for all and part), and a code of not applicable, not reported or none at all says nothing')
    const srkwI = D.srkwInfo({ status: 'Final/Proposed' })
    report(srkwI.title === 'Southern Resident killer whale critical habitat' && srkwI.lines.includes(D.WHALE_RULES) && srkwI.lines.some((l) => /not a sighting/.test(l)) && srkwI.source.includes('For general guidance only') && srkwI.source.includes(OGL_CANADA_STATEMENT) && D.WHALE_RULES === WHALE_RULES_TEXT && D.WHALE_RULE_LINKS.map((l) => l.href).join() === WHALE_LINKS.join(), 'critical habitat: the popup says it is a boundary and not a sighting, gives the vessel distances word for word and the Open Government Licence statement, and "for general guidance only"')
    const rkwI = D.rkwInfo({ seasonal: 'June to October', score: 'H' }), rkwBare = D.rkwInfo({})
    report(rkwI.title === 'Southern Resident killer whale important area' && rkwI.lines.includes(D.WHALE_RULES) && rkwI.lines.includes('A mapped boundary, not a sighting. It does not show where the whales are now.') && rkwI.lines.includes('Experts drew it for June to October.') && rkwI.lines.includes('They rated its importance to this population as high.') && rkwI.lines.some((l) => /Drawn by hand on paper maps in 2009/.test(l) && /carries no added management/.test(l)) && rkwI.source.includes(OGL_CANADA_STATEMENT) && /Not for navigation/.test(rkwI.source) && !rkwBare.lines.some((l) => /Experts drew|rated/.test(l)) && rkwBare.lines.includes(D.WHALE_RULES), 'killer whale important area: the popup says it is a boundary and not a sighting, that experts drew it by hand for June to October and rated it high, that it carries no added management, gives the vessel distances and the Open Government Licence statement, and says nothing about a season or a rating the record lacks')
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
    report(D.marineMessage('kelp', new Array(1118).fill({})) === '1,118 kelp beds.' && D.marineMessage('kelp', [{}]) === '1 kelp bed.' && D.marineMessage('eelgrass', [{ properties: { year: 1998 } }]).includes('mapped in 1998') && D.marineMessage('herring', [{ properties: { first_year: 1937, last_year: 1986 } }, { properties: { first_year: 1950, last_year: 1966 } }]).includes('between 1937 and 1986') && /^81 seabird colonies/.test(D.marineMessage('seabirds', new Array(81).fill({}))) && /^22 marine zones of protected areas/.test(D.marineMessage('protected', new Array(22).fill({}))) && D.marineMessage('srkw', [{}]) === 'Shown for the area this map reaches.' && D.marineMessage('rkw', [{}]) === 'Shown for the area this map reaches.' && threw(() => D.marineMessage('orcas', [])), 'marine layers: the status line gives the count with a thousands separator and the years found in the data, and leaves the reading notes to the notes')
    report(Object.keys(D.MARINE_FILES).join() === 'protected,srkw,cetaceans,kelp,eelgrass,herring,seabirds,rkw' && Object.values(D.MARINE_FILES).every((v) => /^data\/[a-z-]+\.geojson$/.test(v)) && Object.values(D.MARINE_FILES).map((v) => v.slice(5, -8)).join() === MARINE_FILES.join(), 'marine layers: eight data files, each a relative path in data/, the same files this check looks at')
    const plain = [D.WHALE_RULES, ...D.WHALE_RULE_LINKS.map((l) => l.label), ci, cd, ch, ki, kn, ei, hi, hn, si, rr, gs, srkwI, D.rkwInfo({ seasonal: 'June to October', score: 'H' })].flatMap((x) => (typeof x === 'string' ? [x] : [x.title, x.tag, x.source, ...(x.lines || [])].filter(Boolean)))
    report(ruleMarinePlain(plain).length === 0 && ruleMarinePlain([D.marineMessage('kelp', [{}]), D.marineMessage('herring', []), D.marineMessage('seabirds', []), D.marineMessage('protected', []), D.marineMessage('srkw', []), D.marineMessage('eelgrass', [])]).length === 0, 'marine layers: the text of every popup and status line has no em dash and no semicolon', ruleMarinePlain(plain).join(' | '))

    {
    // ---- change over time (js/time-data.js): the steps of the time line, which picture a year shows, and the text
    const ts = T.step
    const tAxis = T.timeAxis([[ts(1932), ts(1950)], [ts(1950), ts(1951), ts(1994, '1994-95')], [ts(1994)]])
    const tOnly = T.timeAxis([[ts(1994, '1994-95'), ts(2002)]])
    report(tAxis.map((s) => s.t).join() === '1932,1950,1951,1994' && tAxis.map((s) => s.label).join() === '1932,1950,1951,1994' && tOnly.map((s) => s.label).join() === '1994-95,2002' && T.timeAxis([]).length === 0 && threw(() => T.timeAxis([[{ t: 'x' }]])) && threw(() => T.step(NaN)), 'time line: the steps of every layer that is on, once each and in order of year, keep a layer’s own label ("1994-95") unless layers say the year differently, and a step without a year is refused')
    report(T.axisIndex(tAxis, 1950) === 1 && T.axisIndex(tAxis, 1970) === 2 && T.axisIndex(tAxis, 1900) === 0 && T.axisIndex([], 1950) === -1, 'time line: a year finds its own step, or the last step before it, or the first')
    const tEv = [ts(1951), ts(1953)], tSnap = [ts(1932), ts(1950)], tCum = [ts(2001), ts(2002), ts(2003)]
    report(T.frameAt(tEv, 'event', 1951)?.t === 1951 && T.frameAt(tEv, 'event', 1952) === null && T.frameAt(tSnap, 'snapshot', 1949)?.t === 1932 && T.frameAt(tSnap, 'snapshot', 1990)?.t === 1950 && T.frameAt(tSnap, 'snapshot', 1920) === null && T.frameAt(tCum, 'cumulative', 2002)?.t === 2002 && T.frameAt(tCum, 'cumulative', 1990) === null && threw(() => T.frameAt(tEv, 'forecast', 1951)), 'time line: an event layer shows tOnly its own year, a snapshot the latest picture in or before the year and nothing before its first, a cumulative layer everything up to the year, and an unknown kind is refused')
    report(T.snapshotLine('Air photo', tSnap, tSnap[1], 1950) === 'Air photo: 1950.' && T.snapshotLine('Air photo', tSnap, tSnap[1], 1967) === 'Air photo: 1950, the latest before 1967.' && T.snapshotLine('Air photo', tSnap, null, 1920) === 'Air photo: the first is from 1932.', 'time line: the readout says the year a layer shows, and says so when it is an earlier picture or when there is none yet')
    report(T.herringSeason(1951) === '1950/1951' && threw(() => T.herringSeason(1951.5)) && T.herringLine(1940, 0, 1951) === 'Herring spawn: the records begin with the 1950/1951 season.' && T.herringLine(1998, 0, 1951) === 'Herring spawn, 1997/1998 season: none recorded in the area this map reaches.' && T.herringLine(1951, 11, 1951) === 'Herring spawn, 1950/1951 season: 11 places.' && T.herringLine(1960, 1, 1951) === 'Herring spawn, 1959/1960 season: 1 place.', 'herring by year: a year is said as DFO’s season (1951 is 1950/1951), and a season with no record says none were recorded')
    report(T.herringSteps([{ properties: { year: 1953 } }, { properties: { year: 1951 } }, { properties: { year: 1953 } }, { properties: {} }]).map((s) => s.t).join() === '1951,1953', 'herring by year: the steps are the seasons found in the file, once each, in order')
    const hy = T.herringYearInfo({ year: 1967, name: 'Boundary Bay', spawns: 3, index_t: 36200, no_index: 1, length_m: 6398, method: 'Mixed' }), hz = T.herringYearInfo({ year: 2020, name: 'Cordova Bay', spawns: 1, index_t: null, no_index: 1, length_m: null, method: 'Incomplete' })
    report(hy.title === 'Boundary Bay' && hy.tag === 'herring spawn, 1966/1967 season' && hy.lines[0] === 'Spawn index: 36,200 tonnes, from 2 of 3 records (the others have none).' && hy.lines[1] === '3 spawn records this season, along about 6,398 m of shore.' && hy.lines.includes('Surveyed from the surface and by divers.') && hy.lines.includes(T.HERRING_CAVEAT) && hy.source.includes(OGL_CANADA_STATEMENT) && hz.lines[0] === 'No spawn index was recorded for this place and season.' && hz.lines.includes('The survey was incomplete.'), 'herring by year: the popup gives the place as DFO names it, the season, the index in tonnes and how many records it comes from, the shore length, the survey method, the caveats and the Open Government Licence – Canada statement', JSON.stringify(hy.lines))
    const sNs = T.seiInfo({ class: 'NS', sub: null, also: null, dist: 'Cleared/Logged' }, 2002), sWd = T.seiInfo({ class: 'WD', sub: 'mx', also: 'HT+SG' }, 1994), s14 = T.seiInfo({ class: 'WD', sub: 'co', also: 'WD', tenths: 8 }, 2014), sDist = T.seiInfo({ class: 'WD', sub: null, also: null, dist: 'Urban Use' }, 2002)
    report(sNs.title === 'Disturbed between 1992 and 2002' && sNs.lines[0] === 'Part of a sensitive ecosystem mapped in 1994-95 that the 2002 update found disturbed.' && sNs.lines[1] === 'Kind of disturbance, as the update records it: cleared/logged.' && sWd.title === 'Woodland, mixed' && sWd.lines.some((l) => /Garry oak, arbutus and Douglas-fir/.test(l)) && sWd.lines.includes('Also in this polygon: terrestrial herbaceous and older second growth forest.') && s14.tag === 'Garry oak ecosystems mapping, 2014' && s14.lines.includes('The main ecosystem covers about 80% of the polygon.') && s14.lines.some((l) => /does not measure change/.test(l)) && sDist.lines.includes('The 2002 update notes a disturbance here: urban use.') && [sNs, sWd, s14].every((i) => i.source.includes(OGL_BC_STATEMENT)) && T.seiSub('SV', 'sp') === 'spit' && T.seiSub('WN', 'sp') === 'swamp' && threw(() => T.seiInfo({ class: 'WD' }, 1999)), 'sensitive ecosystems: a disturbed patch of 2002 says so and by what, woodland says it includes Garry oak, arbutus and Douglas-fir, the 2014 mapping says it does not measure change, subclasses are read with their class, and each popup carries the Open Government Licence – British Columbia statement')
    report(T.lossLine(2000) === 'Forest loss: the satellite record begins in 2001.' && T.lossLine(2016) === 'Forest loss seen by satellite: 2001 to 2016. Darker is more recent.' && T.lossLine(2026).startsWith('Forest loss seen by satellite: 2001 to 2025, the latest year in the data.') && T.lossInfo(2016).title === 'Forest loss in 2016' && T.lossInfo(2016).source.includes('Hansen/UMD/Google/USGS/NASA') && T.lossInfo(2016).source.includes('CC BY 4.0') && T.lossInfo(2016).lines.some((l) => /before 2011/.test(l)) && T.LOSS_YEARS.length === 25 && T.LOSS_YEARS[0].t === 2001 && T.LOSS_YEARS.at(-1).t === 2025, 'forest loss: the slider shows the loss from 2001 up to its year, says when the record begins and ends, and the popup says the early years were processed differently and carries the credit Global Forest Change asks for and its licence')
    report(T.lossYearOf(10, 255) === 2001 && T.lossYearOf(250, 255) === 2025 && T.lossYearOf(121, 255) === 2012 && T.lossYearOf(120, 0) === 0 && T.lossYearOf(0, 255) === 0 && T.lossYearOf(255, 255) === 0, 'forest loss: a pixel’s year is its red value over ten, and a clear pixel or a value off the scale is no loss')
    const [lw, ln] = T.LOSS_CORNERS[0], [le, ls] = T.LOSS_CORNERS[2]
    report(lw === BBOX[0] && le === BBOX[2] && ls === BBOX[1] && ln === BBOX[3] && T.lossPixel(-123.75, 48.7, 2200, 2535).join() === '0,0' && T.lossPixel(-123.2001, 48.2801, 2200, 2535).join() === '2199,2534' && T.lossPixel(-123.475, 48.49, 2200, 2535)[0] === 1100 && Math.abs(T.lossPixel(-123.475, 48.49, 2200, 2535)[1] - 1270) <= 2 && T.lossPixel(-123.1, 48.5, 2200, 2535) === null, 'forest loss: the picture covers the demo box exactly, and a place finds its pixel with rows even in Web Mercator, not in latitude', JSON.stringify(T.lossPixel(-123.475, 48.49, 2200, 2535)))
    report(T.lossRgb(2001).join() === '246,213,92' && T.lossRgb(2013).join() === '232,131,58' && T.lossRgb(2025).join() === '122,16,16' && T.lossRgb(2019).every((v, k) => v <= T.lossRgb(2013)[k]) && T.lossGradient().startsWith('linear-gradient(to right, rgb(246, 213, 92) 0%'), 'forest loss: the colours run from pale yellow in 2001 through orange in 2013 to dark red in 2025, and the key is the same ramp')
    const au = T.aerialTileUrl(1932)
    report(au.startsWith('https://datacube.services.geo.ca/ows/aerial?') && au.includes('layers=victoria') && au.includes('time=1932-07-01T12:00:00Z') && au.includes('bbox={bbox-epsg-3857}') && au.includes('crs=EPSG:3857') && au.includes('format=image/png&transparent=true') && threw(() => T.aerialTileUrl(1940)), 'air photos: each year asks the datacube for its own layer in Web Mercator, as transparent PNG, with the full time form the photo service needs, and a year it does not have is refused')
    const lut = T.landcoverLut(), codes = T.LANDCOVER_CLASSES.map(([c]) => c)
    const lutOk = T.LANDCOVER_CLASSES.every(([c, hex]) => [lut[c * 4], lut[c * 4 + 1], lut[c * 4 + 2], lut[c * 4 + 3]].join() === [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).concat(255).join())
    report(lutOk && lut[3] === 0 && lut[2 * 4 + 3] === 0 && lut[255 * 4 + 3] === 0 && new Set(codes).size === codes.length && codes.length === 11 && T.LANDCOVER_CORNERS.join() === T.LOSS_CORNERS.join() && T.LANDCOVER_YEARS.map((s) => s.t).join() === '2010,2015,2020' && T.LANDCOVER_FILE === 'data/landcover-2010-2020.png', 'land cover: each of the eleven classes is drawn in its key colour, no data and a code not in the key are clear, and the picture covers the demo box')
    const [tl, tr, br, bl] = T.CANOPY_CORNERS
    report(T.CANOPY_CORNERS.length === 4 && tl[1] === tr[1] && bl[1] === br[1] && tl[0] === bl[0] && tr[0] === br[0] && tl[0] < tr[0] && tl[1] > bl[1] && tl[0] > BBOX[0] && tr[0] < BBOX[2] && bl[1] > BBOX[1] && tl[1] < BBOX[3] && T.CANOPY_YEARS.map((s) => s.label).join() === '2013,2019,2023 (draft)' && Object.keys(T.CANOPY_FILES).join() === '2013,2019,2023', 'vegetation from LiDAR: one rectangle in the demo box for the three pictures, corners in the order top left, top right, bottom right, bottom left, and the 2023 step labelled a draft')
    const timeTexts = [hy, hz, sNs, sWd, s14, sDist, T.lossInfo(2016)].flatMap((i) => [i.title, i.tag, i.source, ...i.lines]).concat([T.lossLine(2016), T.herringLine(1998, 0, 1951), T.snapshotLine('Air photo', tSnap, tSnap[1], 1967), ...Object.values(T.SEI_CLASSES).map((c) => c.note).filter(Boolean), ...T.SEI_KEY.map((k) => k[1])])
    report(ruleMarinePlain(timeTexts).length === 0, 'change over time: the text of every popup and readout line has no em dash and no semicolon', ruleMarinePlain(timeTexts).join(' | '))

    }
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
