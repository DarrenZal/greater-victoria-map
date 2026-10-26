// Greater Victoria demo map. Plain ES module, no build step. Every path is relative so the
// page works from any GitHub Pages project path (https://<org>.github.io/<repo>/).
import { Map, Popup, NavigationControl, ScaleControl, AttributionControl, setWorkerUrl, addProtocol } from '../vendor/maplibre-gl.mjs'
import { createOverlays } from './overlays.js'
import { createTimeLayers } from './time-layers.js'
import { createNight } from './night.js'
import { flowRestMs } from './overlays-data.js'

// MapLibre 6.x ships ES modules only, so its worker is pointed at explicitly.
setWorkerUrl(new URL('../vendor/maplibre-gl-worker.mjs', import.meta.url).href)

// Pale basemap so the data layers stay readable. The style is fetched at run
// time and our layers are added on 'load'. Never hard-code its tile URL: the
// versioned path changes weekly.
const BASEMAP_STYLE = 'https://tiles.openfreemap.org/styles/positron'
// Home view: Greater Victoria core. [west, south], [east, north].
const GV_BOUNDS = [[-123.62, 48.34], [-123.24, 48.62]]
// Soft limit so a visitor cannot pan to the other side of the planet.
const MAX_BOUNDS = [[-124.4, 47.9], [-122.7, 49.1]]
const FIT_PADDING = { top: 56, bottom: 56, left: 16, right: 16 }

const OGL_BC = 'https://www2.gov.bc.ca/gov/content?id=A519A56BC2BF44E4A008B33FCF527F61'
const BC_ATTRIB = `Contains information licensed under the <a href="${OGL_BC}" target="_blank" rel="noopener">Open Government Licence &ndash; British Columbia</a>.`
const PARKS_ATTRIB = 'Parks: also OGL &ndash; Victoria, Saanich, Islands Trust'
// Each provider's own attribution statement, word for word as its licence gives
// it (Saanich spells "licenced"). The popup of a park shows the one for its row.
// The Capital Regional District has no entry: its rows are not on the map.
const LIC_STATEMENTS = {
  V: 'Contains information licensed under the Open Government Licence – City of Victoria.',
  S: 'Contains information licenced under the Open Government Licence – District of Saanich.',
  I: 'Contains information licensed under the Open Government Licence – Islands Trust.',
}
// Terrain shading draws a hillshade from AWS Terrain Tiles (terrarium encoding).
// Shown on the map only while the terrain layer is on. The full credit lines are
// in the credits panel.
const TERRAIN_TILES = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'
const TERRAIN_ATTRIB = 'Terrain: AWS Terrain Tiles, OGL – Canada, USGS, NOAA'
// 3D terrain lifts the map from the same elevation tiles. The hillshade box stays separate.
const TERRAIN_EXAGGERATION = 2 // 1 is true height. Raise it for a more dramatic view.
const TERRAIN_PITCH = 60 // degrees the map tilts when 3D terrain is switched on
const TERRAIN_MAX_PITCH = 75
// MapLibre has no way to remove a sky, so turning 3D off sets its own default: nothing drawn.
const NO_SKY = { 'sky-color': 'transparent', 'horizon-color': 'transparent', 'fog-color': 'transparent', 'fog-ground-blend': 1, 'atmosphere-blend': 0 }
const TERRAIN_SKY = { 'sky-color': '#8db7e0', 'horizon-color': '#e8eef1', 'fog-color': '#eef0ea', 'sky-horizon-blend': 0.5, 'horizon-fog-blend': 0.6, 'fog-ground-blend': 0.5, 'atmosphere-blend': 0 }
const NIGHT_SKY = { 'sky-color': '#0b1522', 'horizon-color': '#1b2735', 'fog-color': '#121a24', 'sky-horizon-blend': 0.5, 'horizon-fog-blend': 0.6, 'fog-ground-blend': 0.5, 'atmosphere-blend': 0 }
// The page's own layers that need a colour of their own at night (the Night look darkens the basemap and every label by itself): the hillshade
// would glow, and the lakes and wetlands, drawn pale for a pale map, would be bright patches on a dark one.
const NIGHT_PAINT = {
  hillshade: { 'hillshade-shadow-color': '#000000', 'hillshade-highlight-color': '#5c676e', 'hillshade-accent-color': '#20262b' },
  lakes: { 'fill-color': '#2b5f80' },
  wetlands: { 'fill-color': '#2f6a5c' },
  'muni-line': { 'line-color': '#8b949c' },
}

// Flow: a pale dash pattern slid along the creek lines makes dashes march in the
// direction of the line, which data/streams-flow.geojson draws downstream.
// The pattern is FLOW_DASH wide, FLOW_GAP empty (in line widths). One cycle is
// 14 half-width steps. Each array is the same pattern shifted a bit further.
const FLOW_DASH = 3, FLOW_GAP = 4
const FLOW_SEQUENCE = Array.from({ length: (FLOW_DASH + FLOW_GAP) * 2 }, (_, i) => {
  const shift = i / 2
  if (shift === 0) return [FLOW_DASH, FLOW_GAP]
  if (shift <= FLOW_GAP) return [0, shift, FLOW_DASH, FLOW_GAP - shift]
  return [shift - FLOW_GAP, FLOW_GAP, FLOW_DASH + FLOW_GAP - shift, 0]
})
const FLOW_STEP_MS = 70
const FLOW_MIN_ZOOM = 9
const FLOW_OPACITY = 0.85
// Changing the dash array of a layer makes MapLibre rebuild that layer's tiles in its worker, every time (measured 2026-10-23: six tile
// reloads for each step, and the same with a global-state expression). Changing a layer's opacity costs no rebuild. So each of the 14 steps
// is a layer of its own with its own fixed dash array, and a step shows one layer and hides the one before. The first keeps the id
// 'streams-flow' and the others are 'streams-flow-1' to 'streams-flow-13'.
const flowLayerId = (i) => (i === 0 ? 'streams-flow' : `streams-flow-${i}`)
const FLOW_LAYERS = FLOW_SEQUENCE.map((_, i) => flowLayerId(i))

const PIN_KINDS = {
  'example-place': 'Example place, not an event',
  happening: 'Happening',
  'learning-journey': 'Learning journey',
  'partner-event': 'Partner event',
}
const PIN_COLOURS = { happening: '#d1495b', 'learning-journey': '#edae49', 'partner-event': '#00798c', 'example-place': '#6d597a' }

const motionQuery = matchMedia('(prefers-reduced-motion: reduce)')
const $ = (id) => document.getElementById(id)
const el = (tag, text, cls) => { const n = document.createElement(tag); if (text != null) n.textContent = text; if (cls) n.className = cls; return n }
// Only http(s) links are ever made clickable. Pin text may later come from a
// spreadsheet, so it is untrusted and is only ever written with textContent.
const safeUrl = (u) => { try { const x = new URL(u); return /^https?:$/.test(x.protocol) ? x.href : null } catch { return null } }

// ---- banner height drives where the controls sit
const banner = $('demo-banner')
const syncBannerHeight = () => document.documentElement.style.setProperty('--banner-h', `${banner.offsetHeight}px`)
syncBannerHeight()
new ResizeObserver(syncBannerHeight).observe(banner)

// ---- basemap style, with a plain fallback so the data layers still show
async function loadStyle() {
  try {
    const r = await fetch(BASEMAP_STYLE)
    if (!r.ok) throw new Error(String(r.status))
    return { style: await r.json(), basemap: true }
  } catch {
    return { style: { version: 8, sources: {}, layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#eef0ea' } }] }, basemap: false }
  }
}

// ---- pins: only approved pins with a known kind are shown, only https links
async function loadPins() {
  const empty = { type: 'FeatureCollection', features: [] }
  try {
    const r = await fetch('data/pins.geojson')
    if (!r.ok) throw new Error(String(r.status))
    const fc = await r.json()
    const features = (fc.features || []).filter((f) => {
      const p = f.properties || {}
      return p.status === 'approved' && p.kind in PIN_KINDS && f.geometry?.type === 'Point'
    }).map((f) => {
      const p = { ...f.properties }
      for (const k of ['url', 'source_url']) { const u = p[k] ? safeUrl(p[k]) : null; p[k] = u && u.startsWith('https:') ? u : null }
      return { ...f, properties: p }
    })
    return { type: 'FeatureCollection', features }
  } catch {
    return empty
  }
}

const [{ style, basemap }, pins] = await Promise.all([loadStyle(), loadPins()])

const map = new Map({
  container: 'map',
  style,
  bounds: GV_BOUNDS,
  fitBoundsOptions: { padding: FIT_PADDING },
  maxBounds: MAX_BOUNDS,
  attributionControl: false,
  // Flat and north-up until 'load' switches 3D terrain on (its box is ticked by default).
  maxPitch: 0,
  dragRotate: false,
  touchPitch: false,
})
map.touchZoomRotate.disableRotation()
map.addControl(new AttributionControl({ compact: innerWidth < 700 }), 'bottom-right')
let nav = new NavigationControl({ showCompass: false })
map.addControl(nav, 'top-right')
map.addControl(new ScaleControl({ unit: 'metric' }), 'bottom-left')
// The time slider sits above the attribution, which grows when ticked layers add their credits.
const attribCorner = document.querySelector('.maplibregl-ctrl-bottom-right')
new ResizeObserver(() => document.documentElement.style.setProperty('--attrib-h', `${attribCorner.offsetHeight}px`)).observe(attribCorner)

let basemapNoted = false
function noteBasemapDown() {
  if (basemapNoted) return
  basemapNoted = true
  banner.append(' The street basemap could not be reached, so only the data layers are shown.')
}
if (!basemap) noteBasemapDown()
map.on('error', (e) => { if (basemap && e.sourceId === 'openmaptiles') noteBasemapDown() })

const overlays = createOverlays({ map, $, el, link, basemap, motionQuery, addProtocol })
// Layers that change over time, and the one time slider they share.
const time = createTimeLayers({ map, $, el, link, motionQuery, MapClass: Map, demTiles: TERRAIN_TILES, exaggeration: TERRAIN_EXAGGERATION, addProtocol })

// group -> layer ids, for the toggles
const GROUPS = {
  pins: ['pins', 'pins-label'],
  watersheds: ['watersheds-fill', 'watersheds-line'],
  water: ['wetlands', 'lakes', 'streams', 'streams-label'],
  terrain: ['hillshade'],
  parks: ['parks-local', 'parks-bc', 'parks-bc-line', 'parks-bc-label'],
  bec: ['bec-fill', 'bec-sea-mask'],
  muni: ['muni-fill', 'muni-line', 'muni-label'],
}
// Popup priority, first match wins.
const QUERY_ORDER = ['pins', ...overlays.queryLayers, ...time.queryLayers, 'parks-bc', 'parks-local', 'watersheds-fill', 'streams', 'lakes', 'wetlands', 'bec-fill', 'ecoregions-fill', 'muni-fill']

function applyToggles() {
  for (const box of document.querySelectorAll('input[data-group]')) {
    // Sources stay loaded when a layer is hidden, so toggling never re-downloads.
    for (const id of GROUPS[box.dataset.group]) if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', box.checked ? 'visible' : 'none')
  }
  syncFlow()
}

// ---- flow: pale dashes marching downstream along the creek lines
// The loop runs only while the flow dashes can be seen: the Flow box and the
// creeks box are both on, the system has not asked for reduced motion, this tab
// is in front and the map is zoomed in far enough. Under reduced motion the
// layer is hidden altogether, because a frozen dash pattern says nothing about
// direction.
const flowBox = $('flow'), waterBox = document.querySelector('input[data-group=water]')
flowBox.checked = !motionQuery.matches
let flowFrameId = 0, flowStep = 0 // the layer shown is the first until the loop moves it
let flowLastTs = 0, flowRestUntil = 0 // the time of the last frame, and no step before this time (both in the time of requestAnimationFrame)
let flowWatch = 0, flowEntry = null // after a step: 1 while the frame of the step passes, 2 while the frame that draws it passes (and flowEntry is its line in flowLog)
// In test mode (?test) each step is written down with the duration of the frame that drew it, the rest that gives and the time the loop may step
// again, for scripts/browser-check.mjs.
const flowLog = new URLSearchParams(location.search).has('test') ? [] : null
function flowFrame(ts) {
  flowFrameId = requestAnimationFrame(flowFrame)
  const frameMs = ts - flowLastTs
  flowLastTs = ts
  // A step is drawn in the frame after it, and the browser starts the frame after that one only when the drawing is done, so the length of that
  // frame is how long the redraw of the whole map took (the time map.on('render') sees is only the time the page spent, not the time the graphics
  // chip did). Once it is known the loop rests twice as long, so it never uses more than a third of the page's time on a device that is slow
  // to draw. A step is chosen from the clock, so the dashes keep their pace where the device can keep up and skip ahead where it cannot.
  if (flowWatch === 2) {
    const rest = flowRestMs(frameMs)
    flowRestUntil = ts + rest
    if (flowEntry) { Object.assign(flowEntry, { cost: frameMs, rest, until: flowRestUntil }); flowEntry = null }
    flowWatch = 0
  } else if (flowWatch === 1) flowWatch = 2
  if (flowWatch || ts < flowRestUntil) return
  // In 3D terrain every step redraws the creeks draped over the relief, so the steps come at half the rate.
  const next = Math.floor(ts / (map.getTerrain() ? FLOW_STEP_MS * 2 : FLOW_STEP_MS)) % FLOW_SEQUENCE.length
  if (next === flowStep) return
  try {
    map.setPaintProperty(FLOW_LAYERS[next], 'line-opacity', FLOW_OPACITY)
    map.setPaintProperty(FLOW_LAYERS[flowStep], 'line-opacity', 0)
    flowStep = next
  } catch { return } // the style is not ready this frame
  flowWatch = 1
  if (flowLog) flowLog.push(flowEntry = { at: ts, cost: null, rest: null, until: null })
}
function syncFlow() {
  const reduced = motionQuery.matches
  const on = !reduced && flowBox.checked && waterBox.checked
  flowBox.disabled = reduced || !waterBox.checked
  $('flow-paused').hidden = !reduced
  const has = !!map.getLayer('streams-flow')
  if (has) for (const id of FLOW_LAYERS) map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none')
  const run = has && on && !document.hidden && map.getZoom() >= FLOW_MIN_ZOOM
  if (run && !flowFrameId) { flowLastTs = performance.now(); flowWatch = 0; flowEntry = null; flowFrameId = requestAnimationFrame(flowFrame) }
  if (!run && flowFrameId) { cancelAnimationFrame(flowFrameId); flowFrameId = 0 }
}
flowBox.addEventListener('change', syncFlow)
document.addEventListener('visibilitychange', syncFlow)
map.on('zoomend', syncFlow)
motionQuery.addEventListener('change', () => { flowBox.checked = !motionQuery.matches; syncFlow() })

// ---- 3D terrain: the same elevation tiles as the hillshade, lifted into relief.
// Off, the map is flat and north-up. On, it tilts, can be rotated and pitched, and gets a sky.
// The hillshade box does not change when this one does. MapLibre drapes the flat layers
// (parks, creeks, watersheds and the rest) over the relief.
const terrainBox = $('terrain3d'), nightBox = $('night')
function setNavigation(compass) {
  map.removeControl(nav)
  nav = new NavigationControl({ showCompass: compass, visualizePitch: compass })
  map.addControl(nav, 'top-right')
}
function lockFlat() {
  if (terrainBox.checked) return
  map.setMaxPitch(0)
  map.dragRotate.disable()
  map.touchZoomRotate.disableRotation()
  map.touchPitch.disable()
}
function setTerrain3d() {
  if (!map.getSource('terrain-dem')) return // the map is not ready, 'load' calls this again
  const on = terrainBox.checked, duration = motionQuery.matches ? 0 : 800
  if (on) {
    map.setMaxPitch(TERRAIN_MAX_PITCH)
    map.dragRotate.enable()
    map.touchZoomRotate.enableRotation()
    map.touchPitch.enable()
    map.setTerrain({ source: 'terrain-dem', exaggeration: TERRAIN_EXAGGERATION })
    map.setSky(nightBox.checked ? NIGHT_SKY : TERRAIN_SKY)
    map.easeTo({ pitch: TERRAIN_PITCH, duration })
  } else {
    map.setTerrain(null)
    map.setSky(NO_SKY)
    map.easeTo({ pitch: 0, bearing: 0, duration })
    if (duration) map.once('moveend', lockFlat); else lockFlat()
  }
  setNavigation(on)
  $('terrain3d-note').hidden = !on
}
terrainBox.addEventListener('change', setTerrain3d)

map.once('load', () => {
  // MapLibre opens the compact attribution control expanded the first time.
  // Collapse it to the (i) button once the map is up; the text is one tap away.
  const ctrl = document.querySelector('.maplibregl-ctrl-attrib.maplibregl-compact-show')
  if (ctrl) {
    ctrl.classList.remove('maplibregl-compact-show')
    ctrl.removeAttribute('open')
    ctrl.querySelector('.maplibregl-ctrl-attrib-button')?.setAttribute('aria-expanded', 'false')
  }

  const layers = map.getStyle().layers
  // Our layers go under the basemap's first label so place names stay on top.
  const under = layers.find((l) => l.type === 'symbol')?.id
  const font = layers.find((l) => Array.isArray(l.layout?.['text-font']) && l.layout['text-font'].includes('Noto Sans Regular'))?.layout['text-font'] || ['Noto Sans Regular']
  const water = layers.find((l) => l.type === 'fill' && l['source-layer'] === 'water' && l.source)

  const src = (name, attribution) => map.addSource(name, { type: 'geojson', data: `data/${name}.geojson`, ...(attribution ? { attribution } : {}) })
  src('bec', BC_ATTRIB); src('watersheds', BC_ATTRIB); src('wetlands', BC_ATTRIB); src('lakes', BC_ATTRIB)
  src('streams', BC_ATTRIB); src('streams-flow', BC_ATTRIB); src('bc-parks', BC_ATTRIB); src('greenspaces', `${BC_ATTRIB} ${PARKS_ATTRIB}`)
  src('municipalities', BC_ATTRIB)
  map.addSource('pins', { type: 'geojson', data: pins })
  // The terrain source only loads tiles while the terrain layer is visible.
  map.addSource('terrain', { type: 'raster-dem', tiles: [TERRAIN_TILES], encoding: 'terrarium', tileSize: 256, maxzoom: 15, attribution: TERRAIN_ATTRIB })
  // 3D terrain gets its own source on the same tiles. MapLibre warns that sharing one source
  // with the hillshade lowers the quality of both, and the browser reuses the cached tiles.
  map.addSource('terrain-dem', { type: 'raster-dem', tiles: [TERRAIN_TILES], encoding: 'terrarium', tileSize: 256, maxzoom: 15, attribution: TERRAIN_ATTRIB })

  // Terrain shading sits just under the basemap's water layer, so the sea stays
  // flat. Without a basemap it goes under our first layer.
  map.addLayer({ id: 'hillshade', type: 'hillshade', source: 'terrain', layout: { visibility: 'none' }, paint: {
    'hillshade-exaggeration': 0.4, 'hillshade-shadow-color': '#3a3a35', 'hillshade-highlight-color': '#fbfaf7', 'hillshade-accent-color': '#6b6a5f' } }, water ? water.id : under)
  map.addLayer({ id: 'bec-fill', type: 'fill', source: 'bec', paint: {
    'fill-opacity': 0.3,
    'fill-color': ['match', ['get', 'BGC_LABEL'], 'CDF mm', '#d9b862', 'CWH dm 1', '#a9c783', 'CWH dm 2', '#8fb56a', 'CWH mm 1', '#5f9a6a', 'CWH mm 2', '#3f7f63', '#bbbbbb'] } }, under)
  // The zone polygons run out over open water. Redraw the basemap's own water
  // on top of them so zones only show on land.
  if (water) {
    map.addLayer({ id: 'bec-sea-mask', type: 'fill', source: water.source, 'source-layer': 'water', filter: water.filter,
      paint: { 'fill-color': water.paint?.['fill-color'] ?? '#c2c8ca', 'fill-antialias': true } }, under)
  }
  map.addLayer({ id: 'watersheds-fill', type: 'fill', source: 'watersheds', paint: { 'fill-color': '#2a79a8', 'fill-opacity': 0.04 } }, under)
  map.addLayer({ id: 'watersheds-line', type: 'line', source: 'watersheds', paint: { 'line-color': '#2a79a8', 'line-width': 1.2, 'line-dasharray': [3, 2] } }, under)
  map.addLayer({ id: 'parks-local', type: 'fill', source: 'greenspaces', paint: { 'fill-color': '#7fb069', 'fill-opacity': 0.4 } }, under)
  map.addLayer({ id: 'parks-bc', type: 'fill', source: 'bc-parks', paint: { 'fill-color': '#3f8a4a', 'fill-opacity': 0.4 } }, under)
  map.addLayer({ id: 'parks-bc-line', type: 'line', source: 'bc-parks', paint: { 'line-color': '#2f6f3a', 'line-width': 1 } }, under)
  map.addLayer({ id: 'wetlands', type: 'fill', source: 'wetlands', paint: { 'fill-color': '#8cc3b0', 'fill-opacity': 0.6 } }, under)
  map.addLayer({ id: 'lakes', type: 'fill', source: 'lakes', paint: { 'fill-color': '#9ccbe3', 'fill-opacity': 0.8 } }, under)
  const streamWidth = ['interpolate', ['linear'], ['zoom'], 9, ['*', 0.4, ['get', 'order']], 14, ['*', 1.2, ['get', 'order']]]
  map.addLayer({ id: 'streams', type: 'line', source: 'streams', paint: { 'line-color': '#2a79a8', 'line-width': streamWidth } }, under)
  // Same width as the creek line, so the pale dashes sit on it. Butt caps, because round caps smear the dashes. One layer for each step, see FLOW_LAYERS.
  FLOW_SEQUENCE.forEach((dash, i) => map.addLayer({ id: FLOW_LAYERS[i], type: 'line', source: 'streams-flow', minzoom: FLOW_MIN_ZOOM, layout: { 'line-cap': 'butt', visibility: 'none' }, paint: {
    'line-color': '#eaf6fd', 'line-opacity': i === 0 ? FLOW_OPACITY : 0, 'line-width': streamWidth, 'line-dasharray': dash } }, under))
  // Invisible fill so a click inside a municipality can open its popup.
  map.addLayer({ id: 'muni-fill', type: 'fill', source: 'municipalities', paint: { 'fill-color': '#000000', 'fill-opacity': 0 } }, under)
  map.addLayer({ id: 'muni-line', type: 'line', source: 'municipalities', paint: { 'line-color': '#5b5f58', 'line-width': 1.1, 'line-dasharray': [4, 2] } }, under)

  // Optional overlays: ecoregions, industry and waste sites, and the live layers. All start hidden
  // and none requests anything until its box is ticked.
  overlays.addLayers({ before: under, ecoBefore: 'watersheds-fill', water, demTiles: TERRAIN_TILES })
  // Air photos and land cover go low, just over the basemap. Ecosystems and forest loss go under the creeks, and herring spawn with the other dots.
  time.addLayers({ before: under, low: 'bec-fill', mid: 'streams' })

  map.addLayer({ id: 'pins', type: 'circle', source: 'pins', paint: {
    'circle-radius': 9, 'circle-stroke-width': 2.5, 'circle-stroke-color': '#ffffff',
    'circle-color': ['match', ['get', 'kind'], ...Object.entries(PIN_COLOURS).flat(), '#444444'] } })

  // Text layers need the basemap's glyph server, so they are skipped when the
  // basemap could not be loaded.
  if (basemap) {
    const label = (id, source, textField, minzoom, layout, paint) => {
      map.addLayer({ id, type: 'symbol', source, minzoom,
        layout: { 'text-field': textField, 'text-font': font, 'text-size': 12, ...layout },
        paint: { 'text-color': '#27312c', 'text-halo-color': 'rgba(255,255,255,.9)', 'text-halo-width': 1.4, ...paint } })
    }
    label('streams-label', 'streams', ['get', 'name'], 12, { 'symbol-placement': 'line', 'text-size': 11 }, { 'text-color': '#1d5f86' })
    label('parks-bc-label', 'bc-parks', ['get', 'PROTECTED_LANDS_NAME'], 9, { 'text-size': 11, 'text-max-width': 8 }, { 'text-color': '#245a30' })
    label('muni-label', 'municipalities', ['get', 'name'], 9, { 'text-size': 12, 'text-transform': 'uppercase', 'text-letter-spacing': 0.08 }, { 'text-color': '#4b4f48' })
    map.setLayerZoomRange('muni-label', 9, 13)
    label('pins-label', 'pins', ['get', 'title'], 0, { 'text-offset': [0, 1.4], 'text-anchor': 'top', 'text-optional': true }, { 'text-color': '#1d1d1d' })
    overlays.addLabels({ font })
  }

  // The Night look is off when the page opens. Its box darkens the basemap and the labels, and tells the live layers and the sky.
  const night = createNight({ map, basemapSource: water?.source ?? null, overrides: NIGHT_PAINT })
  const setNight = () => {
    document.body.classList.toggle('night', nightBox.checked) // the attribution and the scale are dark too
    night.set(nightBox.checked)
    overlays.setNight(nightBox.checked)
    if (map.getTerrain()) map.setSky(nightBox.checked ? NIGHT_SKY : TERRAIN_SKY)
  }
  nightBox.addEventListener('change', setNight)
  if (nightBox.checked) setNight() // a browser that keeps a ticked box across a reload

  // Layers start in the state the checkboxes describe.
  applyToggles()
  if (terrainBox.checked) setTerrain3d() // 3D terrain is on by default, so the map tilts once it is ready

  // Honest empty state: only real happenings and journeys count.
  const real = pins.features.filter((f) => f.properties.kind !== 'example-place')
  $('pins-count').textContent = `(${pins.features.length})`
  $('pins-empty').hidden = real.length > 0
})

for (const box of document.querySelectorAll('input[data-group]')) box.addEventListener('change', applyToggles)

// ---- fit, credits, mobile panel
const fit = () => map.fitBounds(GV_BOUNDS, { padding: FIT_PADDING, animate: !motionQuery.matches })
$('fit').addEventListener('click', fit)
const credits = $('credits'), creditsBtn = $('credits-btn')
const setCredits = (open) => {
  credits.hidden = !open
  creditsBtn.setAttribute('aria-expanded', String(open))
  if (open) $('credits-close').focus(); else creditsBtn.focus()
}
creditsBtn.addEventListener('click', () => setCredits(credits.hidden))
$('credits-close').addEventListener('click', () => setCredits(false))
addEventListener('keydown', (e) => { if (e.key === 'Escape' && !credits.hidden) setCredits(false) })
if (matchMedia('(max-width: 640px)').matches) $('panel-details').open = false

// ---- popups (DOM nodes and textContent only)
function link(href, text) {
  const u = href ? safeUrl(href) : null
  if (!u) return null
  const a = el('a', text || u); a.href = u; a.target = '_blank'; a.rel = 'noopener'
  return a
}
const hectares = (n) => `${Number(n).toLocaleString('en-CA', { maximumFractionDigits: 1 })} ha`

function popupFor(f, layer, group = [f], hits = []) {
  if (overlays.popupLayers.includes(layer)) return overlays.popupFor(f, layer, group, hits)
  if (time.queryLayers.includes(layer)) return time.popupFor(f, layer)
  const p = f.properties, box = el('div')
  const add = (title, tag, lines, src) => {
    box.append(el('h3', title))
    if (tag) box.append(el('span', tag, 'tag'))
    for (const l of lines) if (l) box.append(el('p', l))
    if (src) box.append(el('p', src, 'src'))
  }
  if (layer === 'pins') {
    add(p.title, PIN_KINDS[p.kind] || p.kind, [p.summary, p.date, p.place_name])
    for (const [href, text] of [[p.url, p.url_label || 'More information'], [p.source_url, 'Source document']]) {
      const a = link(href, text)
      if (a) { const d = el('p'); d.append(a); box.append(d) }
    }
  } else if (layer === 'parks-bc') {
    // The name is shown exactly as the Province publishes it.
    add(p.PROTECTED_LANDS_NAME, [p.PROTECTED_LANDS_DESIGNATION?.toLowerCase(), p.PARK_CLASS].filter(Boolean).join(', '), [], 'Source: BC Parks, Ecological Reserves, and Protected Areas (Province of British Columbia).')
  } else if (layer === 'parks-local') {
    add(p.name || `Unnamed ${(p.use || 'green space').toLowerCase()}`, [p.type, p.use].filter(Boolean).join(' - '), [p.muni],
      ['Source: Local and Regional Greenspaces (Province of British Columbia). Boundaries are approximate.', LIC_STATEMENTS[p.lic]].filter(Boolean).join(' '))
  } else if (layer === 'watersheds-fill') {
    add(`${p.name} watershed`, 'watershed', [
      `The provincial Freshwater Atlas draws this watershed at about ${hectares(p.area_ha)}.`,
      'Other groups draw watersheds differently, so treat this as one count, not the answer.',
    ], 'Source: Freshwater Atlas named watersheds (Province of British Columbia).')
  } else if (layer === 'streams') {
    add(p.name, 'creek or river', [
      `Stream order ${p.order} (a higher number is a larger stream).`,
      'Creeks that run in pipes may be missing or partly mapped.',
    ], 'Source: Freshwater Atlas stream network (Province of British Columbia).')
  } else if (layer === 'lakes' || layer === 'wetlands') {
    const kind = layer === 'lakes' ? 'lake' : 'wetland'
    add(p.name || `Unnamed ${kind}`, kind, [`About ${hectares(p.area_ha)}.`], 'Source: Freshwater Atlas (Province of British Columbia).')
  } else if (layer === 'bec-fill') {
    add(p.ZONE_NAME, p.BGC_LABEL, [
      [p.SUBZONE_NAME, p.VARIANT_NAME].map((s) => (s || '').trim()).filter(Boolean).join(', '),
      'A biogeoclimatic zone groups land by climate and the plants and ecosystems it supports.',
    ], 'Source: BEC Map (Province of British Columbia).')
  } else if (layer === 'muni-fill') {
    add(p.name, 'municipality', ['Legal boundary. It includes adjacent water.'], 'Source: Municipalities, legally defined administrative areas (Province of British Columbia).')
  } else return null
  return box
}

// Area layers that cover water as well as land. A click on the sea that reaches one of these and nothing
// else also gets the sea readout, above the area's own popup. Every other popup is shown alone.
const AREA_LAYERS = ['bec-fill', 'ecoregions-fill', 'muni-fill', ...overlays.seaAreaLayers]

// What MapLibre itself looks for when it moves focus into a popup.
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

map.on('click', (e) => {
  const r = 8 // 16 px box around the click, not a single pixel
  const hitBox = [[e.point.x - r, e.point.y - r], [e.point.x + r, e.point.y + r]]
  const present = QUERY_ORDER.filter((id) => map.getLayer(id) && map.getLayoutProperty(id, 'visibility') !== 'none')
  const hits = present.length ? map.queryRenderedFeatures(hitBox, { layers: present }) : []
  let content = null, from = null
  for (const id of QUERY_ORDER) {
    // Forest loss is a picture, so its popup comes from the pixel under the click, in its place in the order.
    if (id === 'parks-bc' && (content = time.pixelPopup(e.lngLat))) { from = 'forestloss'; break }
    // While the ecosystems' swipe is open, each side of its line answers for the year it draws.
    if (time.hiddenAt(id, e.point)) continue
    let group = hits.filter((h) => h.layer.id === id)
    if (!group.length) continue
    // Watersheds nest, so show the smallest one under the click.
    if (id === 'watersheds-fill') group = [group.sort((a, b) => a.properties.area_ha - b.properties.area_ha)[0]]
    content = popupFor(group[0], id, group, hits)
    if (!content) continue
    from = id
    break
  }
  const reading = !content || AREA_LAYERS.includes(from) ? overlays.seaReadout(e) : null
  if (reading) {
    if (content) { reading.append(el('hr')); reading.append(content) }
    content = reading
  }
  if (!content) return
  const popup = new Popup({ maxWidth: '300px', focusAfterOpen: false }).setLngLat(e.lngLat).setDOMContent(content).addTo(map)
  // MapLibre moves focus to the first link in a popup, and the browser scrolls a long popup to show it: to its end, as the link is at the end.
  // Chrome does it at once, so setting scrollTop to 0 afterwards worked there, and Safari does it later, so a popup opened scrolled to its
  // end (found 2026-10-23 in WebKit). Focus is moved here instead, to the same element, without scrolling, so the popup opens at its top.
  popup.getElement()?.querySelector(FOCUSABLE)?.focus({ preventScroll: true })
  if (phoneQuery.matches) keepInView(popup)
  // A popup whose text arrives later (a tide prediction, a temperature) says so, and is placed again for its new size.
  content.addEventListener('filled', () => { popup.setLngLat(e.lngLat); if (phoneQuery.matches || content.querySelector('.tide-body')) requestAnimationFrame(() => keepInView(popup)) })
})
// On a phone a popup that opens near an edge would run past the screen, because MapLibre only picks which corner or side the popup hangs from
// (a point 120 px from the left edge of a 390 px screen hangs a 290 px popup from its left edge, 20 px off the right), and a tall popup opened
// low on the screen would run off the bottom. This is the same condition as the CSS media query that limits the popup's size there.
const phoneQuery = matchMedia('(max-width: 640px), (max-height: 500px)')
// The popup of a tide station grows when its levels arrive, and the gauge's carries a long licence notice, so it can reach past the edge of
// the screen and then cannot be read to its end. Pan the map by the least that brings it back, clear of the banner at the top and the
// attribution at the bottom. A popup taller than the room keeps its top in view.
function keepInView(popup) {
  const box = popup.getElement()?.querySelector('.maplibregl-popup-content')
  if (!box) return
  box.style.maxHeight = '' // its own size, in case an earlier call made it shorter
  const space = () => {
    const m = map.getContainer().getBoundingClientRect(), attrib = document.querySelector('.maplibregl-ctrl-attrib')?.getBoundingClientRect()
    const bar = $('timebar').hidden ? null : $('timebar').getBoundingClientRect() // the time slider, while it is shown
    return { top: banner.getBoundingClientRect().bottom + 8, bottom: Math.min(m.bottom - 8, attrib && attrib.height > 0 ? attrib.top - 8 : Infinity, bar ? bar.top - 8 : Infinity), left: m.left + 8, right: m.right - 8 }
  }
  const { top, bottom, left, right } = space(), r = box.getBoundingClientRect()
  let dy = 0, dx = 0
  if (r.top < top) dy = r.top - top // negative: the map moves down
  else if (r.bottom > bottom) dy = Math.min(r.bottom - bottom, r.top - top)
  if (r.left < left) dx = r.left - left; else if (r.right > right) dx = r.right - right
  if (dx || dy) map.panBy([Math.round(dx), Math.round(dy)], { duration: motionQuery.matches ? 0 : 250 })
  // The map's bounds can stop the pan short (a place near the north edge of the area the map reaches, on a screen not much taller than the popup), and
  // then the popup would still reach under the banner or past the bottom. It is made shorter, to the room it has, and scrolls inside.
  let done = false
  const fit = () => {
    if (done) return
    done = true
    map.off('moveend', fit)
    const room = space(), now = box.getBoundingClientRect(), over = Math.max(room.top - now.top, now.bottom - room.bottom, 0)
    if (over > 1) box.style.maxHeight = `${Math.max(120, Math.floor(box.clientHeight - over))}px`
  }
  if (dx || dy) { map.once('moveend', fit); setTimeout(fit, 2000) } else fit()
}
for (const id of ['pins', ...overlays.queryLayers, ...time.queryLayers, 'parks-bc', 'parks-local', 'watersheds-fill', 'streams']) {
  map.on('mouseenter', id, () => { map.getCanvas().style.cursor = 'pointer' })
  map.on('mouseleave', id, () => { map.getCanvas().style.cursor = '' })
}

// Test hook for scripts/browser-check.mjs. Harmless in production.
if (new URLSearchParams(location.search).has('test')) {
  window.__map = map
  window.__overlays = overlays
  window.__time = time
  // `step` is the position of the layer that is shown, read from the map, `layers` are the 14 layers and `log` is what flowLog holds.
  window.__flow = { sequence: FLOW_SEQUENCE, minZoom: FLOW_MIN_ZOOM, layers: FLOW_LAYERS, log: flowLog, running: () => flowFrameId !== 0, step: () => FLOW_LAYERS.findIndex((id) => map.getPaintProperty(id, 'line-opacity') > 0) }
  // map.loaded() and the 'idle' event never settle while the flow dashes animate,
  // so the checks wait for this flag (set after the layers are added) instead.
  map.once('load', () => { window.__ready = true })
}
