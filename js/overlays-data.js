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
// The frame times the service offers for the radar layer: "start/end/PT6M" in its time dimension.
export function radarTimes(xml, count = RADAR_FRAMES) {
  const text = String(xml)
  const at = text.indexOf(`<Name>${RADAR_LAYER}</Name>`)
  if (at < 0) throw new Error('the radar layer is not in the service description')
  const block = text.slice(at, text.indexOf('</Layer>', at))
  const dim = block.match(/<Dimension\s+name="time"[^>]*>\s*([^<]+?)\s*<\/Dimension>/)
  if (!dim) throw new Error('the radar layer has no time dimension')
  const [start, end, step, extra] = dim[1].split('/')
  const m = step?.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/)
  const stepMs = m ? ((+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0)) * 1000 : 0
  const first = Date.parse(start), last = Date.parse(end)
  if (extra || !stepMs || !Number.isFinite(first) || !Number.isFinite(last) || last < first || (last - first) / stepMs > 300) throw new Error('the radar time range could not be read')
  const n = Math.floor((last - first) / stepMs) + 1
  const all = Array.from({ length: n }, (_, i) => new Date(first + i * stepMs).toISOString().replace('.000Z', 'Z'))
  return all.slice(-count)
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
