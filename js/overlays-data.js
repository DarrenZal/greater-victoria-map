// Parsing and filtering for the optional overlays (js/overlays.js). Plain ES module with no
// DOM and no map code, so scripts/check-demo.mjs can run it on sample replies in Node.
//
// Everything here treats the reply of an outside service as untrusted: it picks the fields it
// knows, checks their types, and drops what does not fit. Nothing is written into the page
// from here.

export const DEMO_BOX = [-123.75, 48.28, -123.20, 48.70] // west, south, east, north (the data box)
export const REGION = [-124.4, 47.9, -122.7, 49.1] // the area the map lets a visitor reach
export const NEAR_BOX = [-123.9, 48.2, -123.1, 48.8] // "in or near" the box, for weather stations
export const DOWNTOWN = [-123.3656, 48.4284] // reference point for distances: downtown Victoria

export const ECCC_API = 'https://api.weather.gc.ca/collections'
export const GEOMET = 'https://geo.weather.gc.ca/geomet'
export const RADAR_LAYER = 'RADAR_1KM_RRAI'
export const RADAR_STYLE = 'Radar-Rain_14colors'
export const RADAR_FRAMES = 10 // newest ten frames, six minutes apart
export const RADAR_SIZE = 720 // pixels across for the image requested per frame
export const USGS_QUERY = 'https://earthquake.usgs.gov/fdsnws/event/1/query'
export const GBIF_SEARCH = 'https://api.gbif.org/v1/occurrence/search'

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const str = (v, max = 400) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null)
const iso = (v) => { const t = Date.parse(v); return Number.isFinite(t) ? new Date(t).toISOString() : null }
const inBox = (x, y, b) => x >= b[0] && x <= b[2] && y >= b[1] && y <= b[3]
const point = (g) => (g?.type === 'Point' && Array.isArray(g.coordinates) && num(g.coordinates[0]) != null && num(g.coordinates[1]) != null ? [g.coordinates[0], g.coordinates[1]] : null)
const feature = (coords, properties) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: coords }, properties })
export const collection = (features) => ({ type: 'FeatureCollection', features })
const must = (d) => { if (!d || !Array.isArray(d.features)) throw new Error('the reply was not a feature collection'); return d.features }

// Straight-line distance in km.
export function distanceKm([x1, y1], [x2, y2]) {
  const r = Math.PI / 180, dy = (y2 - y1) * r, dx = (x2 - x1) * r * Math.cos(((y1 + y2) / 2) * r)
  return 6371 * Math.hypot(dx, dy)
}

// Pacific time, whatever the visitor's own zone is, e.g. "Oct 21, 5:10 p.m. PDT".
export function pacificTime(isoText) {
  const t = Date.parse(isoText)
  if (!Number.isFinite(t)) return null
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Vancouver', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).format(t)
}

// ---- precipitation radar (ECCC GeoMet WMS)
const mercator = (lng, lat) => [lng * 20037508.34 / 180, Math.log(Math.tan((90 + lat) * Math.PI / 360)) * 20037508.34 / Math.PI]
export function radarCapabilitiesUrl() {
  return `${GEOMET}?service=WMS&version=1.3.0&request=GetCapabilities&LAYERS=${RADAR_LAYER}`
}
// The times the service offers for a layer: "start/end/PT6M" in its time dimension, every one of them.
function layerTimes(xml, layer, what) {
  const text = String(xml)
  const at = text.indexOf(`<Name>${layer}</Name>`)
  if (at < 0) throw new Error(`the ${what} layer is not in the service description`)
  const block = text.slice(at, text.indexOf('</Layer>', at))
  const dim = block.match(/<Dimension\s+name="time"[^>]*>\s*([^<]+?)\s*<\/Dimension>/)
  if (!dim) throw new Error(`the ${what} layer has no time dimension`)
  const [start, end, step, extra] = dim[1].split('/')
  const m = step?.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/)
  const stepMs = m ? ((+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0)) * 1000 : 0
  const first = Date.parse(start), last = Date.parse(end)
  if (extra || !stepMs || !Number.isFinite(first) || !Number.isFinite(last) || last < first || (last - first) / stepMs > 300) throw new Error(`the ${what} time range could not be read`)
  const n = Math.floor((last - first) / stepMs) + 1
  return Array.from({ length: n }, (_, i) => new Date(first + i * stepMs).toISOString().replace('.000Z', 'Z'))
}
// The frame times the service offers for the radar layer, the newest ones.
export function radarTimes(xml, count = RADAR_FRAMES) {
  return layerTimes(xml, RADAR_LAYER, 'radar').slice(-count)
}
// The image corners (top left, top right, bottom right, bottom left) for the region, and the
// size of the image asked for, which keeps the shape of the region in web Mercator.
export function radarGeometry(region = REGION, width = RADAR_SIZE) {
  const [w, s, e, n] = region
  const [x0, y0] = mercator(w, s), [x1, y1] = mercator(e, n)
  return { coordinates: [[w, n], [e, n], [e, s], [w, s]], bbox: [x0, y0, x1, y1], width, height: Math.round(width * (y1 - y0) / (x1 - x0)) }
}
export function radarFrameUrl(time, geometry = radarGeometry()) {
  if (!Number.isFinite(Date.parse(time))) throw new Error('a frame time is needed')
  const p = new URLSearchParams({ service: 'WMS', version: '1.3.0', request: 'GetMap', layers: RADAR_LAYER, styles: RADAR_STYLE, crs: 'EPSG:3857', bbox: geometry.bbox.join(','), width: String(geometry.width), height: String(geometry.height), format: 'image/png', transparent: 'true', time, INTERPOLATION: 'TRUE' })
  return `${GEOMET}?${p}`
}
export const radarLegendUrl = () => `${GEOMET}?version=1.3.0&service=WMS&request=GetLegendGraphic&sld_version=1.1.0&layer=${RADAR_LAYER}&format=image/png&STYLE=${RADAR_STYLE}`

// ---- weather alerts (ECCC)
export function alertsUrl() { return `${ECCC_API}/weather-alerts/items?f=json&bbox=${DEMO_BOX.join(',')}&limit=50` }
const ALERT_COLOURS = { yellow: '#d9a400', orange: '#e07b00', red: '#c0261b' }
// Alerts still in effect. The text is passed on exactly as published, because the licence says
// a weather alert must be reproduced without changing its content or intent.
export function normaliseAlerts(d, now = Date.now()) {
  const items = []
  for (const f of must(d)) {
    const p = f.properties || {}
    const expires = p.expiration_datetime ? Date.parse(p.expiration_datetime) : null
    if (expires != null && !(expires > now)) continue
    if (!f.geometry || !/^(Multi)?Polygon$/.test(f.geometry.type)) continue
    const colour = String(p.risk_colour_en || '').toLowerCase()
    items.push({
      id: f.id != null ? String(f.id).slice(0, 120) : null,
      geometry: f.geometry,
      title: str(p.alert_short_name_en) || str(p.alert_name_en) || 'Weather alert',
      area: str(p.feature_name_en),
      text: str(p.alert_text_en, 6000),
      issued: iso(p.publication_datetime),
      expires: expires != null ? iso(p.expiration_datetime) : null,
      colour: ALERT_COLOURS[colour] || '#6b6b6b',
    })
  }
  const fc = collection(items.map((a) => ({ type: 'Feature', geometry: a.geometry, properties: { colour: a.colour } })))
  return { fc, items }
}

// ---- air quality (ECCC AQHI)
export function aqhiUrl() { return `${ECCC_API}/aqhi-observations-realtime/items?f=json&bbox=${DEMO_BOX.join(',')}&limit=50&latest=true&sortby=-observation_datetime` }
// The bands of the index, read on the rounded value the index is reported as: 1 to 3 low, 4 to 6 moderate, 7 to 10 high, above 10 very high.
export function aqhiBand(v) { const r = Math.round(v); return r <= 3 ? 'Low risk' : r <= 6 ? 'Moderate risk' : r <= 10 ? 'High risk' : 'Very high risk' }
export function normaliseAqhi(d) {
  const latest = new Map()
  for (const f of must(d)) {
    const p = f.properties || {}, c = point(f.geometry)
    if (!c || !inBox(c[0], c[1], DEMO_BOX) || num(p.aqhi) == null || p.aqhi < 0 || p.location_id == null) continue
    const when = iso(p.observation_datetime)
    if (!when) continue
    const prev = latest.get(p.location_id)
    if (!prev || Date.parse(prev.properties.when) < Date.parse(when)) {
      latest.set(p.location_id, feature(c, { name: str(p.location_name_en) || String(p.location_id).slice(0, 40), aqhi: Math.round(p.aqhi * 100) / 100, shown: String(Math.round(p.aqhi)), band: aqhiBand(p.aqhi), when, id: f.id != null ? String(f.id).slice(0, 120) : null }))
    }
  }
  return collection([...latest.values()])
}

// ---- earthquakes (USGS)
export function quakesUrl(now = Date.now()) {
  const start = new Date(now - 7 * 86400000).toISOString().slice(0, 19)
  const [w, s, e, n] = REGION
  return `${USGS_QUERY}?format=geojson&eventtype=earthquake&orderby=time&limit=200&starttime=${start}&minlatitude=${s}&maxlatitude=${n}&minlongitude=${w}&maxlongitude=${e}`
}
export function normaliseQuakes(d, now = Date.now()) {
  const out = []
  for (const f of must(d)) {
    const p = f.properties || {}, c = point(f.geometry)
    if (!c || !inBox(c[0], c[1], REGION) || p.type !== 'earthquake' || num(p.mag) == null || num(p.time) == null) continue
    const url = typeof p.url === 'string' && p.url.startsWith('https://earthquake.usgs.gov/') ? p.url : null
    out.push(feature(c, { mag: p.mag, place: str(p.place), time: new Date(p.time).toISOString(), age_h: Math.max(0, (now - p.time) / 3600000), depth_km: num(f.geometry.coordinates[2]), mag_type: str(p.magType, 12), url, status: str(p.status, 20), label: `M${p.mag.toFixed(1)}` }))
  }
  return collection(out)
}

// ---- current conditions (ECCC surface weather observations)
const SWOB_FIELDS = ['stn_nam-value', 'msc_id-value', 'tc_id-value', 'data_pvdr-value', 'date_tm-value', 'air_temp', 'rel_hum', 'avg_wnd_spd_10m_pst10mts', 'avg_wnd_spd_10m_pst10mts-uom', 'avg_wnd_dir_10m_pst10mts', 'stn_pres', 'stn_pres-uom', 'mslp', 'pcpn_amt_pst1hr']
export function conditionsUrl() { return `${ECCC_API}/swob-realtime/items?f=json&bbox=${NEAR_BOX.join(',')}&limit=300&sortby=-date_tm-value&properties=${SWOB_FIELDS.join(',')}` }
export function normaliseConditions(d, now = Date.now()) {
  const byStation = new Map()
  for (const f of must(d)) {
    const p = f.properties || {}, c = point(f.geometry)
    const when = iso(p['date_tm-value'])
    if (!c || !when || !inBox(c[0], c[1], NEAR_BOX) || now - Date.parse(when) > 3 * 3600000) continue
    const temp = num(p.air_temp), wind = num(p.avg_wnd_spd_10m_pst10mts)
    if (temp == null && wind == null) continue // a report with nothing to show
    const name = str(p['stn_nam-value'], 80)
    if (!name) continue
    const key = `${name}@${c[0].toFixed(4)},${c[1].toFixed(4)}` // the same site can report under two ids
    const prev = byStation.get(key)
    if (prev && Date.parse(prev.properties.when) >= Date.parse(when)) continue
    byStation.set(key, feature(c, {
      name, provider: str(p['data_pvdr-value'], 40), when,
      temp, label: temp != null ? `${Math.round(temp)}°` : '\u2013', // a dash where the station reports no temperature
      humidity: num(p.rel_hum), wind, wind_dir: num(p.avg_wnd_dir_10m_pst10mts), wind_unit: str(p['avg_wnd_spd_10m_pst10mts-uom'], 10) || 'km/h',
      pressure: num(p.mslp) ?? num(p.stn_pres), pressure_kind: num(p.mslp) != null ? 'sea-level pressure' : 'station pressure', pressure_unit: str(p['stn_pres-uom'], 10) || 'hPa',
      rain_1h: num(p.pcpn_amt_pst1hr),
    }))
  }
  return collection([...byStation.values()])
}

// ---- river gauges (ECCC hydrometric stations)
export function waterStationsUrl() { return `${ECCC_API}/hydrometric-stations/items?f=json&bbox=${REGION.join(',')}&limit=200&STATUS_EN=Active` }
export function waterReadingUrl(station) {
  if (!/^[0-9A-Z]{7}$/.test(station)) throw new Error('unexpected station number')
  return `${ECCC_API}/hydrometric-realtime/items?f=json&STATION_NUMBER=${station}&limit=1&sortby=-DATETIME`
}
// The nearest active gauges that report in real time, nearest first.
export function nearestGauges(d, count = 5, from = DOWNTOWN) {
  const rows = []
  for (const f of must(d)) {
    const p = f.properties || {}, c = point(f.geometry)
    if (!c || p.REAL_TIME !== 1 || p.STATUS_EN !== 'Active' || !/^[0-9A-Z]{7}$/.test(String(p.STATION_NUMBER))) continue
    rows.push({ number: p.STATION_NUMBER, name: str(p.STATION_NAME, 90) || p.STATION_NUMBER, contributor: str(p.CONTRIBUTOR_EN, 60), coords: c, km: distanceKm(from, c) })
  }
  return rows.sort((a, b) => a.km - b.km).slice(0, count)
}
export function gaugeFeature(gauge, reading) {
  const p = reading?.features?.[0]?.properties
  const level = num(p?.LEVEL), discharge = num(p?.DISCHARGE), when = p ? iso(p.DATETIME) : null
  if (!when || (level == null && discharge == null)) return null
  return feature(gauge.coords, { name: gauge.name, number: gauge.number, contributor: gauge.contributor, km: Math.round(gauge.km), label: `${Math.round(gauge.km)} km`, level, discharge, when })
}

// ---- life observations (GBIF)
// The licences kept, as GBIF gives them, and where each one is read.
const LIFE_LICENCES = [
  { test: /creativecommons\.org\/publicdomain\/zero\/1\.0/, short: 'CC0 1.0', url: 'https://creativecommons.org/publicdomain/zero/1.0/legalcode', credit: false },
  { test: /creativecommons\.org\/licenses\/by\/4\.0/, short: 'CC BY 4.0', url: 'https://creativecommons.org/licenses/by/4.0/legalcode', credit: true },
]
// Three windows of four months over the last year, a hundred records each: three hundred in all,
// spread over the year instead of all from one month. Three requests, not one per month, because
// GBIF refuses a burst of requests.
export function lifeUrls(now = Date.now()) {
  const day = 86400000, urls = []
  for (let i = 0; i < 3; i++) {
    const to = new Date(now - i * 122 * day), from = new Date(to.getTime() - 122 * day)
    const p = new URLSearchParams({ decimalLatitude: `${DEMO_BOX[1]},${DEMO_BOX[3]}`, decimalLongitude: `${DEMO_BOX[0]},${DEMO_BOX[2]}`, eventDate: `${from.toISOString().slice(0, 10)},${to.toISOString().slice(0, 10)}`, hasCoordinate: 'true', hasGeospatialIssue: 'false', occurrenceStatus: 'PRESENT', limit: '100' })
    p.append('license', 'CC0_1_0'); p.append('license', 'CC_BY_4_0')
    urls.push(`${GBIF_SEARCH}?${p}`)
  }
  return urls
}
// Records kept: CC0 or CC BY 4.0 only, nothing withheld or generalised by its publisher, a
// position known to within 5 km, and a position rounded to 0.01 degree (about 1 km).
// Whales, dolphins and porpoises (order Cetacea) are left out: a recent sighting point can send
// boats after them, and many killer whale records here are not obscured at the source.
export function normaliseLife(results) {
  const seen = new Set(), out = []
  for (const r of results) {
    if (!r || !Number.isInteger(r.key) || seen.has(r.key)) continue
    seen.add(r.key)
    const lic = LIFE_LICENCES.find((l) => l.test.test(String(r.license || '')))
    if (!lic) continue
    if (r.order === 'Cetacea') continue
    if (r.informationWithheld) continue
    if (r.dataGeneralizations && !/^none$/i.test(String(r.dataGeneralizations).trim())) continue
    if (num(r.decimalLatitude) == null || num(r.decimalLongitude) == null) continue
    if (num(r.coordinateUncertaintyInMeters) != null && r.coordinateUncertaintyInMeters > 5000) continue
    const x = Math.round(r.decimalLongitude * 100) / 100, y = Math.round(r.decimalLatitude * 100) / 100
    if (!inBox(x, y, DEMO_BOX)) continue
    const name = str(r.species, 120) || str(r.scientificName, 160)
    if (!name) continue
    out.push(feature([x, y], {
      key: r.key, name, vernacular: str(r.vernacularName, 120), kingdom: str(r.kingdom, 40), date: str(r.eventDate, 40),
      dataset: str(r.datasetName, 160), dataset_key: /^[0-9a-f-]{36}$/i.test(String(r.datasetKey)) ? r.datasetKey : null,
      licence: lic.short, licence_url: lic.url, holder: lic.credit ? str(r.rightsHolder, 120) : null,
    }))
  }
  return collection(out)
}

// ---- sea currents (ECCC GeoMet WCS, CIOPS-SalishSea model)
export const CURRENTS_LAYER = 'CIOPS-SalishSea_500m_SeaWaterVelocity_0.5m' // the layer whose time dimension lists the hours
export const CURRENTS_BOX = [-124.5, 47.8, -122.6, 49.2] // west, south, east, north: the map's reach (REGION) and a margin
export const CURRENTS_PLAY_HOURS = 13 // Play steps through this many hours, a little more than one tide cycle
const NO_FLOW = 100 // m/s. A value above this is the service's fill value, not a current
const M_PER_DEGREE = 111320

export function currentsCapabilitiesUrl() {
  return `${GEOMET}?service=WMS&version=1.3.0&request=GetCapabilities&LAYER=${CURRENTS_LAYER}`
}
export const currentsTimes = (xml) => layerTimes(xml, CURRENTS_LAYER, 'sea currents')
// The hours Play steps through, and the one shown first: the latest hour not after `now`, then the
// hours after it. If the service ends sooner than that, the window is moved back to fit.
export function currentsWindow(times, now = Date.now(), hours = CURRENTS_PLAY_HOURS) {
  let start = 0
  times.forEach((t, i) => { if (Date.parse(t) <= now) start = i })
  const from = Math.max(0, Math.min(start, times.length - hours))
  return { times: times.slice(from, from + hours), at: start - from }
}
// One component of the velocity for one hour (X or Y), on the grid of CURRENTS_BOX.
export function currentsUrl(axis, time) {
  if (axis !== 'X' && axis !== 'Y') throw new Error('the velocity axis must be X or Y')
  if (!Number.isFinite(Date.parse(time))) throw new Error('an hour is needed')
  const [w, s, e, n] = CURRENTS_BOX
  const p = new URLSearchParams({ service: 'WCS', version: '2.0.1', request: 'GetCoverage', coverageid: `CIOPS-SalishSea_500m_SeaWaterVelocity${axis}_0.5m`, format: 'image/tiff', subsettingcrs: 'http://www.opengis.net/def/crs/EPSG/0/4326', time })
  p.append('subset', `x(${w},${e})`); p.append('subset', `y(${s},${n})`)
  return `${GEOMET}?${p}`
}
// Pacific time to the hour, whatever the visitor's own zone is, e.g. "Oct 21, 9 p.m. PDT".
export function pacificHour(isoText) {
  const t = Date.parse(isoText)
  if (!Number.isFinite(t)) return null
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Vancouver', month: 'short', day: 'numeric', hour: 'numeric', timeZoneName: 'short' }).format(t)
}

// A reader for the one kind of GeoTIFF the service sends: one band of 32-bit floats, not
// compressed, in strips. Anything else is refused. It returns the size, the bounding box
// [west, south, east, north] in degrees and the values, row 0 at the north.
export function readGeoTiff(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer)
  const order = bytes.length >= 8 ? String.fromCharCode(bytes[0], bytes[1]) : ''
  if (order !== 'II' && order !== 'MM') throw new Error('the reply is not a TIFF image')
  const le = order === 'II', dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (dv.getUint16(2, le) !== 42) throw new Error('only classic TIFF is read')
  const ifd = dv.getUint32(4, le)
  if (ifd + 2 > bytes.length) throw new Error('the TIFF directory is outside the file')
  const entries = dv.getUint16(ifd, le)
  if (ifd + 2 + entries * 12 > bytes.length) throw new Error('the TIFF directory is outside the file')
  // Byte, short, long and double values. Other types are not needed and are skipped.
  const readers = { 1: [1, (o) => dv.getUint8(o)], 3: [2, (o) => dv.getUint16(o, le)], 4: [4, (o) => dv.getUint32(o, le)], 12: [8, (o) => dv.getFloat64(o, le)] }
  const tags = {}
  for (let i = 0; i < entries; i++) {
    const at = ifd + 2 + i * 12, type = dv.getUint16(at + 2, le), count = dv.getUint32(at + 4, le), r = readers[type]
    if (!r) continue
    const start = r[0] * count <= 4 ? at + 8 : dv.getUint32(at + 8, le)
    if (start + r[0] * count > bytes.length) throw new Error('a TIFF tag points outside the file')
    tags[dv.getUint16(at, le)] = Array.from({ length: count }, (_, k) => r[1](start + k * r[0]))
  }
  const [width, height] = [tags[256]?.[0], tags[257]?.[0]]
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 2 || height < 2 || width * height > 4e6) throw new Error('the TIFF size is not usable')
  if (tags[258]?.length !== 1 || tags[258][0] !== 32 || tags[339]?.[0] !== 3) throw new Error('the TIFF does not hold 32-bit floating point values')
  if ((tags[259]?.[0] ?? 1) !== 1) throw new Error('the TIFF is compressed')
  if ((tags[277]?.[0] ?? 1) !== 1 || tags[322] || tags[324]) throw new Error('the TIFF is not one band in strips')
  const offsets = tags[273], lengths = tags[279]
  if (!offsets || !lengths || offsets.length !== lengths.length) throw new Error('the TIFF has no strips')
  const scale = tags[33550], tie = tags[33922]
  if (!scale || scale.length < 2 || !tie || tie.length < 6 || !(scale[0] > 0) || !(scale[1] > 0)) throw new Error('the TIFF has no position')
  // The scale is degrees per pixel, east and south. The tie point gives the position of one pixel corner.
  const west = tie[3] - tie[0] * scale[0], north = tie[4] + tie[1] * scale[1]
  const data = new Float32Array(width * height)
  let n = 0
  for (let s = 0; s < offsets.length; s++) {
    if (offsets[s] + lengths[s] > bytes.length || lengths[s] % 4) throw new Error('a TIFF strip is outside the file')
    for (let k = 0; k < lengths[s] && n < data.length; k += 4) data[n++] = dv.getFloat32(offsets[s] + k, le)
  }
  if (n < data.length) throw new Error('the TIFF holds fewer values than its size')
  return { width, height, bbox: [west, north - height * scale[1], west + width * scale[0], north], data }
}

// The east and north components for one hour, on one grid. A cell is sea where both hold a
// number: NaN, a fill value and exactly zero in both (how the model marks land) are no data.
export function currentsGrid(east, north) {
  if (east.width !== north.width || east.height !== north.height || east.bbox.some((x, i) => Math.abs(x - north.bbox[i]) > 1e-9)) throw new Error('the two velocity grids differ')
  const sea = new Uint8Array(east.data.length)
  for (let i = 0; i < sea.length; i++) {
    const u = east.data[i], v = north.data[i]
    sea[i] = Math.abs(u) <= NO_FLOW && Math.abs(v) <= NO_FLOW && (u !== 0 || v !== 0) ? 1 : 0
  }
  return { width: east.width, height: east.height, bbox: east.bbox, u: east.data, v: north.data, sea }
}

// Bilinear interpolation of `layers` (arrays of cols x rows values, cell centres at whole numbers)
// at (fx, fy). The cell nearest the point must be sea. Neighbours that are not sea are left out and
// the weights of the rest are scaled to add up to one, so the flow stops at the coast and does not
// fade into it. Writes the result to `out` and returns true, or returns false for no flow.
function bilinear(layers, sea, cols, rows, fx, fy, out) {
  if (!(fx >= -0.5 && fy >= -0.5 && fx <= cols - 0.5 && fy <= rows - 0.5)) return false
  const x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0
  const nx = tx < 0.5 ? x0 : x0 + 1, ny = ty < 0.5 ? y0 : y0 + 1
  if (nx < 0 || ny < 0 || nx >= cols || ny >= rows || !sea[ny * cols + nx]) return false
  out.fill(0)
  let total = 0
  for (let k = 0; k < 4; k++) {
    const x = x0 + (k & 1), y = y0 + (k >> 1)
    if (x < 0 || y < 0 || x >= cols || y >= rows || !sea[y * cols + x]) continue
    const w = (k & 1 ? tx : 1 - tx) * (k >> 1 ? ty : 1 - ty), i = y * cols + x
    for (let l = 0; l < layers.length; l++) out[l] += layers[l][i] * w
    total += w
  }
  for (let l = 0; l < layers.length; l++) out[l] /= total
  return true
}

// The water's velocity [east, north] in m/s at a place, or null where the model has no sea.
export function seaVelocity(g, lng, lat) {
  const [w, s, e, n] = g.bbox, out = [0, 0]
  const ok = bilinear([g.u, g.v], g.sea, g.width, g.height, (lng - w) / (e - w) * g.width - 0.5, (n - lat) / (n - s) * g.height - 0.5, out)
  return ok ? out : null
}

// The screen row of the horizon in a map tilted `pitch` degrees, for a camera with this vertical field of
// view. The rows above it show sky. It is negative when the horizon lies above the top of the screen.
export function horizonRow(height, fov, pitch) {
  if (!(pitch > 0)) return -Infinity
  return height / 2 - (height / 2) / Math.tan(fov * Math.PI / 360) * Math.tan((90 - pitch) * Math.PI / 180)
}

// The currents as they look on the screen, on a grid of points `step` pixels apart (x = i * step).
// `places` says which place is under the screen: a lattice of `cols` x `rows` points `spacing`
// pixels apart, as { cols, rows, spacing, lng, lat } (arrays, NaN where the map shows no ground).
// It comes from map.unproject, which follows pitch and 3D terrain. The lattice is coarser than the
// field to keep the number of calls down, so the place under a point is interpolated between its
// four lattice points. The pixels the water travels in one second come from the same lattice: the
// slope of longitude and latitude over the screen is turned around and applied to the velocity.
// Each point holds that screen velocity (px per second of water travel) and the speed (m/s).
export function screenField(g, width, height, step, places) {
  const cols = Math.ceil(width / step) + 1, rows = Math.ceil(height / step) + 1, n = cols * rows
  const vx = new Float32Array(n).fill(NaN), vy = new Float32Array(n).fill(NaN), speed = new Float32Array(n).fill(NaN)
  const sea = new Uint8Array(n), list = []
  const { spacing } = places, lng = new Float64Array(4), lat = new Float64Array(4)
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const cx = Math.min(i * step / spacing, places.cols - 1.0001), cy = Math.min(j * step / spacing, places.rows - 1.0001)
      const ci = Math.floor(cx), cj = Math.floor(cy), tx = cx - ci, ty = cy - cj
      for (let k = 0; k < 4; k++) {
        const at = (cj + (k >> 1)) * places.cols + ci + (k & 1)
        lng[k] = places.lng[at]; lat[k] = places.lat[at]
      }
      if (!(Number.isFinite(lng[0] + lng[1] + lng[2] + lng[3]) && Number.isFinite(lat[0] + lat[1] + lat[2] + lat[3]))) continue
      const mix = (q) => (1 - ty) * ((1 - tx) * q[0] + tx * q[1]) + ty * ((1 - tx) * q[2] + tx * q[3])
      const uv = seaVelocity(g, mix(lng), mix(lat))
      if (!uv) continue
      // Slopes of the same patch, in degrees per pixel.
      const slopeX = (q) => ((1 - ty) * (q[1] - q[0]) + ty * (q[3] - q[2])) / spacing
      const slopeY = (q) => ((1 - tx) * (q[2] - q[0]) + tx * (q[3] - q[1])) / spacing
      const a = slopeX(lng), b = slopeY(lng), c = slopeX(lat), d = slopeY(lat)
      const det = a * d - b * c
      if (!Number.isFinite(det) || Math.abs(det) < 1e-18) continue
      const dLng = uv[0] / (M_PER_DEGREE * Math.cos(mix(lat) * Math.PI / 180)), dLat = uv[1] / M_PER_DEGREE // degrees per second
      const x = (d * dLng - b * dLat) / det, y = (a * dLat - c * dLng) / det
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue
      const o = j * cols + i
      vx[o] = x; vy[o] = y; speed[o] = Math.hypot(uv[0], uv[1]); sea[o] = 1
      list.push(o)
    }
  }
  return { cols, rows, step, vx, vy, speed, sea, list: Int32Array.from(list) }
}
// The screen velocity [px/s, px/s, m/s] at a pixel, or false where there is no flow.
export function fieldAt(f, x, y, out) {
  return bilinear([f.vx, f.vy, f.speed], f.sea, f.cols, f.rows, x / f.step, y / f.step, out)
}
