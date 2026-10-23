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

// ---- asking the GeoMet server (geo.weather.gc.ca)
// Its replies take from 0.5 to 12 s, and about one request in six times out or is refused. So each request has its own time limit, covering
// the reply to its last byte, and one more try after a short wait when the first failed in a way a second could mend: no answer in time, a
// broken connection, or an answer that says the server is busy or broken. A request the server refuses for its own sake (a missing layer,
// an hour out of range) or answers with the wrong kind of file is not tried twice. The caller's signal stops everything at once.
export const GEOMET_TRY_MS = 15000 // the time limit of one try
export const GEOMET_SLOW_MS = 6000 // after this long without an answer the status line says the server is slow
export const GEOMET_WAIT_MS = 1500 // between the first try and the second
export const GEOMET_BUSY_MS = 1000 // a time limit that fires this late means the page was busy, not that the server was slow
export const GEOMET_GRACE_MS = 1000 // and the answer, which may be waiting to be handled, then gets this long more
export const GEOMET_SLOW_LINE = 'Environment Canada’s server is slow to answer.'
export const GEOMET_RETRY_LINE = 'Environment Canada’s server did not answer. Trying once more.'
const RETRY_STATUS = [408, 425, 429, 500, 502, 503, 504]
const geometError = (message, reason, status) => Object.assign(new Error(message), { reason, status })
// What the status line adds to a failure: nothing for a failure that is not the server's, or a plain sentence. A reply of the wrong kind
// is the server's own error too: out of range, or while a new model run is being put in place, it answers HTTP 200 with a description of the error.
export function geometWhy(e) {
  if (e?.reason === 'down') return ' Environment Canada’s server is not answering.'
  if (e?.reason === 'error' || e?.reason === 'wrong') return ' Environment Canada’s server sent an error.'
  return ''
}
// The reply to `url` as `as` ('text', 'arrayBuffer' or 'blob'). `say('slow')` is called once if the first try is slow, and `say('retry')`
// as the wait before the second begins. `type` is a pattern the content type must match. `tryMs`, `slowMs`, `waitMs`, `busyMs`, `graceMs` and `fetchImpl` are for the checks.
// A failure carries `reason`: 'down' (no answer), 'error' (the server's own error, with `status`), 'wrong' (the wrong kind of file) or 'cancelled'.
export async function geometGet(url, as, { signal, say, type, tryMs = GEOMET_TRY_MS, slowMs = GEOMET_SLOW_MS, waitMs = GEOMET_WAIT_MS, busyMs = GEOMET_BUSY_MS, graceMs = GEOMET_GRACE_MS, fetchImpl = (...a) => fetch(...a) } = {}) {
  if (!['text', 'arrayBuffer', 'blob'].includes(as)) throw new Error('the reply must be read as text, arrayBuffer or blob')
  let failure
  for (let attempt = 0; attempt < 2; attempt++) {
    if (signal?.aborted) throw geometError('cancelled', 'cancelled')
    if (attempt) {
      say?.('retry')
      await new Promise((resolve, reject) => {
        const t = setTimeout(resolve, waitMs), cancel = () => { clearTimeout(t); reject(geometError('cancelled', 'cancelled')) }
        if (signal?.aborted) cancel(); else signal?.addEventListener('abort', cancel, { once: true })
      })
    }
    let limited = false, graced = false, due = performance.now() + tryMs, limit = 0
    const ac = new AbortController(), stop = () => ac.abort(), slow = say ? setTimeout(() => { if (!attempt) say('slow') }, slowMs) : 0
    // A page starved of time (a phone drawing a 3D view) may run the limit's timer long after it was due, with the answer already in and not yet handled.
    // Then the time limit is not up: the timer is set again, once, for a moment more.
    const arm = (ms) => setTimeout(() => {
      if (!graced && performance.now() - due > busyMs) { graced = true; due = performance.now() + graceMs; limit = arm(graceMs); return }
      limited = true; ac.abort()
    }, ms)
    limit = arm(tryMs)
    signal?.addEventListener('abort', stop, { once: true })
    try {
      const reply = await fetchImpl(url, { signal: ac.signal })
      if (!reply.ok) {
        failure = geometError(`HTTP ${reply.status}`, 'error', reply.status)
        if (RETRY_STATUS.includes(reply.status)) continue
        throw failure
      }
      // Out of range, the service answers HTTP 200 with a description of the error.
      if (type && !type.test(reply.headers.get('content-type') || '')) throw geometError('the service sent the wrong kind of file', 'wrong')
      return await reply[as]()
    } catch (e) {
      if (signal?.aborted) throw geometError('cancelled', 'cancelled')
      if (e?.reason === 'wrong' || (e === failure && !RETRY_STATUS.includes(e.status))) throw e
      if (e !== failure) failure = geometError(limited ? 'no answer in time' : String(e?.message || e), 'down')
    } finally {
      clearTimeout(slow); clearTimeout(limit)
      signal?.removeEventListener('abort', stop)
    }
  }
  throw failure
}

// ---- sea currents (ECCC GeoMet WCS, CIOPS-SalishSea model) and wind (HRDPS, same service)
export const CURRENTS_LAYER = 'CIOPS-SalishSea_500m_SeaWaterVelocity_0.5m' // the layer whose time dimension lists the hours
export const CURRENTS_BOX = [-124.5, 47.8, -122.6, 49.2] // west, south, east, north: the map's reach (REGION) and a margin
export const CURRENTS_SCALE = 0.5 // the service sends every second cell of its 500 m grid: 1 km cells, a quarter of the bytes
export const PLAY_HOURS = 13 // Play steps through this many hours, a little more than one tide cycle
export const WIND_LAYERS = { speed: 'HRDPS.CONTINENTAL_WSPD', direction: 'HRDPS.CONTINENTAL_WD' } // 10 m above the surface, m/s and degrees
export const WIND_SIZE = [57, 62] // cells asked for across the box: about 2.5 km each, the model's own spacing
const NO_FLOW = 100 // m/s. A value above this is the service's fill value, not a current or a wind
const M_PER_DEGREE = 111320

export function currentsCapabilitiesUrl() {
  return `${GEOMET}?service=WMS&version=1.3.0&request=GetCapabilities&LAYER=${CURRENTS_LAYER}`
}
export const currentsTimes = (xml) => layerTimes(xml, CURRENTS_LAYER, 'sea currents')
export function windCapabilitiesUrl() {
  return `${GEOMET}?service=WMS&version=1.3.0&request=GetCapabilities&LAYER=${WIND_LAYERS.speed}`
}
export const windTimes = (xml) => layerTimes(xml, WIND_LAYERS.speed, 'wind')
// The hours Play steps through, and the one shown first: the latest hour not after `now`, then the
// hours after it. If the service ends sooner than that, the window is moved back to fit.
export function hourWindow(times, now = Date.now(), hours = PLAY_HOURS) {
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
  const p = new URLSearchParams({ service: 'WCS', version: '2.0.1', request: 'GetCoverage', coverageid: `CIOPS-SalishSea_500m_SeaWaterVelocity${axis}_0.5m`, format: 'image/tiff', subsettingcrs: 'http://www.opengis.net/def/crs/EPSG/0/4326', scalefactor: String(CURRENTS_SCALE), time })
  p.append('subset', `x(${w},${e})`); p.append('subset', `y(${s},${n})`)
  return `${GEOMET}?${p}`
}
// The wind speed or direction for one hour, on a grid of WIND_SIZE cells over the same box.
export function windUrl(part, time) {
  if (part !== 'speed' && part !== 'direction') throw new Error('the wind part must be speed or direction')
  if (!Number.isFinite(Date.parse(time))) throw new Error('an hour is needed')
  const [w, s, e, n] = CURRENTS_BOX
  const p = new URLSearchParams({ service: 'WCS', version: '2.0.1', request: 'GetCoverage', coverageid: WIND_LAYERS[part], format: 'image/tiff', subsettingcrs: 'http://www.opengis.net/def/crs/EPSG/0/4326', scalesize: `x(${WIND_SIZE[0]}),y(${WIND_SIZE[1]})`, time })
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

// The wind for one hour on one grid, from its speed (m/s) and direction (degrees). The service gives the
// direction the wind blows FROM, clockwise from north (checked against station reports, see data/SOURCES.md),
// so a wind from the west, 270, blows east. The east and north components are made first and interpolated
// after, because directions cannot be averaged. Every cell with a number is data: wind blows over land too,
// and exactly zero is a calm, not land.
export function windGrid(speed, direction) {
  if (speed.width !== direction.width || speed.height !== direction.height || speed.bbox.some((x, i) => Math.abs(x - direction.bbox[i]) > 1e-9)) throw new Error('the two wind grids differ')
  const n = speed.data.length, u = new Float32Array(n), v = new Float32Array(n), sea = new Uint8Array(n)
  for (let i = 0; i < n; i++) {
    const s = speed.data[i], d = direction.data[i]
    if (!(s >= 0 && s <= NO_FLOW && d >= 0 && d <= 360)) continue // NaN fails every comparison
    const r = d * Math.PI / 180
    u[i] = -s * Math.sin(r); v[i] = -s * Math.cos(r); sea[i] = 1
  }
  return { width: speed.width, height: speed.height, bbox: speed.bbox, u, v, sea }
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
  const ux = new Float32Array(n).fill(NaN), uy = new Float32Array(n).fill(NaN) // the flow itself, east and north in m/s
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
      vx[o] = x; vy[o] = y; speed[o] = Math.hypot(uv[0], uv[1]); ux[o] = uv[0]; uy[o] = uv[1]; sea[o] = 1
      list.push(o)
    }
  }
  return { cols, rows, step, vx, vy, speed, ux, uy, vecs: [vx, vy, ux, uy], sea, list: Int32Array.from(list) }
}
// The screen velocity [px/s, px/s, m/s] at a pixel, or false where there is no flow.
export function fieldAt(f, x, y, out) {
  return bilinear([f.vx, f.vy, f.speed], f.sea, f.cols, f.rows, x / f.step, y / f.step, out)
}
// The same, between two fields of the same view for two hours: `t` is how far from `a` to `b` the time has gone (0 to 1). The flow is mixed as a
// vector, so a current that turns round between the hours slows to a stop on the way and does not jump, and its speed is the speed of the mixed
// vector, not the mix of the two speeds. Where only one of the fields has flow, that one is used.
const mixA = [0, 0, 0, 0], mixB = [0, 0, 0, 0]
export function fieldBlendAt(a, b, t, x, y, out) {
  const okA = bilinear(a.vecs, a.sea, a.cols, a.rows, x / a.step, y / a.step, mixA), okB = bilinear(b.vecs, b.sea, b.cols, b.rows, x / b.step, y / b.step, mixB)
  if (!okA && !okB) return false
  const wa = okA ? (okB ? 1 - t : 1) : 0, wb = okB ? (okA ? t : 1) : 0
  out[0] = wa * mixA[0] + wb * mixB[0]; out[1] = wa * mixA[1] + wb * mixB[1]
  out[2] = Math.hypot(wa * mixA[2] + wb * mixB[2], wa * mixA[3] + wb * mixB[3])
  return true
}

// Pixels the picture of the water moves per metre the water travels, typical of this view: the middle value
// over the field. It follows zoom (and tilt, near and far), so a caller can scale every velocity by one
// number to get the same speed on the screen at any zoom. NaN when the field has no flow.
export function fieldScale(f) {
  const step = Math.max(1, Math.floor(f.list.length / 1500)), ratios = []
  for (let k = 0; k < f.list.length; k += step) {
    const o = f.list[k]
    if (f.speed[o] > 1e-3) ratios.push(Math.hypot(f.vx[o], f.vy[o]) / f.speed[o])
  }
  if (!ratios.length) return NaN
  ratios.sort((a, b) => a - b)
  return ratios[Math.floor(ratios.length / 2)]
}

// ---- the readout for a click on the sea
const COMPASS = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west']
// The compass point nearest a bearing in degrees, clockwise from north, e.g. 50 is "north-east".
export const compassWord = (deg) => COMPASS[Math.round((((deg % 360) + 360) % 360) / 45) % 8]
const STILL_MS = 0.03 // below this a current is called almost still and given no direction
// A current [east, north] in m/s as speed in m/s and knots and the way it flows toward.
export function currentReadout([east, north]) {
  const ms = Math.hypot(east, north)
  if (!Number.isFinite(ms)) throw new Error('the current is not a number')
  return { ms, knots: ms * 3600 / 1852, still: ms < STILL_MS, toward: ms < STILL_MS ? null : compassWord(Math.atan2(east, north) * 180 / Math.PI) }
}

// ---- sea temperature and saltiness (ECCC GeoMet WCS, the CIOPS-SalishSea model): the model's numbers for each hour, coloured here
// Each hour is one GeoTIFF of 32-bit numbers over the same box and at the same size as the sea currents, read with readGeoTiff. The service's
// own pictures were not used: their colour styles run over about 30 degrees, so the 9 to 13 degree sea of the Salish Sea came out as one band
// of green. Here the numbers are coloured in the browser with a ramp that spans the Salish Sea's real range and is the same for every hour. The
// temperature layer is in kelvin, the key is in degrees Celsius.
export const SCALARS = {
  temperature: { layer: 'CIOPS-SalishSea_500m_SeaWaterPotentialTemp_0.5m', what: 'sea temperature', unit: '°C' },
  salinity: { layer: 'CIOPS-SalishSea_500m_SeaWaterSalinity_0.5m', what: 'sea saltiness', unit: 'psu' },
}
// The colour ramps: `colours` are the sRGB colours at `from`, `from + step`, `from + 2 * step` and so on. Between them the colour is a smooth
// curve through the points in CIELAB, a space where equal steps look about equally different, so the ramp has no bands and no muddy middle.
// Beyond the first and last the colour stays as it is. The range of each is one fixed scale, so a colour means the same at every hour. On 22
// October the sea held 9.4 to 13.2 degrees (median 11.7) and 12.6 to 32.3 psu (median 29.4, nine tenths of it between 26.6 and 31.2), and the
// ramps run wider than that on both sides to leave room for the seasons: 6 to 20 degrees puts October's range over a third of the ramp, from
// blue through teal to green, and 20 to 34 psu puts the saltiness over the middle of its ramp (see data/SOURCES.md).
const RAMPS = {
  temperature: { from: 6, step: 2, colours: [[47, 54, 148], [35, 112, 190], [28, 164, 196], [60, 190, 150], [140, 205, 95], [235, 215, 65], [245, 150, 40], [214, 60, 52]] },
  salinity: { from: 20, step: 2, colours: [[247, 236, 168], [196, 226, 140], [120, 204, 146], [58, 175, 168], [38, 136, 190], [52, 94, 178], [80, 66, 160], [66, 38, 120]] },
}
export const SCALE_RANGE = Object.fromEntries(Object.entries(RAMPS).map(([k, r]) => [k, [r.from, r.from + r.step * (r.colours.length - 1)]]))
// The ticks written under each key.
export const SCALE_TICKS = Object.fromEntries(Object.entries(RAMPS).map(([k, r]) => [k, r.colours.map((_, i) => r.from + r.step * i)]))

// sRGB to CIELAB (D65) and back, from the standard formulas (IEC 61966-2-1 and CIE 15).
const WHITE = [0.95047, 1, 1.08883]
const toLinear = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4 }
const fromLinear = (c) => 255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055)
const labF = (t) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116)
const labFInv = (t) => (t ** 3 > 216 / 24389 ? t ** 3 : (116 * t - 16) * 27 / 24389)
export function rgbToLab([r, g, b]) {
  const R = toLinear(r), G = toLinear(g), B = toLinear(b)
  const fx = labF((0.4124564 * R + 0.3575761 * G + 0.1804375 * B) / WHITE[0]), fy = labF(0.2126729 * R + 0.7151522 * G + 0.072175 * B), fz = labF((0.0193339 * R + 0.119192 * G + 0.9503041 * B) / WHITE[2])
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)]
}
export function labToRgb([l, a, b]) {
  const fy = (l + 16) / 116, X = labFInv(fy + a / 500) * WHITE[0], Y = labFInv(fy), Z = labFInv(fy - b / 200) * WHITE[2]
  const lin = [3.2404542 * X - 1.5371385 * Y - 0.4985314 * Z, -0.969266 * X + 1.8760108 * Y + 0.041556 * Z, 0.0556434 * X - 0.2040259 * Y + 1.0572252 * Z]
  return lin.map((c) => Math.round(Math.min(255, Math.max(0, fromLinear(Math.min(1, Math.max(0, c)))))))
}
const rampLab = {}
const rampOf = (kind) => {
  const r = RAMPS[kind]
  if (!r) throw new Error('the sea layer must be temperature or salinity')
  return (rampLab[kind] ||= r.colours.map(rgbToLab))
}
// The colour of the ramp at a value, [red, green, blue]. A uniform Catmull-Rom curve through the points, so the colour and its change are smooth.
export function rampColour(kind, v) {
  const lab = rampOf(kind), { from, step, colours } = RAMPS[kind]
  if (!Number.isFinite(v)) throw new Error('a number is needed')
  const x = Math.min(Math.max((v - from) / step, 0), lab.length - 1), i = Math.min(Math.floor(x), lab.length - 2), t = x - i
  if (t === 0) return colours[i].slice()
  if (t === 1) return colours[i + 1].slice()
  const p0 = lab[Math.max(i - 1, 0)], p1 = lab[i], p2 = lab[i + 1], p3 = lab[Math.min(i + 2, lab.length - 1)]
  return labToRgb(p1.map((_, k) => 0.5 * (2 * p1[k] + (p2[k] - p0[k]) * t + (2 * p0[k] - 5 * p1[k] + 4 * p2[k] - p3[k]) * t * t + (3 * p1[k] - p0[k] - 3 * p2[k] + p3[k]) * t * t * t)))
}
// 1024 colours across the ramp's range, three bytes each, for colouring a picture.
export const RAMP_STEPS = 1024
const luts = {}
export function rampLut(kind) {
  if (luts[kind]) return luts[kind]
  const [lo, hi] = SCALE_RANGE[kind], out = new Uint8ClampedArray(RAMP_STEPS * 3)
  for (let i = 0; i < RAMP_STEPS; i++) out.set(rampColour(kind, lo + (hi - lo) * i / (RAMP_STEPS - 1)), i * 3)
  return (luts[kind] = out)
}
// A CSS gradient for the key under the box, from the first value to the last, with a stop every half degree or psu. The browser mixes the colours
// between two stops in straight lines, which at that spacing is within 2 of the ramp in each channel, so the bar is the ramp.
export function rampGradient(kind) {
  const [lo, hi] = SCALE_RANGE[kind], n = Math.round((hi - lo) / 0.5)
  const stops = Array.from({ length: n + 1 }, (_, i) => `rgb(${rampColour(kind, lo + (hi - lo) * i / n).join(', ')}) ${Math.round(i / n * 1000) / 10}%`)
  return `linear-gradient(to right, ${stops.join(', ')})`
}

export function scalarCapabilitiesUrl(kind) {
  return `${GEOMET}?service=WMS&version=1.3.0&request=GetCapabilities&LAYER=${scalarOf(kind).layer}`
}
function scalarOf(kind) {
  const s = SCALARS[kind]
  if (!s) throw new Error('the sea layer must be temperature or salinity')
  return s
}
export const scalarTimes = (kind, xml) => layerTimes(xml, scalarOf(kind).layer, scalarOf(kind).what)
// The hour nearest `time` among the hours on offer (the first one wins a tie). Used to follow the sea currents.
export function nearestHour(times, time) {
  const t = Date.parse(time)
  if (!times.length || !Number.isFinite(t)) throw new Error('an hour is needed')
  return times.reduce((best, x) => (Math.abs(Date.parse(x) - t) < Math.abs(Date.parse(best) - t) ? x : best))
}
// The hour to show: the one nearest `follow` (the hour of the sea currents) when there is one, otherwise the
// latest hour not after now.
export function scalarHour(times, follow, now = Date.now()) {
  if (follow) return nearestHour(times, follow)
  const w = hourWindow(times, now)
  return w.times[w.at]
}
// One hour of the numbers over the box of the currents, as a GeoTIFF: the same request as for a component of the currents, for another coverage.
export function scalarUrl(kind, time) {
  const s = scalarOf(kind)
  if (!Number.isFinite(Date.parse(time))) throw new Error('an hour is needed')
  const [w, south, e, n] = CURRENTS_BOX
  const p = new URLSearchParams({ service: 'WCS', version: '2.0.1', request: 'GetCoverage', coverageid: s.layer, format: 'image/tiff', subsettingcrs: 'http://www.opengis.net/def/crs/EPSG/0/4326', scalefactor: String(CURRENTS_SCALE), time })
  p.append('subset', `x(${w},${e})`); p.append('subset', `y(${south},${n})`)
  return `${GEOMET}?${p}`
}
// The numbers of one hour as a grid in degrees Celsius or psu. A cell is sea where the number is believable: the temperature between 250 and 330 kelvin,
// the saltiness above 0 and not above 45. Exactly zero is how the model marks land, and anything else (NaN, a fill value) is no data. The grid has to
// cover everywhere the map can go, so a picture cannot land in the wrong place.
export function scalarGrid(kind, tiff) {
  scalarOf(kind)
  const { width, height, bbox, data } = tiff, v = new Float32Array(data.length), sea = new Uint8Array(data.length)
  let n = 0
  for (let i = 0; i < data.length; i++) {
    const raw = data[i]
    const ok = kind === 'temperature' ? raw >= 250 && raw <= 330 : raw > 0 && raw <= 45
    if (!ok) continue
    v[i] = kind === 'temperature' ? raw - 273.15 : raw; sea[i] = 1; n++
  }
  if (bbox[0] > REGION[0] || bbox[1] > REGION[1] || bbox[2] < REGION[2] || bbox[3] < REGION[3]) throw new Error('the grid does not cover the map area')
  if (n < data.length * 0.05) throw new Error('the grid has hardly any sea in it')
  // The sea mask blurred over a cell (weights 1, 2, 1 each way), so the edge drawn between sea and land is a smooth curve and not the staircase of 1 km cells.
  const soft = new Float32Array(data.length), at = (x, y) => (x >= 0 && y >= 0 && x < width && y < height ? sea[y * width + x] : 0)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      soft[y * width + x] = (at(x - 1, y - 1) + 2 * at(x, y - 1) + at(x + 1, y - 1) + 2 * (at(x - 1, y) + 2 * at(x, y) + at(x + 1, y)) + at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1)) / 16
    }
  }
  return { kind, width, height, bbox, v, sea, soft }
}
// The value at a place, bilinear between the cell centres that are sea (so it stops at the coast), or null on land and outside the grid.
export function scalarAt(g, lng, lat) {
  const [w, s, e, n] = g.bbox, out = [0]
  return bilinear([g.v], g.sea, g.width, g.height, (lng - w) / (e - w) * g.width - 0.5, (n - lat) / (n - s) * g.height - 0.5, out) ? out[0] : null
}
export const scalarText = (kind, value) => {
  if (!Number.isFinite(value)) throw new Error('the value is not a number')
  return `${(Math.round(value * 10) / 10).toFixed(1)} ${scalarOf(kind).unit}`
}
// The picture of one hour, `width` x `height` pixels over the area of `geometry` (web Mercator, as the radar picture), as RGBA bytes. Each pixel is
// coloured from the value at its place, so the colours are the ramp's and never a blend of two of them. The edge of the sea is drawn from the blurred
// mask (`soft`) and feathered over about half a cell, so the coast is a smooth curve and not a staircase of cells.
export function scalarPicture(g, geometry, width, height) {
  const lut = rampLut(g.kind), [lo, hi] = SCALE_RANGE[g.kind], data = new Uint8ClampedArray(width * height * 4)
  const [x0, y0, x1, y1] = geometry.bbox, [w, s, e, n] = g.bbox, cols = g.width, rows = g.height
  const fxs = new Float64Array(width)
  for (let x = 0; x < width; x++) fxs[x] = (((x + 0.5) / width * (x1 - x0) + x0) / 20037508.34 * 180 - w) / (e - w) * cols - 0.5
  for (let y = 0; y < height; y++) {
    const lat = (2 * Math.atan(Math.exp(((y1 - (y + 0.5) / height * (y1 - y0)) / 20037508.34) * Math.PI)) - Math.PI / 2) * 180 / Math.PI
    const fy = (n - lat) / (n - s) * rows - 0.5, j = Math.floor(fy), ty = fy - j
    for (let x = 0; x < width; x++) {
      const fx = fxs[x], i = Math.floor(fx), tx = fx - i
      let seaW = 0, sum = 0, softW = 0
      for (let k = 0; k < 4; k++) {
        const cx = i + (k & 1), cy = j + (k >> 1)
        if (cx < 0 || cy < 0 || cx >= cols || cy >= rows) continue
        const wt = (k & 1 ? tx : 1 - tx) * (k >> 1 ? ty : 1 - ty), at = cy * cols + cx
        softW += wt * g.soft[at]
        if (g.sea[at]) { seaW += wt; sum += wt * g.v[at] }
      }
      if (seaW === 0 || softW < 0.3) continue
      const o = (y * width + x) * 4, c = Math.round(Math.min(Math.max((sum / seaW - lo) / (hi - lo), 0), 1) * (RAMP_STEPS - 1)) * 3
      data[o] = lut[c]; data[o + 1] = lut[c + 1]; data[o + 2] = lut[c + 2]
      const a = Math.min((softW - 0.3) / 0.3, 1)
      data[o + 3] = Math.round(255 * a * a * (3 - 2 * a))
    }
  }
  return data
}

// The colour of a key at a value: between the measured points, and the end colour beyond them.
export function scaleColour(scale, v) {
  if (!scale.length || !Number.isFinite(v)) throw new Error('a scale and a number are needed')
  if (v <= scale[0][0]) return scale[0][1].slice()
  for (let i = 1; i < scale.length; i++) {
    if (v <= scale[i][0]) {
      const [v0, c0] = scale[i - 1], [v1, c1] = scale[i], f = (v - v0) / (v1 - v0)
      return c0.map((x, k) => Math.round(x + (c1[k] - x) * f))
    }
  }
  return scale.at(-1)[1].slice()
}
// A CSS gradient for a key, left (`from`) to right (`to`), with a stop at each measured point inside it.
export function scaleGradient(scale, from, to) {
  const stops = [from, ...scale.map((s) => s[0]).filter((v) => v > from && v < to), to].map((v) => `rgb(${scaleColour(scale, v).join(', ')}) ${(Math.round((v - from) / (to - from) * 1000) / 10)}%`)
  return `linear-gradient(to right, ${stops.join(', ')})`
}

// ---- the Night look: the basemap's own colours, darkened
// The basemap (OpenFreeMap's Positron) is pale. Its colours are turned into a dark set in the browser, each by what it is for (`role`): the
// ground and the sea get set colours, text becomes light and its halo dark, and everything else keeps its look turned about the ground: what
// was darker than the land becomes lighter than the ground by about the same, and what was lighter (white roads) a little lighter still. The hue is
// kept and the chroma reduced. OpenFreeMap also serves a dark style of its own, which was not used: it has no documentation and its labels are
// grey on black.
export const NIGHT_GROUND = [30, 34, 40]
export const NIGHT_SEA = [13, 31, 50]
const NIGHT_WATERLINE = [28, 58, 80]
const LAND_L = 96.4 // the lightness (CIELAB) of the Positron land, which is the ground the other colours are measured from
const clampL = (l) => Math.min(100, Math.max(0, l))
// A colour [red, green, blue, alpha] for a role: 'ground', 'sea', 'waterline', 'text', 'halo' or 'feature' (anything else drawn on the map).
export function nightColour([r, g, b, a], role) {
  if (role === 'ground') return [...NIGHT_GROUND, a]
  if (role === 'sea') return [...NIGHT_SEA, a]
  if (role === 'waterline') return [...NIGHT_WATERLINE, a]
  const [l, la, lb] = rgbToLab([r, g, b])
  let l2, chroma
  if (role === 'text') { l2 = 94 - 0.5 * l; chroma = 1 } // black text becomes near white, grey text a lighter grey
  else if (role === 'halo') { l2 = 6 + 0.12 * (100 - l); chroma = 0.5 } // a white halo becomes near black
  else if (role === 'feature') { l2 = l < LAND_L ? 13 + (LAND_L - l) * 0.9 : 13 + (l - LAND_L) * 2.5; chroma = 0.7 }
  else throw new Error(`no such role: ${role}`)
  return [...labToRgb([clampL(l2), la * chroma, lb * chroma]), a]
}
// A colour of a style (a CSS colour as a string, or an expression holding some) turned to its Night colour. `parse` turns a colour string into
// [red, green, blue, alpha] (alpha 0 to 1), or null for a string that is not a colour (the name of an operator or a field). Other values stay.
export function nightValue(value, role, parse) {
  if (typeof value === 'string') {
    const c = /^(#|rgb|hsl)/i.test(value) ? parse(value) : null
    if (!c) return value
    const [r, g, b, a] = nightColour(c, role)
    return `rgba(${r}, ${g}, ${b}, ${Math.round(a * 1000) / 1000})`
  }
  return Array.isArray(value) ? value.map((v) => nightValue(v, role, parse)) : value
}
// Which role each colour of a basemap layer has. `layer` is a layer of the style, `prop` the name of the paint property.
export function nightRole(layer, prop) {
  if (layer.type === 'background') return 'ground'
  if (layer.type === 'symbol') return prop === 'text-halo-color' || prop === 'icon-halo-color' ? 'halo' : 'text'
  if (layer.type === 'fill' && layer['source-layer'] === 'water') return 'sea'
  if (layer['source-layer'] === 'waterway') return 'waterline'
  return 'feature'
}

// ---- tides and tidal currents (NOAA CO-OPS predictions)
export const NOAA_API = 'https://api.tidesandcurrents.noaa.gov/api/prod/datagetter'
const TIDE_APP = 'greater-victoria-map' // the application name NOAA asks callers to send
export const TIDE_STATIONS = [
  // Names and positions are NOAA's, from its station metadata read on 2026-10-22. `series` says whether NOAA gave a
  // continuous series (every 30 minutes) as well as the highs and lows or the slacks and maximums on that day. The two
  // stations that do not are drawn between their predicted times, and the popup says so.
  { id: '9444090', kind: 'level', name: 'Port Angeles', short: 'Port Angeles', coords: [-123.44, 48.125], series: true },
  { id: '9449880', kind: 'level', name: 'Friday Harbor', short: 'Friday Harbor', coords: [-123.0125, 48.54528], series: true },
  { id: 'PUG1640', kind: 'current', name: 'Race Rocks, 4.5 mi. S of', short: 'Race Rocks', coords: [-123.5323, 48.2232], series: true },
  { id: 'PUG1636', kind: 'current', name: 'Discovery Island, 7.6 mi. SSE of', short: 'Discovery Island', coords: [-123.16716, 48.30015], series: true },
  { id: 'PUG1718', kind: 'current', name: 'Haro Strait, 1.2 nm west of Kellett Bluff', short: 'Haro Strait', coords: [-123.22583, 48.58872], series: true },
  { id: 'PCT1391', kind: 'current', name: 'Trial Island, 5.2 miles SSW of', short: 'Trial Island', coords: [-123.36667, 48.31667], series: false },
  { id: 'PCT1416', kind: 'current', name: 'Cattle Point, 2.8 miles SSW of', short: 'Cattle Point', coords: [-123, 48.4], series: false },
  // The one gauge of the Canadian Hydrographic Service (CHS), asked in place of NOAA: observed and predicted levels, from its own
  // service (IWLS). Its name, code, id and position are the service's, read on 2026-10-22.
  { id: '07120', kind: 'level', source: 'chs', chsId: '5cebf1df3d0f4a073c4bbd1e', name: 'Victoria Harbour', short: 'Victoria Harbour', coords: [-123.370828, 48.424363], series: true },
]
export const tideStation = (id) => TIDE_STATIONS.find((s) => s.id === id) || null
export function tideFeatures() {
  return collection(TIDE_STATIONS.map((s) => feature(s.coords, { id: s.id, kind: s.kind, name: s.name, short: s.short })))
}
const TIDE_BEFORE_H = 8, TIDE_AFTER_H = 30 // the span asked for, in hours around now: wide enough that an event lies each side of the curve
// "20261022 08:00", the time format NOAA asks for, in UTC.
const noaaStamp = (t) => new Date(t).toISOString().slice(0, 16).replace('T', ' ').replace(/-/g, '')
// The requests for one station: the highs and lows (water level) or the slacks and maximums (currents), and, where
// NOAA gives one, a series every 30 minutes for the curve. Times are asked for and read in UTC.
export function tideUrls(station, now = Date.now()) {
  if (!tideStation(station?.id) || station.source === 'chs') throw new Error('unknown tide station')
  const level = station.kind === 'level'
  const base = { application: TIDE_APP, format: 'json', time_zone: 'gmt', begin_date: noaaStamp(now - TIDE_BEFORE_H * 3600e3), end_date: noaaStamp(now + TIDE_AFTER_H * 3600e3), station: station.id }
  Object.assign(base, level ? { product: 'predictions', datum: 'MLLW', units: 'metric' } : { product: 'currents_predictions', units: 'english' })
  const url = (interval) => `${NOAA_API}?${new URLSearchParams({ ...base, interval })}`
  return { events: url(level ? 'hilo' : 'MAX_SLACK'), series: station.series ? url('30') : null }
}
const noaaMs = (s) => (typeof s === 'string' && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(s) ? Date.parse(`${s.replace(' ', 'T')}:00Z`) : NaN)
const noaaNum = (v) => { const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v; return typeof n === 'number' && Number.isFinite(n) ? n : null }
// The replies for one station as one plain object: { events: [{ ms, type, value }], series: [{ ms, v }] or null,
// feet, floodDir, ebbDir, bin }. Types are high and low for a water level and slack, flood and ebb for currents.
// Heights are metres above the chart datum (MLLW), speeds are knots (flood positive, ebb negative).
export function normaliseTide(station, eventsReply, seriesReply = null) {
  const level = station.kind === 'level'
  if (eventsReply?.error) throw new Error('NOAA gave no predictions for this station')
  const rows = level ? eventsReply?.predictions : eventsReply?.current_predictions?.cp
  if (!Array.isArray(rows)) throw new Error('the reply held no predictions')
  const out = { id: station.id, kind: station.kind, events: [], series: null, feet: null, floodDir: null, ebbDir: null, bin: null }
  const typeOf = level ? { H: 'high', L: 'low' } : { slack: 'slack', flood: 'flood', ebb: 'ebb' }
  for (const r of rows) {
    const ms = noaaMs(level ? r?.t : r?.Time), type = typeOf[level ? r?.type : r?.Type], v = noaaNum(level ? r?.v : r?.Velocity_Major)
    if (!Number.isFinite(ms) || !type || v == null) continue
    out.events.push({ ms, type, value: v === 0 ? 0 : v })
    if (!level && out.bin === null) {
      out.feet = noaaNum(r.Depth); out.floodDir = noaaNum(r.meanFloodDir); out.ebbDir = noaaNum(r.meanEbbDir)
      out.bin = typeof r.Bin === 'string' && /^\d{1,3}$/.test(r.Bin) ? r.Bin : null
    }
  }
  out.events.sort((a, b) => a.ms - b.ms)
  if (!out.events.length) throw new Error('the reply held no usable predictions')
  // A continuous series has no event type. A reply that holds only events (some stations) is not one.
  const serial = level ? seriesReply?.predictions : seriesReply?.current_predictions?.cp
  if (Array.isArray(serial)) {
    const pts = serial.filter((r) => !(level ? r?.type : r?.Type)).map((r) => ({ ms: noaaMs(level ? r?.t : r?.Time), v: noaaNum(level ? r?.v : r?.Velocity_Major) })).filter((p) => Number.isFinite(p.ms) && p.v != null).sort((a, b) => a.ms - b.ms)
    if (pts.length >= 24) out.series = pts
  }
  return out
}
// The next event of each kind after now.
export function tideNext(tide, now = Date.now()) {
  const next = (type) => tide.events.find((e) => e.type === type && e.ms > now) || null
  return tide.kind === 'level' ? { high: next('high'), low: next('low') } : { slack: next('slack'), flood: next('flood'), ebb: next('ebb') }
}
// Linear interpolation of a series [{ ms, v }] at a time, or null outside it.
export function valueAt(points, ms) {
  if (!points.length || ms < points[0].ms || ms > points.at(-1).ms) return null
  const i = points.findIndex((p) => p.ms >= ms)
  if (i === 0 || points[i].ms === ms) return points[i].v
  const a = points[i - 1], b = points[i]
  return a.v + (b.v - a.v) * (ms - a.ms) / (b.ms - a.ms)
}
// The points of the curve between `from` and `to`: NOAA's own series where it gave one. Where it did not, a curve
// drawn between the predicted events, easing from each to the next like a half cosine (`drawn` is then true).
export function tideCurve(tide, from, to, stepMs = 600e3) {
  const pts = []
  if (tide.series) {
    const inside = tide.series.filter((p) => p.ms > from && p.ms < to)
    const a = valueAt(tide.series, from), b = valueAt(tide.series, to)
    if (a != null) pts.push({ ms: from, v: a })
    pts.push(...inside)
    if (b != null) pts.push({ ms: to, v: b })
    return { points: pts, drawn: false }
  }
  const ev = tide.events
  for (let t = from; t <= to; t += stepMs) {
    const j = ev.findIndex((e) => e.ms >= t)
    if (j <= 0 && !(j === 0 && ev[0].ms === t)) continue // before the first event or after the last: nothing to draw from
    const e1 = ev[j], e0 = j === 0 ? e1 : ev[j - 1], f = e1.ms === e0.ms ? 1 : (t - e0.ms) / (e1.ms - e0.ms)
    pts.push({ ms: t, v: e0.value + (e1.value - e0.value) * (1 - Math.cos(Math.PI * f)) / 2 })
  }
  return { points: pts, drawn: true }
}
const pathOf = (points, x, y) => points.map((p, i) => `${i ? 'L' : 'M'}${Math.round(x(p.ms) * 10) / 10} ${Math.round(y(p.v) * 10) / 10}`).join(' ')
// The path of another series on the same drawing (the observed levels over the predicted ones), from `x` and `y` of its geometry.
export const curvePath = (points, g) => pathOf(points, g.x, g.y)
// The drawing of a curve, as numbers for an SVG: the path, the place of "now" on it and of the zero line (currents).
// Heights fill the plot with a margin. Currents are drawn about zero, so that flood is above the line and ebb below it.
export function curveGeometry(points, kind, { from, to, now, width = 260, height = 92, pad = { l: 8, r: 8, t: 8, b: 20 }, scaleWith = [] }) {
  if (points.length < 2) throw new Error('a curve needs two points')
  const vs = [...points, ...scaleWith].map((p) => p.v)
  let lo = Math.min(...vs), hi = Math.max(...vs)
  if (kind === 'current') { const m = Math.max(Math.abs(lo), Math.abs(hi), 0.5) * 1.1; lo = -m; hi = m } else { const m = (hi - lo || 1) * 0.08; lo -= m; hi += m }
  const x = (ms) => pad.l + (ms - from) / (to - from) * (width - pad.l - pad.r)
  const y = (v) => pad.t + (hi - v) / (hi - lo) * (height - pad.t - pad.b)
  const r = (n) => Math.round(n * 10) / 10
  const at = valueAt(points, now)
  return {
    d: pathOf(points, x, y),
    nowX: r(x(now)), nowY: at == null ? null : r(y(at)), nowValue: at,
    zeroY: kind === 'current' ? r(y(0)) : null, top: pad.t, bottom: height - pad.b, left: pad.l, right: width - pad.r,
    min: Math.min(...vs), max: Math.max(...vs), x, y,
  }
}
// A time in Pacific time for a tide popup: the clock time ("10:09 a.m.") for today, and the date too for another day.
export function tideClock(ms, now = Date.now()) {
  const zone = { timeZone: 'America/Vancouver' }
  const day = (t) => new Intl.DateTimeFormat('en-CA', { ...zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(t)
  const clock = new Intl.DateTimeFormat('en-CA', { ...zone, hour: 'numeric', minute: '2-digit' }).format(ms)
  if (day(ms) === day(now)) return clock
  return `${new Intl.DateTimeFormat('en-CA', { ...zone, month: 'short', day: 'numeric' }).format(ms)}, ${clock}`
}
// Pacific clock hours that fall on a multiple of six (midnight, 6, noon, 18) between two times, for the axis.
export function curveTicks(from, to) {
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Vancouver', hour: 'numeric', minute: 'numeric', hourCycle: 'h23' })
  const out = []
  for (let t = Math.ceil(from / 3600e3) * 3600e3; t <= to; t += 3600e3) {
    const parts = Object.fromEntries(fmt.formatToParts(t).map((p) => [p.type, p.value]))
    if (Number(parts.minute) === 0 && Number(parts.hour) % 6 === 0) out.push({ ms: t, hour: Number(parts.hour) })
  }
  return out
}

// ---- Victoria Harbour tide gauge (Canadian Hydrographic Service, IWLS): observed and predicted water level
// Asked for when its popup opens, and for nothing else: three small requests, spaced apart because the service allows 3 a second
// and 30 a minute for each visitor.
export const IWLS_API = 'https://api-iwls.dfo-mpo.gc.ca/api/v1/stations'
export const IWLS_SPACING_MS = 400 // between the requests of one popup
const IWLS_BEHIND_H = 3, IWLS_AHEAD_H = 21, IWLS_EVENTS_H = 30 // the curve runs 3 hours behind now to 21 ahead. The highs and lows look 30 ahead
const iwlsStamp = (t) => `${new Date(t).toISOString().slice(0, 16)}:00Z` // "2026-10-22T18:10:00Z"
export function iwlsUrls(station, now = Date.now()) {
  if (!tideStation(station?.id) || station.source !== 'chs' || !/^[0-9a-f]{24}$/.test(station.chsId || '')) throw new Error('not a CHS station')
  const url = (code, from, to, resolution) => `${IWLS_API}/${station.chsId}/data?${new URLSearchParams({ 'time-series-code': code, from: iwlsStamp(from), to: iwlsStamp(to), ...(resolution ? { resolution } : {}) })}`
  const h = 3600e3
  return {
    hilo: url('wlp-hilo', now, now + IWLS_EVENTS_H * h), // the next highs and lows (no type given: told apart in normaliseIwls)
    observed: url('wlo', now - IWLS_BEHIND_H * h, now, 'FIVE_MINUTES'), // what the gauge has measured
    predicted: url('wlp', now - IWLS_BEHIND_H * h, now + IWLS_AHEAD_H * h, 'FIFTEEN_MINUTES'), // the curve
  }
}
// The rows of a reply as [{ ms, v, reviewed }] in time order, or null if it is not a list. A reading flagged questionable (3), one
// with no number or a height no harbour reaches, and one with no time are dropped.
function iwlsRows(reply) {
  if (!Array.isArray(reply)) return null
  return reply.map((r) => ({ ms: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(r?.eventDate) ? Date.parse(r.eventDate) : NaN, v: num(r?.value), reviewed: r?.reviewed === true, flag: r?.qcFlagCode }))
    .filter((r) => Number.isFinite(r.ms) && r.v != null && r.v > -5 && r.v < 15 && r.flag !== '3').sort((a, b) => a.ms - b.ms)
}
// The replies for the gauge as the same plain object NOAA's give: events [{ ms, type, value }] (the highs and lows, told apart by
// their neighbours, because high and low come in turn), series [{ ms, v }] or null, and also observed [{ ms, v }] and latest
// { ms, v, reviewed } (the newest reading) or null. Heights are metres above chart datum. A reply with no highs or lows is refused.
// Predicted levels and observed ones are optional: a station is still shown with the highs and lows alone.
export function normaliseIwls(station, hiloReply, predictedReply = null, observedReply = null) {
  if (station?.source !== 'chs') throw new Error('not a CHS station')
  const hilo = iwlsRows(hiloReply)
  if (!hilo?.length) throw new Error('the reply held no highs and lows')
  // The next one is high when it stands above the one after it, and the last is the opposite of the one before it.
  const events = hilo.map((e, i) => {
    const high = i < hilo.length - 1 ? e.v > hilo[i + 1].v : (hilo.length > 1 ? !(hilo[i - 1].v > e.v) : null)
    return { ms: e.ms, type: high ? 'high' : 'low', value: e.v, known: high != null }
  })
  if (events.some((e) => !e.known)) throw new Error('could not tell a high from a low in a reply of one')
  const out = { id: station.id, kind: 'level', source: 'chs', events: events.map(({ ms, type, value }) => ({ ms, type, value })), series: null, observed: [], latest: null, feet: null, floodDir: null, ebbDir: null, bin: null }
  const pred = iwlsRows(predictedReply)
  if (pred && pred.length >= 24) out.series = pred.map(({ ms, v }) => ({ ms, v }))
  const obs = iwlsRows(observedReply)
  if (obs?.length) {
    out.observed = obs.map(({ ms, v }) => ({ ms, v }))
    out.latest = { ms: obs.at(-1).ms, v: obs.at(-1).v, reviewed: obs.at(-1).reviewed }
  }
  return out
}

// ---- seafloor depth, drawn from the elevation tiles (ETOPO1 below the waterline at tile zoom 10 and under)
// Metres below sea level and the colour of each, shallow to deep. The colour fades in between DEPTH_FADE_FROM and the
// first depth and is left out above that: the coarse data puts the shore a kilometre or so out, so colouring the
// shallows would tint land.
export const DEPTH_FADE_FROM = 10
export const DEPTH_STOPS = [[25, [150, 202, 222]], [50, [105, 170, 214]], [100, [66, 130, 192]], [200, [44, 92, 160]], [300, [32, 66, 128]]]
// The MapLibre colour ramp over elevation (metres, negative below the sea): transparent from the waterline down to
// DEPTH_FADE_FROM, then fading in to the first colour and deepening to the last.
export function depthExpression(stops = DEPTH_STOPS, fadeFrom = DEPTH_FADE_FROM) {
  const rgb = (c, a = 1) => `rgba(${c.join(',')},${a})`
  const ramp = []
  for (const [d, c] of [...stops].reverse()) ramp.push(-d, rgb(c))
  return ['interpolate', ['linear'], ['elevation'], ...ramp, -fadeFrom, rgb(stops[0][1], 0), 0, rgb(stops[0][1], 0)]
}

// ---- seafloor depth from the Canadian Hydrographic Service (CHS NONNA), drawn over the ETOPO1 colours in Canadian waters
// The visitor's browser asks CHS for map tiles (100 m cells, and 10 m cells close up) and paints them again here, so nothing of
// CHS is stored on this site. The server draws depth in its own colours, a red to green to blue rainbow, and has only that one
// style, so each pixel's colour is read back to metres and painted in this map's blues: one layer, one key. Not for navigation.
export const NONNA_HOST = 'https://nonna-geoserver.data.chs-shc.ca'
export const NONNA_LAYERS = { 100: 'NONNA 100', 10: 'NONNA 10' }
export const NONNA_MAX_ZOOM = { 100: 11, 10: 14 } // the last tile zoom asked for. Beyond it the map stretches the tile
export const NONNA_CLOSE_ZOOM = 11 // from this map zoom the 10 m tiles are drawn, below it the 100 m ones
// The server's colour ramp, fitted on 2026-10-22 to 424,060 places where its own depth grid (WCS) and its picture (WMS) were read
// together: straight lines between these points in red, green and blue (rms error 0.5, 0.7 and 1.2 of 255). Metres below chart
// datum and the colour. Heights above chart datum (land) run the other way, from the first point to a brown.
export const NONNA_RAMP = [[0, [195, 0, 0]], [10, [194, 194, 0]], [15, [0, 194, 0]], [30, [9, 102, 195]], [100, [0, 56, 149]], [1000, [2, 0, 107]]]
export const NONNA_LAND = [[0, [195, 0, 0]], [-100, [148, 83, 0]]]
export const NONNA_MIN_DEPTH = 1 // shallower than this (and land) is left uncoloured
const NONNA_OFF_RAMP = 40 // a colour this far from every point of the ramp (of 441) is not a depth
// ETOPO1's colours start at 25 m, because its grid puts the shore a kilometre or so out. CHS's depths are good to the shore, so the
// key gets two more stops down to 1 m, each a little bluer and no lighter than the sea of the basemap, so that the colour still
// reads as deeper than the sea around it and not as a haze over it.
export const NONNA_STOPS = [[1, [170, 200, 225]], [10, [160, 201, 224]], ...DEPTH_STOPS]
export const nonnaTileUrl = (res, z, x, y) => {
  if (!NONNA_LAYERS[res] || ![z, x, y].every((n) => Number.isInteger(n) && n >= 0)) throw new Error('not a NONNA tile')
  // The service's standard Web Mercator grid (EPSG:900913), tile rows from the top, as MapLibre asks for them.
  return `${NONNA_HOST}/geoserver/gwc/service/wmts/rest/nonna:${encodeURIComponent(NONNA_LAYERS[res])}/raster/EPSG:900913/EPSG:900913:${z}/${y}/${x}?format=image/png`
}
// Metres below chart datum for one colour of the server's picture, or null for land, a drying height or a colour that is not on
// the ramp. The nearest point on the ramp's straight lines in colour space wins, and a colour nearer the land line is land.
export function nonnaDepth(r, g, b) {
  let best = Infinity, depth = null
  for (const [ramp, sign] of [[NONNA_RAMP, 1], [NONNA_LAND, -1]]) {
    for (let i = 1; i < ramp.length; i++) {
      const [d0, c0] = ramp[i - 1], [d1, c1] = ramp[i]
      const vx = c1[0] - c0[0], vy = c1[1] - c0[1], vz = c1[2] - c0[2]
      const t = Math.min(1, Math.max(0, ((r - c0[0]) * vx + (g - c0[1]) * vy + (b - c0[2]) * vz) / (vx * vx + vy * vy + vz * vz)))
      const dist = Math.hypot(r - (c0[0] + t * vx), g - (c0[1] + t * vy), b - (c0[2] + t * vz))
      if (dist < best) { best = dist; depth = sign > 0 ? d0 + t * (d1 - d0) : null }
    }
  }
  return best <= NONNA_OFF_RAMP ? depth : null
}
// This map's colour for a depth in metres: straight lines between the key's stops, the end colour beyond them.
export const nonnaColour = (depth) => scaleColour(NONNA_STOPS, depth)
// The server's picture has a hairline with no data where two of its 0.1 degree sheets meet (1 or 2 pixels wide, all along the tile).
// Fill any run of NONNA_GAP_MAX pixels or fewer with no data that has data on both sides, along a row and then down a column, with
// the colour of the pixel before it, so the grid of sheets does not show as lines across the sea. Wider gaps are real and are left.
// A hairline that falls on the edge of a tile is filled from the line inside it.
export const NONNA_GAP_MAX = 2
export function nonnaFill(rgba, width, maxRun = NONNA_GAP_MAX) {
  if (!(rgba?.length % 4 === 0) || !Number.isInteger(width) || width < 1 || (rgba.length / 4) % width !== 0) throw new Error('a tile and its width are needed')
  const height = rgba.length / 4 / width
  let filled = 0
  const data = (i) => rgba[i + 3] >= 128
  // One pass along a line of `count` pixels that start at pixel `start` and are `step` pixels apart.
  const pass = (start, step, count) => {
    let before = -1 // the last pixel with data, and where the run of pixels without it began
    let runFrom = -1
    for (let k = 0; k < count; k++) {
      const i = (start + k * step) * 4
      if (data(i)) {
        if (before >= 0 && runFrom >= 0 && k - runFrom <= maxRun) {
          for (let j = runFrom; j < k; j++) { const o = (start + j * step) * 4; rgba[o] = rgba[before]; rgba[o + 1] = rgba[before + 1]; rgba[o + 2] = rgba[before + 2]; rgba[o + 3] = 255; filled++ }
        }
        before = i; runFrom = -1
      } else if (runFrom < 0) runFrom = k
    }
  }
  for (let y = 0; y < height; y++) pass(y * width, 1, width)
  for (let x = 0; x < width; x++) pass(x, width, height)
  // The same hairline can lie along the very edge of a tile, with its other side in the next tile. A whole row or column at the edge
  // (95% or more of it empty) of maxRun lines or fewer, with a line inside it that is at least half drawn, is filled from that line.
  const share = (start, step, count) => { let n = 0; for (let k = 0; k < count; k++) if (data((start + k * step) * 4)) n++; return n / count }
  const edge = (lineStart, lineCount, along, alongStep) => {
    // Lines are numbered from the edge inward. `lineStart(k)` is the first pixel of line k.
    let run = 0
    while (run < lineCount && share(lineStart(run), alongStep, along) <= 0.05) run++
    if (run < 1 || run > maxRun || run >= lineCount || share(lineStart(run), alongStep, along) < 0.5) return
    for (let k = 0; k < run; k++) for (let j = 0; j < along; j++) {
      const src = (lineStart(run) + j * alongStep) * 4, dst = (lineStart(k) + j * alongStep) * 4
      if (!data(dst) && data(src)) { rgba[dst] = rgba[src]; rgba[dst + 1] = rgba[src + 1]; rgba[dst + 2] = rgba[src + 2]; rgba[dst + 3] = 255; filled++ }
    }
  }
  edge((k) => k * width, height, width, 1) // top rows
  edge((k) => (height - 1 - k) * width, height, width, 1) // bottom rows
  edge((k) => k, width, height, width) // left columns
  edge((k) => width - 1 - k, width, height, width) // right columns
  return filled
}
// Paint a tile again, in place. `rgba` is the pixels of the server's picture (a Uint8ClampedArray). Each pixel with a depth of
// NONNA_MIN_DEPTH or more becomes this map's colour for it, already mixed with the colour of the sea under it at the layer's
// opacity, and made opaque, so that the coarse ETOPO1 colours below do not show through it. Every other pixel becomes clear.
// `cache` keeps the answer for each colour met, because a tile holds a few hundred colours in its 65,536 pixels.
export function nonnaPaint(rgba, sea, opacity, cache = new Map(), width = Math.round(Math.sqrt(rgba?.length / 4))) {
  if (!(rgba?.length % 4 === 0) || sea?.length !== 3 || !(opacity > 0 && opacity <= 1)) throw new Error('a tile, the sea colour and an opacity are needed')
  nonnaFill(rgba, width)
  let painted = 0
  for (let i = 0; i < rgba.length; i += 4) {
    let out = -1
    if (rgba[i + 3] >= 128) {
      const key = (rgba[i] << 16) | (rgba[i + 1] << 8) | rgba[i + 2]
      out = cache.get(key)
      if (out === undefined) {
        const d = nonnaDepth(rgba[i], rgba[i + 1], rgba[i + 2])
        if (d == null || d < NONNA_MIN_DEPTH) out = -1
        else { const c = nonnaColour(d).map((v, k) => Math.round(v * opacity + sea[k] * (1 - opacity))); out = (c[0] << 16) | (c[1] << 8) | c[2] }
        cache.set(key, out)
      }
    }
    if (out < 0) { rgba[i + 3] = 0; continue }
    rgba[i] = out >> 16; rgba[i + 1] = (out >> 8) & 255; rgba[i + 2] = out & 255; rgba[i + 3] = 255
    painted++
  }
  return painted
}
// The key under the box, from `from` to `to` metres in this map's colours (the first stop shallower than `from` sets the start).
export const NONNA_TICKS = [10, 50, 100, 200, 300]
export const nonnaGradient = (from = 0, to = DEPTH_STOPS.at(-1)[0]) => scaleGradient(NONNA_STOPS, from, to)

// ---- the notices the two Canadian Hydrographic Service licences require
// Each licence asks for its notice "in a prominent location" on a product made from its data. These are the licences' own words,
// with the place for the user's name filled in. The IWLS licence (tides.gc.ca, dated 2023-08-14) leaves no full stop at the end of
// its notice. The NONNA licence is the PDF linked from the catalogue record. Both were read on 2026-10-22.
export const CHS_USER = 'Darren Zal'
export const IWLS_LICENCE_URL = 'https://tides.gc.ca/en/licence-agreement'
export const NONNA_LICENCE_URL = 'https://api-proxy.edh-cde.dfo-mpo.gc.ca/catalogue/records/d3881c4c-650d-4070-bf9b-1e00aabf0a1d/attachments/CHS_NONNA_LICENCE-LICENCE_NONNA_DU_SHC.pdf'
export const IWLS_NOTICE = `This product is not to be used for navigation. This product was made by or for the User ${CHS_USER} and contains intellectual property (Data) of the Canadian Hydrographic Service of the Department of Fisheries and Oceans. The copyrights in the Data are and remain the property of His Majesty the King in Right of Canada and shall not be sold, licensed, leased, assigned or given to a third party. The incorporation of the Data in this product does not constitute an endorsement or an approval of this product by the Canadian Hydrographic Service, the Department of Fisheries and Oceans or His Majesty the King in Right of Canada`
export const NONNA_NOTICE = `This product was made by ${CHS_USER} and contains intellectual property of the Canadian Hydrographic Service (CHS) of the Department of Fisheries and Oceans. This product does not meet the requirements of the Navigation Safety Regulations, 2020 under the Canada Shipping Act, 2001. Charts and publications issued by or on the authority of CHS must be used to meet the requirements of those regulations. The copyright in the data are and remain the property of His Majesty the King in Right of Canada and shall not be sold, licensed, leased, assigned or given to a third party. The incorporation of CHS data in this product does not constitute an endorsement or an approval of this product by the Canadian Hydrographic Service, the Department of Fisheries and Oceans or His Majesty the King in Right of Canada.`

// ---- marine life and protection: seven files in data/, built by scripts/fetch-layers.sh from open government data
// None shows where an animal is now. The protected areas, the critical habitat and the CRIMS survey are drawn from
// fixed boundaries and old records, and the density layer is a model of summer 2018 ship surveys.
export const MARINE_FILES = {
  protected: 'data/marine-protected.geojson', srkw: 'data/srkw-habitat.geojson', cetaceans: 'data/whale-density.geojson',
  kelp: 'data/kelp.geojson', eelgrass: 'data/eelgrass.geojson', herring: 'data/herring-spawn.geojson', seabirds: 'data/seabird-colonies.geojson',
}
// The vessel distances, said wherever whales appear. The 1,000 m rule is Transport Canada Ship Safety Bulletin 08/2026 (the
// Interim Order, in force from June 1, 2026 to May 31, 2027). The 200 m and 100 m rules are the Marine Mammal Regulations,
// Schedule VI (read 2026-10-22). The bulletin lists exceptions, for example for vessels in transit.
export const WHALE_RULES = 'Vessels must stay at least 1,000 m from Southern Resident killer whales from June 1, 2026 to May 31, 2027, at least 200 m from all other killer whales and at least 100 m from all other whales, dolphins and porpoises. Some exceptions apply.'
export const WHALE_RULE_LINKS = [
  { href: 'https://tc.canada.ca/en/marine-transportation/marine-safety/ship-safety-bulletins/protecting-killer-whales-waters-southern-british-columbia-2026-ssb-no-08-2026', label: 'Transport Canada Ship Safety Bulletin 08/2026 (the 1,000 m rule)' },
  { href: 'https://laws-lois.justice.gc.ca/eng/regulations/SOR-93-56/FullText.html', label: 'Marine Mammal Regulations, Schedule VI (the 200 m and 100 m rules)' },
]
export const OGL_CANADA_LINE = 'Contains information licensed under the Open Government Licence – Canada.'
const OGL_BC_LINE = 'Contains information licensed under the Open Government Licence – British Columbia.'
const CRIMS_SOURCE = `Source: Coastal Resource Information Management System (CRIMS), Province of British Columbia. A legacy survey that began in 1979 and was only updated now and then. ${OGL_BC_LINE}`

// Names the sources publish in capitals ("RACE ROCKS ECOLOGICAL RESERVE") are shown in capitals and small letters. A name
// that already has small letters is shown as published.
const SMALL_WORDS = new Set(['of', 'and', 'the', 'in', 'on', 'at'])
export function tidyName(s) {
  const t = str(s, 120)
  if (!t) return null
  if (t !== t.toUpperCase() || t === t.toLowerCase()) return t
  return t.toLowerCase().replace(/(^|[\s(/-])(\p{L})(\p{L}*)/gu, (m, lead, first, rest, at) => (at > 0 && SMALL_WORDS.has(first + rest) ? m : lead + first.toUpperCase() + rest))
}
const lower = (s) => (typeof s === 'string' ? s.trim().toLowerCase() : '')
const sentence = (s) => (/[.!?]$/.test(s) ? s : `${s}.`)
const TYPE_TAGS = { 'A - Park': 'park (class A)', 'Other Effective Area-Based Conservation Measure': 'area-based conservation measure (OECM)' }
export const typeTag = (type) => TYPE_TAGS[type] || lower(type) || 'protected area'
// CPCAD's "Marine Resource Use" field: All, Part or None of the area is no-take. Anything else (not reported, not applicable) is not said.
export const NO_TAKE_WORDS = { 1: 'all of it', 2: 'part of it', 3: 'none of it' }

// What each popup says, as plain data: { title, tag, lines, source }. js/overlays.js turns it into text nodes.
export function protectedInfo(p) {
  const owner = str(p.owner, 200), year = Number.isInteger(p.year) && p.year > 1800 ? p.year : null
  return {
    title: tidyName(p.name) || 'Protected marine area',
    tag: typeTag(p.type),
    lines: [
      owner ? sentence(`Owner: ${owner}`) : null,
      year ? `Established ${year}.` : null,
      NO_TAKE_WORDS[p.no_take] ? `No-take area, as reported to CPCAD: ${NO_TAKE_WORDS[p.no_take]}.` : null,
      'This is the marine part of the protected area. Its land is not drawn here.',
    ].filter(Boolean),
    source: `Source: Canadian Protected and Conserved Areas Database (CPCAD). Boundaries are approximate and not for navigation. ${OGL_CANADA_LINE}`,
  }
}
export function srkwInfo(p) {
  return {
    title: 'Southern Resident killer whale critical habitat',
    tag: 'critical habitat, Species at Risk Act',
    lines: [
      'A mapped boundary, not a sighting. It does not show where the whales are now.',
      /final/i.test(String(p.status)) ? 'Mapped as final or proposed critical habitat.' : null,
      WHALE_RULES,
    ].filter(Boolean),
    source: `Source: Fisheries and Oceans Canada, Species at Risk critical habitat. For general guidance only. Not for navigation. ${OGL_CANADA_LINE}`,
  }
}

// The three species of the density model. Each is a column of Nhat ("<key>_n") and CV ("<key>_cv") in data/whale-density.geojson.
export const CETACEANS = {
  humpback: { name: 'Humpback whale', plural: 'humpback whales' },
  harbour: { name: 'Harbour porpoise', plural: 'harbour porpoises' },
  dalls: { name: 'Dall’s porpoise', plural: 'Dall’s porpoises' },
}
export const CETACEAN_CLASSES = 5
// Animals per 100 km2 from the model's Nhat (animals in the cell) and the cell's area. Cells cut by the coast are smaller than
// 25 km2 and hold fewer animals, so the colour is read from the density and not from Nhat.
export function cetaceanDensity(n, km2) {
  if (!Number.isFinite(n) || !Number.isFinite(km2) || n < 0 || km2 <= 0) throw new Error('a count and an area are needed')
  return n / km2 * 100
}
// The cells with a density column for each species ("d_<key>"), ready to draw. A cell that does not have all three numbers is dropped.
export function cetaceanCells(d) {
  const out = []
  for (const f of must(d)) {
    const p = f?.properties, km2 = num(p?.km2)
    if (!f.geometry || km2 == null || km2 <= 0) continue
    const props = { ...p }
    let ok = true
    for (const key of Object.keys(CETACEANS)) {
      const n = num(p[`${key}_n`]), cv = num(p[`${key}_cv`])
      if (n == null || n < 0 || cv == null) { ok = false; break }
      props[`d_${key}`] = cetaceanDensity(n, km2)
    }
    if (ok) out.push({ type: 'Feature', geometry: f.geometry, properties: props })
  }
  return collection(out)
}
// Class limits at equal shares of the cells (the 20th, 40th, 60th and 80th percentile), shown to 2 significant figures. They are
// strictly increasing, which a MapLibre `step` needs, and fewer than `classes - 1` if the values do not spread that far.
export function densityBreaks(values, classes = CETACEAN_CLASSES) {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b)
  if (v.length < classes) throw new Error('too few values to make classes')
  const out = []
  for (let i = 1; i < classes; i++) {
    const q = Number(v[Math.min(v.length - 1, Math.floor(v.length * i / classes))].toPrecision(2))
    if (q > 0 && (!out.length || q > out.at(-1))) out.push(q)
  }
  return out
}
export const densityClass = (value, breaks) => breaks.filter((b) => value >= b).length
// Five steps of one hue, light to dark. Drawn at 0.75 opacity over the pale sea of the basemap.
export const DENSITY_COLOURS = ['#e6d9f2', '#c4a6e0', '#9d6dc9', '#7340a6', '#47206b']
export function densityExpression(prop, breaks, colours = DENSITY_COLOURS) {
  if (breaks.length + 1 > colours.length) throw new Error('more classes than colours')
  const expr = ['step', ['get', prop], colours[0]]
  breaks.forEach((b, i) => expr.push(b, colours[i + 1]))
  return expr
}
// A key of stepped blocks, left to right, one block per class.
export function stepGradient(colours) {
  const w = 100 / colours.length
  return `linear-gradient(to right, ${colours.map((c, i) => `${c} ${Math.round(i * w * 10) / 10}%, ${c} ${Math.round((i + 1) * w * 10) / 10}%`).join(', ')})`
}
// A number shown to 2 significant figures, with the thousands separator.
export const fmt2 = (n) => Number(Number(n).toPrecision(2)).toLocaleString('en-CA', { maximumFractionDigits: 6 })
export function cetaceanInfo(p, key) {
  const sp = CETACEANS[key]
  if (!sp) throw new Error('unknown species')
  const n = num(p[`${key}_n`]), cv = num(p[`${key}_cv`]), km2 = num(p.km2)
  if (n == null || cv == null || km2 == null) throw new Error('the cell has no number for this species')
  return {
    title: `${sp.name}: modelled summer numbers`,
    tag: 'model of summer 2018 surveys',
    lines: [
      `The model predicts about ${fmt2(n)} ${n === 1 ? sp.plural.replace(/s$/, '') : sp.plural} in this cell (Nhat, for a cell of ${fmt2(km2)} km²).`,
      `That is about ${fmt2(cetaceanDensity(n, km2))} per 100 km².`,
      `Uncertainty (CV): ${cv.toFixed(2)}. Higher means less certain.`,
      'This is a model of ship surveys from July to early September 2018. It is not where animals are now, and no sighting is shown on this map.',
      WHALE_RULES,
    ],
    source: `Source: Fisheries and Oceans Canada, Pacific Region International Survey of Marine Megafauna (PRISMM), spatial density models. Not for navigation. ${OGL_CANADA_LINE}`,
  }
}

// CRIMS (coastal habitat). Every popup says the survey is old.
export function kelpInfo(p) {
  const species = str(p.species, 60), density = lower(p.density)
  return {
    title: species ? `${species.charAt(0).toUpperCase()}${species.slice(1).toLowerCase()} bed` : 'Kelp bed',
    tag: 'kelp bed',
    lines: [density ? `Density recorded: ${density}.` : null, 'Mapped in a survey that began in 1979, so the bed may have changed or gone.'].filter(Boolean),
    source: CRIMS_SOURCE,
  }
}
export function eelgrassInfo(p) {
  const year = Number.isInteger(p.year) && p.year > 1900 ? p.year : null
  return {
    title: 'Eelgrass bed',
    tag: 'eelgrass',
    lines: [year ? `Mapped in ${year}.` : null, 'This is an old survey, so the bed may have changed or gone.'].filter(Boolean),
    source: CRIMS_SOURCE,
  }
}
export function herringInfo(p) {
  const magnitude = lower(p.magnitude), consistency = lower(p.consistency)
  const from = Number.isInteger(p.first_year) ? p.first_year : null, to = Number.isInteger(p.last_year) ? p.last_year : null
  return {
    title: 'Herring spawn, shore',
    tag: 'herring spawn',
    lines: [
      magnitude ? `Spawn magnitude recorded: ${magnitude}.` : null,
      consistency ? `Spawning here was recorded as ${consistency}.` : null,
      from && to ? `The records run from ${from} to ${to}.` : null,
      'These are old records, not this year’s spawn.',
    ].filter(Boolean),
    source: CRIMS_SOURCE,
  }
}
export function seabirdInfo(p) {
  return {
    title: tidyName(p.name) || 'Seabird colony',
    tag: 'seabird colony',
    lines: ['A nesting colony recorded in a survey that began in 1979. Colonies change, so this may be out of date.', 'Nesting birds are easily disturbed by boats and people. Keep well back.'],
    source: CRIMS_SOURCE,
  }
}

// The status line of a marine layer, from the features that were loaded.
export function marineMessage(id, features) {
  const n = features.length, plural = (one, many) => `${n.toLocaleString('en-CA')} ${n === 1 ? one : many}`
  const years = (key) => features.map((f) => f.properties?.[key]).filter((y) => Number.isInteger(y) && y > 0)
  if (id === 'protected') return `${plural('marine zone', 'marine zones')} of protected areas in the area this map reaches.`
  if (id === 'srkw') return 'Shown for the area this map reaches.'
  if (id === 'kelp') return `${plural('kelp bed', 'kelp beds')}.`
  if (id === 'eelgrass') {
    const y = years('year')
    return `${plural('eelgrass bed', 'eelgrass beds')}${y.length ? `, mapped in ${Math.min(...y) === Math.max(...y) ? Math.min(...y) : `${Math.min(...y)} to ${Math.max(...y)}`}` : ''}.`
  }
  if (id === 'herring') {
    const a = years('first_year'), b = years('last_year')
    return `${plural('stretch of shore', 'stretches of shore')} with herring spawn recorded${a.length && b.length ? ` between ${Math.min(...a)} and ${Math.max(...b)}` : ''}.`
  }
  if (id === 'seabirds') return `${plural('seabird colony', 'seabird colonies')}. Keep well back from nesting birds.`
  throw new Error('unknown marine layer')
}
