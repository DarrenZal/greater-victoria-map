// Optional overlays for the Greater Victoria demo map. Plain ES module, no build step.
//
// Twelve live layers load from outside services straight from the visitor's browser, and ten
// static layers (ecoregions, industry and waste sites, seafloor depth and seven marine life and protection
// layers) draw from files and tiles this site already has, except that seafloor depth also asks the Canadian
// Hydrographic Service for tiles, and tides and tidal currents ask it for one gauge. Every one is off by default
// and makes no request until its box is ticked, or, for a tide station, its dot is clicked. Each shows a plain status line,
// and a plain failure line if its request fails. Parsing and filtering live in
// js/overlays-data.js, which has no DOM code so the checks can run it in Node.
import {
  DEMO_BOX, REGION, DOWNTOWN, collection, pacificTime, distanceKm,
  radarCapabilitiesUrl, radarTimes, radarGeometry, radarFrameUrl, radarLegendUrl,
  alertsUrl, normaliseAlerts, aqhiUrl, normaliseAqhi, quakesUrl, normaliseQuakes,
  conditionsUrl, normaliseConditions, waterStationsUrl, waterReadingUrl, nearestGauges, gaugeFeature,
  lifeUrls, normaliseLife,
  PLAY_HOURS, hourWindow, currentsCapabilitiesUrl, currentsTimes, currentsUrl, currentsGrid, windCapabilitiesUrl, windTimes, windUrl, windGrid,
  GEOMET_SLOW_LINE, GEOMET_RETRY_LINE, geometGet, geometWhy,
  readGeoTiff, pacificHour, pacificHourLabel, seaVelocity, currentReadout, compassWord,
  SCALARS, SCALE_TICKS, scalarCapabilitiesUrl, scalarTimes, scalarHour, nearestHour, scalarUrl, scalarGrid, scalarAt, scalarPicture, scalarText, rampGradient,
  tideStation, tideFeatures, tideUrls, normaliseTide, tideNext, tideCurve, curveGeometry, curvePath, curveTicks, tideClock, TIDE_STATIONS,
  IWLS_SPACING_MS, iwlsUrls, normaliseIwls,
  depthExpression,
  NONNA_MAX_ZOOM, NONNA_CLOSE_ZOOM, NONNA_TICKS, nonnaTileUrl, nonnaGradient, NONNA_NOTICE, IWLS_NOTICE, NONNA_LICENCE_URL, IWLS_LICENCE_URL,
  MARINE_FILES, WHALE_RULES, WHALE_RULE_LINKS, OGL_CANADA_LINE, CETACEANS, cetaceanCells, densityBreaks, densityExpression, DENSITY_COLOURS, stepGradient, fmt2,
  protectedInfo, srkwInfo, rkwInfo, cetaceanInfo, kelpInfo, eelgrassInfo, herringInfo, seabirdInfo, marineMessage,
  NIGHT_SEA,
} from './overlays-data.js'
import { createFlow, FLOW_PROFILES } from './flow.js'

const ECCC_LICENCE = 'https://eccc-msc.github.io/open-data/licence/readme_en/'
// The statement the Environment and Climate Change Canada licence requires when the server names
// no specific one (version 2.1.1, August 2026). The credits panel adds its "Data Source" line.
export const ECCC_ATTRIB = `Contains information licenced under the <a href="${ECCC_LICENCE}" target="_blank" rel="noopener">Data Server End-use Licence</a> of Environment and Climate Change Canada.`
const USGS_ATTRIB = 'Earthquakes: <a href="https://www.usgs.gov/information-policies-and-instructions/copyrights-and-credits" target="_blank" rel="noopener">U.S. Geological Survey</a>'
const GBIF_ATTRIB = 'Observations: <a href="https://www.gbif.org" target="_blank" rel="noopener">GBIF</a>, CC0 or CC BY 4.0 per record'
const ECO_ATTRIB = 'Ecoregions 2017 &copy; <a href="https://ecoregions.appspot.com/" target="_blank" rel="noopener">Resolve</a>, <a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noopener">CC BY 4.0</a>'
const TIDES_ATTRIB = `Tides and tidal currents: <a href="https://tidesandcurrents.noaa.gov/disclaimers.html" target="_blank" rel="noopener">NOAA/NOS/CO-OPS</a> predictions, and the <a href="${IWLS_LICENCE_URL}" target="_blank" rel="noopener">Canadian Hydrographic Service</a> for Victoria Harbour`
const SEAFLOOR_ATTRIB = 'Seafloor depth: ETOPO1, NOAA (coarse, not for navigation)'
const NONNA_ATTRIB = `Seafloor depth in Canadian waters: <a href="${NONNA_LICENCE_URL}" target="_blank" rel="noopener">Canadian Hydrographic Service</a> (NONNA, not for navigation)`
const OGL_CANADA_LINK = '<a href="https://open.canada.ca/en/open-government-licence-canada" target="_blank" rel="noopener">OGL &ndash; Canada</a>'
const OGL_BC_LINK = '<a href="https://www2.gov.bc.ca/gov/content?id=A519A56BC2BF44E4A008B33FCF527F61" target="_blank" rel="noopener">OGL &ndash; British Columbia</a>'
const PROTECTED_ATTRIB = `Protected areas: <a href="https://open.canada.ca/data/en/dataset/6c343726-1e92-451a-876a-76e17d398a1c" target="_blank" rel="noopener">CPCAD</a> (${OGL_CANADA_LINK})`
const SRKW_ATTRIB = `Killer whale critical habitat: <a href="https://open.canada.ca/data/en/dataset/db177a8c-5d7d-49eb-8290-31e6a45d786c" target="_blank" rel="noopener">Fisheries and Oceans Canada</a> (${OGL_CANADA_LINK})`
const RKW_ATTRIB = `Killer whale important area: <a href="https://open.canada.ca/data/en/dataset/5db1e0ce-4515-49ac-891f-a0862c59bc01" target="_blank" rel="noopener">Fisheries and Oceans Canada</a> (${OGL_CANADA_LINK})`
const CETACEANS_ATTRIB = `Whale and porpoise model: <a href="https://open.canada.ca/data/en/dataset/39546277-b33e-4f80-8a2d-3ca1ce5b1401" target="_blank" rel="noopener">Fisheries and Oceans Canada</a> (${OGL_CANADA_LINK})`
const CRIMS_ATTRIB = `Coastal habitat: CRIMS, Province of British Columbia, a legacy survey from 1979 (${OGL_BC_LINK})`
const INDUSTRY_ATTRIB = 'Industry and waste sites: Statistics Canada (OGL &ndash; Canada), HydroWASTE (CC BY 4.0), WRI (CC BY 4.0)'

// The full attribution of each industry and waste source, shown in the popup of its sites.
const INDUSTRY_SOURCES = {
  odi: { text: 'Statistics Canada, Open Database of Infrastructure, Version 2 (Catalogue no. 34-26-0003), released November 13, 2024. Contains information licensed under the Open Government Licence – Canada.', href: 'https://open.canada.ca/en/open-government-licence-canada', label: 'Open Government Licence – Canada' },
  hydrowaste: { text: 'Ehalt Macedo, H., Lehner, B., Nicell, J., Grill, G., Li, J., Limtong, A., Shakya, R. (2022). Distribution and characteristics of wastewater treatment plants within the global river network. Earth System Science Data, 14(2): 559-577. HydroWASTE version 1.0, licensed CC BY 4.0. Clipped to this map’s box and shortened.', href: 'https://doi.org/10.5194/essd-14-559-2022', label: 'HydroWASTE paper' },
  gppd: { text: 'Global Energy Observatory, Google, KTH Royal Institute of Technology in Stockholm, Enipedia, World Resources Institute. 2021. Global Power Plant Database version 1.3.0. Licensed CC BY 4.0. Clipped to this map’s box.', href: 'https://datasets.wri.org/datasets/global-power-plant-database', label: 'Global Power Plant Database' },
}
const KIND_LABEL = { landfill: 'landfill or waste site', power: 'power plant', wastewater: 'wastewater plant or pump station' }

const EMPTY = collection([])
// The longest a layer from the GeoMet server may take to load, all its requests together: each has its own limit and a second try
// (see geometGet in js/overlays-data.js), and the description of the hours comes before the hours themselves.
const GEOMET_LOAD_MS = 60000
const SEAFLOOR_MAX_ZOOM = 8 // the last tile zoom with sea floor depth all the way to the coast
const SEAFLOOR_OPACITY = 0.75
const SCALAR_OPACITY = 0.65 // the sea temperature and saltiness picture, over the pale sea of the basemap
const NIGHT_SCALAR_OPACITY = 0.8 // over the dark sea of the Night look, where a colour needs more of the paint to stand out
const SCALAR_WIDTH = 480 // pixels across the picture: about 4 for each 1 km cell of the grid. The map stretches it smoothly
const json = async (url, signal) => { const r = await fetch(url, { signal }); if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json() }
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`
const km = (n) => `${Math.round(n)} km`
// "rgb(194, 200, 202)" or "#c2c8ca" as [194, 200, 202], or null for anything else (an expression, a name).
const rgbOf = (c) => {
  const m = typeof c === 'string' && (/^rgb\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)$/.exec(c) || /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(c))
  if (!m) return null
  const hex = c.startsWith('#')
  const out = [m[1], m[2], m[3]].map((v) => (hex ? parseInt(v, 16) : Number(v)))
  return out.every((v) => v >= 0 && v <= 255) ? out : null
}

export function createOverlays({ map, $, el, link, basemap, motionQuery, addProtocol }) {
  const geo = radarGeometry()
  let ready
  const whenReady = new Promise((resolve) => { ready = resolve })

  // ---- status lines
  const lastStatus = {}
  function setStatus(id, state, message) {
    lastStatus[id] = { state, message }
    const p = $(`status-${id}`)
    if (!p) return
    p.hidden = !message
    p.textContent = message || ''
    p.dataset.state = state || ''
  }
  const showStatus = (id) => { const s = lastStatus[id]; if (s) setStatus(id, s.state, s.message) }
  const hideStatus = (id) => { const p = $(`status-${id}`); if (p) p.hidden = true }

  // ---- layer definitions. 'ids' are the map layers each box shows and hides.
  const DEFS = {
    radar: { label: 'Precipitation radar', ids: ['radar', 'radar-credit'], ttl: 5 * 60e3, timeout: GEOMET_LOAD_MS, load: loadRadar },
    currents: { label: 'Sea currents', ids: ['currents-credit'], ttl: 30 * 60e3, timeout: GEOMET_LOAD_MS, load: (s) => loadHourly('currents', s) },
    wind: { label: 'Wind', ids: ['wind-credit'], ttl: 30 * 60e3, timeout: GEOMET_LOAD_MS, load: (s) => loadHourly('wind', s) },
    // Sea temperature and saltiness share one picture (one layer, drawn from one canvas), so only one can be on.
    temperature: { label: 'Sea temperature', ids: ['sea-scalar', 'temperature-credit'], ui: ['temperature-key', 'temperature-note'], ttl: 30 * 60e3, timeout: GEOMET_LOAD_MS, load: (s) => loadScalar('temperature', s) },
    salinity: { label: 'Sea saltiness', ids: ['sea-scalar', 'salinity-credit'], ui: ['salinity-key', 'salinity-note'], ttl: 30 * 60e3, timeout: GEOMET_LOAD_MS, load: (s) => loadScalar('salinity', s) },
    tides: { label: 'Tides and tidal currents', ids: ['tides-dot', 'tides-label'], ui: ['tides-note', 'tides-chs-notice'], source: 'ov-tides', ttl: Infinity, load: loadTides },
    seafloor: { label: 'Seafloor depth', ids: ['seafloor', 'seafloor-nonna', 'seafloor-nonna-10'], ui: ['seafloor-key', 'seafloor-note', 'seafloor-chs-notice'], ttl: Infinity, load: loadSeafloor },
    // Marine life and protection: a file of this site each, fetched when the box is first ticked.
    protected: { label: 'Protected marine areas', ids: ['protected-fill', 'protected-line'], ui: ['protected-note'], source: 'ov-protected', ttl: Infinity, load: (s) => loadMarine(s, 'protected') },
    srkw: { label: 'Killer whale critical habitat', ids: ['srkw-fill', 'srkw-line'], ui: ['srkw-note'], source: 'ov-srkw', ttl: Infinity, load: (s) => loadMarine(s, 'srkw') },
    rkw: { label: 'Killer whale important area', ids: ['rkw-fill', 'rkw-line'], ui: ['rkw-note'], source: 'ov-rkw', ttl: Infinity, load: (s) => loadMarine(s, 'rkw') },
    cetaceans: { label: 'Whale and porpoise density', ids: ['cetaceans-fill', 'cetaceans-line'], ui: ['cetaceans-controls', 'cetaceans-key', 'cetaceans-note'], source: 'ov-cetaceans', ttl: Infinity, load: loadCetaceans },
    kelp: { label: 'Kelp beds', ids: ['kelp-fill', 'kelp-line'], source: 'ov-kelp', ttl: Infinity, load: (s) => loadMarine(s, 'kelp') },
    eelgrass: { label: 'Eelgrass', ids: ['eelgrass-fill', 'eelgrass-line'], source: 'ov-eelgrass', ttl: Infinity, load: (s) => loadMarine(s, 'eelgrass') },
    herring: { label: 'Herring spawn', ids: ['herring-line'], source: 'ov-herring', ttl: Infinity, load: (s) => loadMarine(s, 'herring') },
    seabirds: { label: 'Seabird colonies', ids: ['seabirds-dot'], source: 'ov-seabirds', ttl: Infinity, load: (s) => loadMarine(s, 'seabirds') },
    alerts: { label: 'Weather alerts', ids: ['alerts-fill', 'alerts-line'], source: 'ov-alerts', ttl: 5 * 60e3, load: loadAlerts },
    aqhi: { label: 'Air quality', ids: ['aqhi-dot', 'aqhi-label'], source: 'ov-aqhi', ttl: 15 * 60e3, load: loadAqhi },
    quakes: { label: 'Earthquakes', ids: ['quakes-dot', 'quakes-label'], source: 'ov-quakes', ttl: 5 * 60e3, load: loadQuakes },
    conditions: { label: 'Current conditions', ids: ['conditions-dot', 'conditions-label'], source: 'ov-conditions', ttl: 10 * 60e3, load: loadConditions },
    water: { label: 'River gauges', ids: ['water-dot', 'water-label'], source: 'ov-water', ttl: 15 * 60e3, load: loadWater },
    life: { label: 'Life observations', ids: ['life-dot'], source: 'ov-life', ttl: 60 * 60e3, load: loadLife },
    ecoregions: { label: 'Ecoregions', ids: ['ecoregions-fill', 'ecoregions-sea-mask', 'ecoregions-line'], source: 'ov-ecoregions', ttl: Infinity, load: (s) => loadStatic(s, 'data/ecoregions.geojson', 'ecoregions') },
    industry: { label: 'Industry and waste sites', ids: ['industry-dot'], source: 'ov-industry', ttl: Infinity, load: (s) => loadStatic(s, 'data/industry-waste.geojson', 'industry') },
  }
  const state = Object.fromEntries(Object.keys(DEFS).map((id) => [id, { on: false, loadedAt: 0, abort: null, loading: false }]))
  const have = (id) => !!map.getLayer(id)
  const setVisible = (def, on) => { for (const id of def.ids) if (have(id)) map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none') }

  async function enable(id) {
    const def = DEFS[id], st = state[id]
    await whenReady
    if (!st.on) return // unticked while waiting
    setVisible(def, true)
    for (const u of def.ui || []) $(u).hidden = false
    if (id === 'radar') $('radar-controls').hidden = false
    if (HOURLY[id]) showHourlyControls(id, true)
    if (st.loading) { showStatus(id); return }
    if (st.loadedAt && Date.now() - st.loadedAt < def.ttl) { showStatus(id); return }
    st.loading = true
    const ac = st.abort = new AbortController()
    const timer = setTimeout(() => ac.abort(), def.timeout || 25000)
    setStatus(id, 'loading', `Loading ${def.label.toLowerCase()}…`)
    try {
      const result = await def.load(ac.signal)
      if (ac.signal.aborted) return
      if (def.source) map.getSource(def.source).setData(result.data)
      st.loadedAt = Date.now()
      setStatus(id, result.state || 'ok', result.message)
      if (!st.on) hideStatus(id)
      result.after?.()
    } catch (e) {
      if (ac.signal.aborted && !st.on) return
      st.loadedAt = 0
      setStatus(id, 'fail', failureLine(id, def, e))
      if (def.source) map.getSource(def.source)?.setData(EMPTY)
    } finally {
      clearTimeout(timer)
      st.loading = false
    }
  }
  // `e` is what went wrong. A request to the GeoMet server says whether it was the server that did not answer or sent an error.
  function failureLine(id, def, e) {
    if (id === 'alerts') return 'Weather alerts could not be loaded, so this map is not showing whether any are in effect. Check Environment Canada’s own alerts.'
    return `${def.label} could not be loaded just now.${geometWhy(e)} Try again later.`
  }
  // What the status line of `id` says while a GeoMet request is slow or is being asked a second time, with the line it had before after it.
  const sayFor = (id, base) => (kind) => { if (state[id].on) setStatus(id, 'loading', `${kind === 'slow' ? GEOMET_SLOW_LINE : GEOMET_RETRY_LINE} ${base}`) }
  const geomet = (url, as, signal, say, type) => geometGet(url, as, { signal, say, type })
  function disable(id) {
    const def = DEFS[id], st = state[id]
    st.on = false
    st.abort?.abort()
    st.loading = false
    setVisible(def, false)
    hideStatus(id)
    for (const u of def.ui || []) $(u).hidden = true
    if (SCALARS[id]) {
      // Let go of the hours kept and start fresh next time. The picture stays on the map only while one of the two is on.
      st.loadedAt = 0
      if (scalar.shown?.kind === id) { scalar.shown = null; scalar.times = [] }
      if (!activeScalar()) { scalar.grids.clear(); scalar.pending.clear() }
    }
    if (id === 'tides') { tideCache.clear(); st.loadedAt = 0 }
    if (id === 'seafloor') { nonna.ok = 0; nonna.failed = 0 }
    if (id === 'radar') {
      // Drop the frames (about 2 MB each in memory) and start fresh next time.
      $('radar-controls').hidden = true
      stopRadar()
      radar.playing = false; radar.frames = []; radar.shown = -1; st.loadedAt = 0
      syncPlayButton()
    }
    if (HOURLY[id]) {
      // Free the canvas and the hours kept in memory, and start fresh next time.
      const run = HOURLY[id].run
      stopHourly(run)
      run.playing = false; run.hours = []; run.at = -1; run.cache.clear(); run.pending.clear(); run.shown = null; st.loadedAt = 0
      flow.hide()
      showHourlyControls(id, false)
      syncHourlyPlay(id)
      if (id === 'currents') syncScalar() // a sea temperature or saltiness picture goes back to the latest hour not after now
    }
  }
  const boxes = document.querySelectorAll('input[data-overlay]')
  // Sea currents and wind share one canvas and one engine, and sea temperature and saltiness share one picture,
  // so ticking one unticks the other.
  const EXCLUSIVE = { currents: 'wind', wind: 'currents', temperature: 'salinity', salinity: 'temperature' }
  for (const box of boxes) {
    box.addEventListener('change', () => {
      const id = box.dataset.overlay
      if (box.checked) {
        const other = EXCLUSIVE[id]
        if (other && state[other].on) {
          for (const b of boxes) if (b.dataset.overlay === other) b.checked = false
          disable(other)
        }
        state[id].on = true; enable(id)
      } else disable(id)
    })
  }

  // ---- static layers: the data file is fetched on the first tick
  async function loadStatic(signal, url, id) {
    const data = await json(url, signal)
    if (!Array.isArray(data.features)) throw new Error('not a feature collection')
    const n = data.features.length
    if (id === 'ecoregions') return { data, message: `Greater Victoria lies inside ${n === 1 ? 'one ecoregion, shown here' : plural(n, 'ecoregion', 'ecoregions')}. The shapes are coarse.` }
    const kinds = data.features.reduce((a, f) => ((a[f.properties.kind] = (a[f.properties.kind] || 0) + 1), a), {})
    return { data, message: `${plural(n, 'site', 'sites')}: ${plural(kinds.landfill || 0, 'landfill or waste site', 'landfills and waste sites')}, ${plural(kinds.wastewater || 0, 'wastewater plant', 'wastewater plants')}, ${plural(kinds.power || 0, 'power plant', 'power plants')}.` }
  }

  // ---- marine life and protection: files of this site. None shows where an animal is now.
  async function loadMarine(signal, id) {
    const data = await json(MARINE_FILES[id], signal)
    if (!Array.isArray(data.features) || !data.features.length) throw new Error('not a feature collection')
    return { data, message: marineMessage(id, data.features) }
  }
  // Whale and porpoise density: 223 cells of 25 km2 with the numbers of three species, one picked at a time. The colour is the
  // density (animals per 100 km2) in five classes of equal shares of the cells, worked out for the species when the file is read.
  const cet = { key: 'humpback', breaks: {}, cells: 0 }
  const cetaceanStatus = () => `${CETACEANS[cet.key].name}: modelled summer density from the 2018 ship surveys, not where animals are now. ${cet.cells} cells in Canadian waters.`
  async function loadCetaceans(signal) {
    const data = cetaceanCells(await json(MARINE_FILES.cetaceans, signal))
    if (!data.features.length) throw new Error('no cells')
    cet.cells = data.features.length
    for (const key of Object.keys(CETACEANS)) cet.breaks[key] = densityBreaks(data.features.map((f) => f.properties[`d_${key}`]))
    return { data, message: cetaceanStatus(), after: showCetacean }
  }
  // Colour the cells for the species picked, and write the key under the box.
  function showCetacean() {
    const key = cet.key, breaks = cet.breaks[key]
    if (!breaks || !have('cetaceans-fill')) return
    const colours = DENSITY_COLOURS.slice(0, breaks.length + 1)
    map.setPaintProperty('cetaceans-fill', 'fill-color', densityExpression(`d_${key}`, breaks))
    $('cetaceans-bar').style.backgroundImage = stepGradient(colours)
    $('cetaceans-key-title').textContent = `Modelled ${CETACEANS[key].plural} per 100 km², summer 2018`
    const row = $('cetaceans-ticks')
    row.replaceChildren()
    breaks.forEach((b, i) => { const t = el('span', fmt2(b)); t.style.left = `${(i + 1) / colours.length * 100}%`; row.append(t) })
    if (state.cetaceans.on) setStatus('cetaceans', 'ok', cetaceanStatus())
  }
  $('cetaceans-species').addEventListener('change', (e) => { if (CETACEANS[e.target.value]) { cet.key = e.target.value; showCetacean() } })
  $('protected-note').textContent = 'Only the marine parts of protected areas. The land of a park is in Parks and green spaces. Boundaries are approximate. Click an area for its owner, its year and whether it is a no-take area. Not for navigation.'
  $('srkw-note').textContent = `The area Canada has mapped as critical habitat for Southern Resident killer whales. It is a boundary, not a sighting, and is for general guidance only. ${WHALE_RULES}`
  $('rkw-note').textContent = `The area experts drew by hand in 2009 as important to Southern Resident killer whales from June to October. It is a boundary, not a sighting, and carries no added management. ${WHALE_RULES}`
  $('cetaceans-note').textContent = `A model of summer 2018 ship surveys, not where animals are now. Each square is 5 km across (25 km²). Darker means more animals predicted per 100 km². Canadian waters only. ${WHALE_RULES}`

  // ---- weather alerts
  async function loadAlerts(signal) {
    const { fc, items } = normaliseAlerts(await json(alertsUrl(), signal))
    const list = $('alerts-list')
    list.replaceChildren()
    for (const a of items) {
      const d = el('details', null, 'alert')
      const s = el('summary', [a.title, a.area].filter(Boolean).join(' · '))
      d.append(s)
      if (a.text) d.append(el('p', a.text, 'alert-text'))
      const meta = [a.issued && `Issued ${pacificTime(a.issued)}.`, a.expires && `Expires ${pacificTime(a.expires)}.`].filter(Boolean).join(' ')
      if (meta) d.append(el('p', meta, 'src'))
      if (a.id) {
        const p = el('p', null, 'src')
        const l = link(`https://api.weather.gc.ca/collections/weather-alerts/items/${encodeURIComponent(a.id)}?f=html`, 'Alert on the Environment Canada service')
        if (l) { p.append(l); d.append(p) }
      }
      list.append(d)
    }
    const when = pacificTime(new Date().toISOString())
    return {
      data: fc,
      state: items.length ? 'ok' : 'empty',
      message: items.length ? `${plural(items.length, 'weather alert', 'weather alerts')} in effect for areas that touch the demo box (checked ${when}). The text is shown unchanged, below.` : `No weather alerts in effect for areas that touch the demo box (checked ${when}).`,
    }
  }

  // ---- air quality
  async function loadAqhi(signal) {
    const data = normaliseAqhi(await json(aqhiUrl(), signal))
    const n = data.features.length
    if (!n) return { data, state: 'empty', message: 'No air quality station reported in the demo box.' }
    const latest = data.features.map((f) => f.properties.when).sort().at(-1)
    return { data, message: `${plural(n, 'station', 'stations')} (Victoria and Westshore). Latest reading ${pacificTime(latest)}.` }
  }

  // ---- earthquakes
  async function loadQuakes(signal) {
    const data = normaliseQuakes(await json(quakesUrl(), signal))
    const n = data.features.length
    if (!n) return { data, state: 'empty', message: 'No earthquakes recorded in the last 7 days in the area this map covers.' }
    const mags = data.features.map((f) => f.properties.mag)
    return { data, message: `${plural(n, 'earthquake', 'earthquakes')} in the last 7 days, magnitude ${Math.min(...mags).toFixed(1)} to ${Math.max(...mags).toFixed(1)}. Positions in the strait and offshore are included.` }
  }

  // ---- current conditions
  async function loadConditions(signal) {
    const data = normaliseConditions(await json(conditionsUrl(), signal))
    const n = data.features.length
    if (!n) return { data, state: 'empty', message: 'No weather station reported in the last 3 hours.' }
    const latest = data.features.map((f) => f.properties.when).sort().at(-1)
    return { data, message: `${plural(n, 'station', 'stations')} in or near the demo box. Latest report ${pacificTime(latest)}.` }
  }

  // ---- river gauges: the nearest active gauges, wherever they are
  async function loadWater(signal) {
    const gauges = nearestGauges(await json(waterStationsUrl(), signal))
    if (!gauges.length) throw new Error('no active real-time gauges found')
    const got = await Promise.allSettled(gauges.map(async (g) => gaugeFeature(g, await json(waterReadingUrl(g.number), signal))))
    const features = got.filter((r) => r.status === 'fulfilled' && r.value).map((r) => r.value)
    if (!features.length) throw new Error('no readings')
    const inside = features.some((f) => f.geometry.coordinates[0] >= DEMO_BOX[0] && f.geometry.coordinates[0] <= DEMO_BOX[2] && f.geometry.coordinates[1] >= DEMO_BOX[1] && f.geometry.coordinates[1] <= DEMO_BOX[3])
    const ds = features.map((f) => f.properties.km)
    const part = features.length < gauges.length ? ` ${features.length} of ${gauges.length} gauges answered.` : ''
    return { data: collection(features), message: `${plural(features.length, 'gauge', 'gauges')}, ${Math.min(...ds)} to ${Math.max(...ds)} km in a straight line from downtown Victoria${inside ? '' : ', all outside the demo box'}.${part}` }
  }

  // ---- life observations: a bounded sample from GBIF
  async function loadLife(signal) {
    // One request after the other: GBIF answers a burst of requests with HTTP 429.
    const urls = lifeUrls(), results = []
    let answered = 0
    for (const u of urls) {
      try {
        const d = await json(u, signal)
        if (!Array.isArray(d?.results)) throw new Error('unexpected reply')
        results.push(...d.results)
        answered++
      } catch (e) { if (signal.aborted) throw e }
    }
    if (!answered) throw new Error('no reply')
    const data = normaliseLife(results)
    const n = data.features.length
    const part = answered < urls.length ? ` ${answered} of ${urls.length} requests answered.` : ''
    if (!n) return { data, state: 'empty', message: `No records matched.${part}` }
    return { data, message: `${plural(n, 'record', 'records')}, a sample from the last 12 months, not every observation.${part}` }
  }

  // ---- precipitation radar: a few recent frames, drawn as one image and stepped through
  const radar = { frames: [], shown: -1, playing: false, timer: 0, refresh: 0 }
  const radarSourceReady = () => {
    if (!map.getSource('radar')) {
      // No url: each image is handed over with updateImage(), so nothing is fetched twice.
      map.addSource('radar', { type: 'image', coordinates: geo.coordinates })
      map.addLayer({ id: 'radar', type: 'raster', source: 'radar', paint: { 'raster-opacity': 0.72, 'raster-fade-duration': 0 } }, 'alerts-fill')
    }
  }
  async function frameImage(time, signal, say) {
    const bitmap = await createImageBitmap(await geomet(radarFrameUrl(time, geo), 'blob', signal, say, /image\/png/i))
    if (!bitmap.width || bitmap.width > 4096 || bitmap.height > 4096) { bitmap.close(); throw new Error('unexpected image size') }
    const canvas = document.createElement('canvas')
    canvas.width = bitmap.width; canvas.height = bitmap.height
    canvas.getContext('2d').drawImage(bitmap, 0, 0)
    bitmap.close()
    return canvas
  }
  function showFrame(i) {
    const f = radar.frames[i]
    if (!f) return
    radarSourceReady()
    map.getSource('radar').updateImage({ image: f.canvas, coordinates: geo.coordinates })
    map.triggerRepaint()
    radar.shown = i
    $('radar-time').textContent = `Radar, ${pacificTime(f.time)}${i === radar.frames.length - 1 ? ' (latest)' : ''}`
  }
  function stopRadar() { clearTimeout(radar.timer); radar.timer = 0; clearInterval(radar.refresh); radar.refresh = 0 }
  function syncPlayButton() {
    const b = $('radar-play')
    b.textContent = radar.playing ? 'Pause' : 'Play'
    b.setAttribute('aria-pressed', String(radar.playing))
    b.disabled = radar.frames.length < 2
  }
  function tick() {
    clearTimeout(radar.timer); radar.timer = 0
    if (!radar.playing || !state.radar.on || document.hidden || radar.frames.length < 2) return
    const next = (radar.shown + 1) % radar.frames.length
    showFrame(next)
    radar.timer = setTimeout(tick, next === radar.frames.length - 1 ? 1800 : 600)
  }
  function setPlaying(on) { radar.playing = on; syncPlayButton(); if (on) tick(); else { clearTimeout(radar.timer); radar.timer = 0 } }
  $('radar-play').addEventListener('click', () => setPlaying(!radar.playing))
  document.addEventListener('visibilitychange', () => { if (radar.playing) tick() })

  async function loadRadar(signal) {
    const say = sayFor('radar', 'Loading precipitation radar…')
    const times = radarTimes(await geomet(radarCapabilitiesUrl(), 'text', signal, say))
    const got = new Map()
    let failed = 0
    const queue = [...times].reverse() // newest first, so a picture appears as soon as one frame is in
    const worker = async () => {
      for (let t; (t = queue.shift());) {
        try { got.set(t, await frameImage(t, signal, say)) } catch { if (signal.aborted) return; failed++; continue }
        const shownTime = radar.frames[radar.shown]?.time
        radar.frames = times.filter((x) => got.has(x)).map((x) => ({ time: x, canvas: got.get(x) }))
        if (got.size === 1) showFrame(radar.frames.length - 1) // the first to arrive is the newest
        else radar.shown = Math.max(0, radar.frames.findIndex((f) => f.time === shownTime))
        syncPlayButton()
      }
    }
    await Promise.all([worker(), worker(), worker()])
    if (signal.aborted) throw new Error('cancelled')
    if (!got.size) throw new Error('no frames')
    const n = radar.frames.length
    const lost = failed ? ` ${plural(failed, 'frame', 'frames')} did not load.` : ''
    return {
      data: null,
      message: `${plural(n, 'frame', 'frames')}${n > 1 ? ', six minutes apart' : ''}. Colours show rain rate, from light to heavy. Where nothing is drawn, the radar saw no rain or has no coverage.${lost}`,
      after() {
        if (!state.radar.on) return
        setPlaying(!motionQuery.matches && n > 1)
        clearInterval(radar.refresh)
        radar.refresh = setInterval(() => { if (state.radar.on && !document.hidden) { state.radar.loadedAt = 0; enable('radar') } }, 6 * 60e3)
      },
    }
  }
  // The legend picture is fetched only when the visitor opens it.
  $('radar-legend').addEventListener('toggle', (e) => {
    const img = $('radar-legend-img')
    if (e.target.open && !img.src) { img.src = radarLegendUrl(); img.onerror = () => { $('radar-legend-note').hidden = false } }
  })

  // ---- sea currents and wind: modelled hourly fields, drawn as moving particles (js/flow.js)
  // Each hour is two small images from the GeoMet WCS (the east and north components of the currents, the
  // speed and direction of the wind). Only the hour shown is fetched, and while Play runs the one after
  // it. The last few hours are kept for the next loop. Currents and wind share one canvas and one engine.
  const flow = createFlow({ map, motionQuery })
  const HOURS_KEPT = 14, HOUR_STEP_MS = 1500
  const newRun = () => ({ hours: [], at: -1, cache: new Map(), pending: new Map(), playing: false, timer: 0, stepAt: 0, shown: null })
  const sea = newRun(), wind = newRun()
  async function tiff(url, signal, say) {
    return readGeoTiff(await geomet(url, 'arrayBuffer', signal, say, /image\/tiff/i))
  }
  const HOURLY = {
    currents: {
      run: sea, capabilities: currentsCapabilitiesUrl, times: currentsTimes, example: 0.5, medium: 'water',
      grid: async (time, signal, say) => currentsGrid(...(await Promise.all([tiff(currentsUrl('X', time), signal, say), tiff(currentsUrl('Y', time), signal, say)]))),
      message: (time) => `Modelled surface currents for ${pacificHour(time)}, Environment Canada’s CIOPS Salish Sea model (experimental, not for navigation).`,
      loading: (time) => `Loading sea currents for ${pacificHour(time)}…`,
      nextFailed: (time) => `The next hour of sea currents could not be loaded just now. The map still shows ${pacificHour(time)}.`,
    },
    wind: {
      run: wind, capabilities: windCapabilitiesUrl, times: windTimes, example: 5, medium: 'air',
      grid: async (time, signal, say) => windGrid(...(await Promise.all([tiff(windUrl('speed', time), signal, say), tiff(windUrl('direction', time), signal, say)]))),
      message: (time) => `Modelled wind for ${pacificHour(time)}, Environment Canada’s HRDPS model (forecast, not for navigation).`,
      loading: (time) => `Loading wind for ${pacificHour(time)}…`,
      nextFailed: (time) => `The next hour of wind could not be loaded just now. The map still shows ${pacificHour(time)}.`,
    },
  }
  const stopHourly = (run) => { clearTimeout(run.timer); run.timer = 0 }
  const showHourlyControls = (id, on) => { $(`${id}-controls`).hidden = !on; $(`${id}-note`).hidden = !on }
  // One request for an hour at a time: a second call for an hour already on its way waits for that request.
  async function hourlyGrid(id, time, signal, say) {
    const { run } = HOURLY[id], kept = run.cache.get(time)
    if (kept) { run.cache.delete(time); run.cache.set(time, kept); return kept } // most recently used last
    let ask = run.pending.get(time)
    if (!ask) {
      ask = HOURLY[id].grid(time, signal, say).then((grid) => {
        if (signal?.aborted) throw new Error('cancelled')
        run.cache.set(time, grid)
        while (run.cache.size > HOURS_KEPT) run.cache.delete(run.cache.keys().next().value)
        return grid
      }).finally(() => run.pending.delete(time))
      run.pending.set(time, ask)
    }
    return ask
  }
  // Put one hour on the map and remember it, for the click readout.
  function showHour(id, time, grid) { HOURLY[id].run.shown = { time, grid }; flow.show(grid, id); if (id === 'currents') syncScalar() } // a sea temperature or saltiness picture follows the hour
  function syncHourlyPlay(id) {
    const { run } = HOURLY[id], b = $(`${id}-play`), reduced = motionQuery.matches
    b.textContent = run.playing ? 'Pause' : 'Play'
    b.setAttribute('aria-pressed', String(run.playing))
    b.disabled = reduced || run.hours.length < 2
    $(`${id}-paused`).hidden = !reduced || !state[id].on
    // A line that changes every hour is not read out while Play runs.
    $(`status-${id}`).setAttribute('aria-live', run.playing ? 'off' : 'polite')
  }
  async function hourlyStep(id) {
    const h = HOURLY[id], run = h.run
    stopHourly(run)
    if (!run.playing || !state[id].on || document.hidden) return
    const next = (run.at + 1) % run.hours.length, signal = state[id].abort?.signal
    if (!run.cache.has(run.hours[next])) setStatus(id, 'loading', h.loading(run.hours[next]))
    try {
      const grid = await hourlyGrid(id, run.hours[next], signal, sayFor(id, h.loading(run.hours[next])))
      if (!run.playing || !state[id].on) return
      run.at = next
      showHour(id, run.hours[next], grid)
      setStatus(id, 'ok', h.message(run.hours[next]))
      blendToNext(id) // fetches the hour after this one, and blends toward it
    } catch (e) {
      if (signal?.aborted || !state[id].on) return
      setHourlyPlaying(id, false)
      setStatus(id, 'fail', h.nextFailed(run.hours[run.at]) + geometWhy(e))
      return
    }
    run.timer = setTimeout(() => hourlyStep(id), HOUR_STEP_MS)
  }
  // While Play runs, the flow is blended from the hour shown to the one after it over the time until the next step, so it changes smoothly
  // and does not jump each hour. The hour after is fetched at the start of the step, no earlier, and the blend starts when it is in.
  async function blendToNext(id) {
    const { run } = HOURLY[id], at = run.at, stepAt = (run.stepAt = performance.now()), next = run.hours[(at + 1) % run.hours.length]
    // A sea temperature or saltiness picture follows the currents, so its grid for the next hour is asked for now too, and is in when the step comes.
    const kind = id === 'currents' ? activeScalar() : null
    if (kind && scalar.times.length) scalarGridFor(kind, nearestHour(scalar.times, next), state[kind].abort?.signal).catch(() => {})
    try {
      const grid = await hourlyGrid(id, next, state[id].abort?.signal)
      if (!run.playing || !state[id].on || run.at !== at || run.stepAt !== stepAt) return // paused, unticked or stepped on while it was coming
      flow.blend(grid, HOUR_STEP_MS - (performance.now() - stepAt))
    } catch { /* the step that wants this hour says so if it cannot be had */ }
  }
  function setHourlyPlaying(id, on) {
    const { run } = HOURLY[id]
    run.playing = on
    syncHourlyPlay(id)
    if (on) {
      blendToNext(id) // the first step comes a step from now: the flow starts to change at once, and smoothly
      run.timer = setTimeout(() => hourlyStep(id), HOUR_STEP_MS)
    } else { stopHourly(run); flow.unblend() } // back to the hour the status line names
  }
  for (const id of Object.keys(HOURLY)) {
    const { run } = HOURLY[id]
    $(`${id}-play`).addEventListener('click', () => setHourlyPlaying(id, !run.playing))
    document.addEventListener('visibilitychange', () => { if (run.playing) hourlyStep(id) })
    motionQuery.addEventListener('change', () => { if (motionQuery.matches && run.playing) setHourlyPlaying(id, false); syncHourlyPlay(id) })
    // The particles are sped up so they can be seen, and by the same pace at every zoom, so no single factor is quoted.
    const { example, medium } = HOURLY[id]
    $(`${id}-note`).textContent = `Particles are sped up so you can see them: ${example} m/s shows as about ${Math.round(example * FLOW_PROFILES[id].pxPerMs)} px a second at any zoom. The real ${medium} moves much slower than it looks. Play steps through the next ${PLAY_HOURS} hours. Sea currents and Wind share one picture, so only one can be on.`
  }

  async function loadHourly(id, signal) {
    const h = HOURLY[id]
    const say = sayFor(id, `Loading ${DEFS[id].label.toLowerCase()}…`)
    const { times, at } = hourWindow(h.times(await geomet(h.capabilities(), 'text', signal, say)))
    const grid = await hourlyGrid(id, times[at], signal, say)
    return {
      data: null,
      message: h.message(times[at]),
      after() {
        if (!state[id].on) return
        h.run.hours = times; h.run.at = at
        showHour(id, times[at], grid)
        syncHourlyPlay(id)
      },
    }
  }

  // ---- sea temperature and saltiness: the model's numbers for each hour, coloured here and drawn as one picture of the map area
  // The hour shown is the one of the sea currents while that layer is on (and it follows its Play), and the latest hour not after now
  // otherwise. Only the hour shown is fetched, and while the currents play the one after it. Each hour is one grid of 73 KB (the same size as a
  // component of the currents), kept for the next loop of Play, and the picture is made from it in the browser (scalarPicture, in js/overlays-data.js).
  const scalar = { kind: null, times: [], shown: null, grids: new Map(), pending: new Map(), canvas: null, busy: false, dirty: false, before: null }
  const activeScalar = () => (state.temperature.on ? 'temperature' : state.salinity.on ? 'salinity' : null)
  const seaFollow = () => (state.currents.on && sea.shown ? sea.shown.time : null)
  const scalarMessage = (kind, time) => `Modelled ${SCALARS[kind].what} for ${pacificHour(time)}, Environment Canada’s CIOPS Salish Sea model (experimental, not for navigation).`
  async function scalarGridFor(kind, time, signal, say) {
    const key = `${kind}|${time}`, kept = scalar.grids.get(key)
    if (kept) { scalar.grids.delete(key); scalar.grids.set(key, kept); return kept } // most recently used last
    let ask = scalar.pending.get(key)
    if (!ask) {
      ask = tiff(scalarUrl(kind, time), signal, say).then((raw) => {
        if (signal?.aborted) throw new Error('cancelled')
        const grid = scalarGrid(kind, raw)
        scalar.grids.set(key, grid)
        while (scalar.grids.size > HOURS_KEPT) scalar.grids.delete(scalar.grids.keys().next().value)
        return grid
      }).finally(() => scalar.pending.delete(key))
      scalar.pending.set(key, ask)
    }
    return ask
  }
  function scalarSourceReady() {
    if (map.getSource('sea-scalar')) return
    // No url: each picture is handed over with updateImage(), as for the radar. It sits above the sea of the basemap and
    // the ecosystem and ecoregion sea masks, and under the creeks, parks and boundaries.
    map.addSource('sea-scalar', { type: 'image', coordinates: geo.coordinates })
    map.addLayer({ id: 'sea-scalar', type: 'raster', source: 'sea-scalar', paint: { 'raster-opacity': nonna.night ? NIGHT_SCALAR_OPACITY : SCALAR_OPACITY, 'raster-fade-duration': 0 } }, scalar.before)
  }
  function drawScalar(kind, time, grid) {
    if (activeScalar() !== kind) return // unticked while the grid was on its way
    const height = Math.round(SCALAR_WIDTH * geo.height / geo.width)
    if (!scalar.canvas) { scalar.canvas = document.createElement('canvas'); scalar.canvas.width = SCALAR_WIDTH; scalar.canvas.height = height }
    scalar.canvas.getContext('2d').putImageData(new ImageData(scalarPicture(grid, geo, SCALAR_WIDTH, height), SCALAR_WIDTH, height), 0, 0)
    scalarSourceReady()
    map.getSource('sea-scalar').updateImage({ image: scalar.canvas, coordinates: geo.coordinates })
    map.triggerRepaint()
    scalar.shown = { kind, time, grid }
  }
  // Bring the picture to the hour it should show now: after the sea currents step, or when they are switched on or off.
  async function syncScalar() {
    if (!activeScalar() || !scalar.times.length) return
    if (scalar.busy) { scalar.dirty = true; return }
    scalar.busy = true
    try {
      do {
        scalar.dirty = false
        const kind = activeScalar()
        if (!kind) break
        const time = scalarHour(scalar.times, seaFollow())
        if (scalar.shown?.kind === kind && scalar.shown.time === time) continue
        const signal = state[kind].abort?.signal, had = scalar.shown?.kind === kind ? scalar.shown.time : null
        const loading = `Loading ${SCALARS[kind].what} for ${pacificHour(time)}…`
        if (!scalar.grids.has(`${kind}|${time}`)) setStatus(kind, 'loading', loading)
        try {
          drawScalar(kind, time, await scalarGridFor(kind, time, signal, sayFor(kind, loading)))
          if (activeScalar() !== kind) break
          setStatus(kind, 'ok', scalarMessage(kind, time))
          // While the currents play, the next hour is ready before it is wanted. It is the hour after the one shown, and no more.
          if (sea.playing) scalarGridFor(kind, nearestHour(scalar.times, sea.hours[(sea.at + 1) % sea.hours.length]), signal).catch(() => {})
        } catch (e) {
          if (signal?.aborted || activeScalar() !== kind) break
          setStatus(kind, 'fail', had ? `The next hour of ${SCALARS[kind].what} could not be loaded just now. The map still shows ${pacificHour(had)}.${geometWhy(e)}` : failureLine(kind, DEFS[kind], e))
        }
      } while (scalar.dirty)
    } finally { scalar.busy = false }
  }
  async function loadScalar(kind, signal) {
    const say = sayFor(kind, `Loading ${DEFS[kind].label.toLowerCase()}…`)
    const times = scalarTimes(kind, await geomet(scalarCapabilitiesUrl(kind), 'text', signal, say))
    const time = scalarHour(times, seaFollow())
    const grid = await scalarGridFor(kind, time, signal, say)
    return {
      data: null,
      message: scalarMessage(kind, time),
      after() {
        if (state[kind].on) {
          scalar.times = times
          try { drawScalar(kind, time, grid) } catch { setStatus(kind, 'fail', failureLine(kind, DEFS[kind])) }
        }
      },
    }
  }
  // The keys under the boxes: the colour ramp itself, and the values at its ticks.
  function buildKey(id, gradient, ticks, from, to) {
    $(`${id}-bar`).style.backgroundImage = gradient
    const row = $(`${id}-ticks`)
    for (const v of ticks) { const t = el('span', String(v)); t.style.left = `${(v - from) / (to - from) * 100}%`; row.append(t) }
  }
  for (const kind of Object.keys(SCALARS)) {
    const t = SCALE_TICKS[kind], from = t[0], to = t.at(-1)
    buildKey(kind, rampGradient(kind), t, from, to)
  }
  buildKey('seafloor', nonnaGradient(0, NONNA_TICKS.at(-1)), NONNA_TICKS, 0, NONNA_TICKS.at(-1))
  $('seafloor-chs-notice').textContent = NONNA_NOTICE
  $('tides-chs-notice').textContent = IWLS_NOTICE

  // ---- seafloor depth. NOAA's ETOPO1 colours are drawn in the browser from the elevation tiles, with no request of their own.
  // Over them, in Canadian waters, go the tiles of the Canadian Hydrographic Service (CHS), asked for live from CHS by the visitor's
  // browser only while the box is ticked, painted again in the same colours by a worker (js/seafloor-worker.js) and never kept.
  // The tiles are opaque where they have depths, so the coarser colours below do not show through them.
  const SEAFLOOR_MESSAGE = 'Depth in metres, from the Canadian Hydrographic Service in Canadian waters (cells of 100 m, and 10 m close up) and from NOAA’s ETOPO1 grid elsewhere. Not for navigation.'
  const SEAFLOOR_FAILURE = 'The Canadian Hydrographic Service’s depths could not be loaded just now, so the coarser ETOPO1 depths from NOAA are shown. Try again later.'
  const nonna = { worker: null, jobs: new Map(), id: 0, ok: 0, failed: 0, sea: [194, 200, 202], daySea: [194, 200, 202] } // sea: the colour of the basemap's water, mixed into the tiles
  function nonnaWorker() {
    if (nonna.worker) return nonna.worker
    const w = new Worker(new URL('./seafloor-worker.js', import.meta.url), { type: 'module' })
    w.onmessage = ({ data }) => { const job = nonna.jobs.get(data.id); nonna.jobs.delete(data.id); if (job) (data.error ? job.reject(new Error(data.error)) : job.resolve(data.buffer)) }
    w.onerror = () => { for (const job of nonna.jobs.values()) job.reject(new Error('the painting worker failed')); nonna.jobs.clear(); nonna.worker = null }
    return (nonna.worker = w)
  }
  const paintNonna = (buffer) => new Promise((resolve, reject) => { const id = ++nonna.id; nonna.jobs.set(id, { resolve, reject }); nonnaWorker().postMessage({ id, buffer, sea: nonna.sea, opacity: SEAFLOOR_OPACITY }, [buffer]) })
  // A tile that fails is not counted if the map gave up on it itself. The plain failure line is shown only while no tile has come at all.
  async function loadNonnaTile({ url }, abort) {
    const m = /^nonna:\/\/(\d+)\/(\d+)\/(\d+)\/(\d+)$/.exec(url)
    if (!m) throw new Error('not a seafloor tile')
    try {
      const reply = await fetch(nonnaTileUrl(+m[1], +m[2], +m[3], +m[4]), { signal: abort.signal })
      if (!reply.ok) throw new Error(`HTTP ${reply.status}`)
      const data = await paintNonna(await reply.arrayBuffer())
      nonna.ok++
      if (state.seafloor.on && lastStatus.seafloor?.state === 'fail') setStatus('seafloor', 'ok', SEAFLOOR_MESSAGE)
      return { data }
    } catch (e) {
      if (!abort.signal.aborted) {
        nonna.failed++
        if (state.seafloor.on && !nonna.ok) setStatus('seafloor', 'fail', SEAFLOOR_FAILURE)
      }
      throw e
    }
  }
  addProtocol?.('nonna', loadNonnaTile)
  // The two sources and layers of the CHS tiles, just under `before`. The tile already carries the layer's opacity, mixed with the colour of the
  // water under it, so the layer itself is opaque.
  function addNonna(before, visible) {
    for (const res of [100, 10]) map.addSource(`nonna-${res}`, { type: 'raster', tiles: [`nonna://${res}/{z}/{x}/{y}`], tileSize: 256, maxzoom: NONNA_MAX_ZOOM[res], attribution: NONNA_ATTRIB })
    const style = { 'raster-opacity': 1, 'raster-fade-duration': 0 }, layout = { visibility: visible ? 'visible' : 'none' }
    map.addLayer({ id: 'seafloor-nonna', type: 'raster', source: 'nonna-100', maxzoom: NONNA_CLOSE_ZOOM, layout, paint: style }, before)
    map.addLayer({ id: 'seafloor-nonna-10', type: 'raster', source: 'nonna-10', minzoom: NONNA_CLOSE_ZOOM, layout, paint: style }, before)
  }
  // The tiles are painted with the colour of the water in them, so when the water changes colour they are asked for and painted again, in their place in the stack.
  function refreshNonna() {
    if (!map.getLayer('seafloor-nonna-10')) return
    const ids = map.getStyle().layers.map((l) => l.id), above = ids[ids.indexOf('seafloor-nonna-10') + 1]
    for (const id of ['seafloor-nonna-10', 'seafloor-nonna']) map.removeLayer(id)
    for (const res of [100, 10]) map.removeSource(`nonna-${res}`)
    nonna.worker?.terminate(); nonna.worker = null // its answers for each colour were made for the old water
    for (const job of nonna.jobs.values()) job.reject(new Error('the sea changed colour'))
    nonna.jobs.clear()
    addNonna(above, state.seafloor.on)
  }
  // The Night look: the water is dark, the trails of the currents and the wind are pale, the temperature and saltiness need more paint, and the
  // CHS tiles are painted again on the dark water. The basemap and the labels are darkened by js/night.js.
  function setNight(on) {
    flow.setNight(on)
    nonna.sea = on ? NIGHT_SEA : nonna.daySea
    refreshNonna()
    if (map.getLayer('sea-scalar')) map.setPaintProperty('sea-scalar', 'raster-opacity', on ? NIGHT_SCALAR_OPACITY : SCALAR_OPACITY)
    nonna.night = on
  }
  async function loadSeafloor() {
    return { data: null, message: nonna.failed && !nonna.ok ? SEAFLOOR_FAILURE : SEAFLOOR_MESSAGE, state: nonna.failed && !nonna.ok ? 'fail' : 'ok' }
  }

  // ---- tides and tidal currents: markers from a list of stations, and NOAA's predictions fetched when one is opened
  const tideCache = new Map() // station id -> { at, tide }
  const TIDE_STALE_MS = 6 * 3600e3 // a station opened again after this long is asked for afresh, so "next" stays ahead of now
  const GAUGE_STALE_MS = 15 * 60e3 // the same for the gauge, whose popup also says what it has measured, so it is asked afresh sooner
  async function loadTides() {
    const levels = TIDE_STATIONS.filter((s) => s.kind === 'level').length, currents = TIDE_STATIONS.length - levels
    return { data: tideFeatures(), message: `${plural(levels, 'water level station', 'water level stations')} and ${plural(currents, 'tidal current station', 'tidal current stations')}. Click one to ask NOAA, or the Canadian Hydrographic Service for Victoria Harbour. Not for navigation.` }
  }
  // A wait that the signal can cut short.
  const pause = (ms, signal) => new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new Error('cancelled')); return }
    const t = setTimeout(resolve, ms)
    signal.addEventListener('abort', () => { clearTimeout(t); reject(new Error('cancelled')) }, { once: true })
  })
  // The gauge's three requests start IWLS_SPACING_MS apart, each wait begun when the request before it has been sent, so that a busy page
  // cannot bunch them and no second holds more than the three the service allows. Only the highs and lows are needed: without the
  // other two the curve is drawn between them, and no observed level is said.
  async function gaugeFor(station, now, signal) {
    const urls = iwlsUrls(station, now)
    const hilo = json(urls.hilo, signal)
    const rest = (async () => {
      await pause(IWLS_SPACING_MS, signal)
      const observed = json(urls.observed, signal).catch(() => null)
      await pause(IWLS_SPACING_MS, signal)
      return [await observed, await json(urls.predicted, signal).catch(() => null)]
    })().catch(() => [null, null])
    const [highsAndLows, [observed, predicted]] = await Promise.all([hilo, rest])
    return normaliseIwls(station, highsAndLows, predicted, observed)
  }
  async function tideFor(station) {
    const kept = tideCache.get(station.id)
    if (kept && Date.now() - kept.at < (station.source === 'chs' ? GAUGE_STALE_MS : TIDE_STALE_MS)) return kept.tide
    // Own timeout, and the tick's own signal, so unticking the box cancels it.
    const ac = new AbortController(), parent = state.tides.abort?.signal
    const timer = setTimeout(() => ac.abort(), 25000)
    parent?.addEventListener('abort', () => ac.abort(), { once: true })
    try {
      const now = Date.now()
      let tide
      if (station.source === 'chs') tide = await gaugeFor(station, now, ac.signal)
      else {
        const urls = tideUrls(station, now)
        const [events, series] = await Promise.all([json(urls.events, ac.signal), urls.series ? json(urls.series, ac.signal).catch(() => null) : null]) // no series is not a failure: the curve is then drawn between the events
        tide = normaliseTide(station, events, series)
      }
      if (state.tides.on) tideCache.set(station.id, { at: now, tide })
      return tide
    } catch (e) { ac.abort(); throw e } finally { clearTimeout(timer) }
  }
  const SVG = 'http://www.w3.org/2000/svg'
  const svgEl = (name, attrs = {}, text) => { const n = document.createElementNS(SVG, name); for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v)); if (text != null) n.textContent = text; return n }
  // The 24 hours of a curve from three hours ago, with "now" marked. For the gauge the observed levels are drawn over the predicted
  // ones up to now, and a small key below says which line is which.
  function tideSvg(station, tide, now) {
    const from = now - 3 * 3600e3, to = now + 21 * 3600e3, { points, drawn } = tideCurve(tide, from, to)
    if (points.length < 2) return { svg: null, drawn }
    const level = station.kind === 'level', seen = tide.observed?.filter((p) => p.ms >= from && p.ms <= now) || [], gauge = seen.length > 1
    const g = curveGeometry(points, station.kind, { from, to, now, scaleWith: seen })
    const svg = svgEl('svg', { viewBox: `0 0 260 ${gauge ? 106 : 92}`, width: '100%', role: 'img', class: 'tide-curve' })
    svg.setAttribute('aria-label', level ? `Predicted tide height for the 24 hours around now, from ${g.min.toFixed(1)} to ${g.max.toFixed(1)} metres.${gauge ? ' The observed height is drawn over it up to now.' : ''} A red line marks now.` : `Predicted current speed for the 24 hours around now, flood above the line and ebb below it, up to ${Math.max(Math.abs(g.min), Math.abs(g.max)).toFixed(1)} knots. A red line marks now.`)
    svg.append(svgEl('rect', { x: g.left, y: g.top, width: g.right - g.left, height: g.bottom - g.top, fill: '#f3f6f4' }))
    if (g.zeroY != null) svg.append(svgEl('line', { x1: g.left, x2: g.right, y1: g.zeroY, y2: g.zeroY, stroke: '#8a948e', 'stroke-width': 1, 'stroke-dasharray': '3 3' }))
    for (const t of curveTicks(from, to)) {
      const x = g.x(t.ms)
      svg.append(svgEl('line', { x1: x, x2: x, y1: g.top, y2: g.bottom + 3, stroke: '#c9d0cb', 'stroke-width': 1 }))
      svg.append(svgEl('text', { x, y: g.bottom + 13, 'text-anchor': 'middle', 'font-size': 10, fill: '#4a554f' }, pacificHourLabel(t.ms)))
    }
    svg.append(svgEl('path', { d: g.d, fill: 'none', stroke: '#1d5f86', 'stroke-width': 2, 'stroke-linejoin': 'round', class: 'predicted' }))
    if (gauge) svg.append(svgEl('path', { d: curvePath(seen, g), fill: 'none', stroke: '#1b1b1b', 'stroke-width': 2, 'stroke-linejoin': 'round', class: 'observed' }))
    if (g.nowY != null) {
      svg.append(svgEl('line', { x1: g.nowX, x2: g.nowX, y1: g.top, y2: g.bottom, stroke: '#b3261e', 'stroke-width': 1.5 }))
      svg.append(svgEl('circle', { cx: g.nowX, cy: g.nowY, r: 3.5, fill: '#b3261e', stroke: '#ffffff', 'stroke-width': 1 }))
    }
    svg.append(svgEl('text', { x: Math.min(g.nowX + 3, g.right - 18), y: g.top + 9, 'font-size': 10, fill: '#b3261e' }, 'now'))
    // The scale: the highest and lowest height, or which side of the line is flood and which is ebb.
    const small = { 'font-size': 10, fill: '#4a554f', x: g.left + 3 }
    if (level) {
      svg.append(svgEl('text', { ...small, y: g.top + 20 }, `${g.max.toFixed(1)} m`))
      svg.append(svgEl('text', { ...small, y: g.bottom - 4 }, `${g.min.toFixed(1)} m`))
    } else {
      svg.append(svgEl('text', { ...small, y: g.top + 20 }, 'flood'))
      svg.append(svgEl('text', { ...small, y: g.bottom - 4 }, 'ebb'))
    }
    if (gauge) {
      for (const [x, colour, word] of [[g.left + 3, '#1d5f86', 'predicted'], [g.left + 73, '#1b1b1b', 'observed']]) {
        svg.append(svgEl('line', { x1: x, x2: x + 14, y1: 99, y2: 99, stroke: colour, 'stroke-width': 2 }))
        svg.append(svgEl('text', { x: x + 18, y: 102.5, 'font-size': 10, fill: '#4a554f' }, word))
      }
    }
    return { svg, drawn, nowValue: g.nowValue }
  }
  // The text and the curve of a popup for one station: a small table of the next events, soonest first, the curve and
  // its notes. Times are Pacific, said once in the notes.
  function tideNodes(station, tide, now = Date.now()) {
    const nodes = [], next = tideNext(tide, now), level = station.kind === 'level', gauge = station.source === 'chs'
    const speed = (v) => `${Math.abs(v).toFixed(1)} knots`
    const rows = level
      ? [['High tide', next.high, (e) => `${e.value.toFixed(2)} m`], ['Low tide', next.low, (e) => `${e.value.toFixed(2)} m`]]
      : [['Slack water', next.slack, () => ''], ['Max flood', next.flood, (e) => speed(e.value)], ['Max ebb', next.ebb, (e) => speed(e.value)]]
    rows.sort((a, b) => (a[1]?.ms ?? Infinity) - (b[1]?.ms ?? Infinity))
    const { svg, drawn, nowValue } = tideSvg(station, tide, now)
    const table = el('table', null, 'tide-events'), body = el('tbody')
    const row = (label, time, value) => { const tr = el('tr'); tr.append(el('th', label), el('td', time), el('td', value)); body.append(tr) }
    for (const [label, e, say] of rows) row(label, e ? tideClock(e.ms, now) : 'none in 30 h', e ? say(e) : '')
    if (gauge) row('Observed', tide.latest ? tideClock(tide.latest.ms, now) : 'none just now', tide.latest ? `${tide.latest.v.toFixed(2)} m` : '')
    else if (nowValue != null) row('Right now', '', level ? `${nowValue.toFixed(2)} m` : Math.abs(nowValue) < 0.05 ? 'slack' : `${speed(nowValue)} ${nowValue > 0 ? 'flood' : 'ebb'}`)
    table.append(body); nodes.push(table)
    if (svg) { const wrap = el('div', null, 'tide-curve-box'); wrap.append(svg); nodes.push(wrap) }
    const toward = (deg) => compassWord(deg)
    const notes = [gauge ? 'Predicted and observed, in Pacific time.' : 'Predicted, in Pacific time.']
    if (gauge) notes.push('Heights are metres above chart datum.')
    else if (level) notes.push('Heights are metres above chart datum (MLLW).')
    else {
      if (tide.floodDir != null && tide.ebbDir != null) notes.push(`Flood flows toward the ${toward(tide.floodDir)}, ebb toward the ${toward(tide.ebbDir)}.`)
      if (tide.feet != null) notes.push(`About ${Math.round(tide.feet * 0.3048)} m (${tide.feet} ft) below the surface.`)
    }
    if (gauge && !tide.latest) notes.push('The observed levels could not be loaded just now.')
    else if (gauge && tide.latest.reviewed === false) notes.push('Observed levels are real-time readings that have not been reviewed.')
    if (gauge && !tide.series) notes.push('The predicted levels could not be loaded just now, so the curve is drawn between the highs and lows.')
    else if (drawn) notes.push('NOAA gives only the times and speeds of slack water and the strongest current here, so the curve is drawn between them.')
    const line = (t, cls) => nodes.push(el('p', t, cls))
    line(notes.join(' '), 'src')
    if (gauge) {
      line(`Not for navigation. Source: Canadian Hydrographic Service, station ${station.id}, drawn here from its numbers.`, 'src')
      line(IWLS_NOTICE, 'src notice')
    } else line(`Predictions, not for navigation. Source: NOAA/NOS/CO-OPS, station ${station.id}, drawn here from NOAA’s numbers. Not official NOAA material.`, 'src')
    const href = gauge ? `https://tides.gc.ca/en/stations/${encodeURIComponent(station.id)}` : level ? `https://tidesandcurrents.noaa.gov/noaatidepredictions.html?id=${encodeURIComponent(station.id)}` : (tide.bin ? `https://tidesandcurrents.noaa.gov/noaacurrents/predictions?id=${encodeURIComponent(`${station.id}_${tide.bin}`)}` : null)
    const a = href ? link(href, gauge ? 'This station on the Canadian Hydrographic Service site' : 'This station on NOAA’s site') : null
    if (a) { const d = el('p'); d.append(a); nodes.push(d) }
    return nodes
  }
  // Ask for the station's predictions and put them in the popup when they arrive. The popup is told, so it can resize.
  function fillTide(station, body, box) {
    const done = (nodes) => { body.replaceChildren(...nodes); box.dispatchEvent(new Event('filled')) }
    const gauge = station.source === 'chs'
    tideFor(station).then((tide) => done(tideNodes(station, tide)), () => done(gauge
      ? [el('p', 'The Canadian Hydrographic Service’s levels for this station could not be loaded just now. Try again later.'), el('p', 'Not for navigation. Source: Canadian Hydrographic Service.', 'src'), el('p', IWLS_NOTICE, 'src notice')]
      : [el('p', 'Predictions for this station could not be loaded just now. Try again later.'), el('p', 'Predictions, not for navigation. Source: NOAA/NOS/CO-OPS.', 'src')]))
  }

  // ---- the readout for a click on the sea: the modelled current of the hour shown and the temperature or saltiness at the place,
  // read from the grids already loaded, so a click makes no request.
  const waterLayerId = () => map.getStyle().layers.find((l) => l.type === 'fill' && l['source-layer'] === 'water' && l.source && !/mask/.test(l.id))?.id
  function seaReadout(e) {
    const { lngLat, point } = e, shown = sea.shown, kind = activeScalar()
    const uv = state.currents.on && shown ? seaVelocity(shown.grid, lngLat.lng, lngLat.lat) : null // null on land, or outside the model
    // With only a temperature or saltiness picture on, the click has to be on the basemap's water.
    const wet = !uv && kind && scalar.shown?.kind === kind && (() => { const id = waterLayerId(); return !!id && map.queryRenderedFeatures(point, { layers: [id] }).length > 0 })()
    if (!uv && !wet) return null
    const box = el('div')
    box.append(el('h3', uv ? 'Modelled sea current' : `Modelled ${SCALARS[kind].what}`))
    box.append(el('span', 'model estimate', 'tag'))
    if (uv) {
      const r = currentReadout(uv)
      box.append(el('p', r.still ? `Almost still: ${r.knots.toFixed(2)} knots (${r.ms.toFixed(2)} m/s).` : `${r.knots.toFixed(1)} knots (${r.ms.toFixed(2)} m/s), flowing toward the ${r.toward}.`))
      box.append(el('p', `Surface current for ${pacificHour(shown.time)}.`))
    }
    if (kind && scalar.shown?.kind === kind) {
      // The number is read from the grid the picture was made from, so it is the one the colour stands for.
      const v = scalarAt(scalar.shown.grid, lngLat.lng, lngLat.lat)
      box.append(el('p', v == null ? `Surface ${SCALARS[kind].what}: the model has no value here.` : `Surface ${SCALARS[kind].what}: ${scalarText(kind, v)} (for ${pacificHour(scalar.shown.time)}).`))
    }
    box.append(el('p', 'Model estimate, not for navigation. Environment Canada’s CIOPS Salish Sea model (experimental), on a 1 km grid.', 'src'))
    return box
  }

  // ---- add the map layers (called once, when the basemap style is in)
  function addLayers({ before, ecoBefore, water, demTiles }) {
    const src = (id, attribution, data = EMPTY) => map.addSource(id, { type: 'geojson', data, ...(attribution ? { attribution } : {}) })
    const hidden = { visibility: 'none' }
    // The image source of the radar cannot carry an attribution, so an empty point source does.
    src('ov-radar-credit', ECCC_ATTRIB)
    map.addLayer({ id: 'radar-credit', type: 'circle', source: 'ov-radar-credit', layout: hidden, paint: { 'circle-radius': 0, 'circle-opacity': 0 } }, before)

    src('ov-currents-credit', ECCC_ATTRIB)
    map.addLayer({ id: 'currents-credit', type: 'circle', source: 'ov-currents-credit', layout: hidden, paint: { 'circle-radius': 0, 'circle-opacity': 0 } }, before)

    src('ov-wind-credit', ECCC_ATTRIB)
    map.addLayer({ id: 'wind-credit', type: 'circle', source: 'ov-wind-credit', layout: hidden, paint: { 'circle-radius': 0, 'circle-opacity': 0 } }, before)

    src('ov-temperature-credit', ECCC_ATTRIB)
    map.addLayer({ id: 'temperature-credit', type: 'circle', source: 'ov-temperature-credit', layout: hidden, paint: { 'circle-radius': 0, 'circle-opacity': 0 } }, before)

    src('ov-salinity-credit', ECCC_ATTRIB)
    map.addLayer({ id: 'salinity-credit', type: 'circle', source: 'ov-salinity-credit', layout: hidden, paint: { 'circle-radius': 0, 'circle-opacity': 0 } }, before)

    // Seafloor depth: colours drawn in the browser from the elevation tiles (ETOPO1 below the waterline), on its own copy of the
    // source with its tiles stopped at zoom 8, so the colours still show at street zoom from the zoom 8 tile and no deeper
    // tile is asked for. Measured 2026-10-22: from tile zoom 9 the Canadian and U.S. land data masks the sea near the coast to
    // 0 m (a hole round Victoria's waters), and from zoom 11 the sea is flat 0 m everywhere. Same address as the other two
    // elevation sources, so no new host.
    scalar.before = ecoBefore
    map.addSource('seafloor', { type: 'raster-dem', tiles: [demTiles], encoding: 'terrarium', tileSize: 256, maxzoom: SEAFLOOR_MAX_ZOOM, attribution: SEAFLOOR_ATTRIB })
    map.addLayer({ id: 'seafloor', type: 'color-relief', source: 'seafloor', layout: hidden, paint: { 'color-relief-color': depthExpression(), 'color-relief-opacity': SEAFLOOR_OPACITY } }, ecoBefore)
    // The Canadian Hydrographic Service tiles over it: 100 m cells below map zoom 11 and 10 m cells from there. Tiles are asked for
    // by the "nonna" protocol (loadNonnaTile), and only while their layer is shown, which is while the box is ticked. The tile
    // already carries the layer's opacity, mixed with the colour of the water under it, so the layer itself is opaque.
    nonna.sea = nonna.daySea = rgbOf(water?.paint?.['fill-color']) || (basemap ? [194, 200, 202] : [238, 240, 234])
    addNonna(ecoBefore, false)

    src('ov-ecoregions', ECO_ATTRIB)
    map.addLayer({ id: 'ecoregions-fill', type: 'fill', source: 'ov-ecoregions', layout: hidden, paint: { 'fill-color': '#4f8a5b', 'fill-opacity': 0.22 } }, ecoBefore)
    if (water) {
      map.addLayer({ id: 'ecoregions-sea-mask', type: 'fill', source: water.source, 'source-layer': 'water', filter: water.filter, layout: hidden,
        paint: { 'fill-color': water.paint?.['fill-color'] ?? '#c2c8ca', 'fill-antialias': true } }, ecoBefore)
    }
    map.addLayer({ id: 'ecoregions-line', type: 'line', source: 'ov-ecoregions', layout: hidden, paint: { 'line-color': '#2f6a3d', 'line-width': 1.4 } }, ecoBefore)

    // Marine life and protection. The areas sit under the parks and creeks, so land features stay on top of anything that touches the
    // shore. The lines and dots sit with the other dots, under the basemap's labels.
    src('ov-srkw', SRKW_ATTRIB)
    map.addLayer({ id: 'srkw-fill', type: 'fill', source: 'ov-srkw', layout: hidden, paint: { 'fill-color': '#c0522c', 'fill-opacity': 0.12 } }, ecoBefore)
    map.addLayer({ id: 'srkw-line', type: 'line', source: 'ov-srkw', layout: hidden, paint: { 'line-color': '#8c2f0f', 'line-width': 2.2, 'line-dasharray': [3, 2] } }, ecoBefore)
    src('ov-rkw', RKW_ATTRIB)
    // A dotted outline, so it reads as a part of the critical habitat above and not a second copy of it.
    map.addLayer({ id: 'rkw-fill', type: 'fill', source: 'ov-rkw', layout: hidden, paint: { 'fill-color': '#c0522c', 'fill-opacity': 0.12 } }, ecoBefore)
    map.addLayer({ id: 'rkw-line', type: 'line', source: 'ov-rkw', layout: { ...hidden, 'line-cap': 'round' }, paint: { 'line-color': '#6b1d12', 'line-width': 2.6, 'line-dasharray': [0.1, 2] } }, ecoBefore)
    src('ov-cetaceans', CETACEANS_ATTRIB)
    map.addLayer({ id: 'cetaceans-fill', type: 'fill', source: 'ov-cetaceans', layout: hidden, paint: { 'fill-color': DENSITY_COLOURS[0], 'fill-opacity': 0.75 } }, ecoBefore)
    map.addLayer({ id: 'cetaceans-line', type: 'line', source: 'ov-cetaceans', layout: hidden, paint: { 'line-color': '#ffffff', 'line-opacity': 0.5, 'line-width': 0.6 } }, ecoBefore)
    src('ov-protected', PROTECTED_ATTRIB)
    map.addLayer({ id: 'protected-fill', type: 'fill', source: 'ov-protected', layout: hidden, paint: { 'fill-color': '#0f7f7b', 'fill-opacity': 0.3 } }, ecoBefore)
    map.addLayer({ id: 'protected-line', type: 'line', source: 'ov-protected', layout: hidden, paint: { 'line-color': '#0b5f5c', 'line-width': 1.5 } }, ecoBefore)
    src('ov-kelp', CRIMS_ATTRIB)
    map.addLayer({ id: 'kelp-fill', type: 'fill', source: 'ov-kelp', layout: hidden, paint: { 'fill-color': '#8a6d0b', 'fill-opacity': 0.7 } }, ecoBefore)
    map.addLayer({ id: 'kelp-line', type: 'line', source: 'ov-kelp', layout: hidden, paint: { 'line-color': '#6b5408', 'line-width': 1 } }, ecoBefore)
    src('ov-eelgrass', CRIMS_ATTRIB)
    map.addLayer({ id: 'eelgrass-fill', type: 'fill', source: 'ov-eelgrass', layout: hidden, paint: { 'fill-color': '#1f9d55', 'fill-opacity': 0.75 } }, ecoBefore)
    map.addLayer({ id: 'eelgrass-line', type: 'line', source: 'ov-eelgrass', layout: hidden, paint: { 'line-color': '#136b39', 'line-width': 1 } }, ecoBefore)
    src('ov-herring', CRIMS_ATTRIB)
    map.addLayer({ id: 'herring-line', type: 'line', source: 'ov-herring', layout: { ...hidden, 'line-cap': 'round' }, paint: { 'line-color': '#e8590c', 'line-width': ['interpolate', ['linear'], ['zoom'], 9, 2, 14, 4] } }, before)
    src('ov-seabirds', CRIMS_ATTRIB)
    map.addLayer({ id: 'seabirds-dot', type: 'circle', source: 'ov-seabirds', layout: hidden, paint: { 'circle-radius': 6, 'circle-color': '#ffd23f', 'circle-stroke-width': 2, 'circle-stroke-color': '#3d2f00' } }, before)

    src('ov-alerts', ECCC_ATTRIB)
    map.addLayer({ id: 'alerts-fill', type: 'fill', source: 'ov-alerts', layout: hidden, paint: { 'fill-color': ['get', 'colour'], 'fill-opacity': 0.14 } }, before)
    map.addLayer({ id: 'alerts-line', type: 'line', source: 'ov-alerts', layout: hidden, paint: { 'line-color': ['get', 'colour'], 'line-width': 3 } }, before)

    src('ov-industry', INDUSTRY_ATTRIB)
    map.addLayer({ id: 'industry-dot', type: 'circle', source: 'ov-industry', layout: hidden, paint: {
      'circle-radius': ['case', ['has', 'facts'], 7, 5],
      'circle-color': ['match', ['get', 'kind'], 'landfill', '#8a6a3b', 'wastewater', '#2d7f9a', 'power', '#c79a1d', '#555555'],
      'circle-stroke-width': 2, 'circle-stroke-color': '#ffffff' } }, before)

    src('ov-tides', TIDES_ATTRIB)
    map.addLayer({ id: 'tides-dot', type: 'circle', source: 'ov-tides', layout: hidden, paint: {
      'circle-radius': 8, 'circle-color': ['match', ['get', 'kind'], 'level', '#0e7c86', 'current', '#4338ca', '#555555'],
      'circle-stroke-width': 2.5, 'circle-stroke-color': '#ffffff' } }, before)

    src('ov-life', GBIF_ATTRIB)
    map.addLayer({ id: 'life-dot', type: 'circle', source: 'ov-life', layout: hidden, paint: {
      'circle-radius': 5, 'circle-color': '#3d8f4f', 'circle-opacity': 0.6, 'circle-stroke-width': 1, 'circle-stroke-color': '#ffffff' } }, before)

    src('ov-water', ECCC_ATTRIB)
    map.addLayer({ id: 'water-dot', type: 'circle', source: 'ov-water', layout: hidden, paint: { 'circle-radius': 8, 'circle-color': '#0b6fa4', 'circle-stroke-width': 2.5, 'circle-stroke-color': '#ffffff' } }, before)

    src('ov-conditions', ECCC_ATTRIB)
    map.addLayer({ id: 'conditions-dot', type: 'circle', source: 'ov-conditions', layout: hidden, paint: { 'circle-radius': 12, 'circle-color': '#f4efe2', 'circle-stroke-width': 2, 'circle-stroke-color': '#7a6a3a' } }, before)

    src('ov-aqhi', ECCC_ATTRIB)
    map.addLayer({ id: 'aqhi-dot', type: 'circle', source: 'ov-aqhi', layout: hidden, paint: {
      'circle-radius': 14, 'circle-stroke-width': 2, 'circle-stroke-color': '#ffffff',
      'circle-color': ['step', ['get', 'aqhi'], '#7fbf7b', 3.5, '#f2c94c', 6.5, '#e07b00', 10.5, '#9b2d20'] } }, before)

    src('ov-quakes', USGS_ATTRIB)
    map.addLayer({ id: 'quakes-dot', type: 'circle', source: 'ov-quakes', layout: hidden, paint: {
      'circle-radius': ['interpolate', ['linear'], ['get', 'mag'], 0, 4, 2, 7, 4, 13, 6, 24],
      'circle-color': ['interpolate', ['linear'], ['get', 'age_h'], 0, '#b3261e', 168, '#f3b8a8'],
      'circle-opacity': 0.85, 'circle-stroke-width': 1.5, 'circle-stroke-color': '#ffffff' } }, before)

    for (const id of Object.keys(DEFS)) setVisible(DEFS[id], false)
    ready()
  }

  // Text on the dots needs the basemap's glyph server, so the caller skips this when the basemap
  // is down. It is called after the page's own labels so the numbers sit on top of them.
  function addLabels({ font }) {
    const label = (id, source, field, extra = {}, paint = {}) => map.addLayer({ id, type: 'symbol', source, layout: { visibility: 'none', 'text-field': field, 'text-font': font, 'text-size': 12, 'text-allow-overlap': true, ...extra },
      paint: { 'text-color': '#1d1d1d', 'text-halo-color': 'rgba(255,255,255,.9)', 'text-halo-width': 1.2, ...paint } })
    label('aqhi-label', 'ov-aqhi', ['get', 'shown'], { 'text-size': 13 }, { 'text-halo-width': 0 })
    label('conditions-label', 'ov-conditions', ['get', 'label'], { 'text-size': 12 }, { 'text-halo-width': 0 })
    label('water-label', 'ov-water', ['get', 'label'], { 'text-offset': [0, 1.5], 'text-anchor': 'top', 'text-size': 11 }, { 'text-color': '#0b4f73' })
    label('tides-label', 'ov-tides', ['get', 'short'], { 'text-offset': [0, 1.4], 'text-anchor': 'top', 'text-size': 11, 'text-optional': true }, { 'text-color': '#2b2a63' })
    label('quakes-label', 'ov-quakes', ['get', 'label'], { 'text-offset': [0, 1.6], 'text-anchor': 'top', 'text-size': 11, 'text-optional': true }, { 'text-color': '#7a1a14' })
  }

  // ---- popups (DOM nodes and textContent only)
  const fmtNum = (n, d = 1) => Number(n).toLocaleString('en-CA', { maximumFractionDigits: d })
  function popupFor(f, layer, group = [f], hits = []) {
    const p = f.properties, box = el('div')
    const add = (title, tag, lines, src) => {
      box.append(el('h3', title))
      if (tag) box.append(el('span', tag, 'tag'))
      for (const l of lines) if (l) box.append(el('p', l))
      if (src) box.append(el('p', src, 'src'))
    }
    const more = (href, label) => { const a = link(href, label); if (a) { const d = el('p'); d.append(a); box.append(d) } }
    const addInfo = (i) => add(i.title, i.tag, i.lines, i.source)
    const ECCC = 'Data Source: Environment and Climate Change Canada.'
    if (layer === 'aqhi-dot') {
      add(p.name, 'air quality (AQHI)', [`Air Quality Health Index ${p.shown}: ${p.band}. (${fmtNum(p.aqhi, 2)} before rounding.)`, `Observed ${pacificTime(p.when)}.`, 'The AQHI is a health index from 1 to 10+, not a pollutant measurement.'], ECCC)
      if (p.id) more(`https://api.weather.gc.ca/collections/aqhi-observations-realtime/items/${encodeURIComponent(p.id)}?f=html`, 'This reading on the Environment Canada service')
    } else if (layer === 'quakes-dot') {
      add(`Magnitude ${fmtNum(p.mag)} earthquake`, p.status ? `status: ${p.status}` : 'earthquake', [p.place, `${pacificTime(p.time)}.`, p.depth_km != null ? `Depth ${fmtNum(p.depth_km)} km${p.mag_type ? `, magnitude type ${p.mag_type}` : ''}.` : null], 'Source: U.S. Geological Survey. Early values are revised.')
      if (p.url) more(p.url, 'Event page at the U.S. Geological Survey')
    } else if (layer === 'conditions-dot') {
      const lines = [
        p.temp != null ? `Air temperature ${fmtNum(p.temp)} °C.` : null,
        p.humidity != null ? `Relative humidity ${fmtNum(p.humidity, 0)} %.` : null,
        p.wind != null ? `Wind ${fmtNum(p.wind)} ${p.wind_unit}${p.wind_dir != null ? ` from ${fmtNum(p.wind_dir, 0)}°` : ''} (10-minute average).` : null,
        p.pressure != null ? `${p.pressure_kind[0].toUpperCase()}${p.pressure_kind.slice(1)} ${fmtNum(p.pressure)} ${p.pressure_unit}.` : null,
        p.rain_1h != null ? `Rain in the past hour ${fmtNum(p.rain_1h)} mm.` : null,
        `Reported ${pacificTime(p.when)}.`,
      ]
      const provider = p.provider && p.provider !== 'MSC' ? ` and ${p.provider}` : ''
      add(p.name, 'weather station', lines, `Data Source: Environment and Climate Change Canada${provider}.`)
    } else if (layer === 'water-dot') {
      add(p.name, `river gauge, ${p.km} km from downtown Victoria`, [
        p.level != null ? `Level ${fmtNum(p.level, 3)} m.` : null,
        p.discharge != null ? `Flow ${fmtNum(p.discharge, 3)} m³/s.` : null,
        `Latest reading ${pacificTime(p.when)}.`,
        `Distance is a straight line. Station ${p.number}.`,
      ], `${ECCC}${p.contributor ? ` Contributor: ${p.contributor}.` : ''}`)
      more(`https://wateroffice.ec.gc.ca/report/real_time_e.html?stn=${encodeURIComponent(p.number)}`, 'This station on Water Office')
    } else if (layer === 'life-dot') {
      const shown = group.slice(0, 5)
      shown.forEach((g, i) => {
        const q = g.properties
        if (i) box.append(el('hr'))
        box.append(el('h3', q.name))
        box.append(el('span', [q.kingdom, 'observation'].filter(Boolean).join(', '), 'tag'))
        if (q.date) box.append(el('p', `Observed ${q.date.replace(/T.*$/, '')}. Position rounded to about 1 km.`))
        if (q.dataset) {
          const d = el('p', 'Dataset: ')
          const l = q.dataset_key ? link(`https://www.gbif.org/dataset/${q.dataset_key}`, q.dataset) : null
          d.append(l || document.createTextNode(q.dataset))
          box.append(d)
        }
        const lic = el('p', 'Licence: ')
        lic.append(link(q.licence_url, q.licence) || document.createTextNode(q.licence))
        if (q.holder) lic.append(document.createTextNode(`. Credit: ${q.holder}`))
        box.append(lic)
        const rec = link(`https://www.gbif.org/occurrence/${q.key}`, 'This record on GBIF')
        if (rec) { const d = el('p'); d.append(rec); box.append(d) }
      })
      if (group.length > shown.length) box.append(el('p', `${group.length - shown.length} more records at this spot.`, 'src'))
      box.append(el('p', 'Source: GBIF. A sample, not every observation. Records withheld or generalised by their publisher are left out.', 'src'))
    } else if (layer === 'industry-dot') {
      const s = INDUSTRY_SOURCES[p.src]
      add(p.name || `Unnamed ${KIND_LABEL[p.kind] || 'site'}`, KIND_LABEL[p.kind], [
        p.name ? null : 'The source gives this site no name.',
        p.type ? `${p.kind === 'wastewater' ? 'Treatment level' : 'Type in the source'}: ${p.type}.` : null,
        p.status ? `Status: ${p.status}.` : null,
        ...(p.facts ? p.facts.split(' | ').map((x) => `${x}.`) : [p.kind === 'power' ? null : 'No figures. This is a location only, not an empty site.']),
        p.listed_as ? `Listed in the source as “${p.listed_as}”.` : null,
        p.note,
      ], s ? s.text : null)
      if (p.note_url) more(p.note_url, 'Capital Regional District page')
      if (s) more(s.href, s.label)
    } else if (layer === 'tides-dot') {
      const station = tideStation(p.id)
      if (!station) return null
      add(station.name, station.source === 'chs' ? 'tide gauge' : station.kind === 'level' ? 'tide predictions' : 'tidal current predictions', [], null)
      const body = el('div', null, 'tide-body')
      body.append(el('p', station.source === 'chs' ? 'Asking the Canadian Hydrographic Service for this station’s levels…' : 'Asking NOAA for this station’s predictions…'))
      box.append(body)
      fillTide(station, body, box)
    } else if (layer === 'seabirds-dot') {
      addInfo(seabirdInfo(p))
    } else if (layer === 'herring-line') {
      addInfo(herringInfo(p))
    } else if (layer === 'kelp-fill') {
      addInfo(kelpInfo(p))
    } else if (layer === 'eelgrass-fill') {
      addInfo(eelgrassInfo(p))
    } else if (layer === 'protected-fill' || layer === 'srkw-fill' || layer === 'rkw-fill' || layer === 'cetaceans-fill') {
      // One popup for everything under the click that is a protected area, the critical habitat or the model, in that order. The
      // vessel distances are said once, at the end, when any whale is in it.
      const under = (id) => (hits.length ? hits.filter((h) => h.layer.id === id) : id === layer ? group : [])
      const seen = new Set(), areas = under('protected-fill').filter((h) => { const k = `${h.properties.name}|${h.properties.type}`; return !seen.has(k) && seen.add(k) })
      const sections = areas.slice(0, 3).map((h) => protectedInfo(h.properties))
      if (under('srkw-fill').length) sections.push(srkwInfo(under('srkw-fill')[0].properties))
      if (under('rkw-fill').length) sections.push(rkwInfo(under('rkw-fill')[0].properties))
      if (under('cetaceans-fill').length) sections.push(cetaceanInfo(under('cetaceans-fill')[0].properties, cet.key))
      const whales = sections.some((i) => i.lines.includes(WHALE_RULES))
      sections.forEach((i, k) => { if (k) box.append(el('hr')); addInfo({ ...i, lines: i.lines.filter((l) => l !== WHALE_RULES), source: i.source.replace(` ${OGL_CANADA_LINE}`, '') }) })
      box.append(el('hr'))
      if (whales) {
        box.append(el('p', WHALE_RULES))
        for (const l of WHALE_RULE_LINKS) more(l.href, l.label)
      }
      box.append(el('p', OGL_CANADA_LINE, 'src'))
    } else if (layer === 'ecoregions-fill') {
      add(p.name, 'ecoregion', [`Biome: ${p.biome}.`, `Realm: ${p.realm}.`, 'The shapes come from a worldwide map, so the coast and edges are coarse.'], 'Ecoregions 2017 © Resolve. Licensed under CC BY 4.0. Simplified and clipped to this map’s box.')
      more('https://ecoregions.appspot.com/', 'Ecoregions 2017')
    } else return null
    return box
  }

  // Points and lines first, then the small areas, then the big ones, so the most specific thing under a click is the popup.
  const QUERY_LAYERS = ['quakes-dot', 'aqhi-dot', 'conditions-dot', 'water-dot', 'life-dot', 'industry-dot', 'tides-dot', 'seabirds-dot', 'herring-line', 'kelp-fill', 'eelgrass-fill', 'protected-fill', 'rkw-fill', 'srkw-fill', 'cetaceans-fill']
  const POPUP_LAYERS = [...QUERY_LAYERS, 'ecoregions-fill']
  // Areas of the sea. A click on the sea that reaches one of these also gets the sea readout, above the area's popup.
  const SEA_AREA_LAYERS = ['kelp-fill', 'eelgrass-fill', 'protected-fill', 'rkw-fill', 'srkw-fill', 'cetaceans-fill']

  return { addLayers, addLabels, popupFor, seaReadout, setNight, queryLayers: QUERY_LAYERS, popupLayers: POPUP_LAYERS, seaAreaLayers: SEA_AREA_LAYERS, defs: DEFS, state, radar, sea, wind, scalar, tideCache, flow, enable, disable, showFrame }
}
