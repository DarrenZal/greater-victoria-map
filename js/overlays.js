// Optional overlays for the Greater Victoria demo map. Plain ES module, no build step.
//
// Eight live layers load from outside services straight from the visitor's browser, and two
// static layers (ecoregions, industry and waste sites) load their own data file. Every one is
// off by default and makes no request until its box is ticked. Each shows a plain status line,
// and a plain failure line if its request fails. Parsing and filtering live in
// js/overlays-data.js, which has no DOM code so the checks can run it in Node.
import {
  DEMO_BOX, REGION, DOWNTOWN, collection, pacificTime, distanceKm,
  radarCapabilitiesUrl, radarTimes, radarGeometry, radarFrameUrl, radarLegendUrl,
  alertsUrl, normaliseAlerts, aqhiUrl, normaliseAqhi, quakesUrl, normaliseQuakes,
  conditionsUrl, normaliseConditions, waterStationsUrl, waterReadingUrl, nearestGauges, gaugeFeature,
  lifeUrls, normaliseLife,
  CURRENTS_PLAY_HOURS, currentsCapabilitiesUrl, currentsTimes, currentsWindow, currentsUrl, currentsGrid, readGeoTiff, pacificHour,
} from './overlays-data.js'
import { createCurrents, SPEED_UP } from './currents.js'

const ECCC_LICENCE = 'https://eccc-msc.github.io/open-data/licence/readme_en/'
// The statement the Environment and Climate Change Canada licence requires when the server names
// no specific one (version 2.1.1, August 2026). The credits panel adds its "Data Source" line.
export const ECCC_ATTRIB = `Contains information licenced under the <a href="${ECCC_LICENCE}" target="_blank" rel="noopener">Data Server End-use Licence</a> of Environment and Climate Change Canada.`
const USGS_ATTRIB = 'Earthquakes: <a href="https://www.usgs.gov/information-policies-and-instructions/copyrights-and-credits" target="_blank" rel="noopener">U.S. Geological Survey</a>'
const GBIF_ATTRIB = 'Observations: <a href="https://www.gbif.org" target="_blank" rel="noopener">GBIF</a>, CC0 or CC BY 4.0 per record'
const ECO_ATTRIB = 'Ecoregions 2017 &copy; <a href="https://ecoregions.appspot.com/" target="_blank" rel="noopener">Resolve</a>, <a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noopener">CC BY 4.0</a>'
const INDUSTRY_ATTRIB = 'Industry and waste sites: Statistics Canada (OGL &ndash; Canada), HydroWASTE (CC BY 4.0), WRI (CC BY 4.0)'

// The full attribution of each industry and waste source, shown in the popup of its sites.
const INDUSTRY_SOURCES = {
  odi: { text: 'Statistics Canada, Open Database of Infrastructure, Version 2 (Catalogue no. 34-26-0003), released November 13, 2024. Contains information licensed under the Open Government Licence – Canada.', href: 'https://open.canada.ca/en/open-government-licence-canada', label: 'Open Government Licence – Canada' },
  hydrowaste: { text: 'Ehalt Macedo, H., Lehner, B., Nicell, J., Grill, G., Li, J., Limtong, A., Shakya, R. (2022). Distribution and characteristics of wastewater treatment plants within the global river network. Earth System Science Data, 14(2): 559-577. HydroWASTE version 1.0, licensed CC BY 4.0. Clipped to this map’s box and shortened.', href: 'https://doi.org/10.5194/essd-14-559-2022', label: 'HydroWASTE paper' },
  gppd: { text: 'Global Energy Observatory, Google, KTH Royal Institute of Technology in Stockholm, Enipedia, World Resources Institute. 2021. Global Power Plant Database version 1.3.0. Licensed CC BY 4.0. Clipped to this map’s box.', href: 'https://datasets.wri.org/datasets/global-power-plant-database', label: 'Global Power Plant Database' },
}
const KIND_LABEL = { landfill: 'landfill or waste site', power: 'power plant', wastewater: 'wastewater plant or pump station' }

const EMPTY = collection([])
const text = async (url, signal) => { const r = await fetch(url, { signal }); if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.text() }
const json = async (url, signal) => { const r = await fetch(url, { signal }); if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json() }
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`
const km = (n) => `${Math.round(n)} km`

export function createOverlays({ map, $, el, link, basemap, motionQuery }) {
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
    radar: { label: 'Precipitation radar', ids: ['radar', 'radar-credit'], ttl: 5 * 60e3, load: loadRadar },
    currents: { label: 'Sea currents', ids: ['currents-credit'], ttl: 30 * 60e3, load: loadCurrents },
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
    if (id === 'radar') $('radar-controls').hidden = false
    if (id === 'currents') showCurrentsControls(true)
    if (st.loading) { showStatus(id); return }
    if (st.loadedAt && Date.now() - st.loadedAt < def.ttl) { showStatus(id); return }
    st.loading = true
    const ac = st.abort = new AbortController()
    const timer = setTimeout(() => ac.abort(), 25000)
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
      setStatus(id, 'fail', failureLine(id, def))
      if (def.source) map.getSource(def.source)?.setData(EMPTY)
    } finally {
      clearTimeout(timer)
      st.loading = false
    }
  }
  function failureLine(id, def) {
    if (id === 'alerts') return 'Weather alerts could not be loaded, so this map is not showing whether any are in effect. Check Environment Canada’s own alerts.'
    if (id === 'radar') return 'Precipitation radar could not be loaded just now. Try again later.'
    return `${def.label} could not be loaded just now. Try again later.`
  }
  function disable(id) {
    const def = DEFS[id], st = state[id]
    st.on = false
    st.abort?.abort()
    st.loading = false
    setVisible(def, false)
    hideStatus(id)
    if (id === 'radar') {
      // Drop the frames (about 2 MB each in memory) and start fresh next time.
      $('radar-controls').hidden = true
      stopRadar()
      radar.playing = false; radar.frames = []; radar.shown = -1; st.loadedAt = 0
      syncPlayButton()
    }
    if (id === 'currents') {
      // Free the canvas and the hours kept in memory, and start fresh next time.
      stopSea()
      sea.playing = false; sea.hours = []; sea.at = -1; sea.cache.clear(); st.loadedAt = 0
      currents.hide()
      showCurrentsControls(false)
      syncSeaPlay()
    }
  }
  const boxes = document.querySelectorAll('input[data-overlay]')
  for (const box of boxes) {
    box.addEventListener('change', () => {
      const id = box.dataset.overlay
      if (box.checked) { state[id].on = true; enable(id) } else disable(id)
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
  async function frameImage(time, signal) {
    const r = await fetch(radarFrameUrl(time, geo), { signal })
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    if (!/image\/png/i.test(r.headers.get('content-type') || '')) throw new Error('the service sent no image')
    const bitmap = await createImageBitmap(await r.blob())
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
    const times = radarTimes(await text(radarCapabilitiesUrl(), signal))
    const got = new Map()
    let failed = 0
    const queue = [...times].reverse() // newest first, so a picture appears as soon as one frame is in
    const worker = async () => {
      for (let t; (t = queue.shift());) {
        try { got.set(t, await frameImage(t, signal)) } catch { if (signal.aborted) return; failed++; continue }
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

  // ---- sea currents: modelled hourly surface currents, drawn as moving particles (js/currents.js)
  // Each hour is two small images from the GeoMet WCS, one for each component of the velocity. Only the
  // hour shown is fetched, and while Play runs the one after it. The last few hours are kept for the next loop.
  const currents = createCurrents({ map, motionQuery })
  const sea = { hours: [], at: -1, cache: new Map(), playing: false, timer: 0 }
  const SEA_CACHE_HOURS = 14, SEA_STEP_MS = 1500
  const seaSignal = () => state.currents.abort?.signal
  const stopSea = () => { clearTimeout(sea.timer); sea.timer = 0 }
  const showCurrentsControls = (on) => { $('currents-controls').hidden = !on; $('currents-note').hidden = !on }
  async function tiff(axis, time, signal) {
    const r = await fetch(currentsUrl(axis, time), { signal })
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    // Out of range, the service answers HTTP 200 with a description of the error.
    if (!/image\/tiff/i.test(r.headers.get('content-type') || '')) throw new Error('the service sent no image')
    return readGeoTiff(await r.arrayBuffer())
  }
  async function seaGrid(time, signal) {
    const kept = sea.cache.get(time)
    if (kept) { sea.cache.delete(time); sea.cache.set(time, kept); return kept } // most recently used last
    const grid = currentsGrid(...(await Promise.all([tiff('X', time, signal), tiff('Y', time, signal)])))
    sea.cache.set(time, grid)
    while (sea.cache.size > SEA_CACHE_HOURS) sea.cache.delete(sea.cache.keys().next().value)
    return grid
  }
  const seaMessage = (time) => `Modelled surface currents for ${pacificHour(time)}, Environment Canada’s CIOPS Salish Sea model (experimental, not for navigation).`
  function syncSeaPlay() {
    const b = $('currents-play'), reduced = motionQuery.matches
    b.textContent = sea.playing ? 'Pause' : 'Play'
    b.setAttribute('aria-pressed', String(sea.playing))
    b.disabled = reduced || sea.hours.length < 2
    $('currents-paused').hidden = !reduced || !state.currents.on
    // A line that changes every hour is not read out while Play runs.
    $('status-currents').setAttribute('aria-live', sea.playing ? 'off' : 'polite')
  }
  async function seaStep() {
    stopSea()
    if (!sea.playing || !state.currents.on || document.hidden) return
    const next = (sea.at + 1) % sea.hours.length, signal = seaSignal()
    if (!sea.cache.has(sea.hours[next])) setStatus('currents', 'loading', `Loading sea currents for ${pacificHour(sea.hours[next])}…`)
    try {
      const grid = await seaGrid(sea.hours[next], signal)
      if (!sea.playing || !state.currents.on) return
      sea.at = next
      currents.show(grid)
      setStatus('currents', 'ok', seaMessage(sea.hours[next]))
      seaGrid(sea.hours[(next + 1) % sea.hours.length], signal).catch(() => {}) // the next hour, ready before it is wanted
    } catch (e) {
      if (signal?.aborted || !state.currents.on) return
      setSeaPlaying(false)
      setStatus('currents', 'fail', `The next hour of sea currents could not be loaded just now. The map still shows ${pacificHour(sea.hours[sea.at])}.`)
      return
    }
    sea.timer = setTimeout(seaStep, SEA_STEP_MS)
  }
  function setSeaPlaying(on) {
    sea.playing = on
    syncSeaPlay()
    if (on) seaStep(); else stopSea()
  }
  $('currents-play').addEventListener('click', () => setSeaPlaying(!sea.playing))
  document.addEventListener('visibilitychange', () => { if (sea.playing) seaStep() })
  motionQuery.addEventListener('change', () => { if (motionQuery.matches && sea.playing) setSeaPlaying(false); syncSeaPlay() })
  $('currents-note').textContent = `Particles move ${SPEED_UP.toLocaleString('en-CA')} times faster than the water. Play steps through the next ${CURRENTS_PLAY_HOURS} hours.`

  async function loadCurrents(signal) {
    const { times, at } = currentsWindow(currentsTimes(await text(currentsCapabilitiesUrl(), signal)))
    const grid = await seaGrid(times[at], signal)
    return {
      data: null,
      message: seaMessage(times[at]),
      after() {
        if (!state.currents.on) return
        sea.hours = times; sea.at = at
        currents.show(grid)
        syncSeaPlay()
      },
    }
  }

  // ---- add the map layers (called once, when the basemap style is in)
  function addLayers({ before, ecoBefore, water }) {
    const src = (id, attribution, data = EMPTY) => map.addSource(id, { type: 'geojson', data, ...(attribution ? { attribution } : {}) })
    const hidden = { visibility: 'none' }
    // The image source of the radar cannot carry an attribution, so an empty point source does.
    src('ov-radar-credit', ECCC_ATTRIB)
    map.addLayer({ id: 'radar-credit', type: 'circle', source: 'ov-radar-credit', layout: hidden, paint: { 'circle-radius': 0, 'circle-opacity': 0 } }, before)

    src('ov-currents-credit', ECCC_ATTRIB)
    map.addLayer({ id: 'currents-credit', type: 'circle', source: 'ov-currents-credit', layout: hidden, paint: { 'circle-radius': 0, 'circle-opacity': 0 } }, before)

    src('ov-ecoregions', ECO_ATTRIB)
    map.addLayer({ id: 'ecoregions-fill', type: 'fill', source: 'ov-ecoregions', layout: hidden, paint: { 'fill-color': '#4f8a5b', 'fill-opacity': 0.22 } }, ecoBefore)
    if (water) {
      map.addLayer({ id: 'ecoregions-sea-mask', type: 'fill', source: water.source, 'source-layer': 'water', filter: water.filter, layout: hidden,
        paint: { 'fill-color': water.paint?.['fill-color'] ?? '#c2c8ca', 'fill-antialias': true } }, ecoBefore)
    }
    map.addLayer({ id: 'ecoregions-line', type: 'line', source: 'ov-ecoregions', layout: hidden, paint: { 'line-color': '#2f6a3d', 'line-width': 1.4 } }, ecoBefore)

    src('ov-alerts', ECCC_ATTRIB)
    map.addLayer({ id: 'alerts-fill', type: 'fill', source: 'ov-alerts', layout: hidden, paint: { 'fill-color': ['get', 'colour'], 'fill-opacity': 0.14 } }, before)
    map.addLayer({ id: 'alerts-line', type: 'line', source: 'ov-alerts', layout: hidden, paint: { 'line-color': ['get', 'colour'], 'line-width': 3 } }, before)

    src('ov-industry', INDUSTRY_ATTRIB)
    map.addLayer({ id: 'industry-dot', type: 'circle', source: 'ov-industry', layout: hidden, paint: {
      'circle-radius': ['case', ['has', 'facts'], 7, 5],
      'circle-color': ['match', ['get', 'kind'], 'landfill', '#8a6a3b', 'wastewater', '#2d7f9a', 'power', '#c79a1d', '#555555'],
      'circle-stroke-width': 2, 'circle-stroke-color': '#ffffff' } }, before)

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
    label('quakes-label', 'ov-quakes', ['get', 'label'], { 'text-offset': [0, 1.6], 'text-anchor': 'top', 'text-size': 11, 'text-optional': true }, { 'text-color': '#7a1a14' })
  }

  // ---- popups (DOM nodes and textContent only)
  const fmtNum = (n, d = 1) => Number(n).toLocaleString('en-CA', { maximumFractionDigits: d })
  function popupFor(f, layer, group = [f]) {
    const p = f.properties, box = el('div')
    const add = (title, tag, lines, src) => {
      box.append(el('h3', title))
      if (tag) box.append(el('span', tag, 'tag'))
      for (const l of lines) if (l) box.append(el('p', l))
      if (src) box.append(el('p', src, 'src'))
    }
    const more = (href, label) => { const a = link(href, label); if (a) { const d = el('p'); d.append(a); box.append(d) } }
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
    } else if (layer === 'ecoregions-fill') {
      add(p.name, 'ecoregion', [`Biome: ${p.biome}.`, `Realm: ${p.realm}.`, 'The shapes come from a worldwide map, so the coast and edges are coarse.'], 'Ecoregions 2017 © Resolve. Licensed under CC BY 4.0. Simplified and clipped to this map’s box.')
      more('https://ecoregions.appspot.com/', 'Ecoregions 2017')
    } else return null
    return box
  }

  const QUERY_LAYERS = ['quakes-dot', 'aqhi-dot', 'conditions-dot', 'water-dot', 'life-dot', 'industry-dot']
  const POPUP_LAYERS = [...QUERY_LAYERS, 'ecoregions-fill']

  return { addLayers, addLabels, popupFor, queryLayers: QUERY_LAYERS, popupLayers: POPUP_LAYERS, defs: DEFS, state, radar, sea, currents, enable, disable, showFrame }
}
