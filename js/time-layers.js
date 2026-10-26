// Layers that change over time, for the Greater Victoria demo map. Plain ES module, no build step.
//
// Each box in "Change over time" is off at load and makes no request until it is ticked. Once its data is in, the layer registers its years
// with the one time control (js/timeline.js), and the slider at the bottom of the map moves every ticked layer through time together. The
// air photos are map images from Natural Resources Canada's datacube, asked for only while their box is ticked and only for the year shown.
// The others are files of this site. The years, text and popups are in js/time-data.js.
import {
  snapshotLine,
  HERRING_YEARS_FILE, HERRING_RECORD, herringSteps, herringSeason, herringYearInfo, herringLine, herringRadius,
  AERIAL_RECORD, AERIAL_YEARS, AERIAL_BOUNDS, aerialTileUrl,
  LANDCOVER_RECORD, LANDCOVER_YEARS, LANDCOVER_FILE, LANDCOVER_CORNERS, LANDCOVER_CLASSES, landcoverLut,
  SEI_RECORD, SEI_FILES, SEI_YEARS, SEI_KEY, SEI_CLASSES, seiColour, seiInfo,
  CANOPY_YEARS, CANOPY_FILES, CANOPY_CORNERS, CANOPY_ITEMS,
  LOSS_FILE, LOSS_YEARS, LOSS_PAGE, LOSS_CORNERS, lossYearOf, lossPixel, lossRgb, lossGradient, lossLine, lossInfo,
} from './time-data.js'
import { createTimeline } from './timeline.js'
import { createSwipe } from './swipe.js'

const OGL_CANADA_LINK = '<a href="https://open.canada.ca/en/open-government-licence-canada" target="_blank" rel="noopener">OGL &ndash; Canada</a>'
const OGL_BC_LINK = '<a href="https://www2.gov.bc.ca/gov/content?id=A519A56BC2BF44E4A008B33FCF527F61" target="_blank" rel="noopener">OGL &ndash; British Columbia</a>'
const OGL_VICTORIA_LINK = '<a href="https://opendata.victoria.ca/pages/open-data-licence" target="_blank" rel="noopener">OGL &ndash; City of Victoria</a>'
const HERRING_YEARS_ATTRIB = `Herring spawn by year: <a href="${HERRING_RECORD}" target="_blank" rel="noopener">Fisheries and Oceans Canada</a> (${OGL_CANADA_LINK})`
const AERIAL_ATTRIB = `Air photos 1932 and 1950: <a href="${AERIAL_RECORD}" target="_blank" rel="noopener">National Air Photo Library, Natural Resources Canada</a> (${OGL_CANADA_LINK})`
const LANDCOVER_ATTRIB = `Land cover: <a href="${LANDCOVER_RECORD}" target="_blank" rel="noopener">Natural Resources Canada</a> (${OGL_CANADA_LINK})`
const SEI_ATTRIB = `Sensitive ecosystems: <a href="${SEI_RECORD}" target="_blank" rel="noopener">Province of British Columbia</a> (${OGL_BC_LINK})`
const CANOPY_ATTRIB = `Tree canopy from LiDAR: <a href="${CANOPY_ITEMS[2019]}" target="_blank" rel="noopener">City of Victoria</a> (${OGL_VICTORIA_LINK})`
const LOSS_ATTRIB = `Forest loss: <a href="${LOSS_PAGE}" target="_blank" rel="noopener">Hansen/UMD/Google/USGS/NASA</a> (<a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noopener">CC BY 4.0</a>)`

const EMPTY = { type: 'FeatureCollection', features: [] }
const TILE_WAIT_MS = 10000 // the longest a step waits for its map images
const AERIAL_MAX_ZOOM = { 1932: 17, 1950: 18 } // about 1 m and 0.5 m a pixel
const LANDCOVER_OPACITY = 0.7
const CANOPY_OPACITY = 0.8
const FADE_MS = 250 // a picture fades into the next year's over this long, or at once under reduced motion
const json = async (url, signal) => { const r = await fetch(url, { signal }); if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json() }
const plural = (n, one, many) => `${n.toLocaleString('en-CA')} ${n === 1 ? one : many}`

export function createTimeLayers({ map, $, el, link, motionQuery, MapClass, demTiles, exaggeration }) {
  const timeline = createTimeline({ $, motionQuery })
  const swipe = createSwipe({ map, MapClass, el, demTiles, exaggeration })
  let ready
  const whenReady = new Promise((resolve) => { ready = resolve })

  // ---- status lines, as for the other layers
  function setStatus(id, state, message) {
    const p = $(`status-${id}`)
    if (!p) return
    p.hidden = !message
    p.textContent = message || ''
    p.dataset.state = state || ''
  }
  // Wait until the tiles of a source are in for the view, or give up after TILE_WAIT_MS. Checked on a timer, because the map draws all the time
  // while the creek Flow runs and its 'idle' event never comes.
  const tilesIn = (source) => new Promise((resolve) => {
    const until = performance.now() + TILE_WAIT_MS
    const check = () => { if (!map.getSource(source) || map.isSourceLoaded(source) || performance.now() > until) resolve(); else setTimeout(check, 150) }
    setTimeout(check, 50)
  })
  const show = (id, on) => { if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none') }
  // A layer with a picture of its own per year (land cover, tree canopy) keeps every year drawn while its box is ticked, at no opacity but
  // the year shown's, so a step only fades one picture into the next.
  function crossfade(prefix, years, frame, opacity) {
    for (const s of years) {
      const id = `${prefix}-${s.t}`
      if (!map.getLayer(id)) continue
      map.setPaintProperty(id, 'raster-opacity-transition', { duration: motionQuery.matches ? 0 : FADE_MS, delay: 0 })
      map.setPaintProperty(id, 'raster-opacity', s.t === frame?.t ? opacity : 0)
      show(id, true)
    }
  }
  // The air photos come from the datacube a tile at a time, so a step shows the new year at once and keeps the year before drawn until the
  // new year's tiles are in. The map is never empty between two years. `aerialStep` drops a step that a later one, Swipe or the box overtook.
  let aerialStep = 0

  // ---- the layers. `ids` are hidden when the box is unticked. `kind` and `steps` are what each registers with the time control.
  const DEFS = {
    herringyears: { label: 'Herring spawn by year', ids: ['herringyears-all', 'herringyears-dot'], ui: ['herringyears-note'], kind: 'event', load: loadHerring },
    aerials: { label: 'Air photos', ids: ['aerial-1932', 'aerial-1950'], ui: ['aerials-controls', 'aerials-note'], kind: 'snapshot', steps: AERIAL_YEARS, load: async () => ({ message: 'Greyscale air photos of central Victoria, Oak Bay, Esquimalt and south Saanich, from Natural Resources Canada.' }) },
    sei: { label: 'Sensitive ecosystems', ids: ['sei-1994-fill', 'sei-1994-line', 'sei-2002-fill', 'sei-2002-line'], ui: ['sei-key', 'sei-note'], kind: 'snapshot', steps: SEI_YEARS, load: loadSei },
    sei2014: { label: 'Garry oak ecosystems mapped in 2014', ids: ['sei2014-fill', 'sei2014-line'], ui: ['sei2014-note'], load: loadSei2014 },
    landcover: { label: 'Land cover', ids: [...LANDCOVER_YEARS.map((s) => `landcover-${s.t}`), 'landcover-credit'], ui: ['landcover-key', 'landcover-note'], kind: 'snapshot', steps: LANDCOVER_YEARS, load: loadLandcover },
    canopy: { label: 'Tree canopy', ids: [...CANOPY_YEARS.map((s) => `canopy-${s.t}`), 'canopy-credit'], ui: ['canopy-note'], kind: 'snapshot', steps: CANOPY_YEARS, load: loadCanopy },
    forestloss: { label: 'Forest loss', ids: ['forestloss', 'forestloss-credit'], ui: ['forestloss-key', 'forestloss-note'], kind: 'cumulative', steps: LOSS_YEARS, load: loadLoss },
  }
  const state = Object.fromEntries(Object.keys(DEFS).map((id) => [id, { on: false, loaded: false, loading: null }]))

  // What each layer shows for a step of the time control, and its line in the readout.
  const herring = { counts: new Map(), first: null, steps: [] }
  const SHOW = {
    herringyears: {
      show: (frame, t) => { map.setFilter('herringyears-dot', ['==', ['get', 'year'], t]) },
      line: (frame, t) => herringLine(t, herring.counts.get(t) || 0, herring.first),
    },
    aerials: {
      show: (frame) => {
        const want = frame ? `aerial-${frame.t}` : null, mine = ++aerialStep
        const others = () => { for (const s of AERIAL_YEARS) if (`aerial-${s.t}` !== want) show(`aerial-${s.t}`, false) }
        if (!want) { others(); return null }
        show(want, true)
        return tilesIn(want).then(() => { if (mine === aerialStep) others() })
      },
      line: (frame, t) => snapshotLine('Air photo', AERIAL_YEARS, frame, t),
    },
    sei: {
      show: (frame) => { for (const s of SEI_YEARS) for (const part of ['fill', 'line']) show(`sei-${s.t}-${part}`, s.t === frame?.t) },
      line: (frame, t) => snapshotLine('Sensitive ecosystems', SEI_YEARS, frame, t),
    },
    landcover: {
      show: (frame) => crossfade('landcover', LANDCOVER_YEARS, frame, LANDCOVER_OPACITY),
      line: (frame, t) => snapshotLine('Land cover', LANDCOVER_YEARS, frame, t),
    },
    canopy: {
      show: (frame) => crossfade('canopy', CANOPY_YEARS, frame, CANOPY_OPACITY),
      line: (frame, t) => snapshotLine('Tree canopy, City of Victoria', CANOPY_YEARS, frame, t),
    },
    forestloss: {
      show: (frame, t) => paintLoss(t),
      line: (frame, t) => lossLine(t),
    },
  }
  const stepsOf = (id) => (id === 'herringyears' ? herring.steps : DEFS[id].steps)
  // The readout lists the layers in the order of their boxes.
  const join = (id) => timeline.register(id, { kind: DEFS[id].kind, steps: stepsOf(id), order: Object.keys(DEFS).indexOf(id), ...SHOW[id] })

  async function enable(id) {
    const def = DEFS[id], st = state[id]
    await whenReady
    if (!st.on) return
    for (const u of def.ui || []) $(u).hidden = false
    if (!st.loaded) {
      if (!st.loading) {
        setStatus(id, 'loading', `Loading ${def.label.toLowerCase()}…`)
        st.loading = def.load().then((r) => { st.loaded = true; st.message = r.message; return r }).finally(() => { st.loading = null })
      }
      try { await st.loading } catch {
        if (!st.on) return
        setStatus(id, 'fail', `${def.label} could not be loaded just now. Try again later.`)
        return
      }
      if (!st.on) return
    }
    setStatus(id, 'ok', st.message)
    // A layer whose picture is one filter (herring spawn, forest loss) is shown now. A layer with a picture per year shows the one its step
    // asks for. The 2014 mapping is not on the time line.
    if (def.kind !== 'snapshot') for (const l of def.ids) show(l, true)
    if (!def.kind) return
    if (id === 'canopy' || id === 'landcover') show(`${id}-credit`, true)
    if (id === 'aerials' && $('aerials-swipe').checked) openSwipe()
    else join(id)
  }
  function disable(id) {
    const def = DEFS[id]
    state[id].on = false
    if (def.kind) timeline.unregister(id)
    if (id === 'aerials') { aerialStep++; closeSwipe(); $('aerials-swipe').checked = false }
    for (const l of def.ids) show(l, false)
    for (const u of def.ui || []) $(u).hidden = true
    setStatus(id, '', '')
  }
  for (const box of document.querySelectorAll('input[data-time]')) {
    box.addEventListener('change', () => {
      const id = box.dataset.time
      if (box.checked) { state[id].on = true; enable(id) } else disable(id)
    })
  }

  // ---- the swipe of the air photos: 1932 on the left of a line the visitor drags, 1950 on the right. While it is open the photos leave the
  // time control, because both years are on the screen at once.
  const SWIPE_LINE = 'Swipe: 1932 on the left of the line and 1950 on the right. Drag the line, or use the arrow keys on it.'
  function openSwipe() {
    timeline.unregister('aerials')
    aerialStep++
    show('aerial-1932', false); show('aerial-1950', true)
    swipe.open({ id: 'aerial-1932-left', source: { type: 'raster', tiles: [aerialTileUrl(1932)], tileSize: 256, bounds: AERIAL_BOUNDS[1932], maxzoom: AERIAL_MAX_ZOOM[1932] } }, ['1932', '1950'])
    setStatus('aerials', 'ok', SWIPE_LINE)
  }
  function closeSwipe() { if (swipe.isOpen()) swipe.close() }
  $('aerials-swipe').addEventListener('change', (e) => {
    if (!state.aerials.on || !state.aerials.loaded) return
    if (e.target.checked) openSwipe()
    else { closeSwipe(); show('aerial-1950', false); setStatus('aerials', 'ok', state.aerials.message); join('aerials') }
  })

  // ---- the map images of the federal datacube. A tile that fails says so in the status line while none of that layer's tiles has come.
  const WMS = { aerials: /^aerial-(1932|1950)$/ }
  const wms = { aerials: { ok: 0 } }
  const WMS_FAILURE = { aerials: 'The air photos could not be loaded just now from Natural Resources Canada. Try again later.' }
  map.on('error', (e) => {
    const id = Object.keys(WMS).find((k) => WMS[k].test(e.sourceId || ''))
    if (id && state[id].on && !wms[id].ok) setStatus(id, 'fail', WMS_FAILURE[id])
  })
  map.on('sourcedata', (e) => {
    const id = Object.keys(WMS).find((k) => WMS[k].test(e.sourceId || ''))
    if (!id || !e.tile || e.tile.state !== 'loaded') return
    if (!wms[id].ok++ && state[id].on && $(`status-${id}`).dataset.state === 'fail') setStatus(id, 'ok', id === 'aerials' && swipe.isOpen() ? SWIPE_LINE : state[id].message)
  })

  // ---- loading. Each file is fetched on the first tick only.
  async function loadHerring() {
    const data = await json(HERRING_YEARS_FILE)
    if (!Array.isArray(data.features) || !data.features.length) throw new Error('not a feature collection')
    herring.counts.clear()
    for (const f of data.features) herring.counts.set(f.properties.year, (herring.counts.get(f.properties.year) || 0) + 1)
    herring.steps = herringSteps(data.features)
    herring.first = herring.steps[0].t
    map.getSource('tl-herringyears').setData(data)
    const last = herring.steps.at(-1).t
    return { message: `${plural(data.features.length, 'place and season', 'places and seasons')} with spawn recorded, from the ${herringSeason(herring.first)} season to ${herringSeason(last)}.` }
  }
  async function loadSei() {
    const [a, b] = await Promise.all([json(SEI_FILES[1994]), json(SEI_FILES[2002])])
    if (!a.features?.length || !b.features?.length) throw new Error('not a feature collection')
    map.getSource('tl-sei-1994').setData(a)
    map.getSource('tl-sei-2002').setData(b)
    const disturbed = b.features.filter((f) => f.properties.class === 'NS').length
    return { message: `${plural(a.features.length, 'polygon', 'polygons')} mapped in 1994-95. The 2002 update marks ${plural(disturbed, 'patch', 'patches')} as disturbed since 1992.` }
  }
  async function loadSei2014() {
    const d = await json(SEI_FILES[2014])
    if (!d.features?.length) throw new Error('not a feature collection')
    map.getSource('tl-sei-2014').setData(d)
    return { message: `${plural(d.features.length, 'polygon', 'polygons')}, all in the west of the map area.` }
  }
  // The three pictures (one per year) are added under the photos' place in the stack, and the step waits until all three are in.
  async function loadCanopy() {
    for (const s of CANOPY_YEARS) {
      if (map.getSource(`canopy-${s.t}`)) continue
      map.addSource(`canopy-${s.t}`, { type: 'image', url: CANOPY_FILES[s.t], coordinates: CANOPY_CORNERS })
      map.addLayer({ id: `canopy-${s.t}`, type: 'raster', source: `canopy-${s.t}`, layout: { visibility: 'none' }, paint: { 'raster-opacity': 0, 'raster-fade-duration': 0 } }, pos.low)
    }
    // A picture that cannot be had makes the map send an error for its source, and the box then says so.
    const failed = new Set()
    const onError = (e) => { if (/^canopy-\d{4}$/.test(e.sourceId || '')) failed.add(e.sourceId) }
    map.on('error', onError)
    try {
      await Promise.all(CANOPY_YEARS.map((s) => new Promise((resolve, reject) => {
        const id = `canopy-${s.t}`, until = performance.now() + 30000
        const check = () => {
          if (failed.has(id)) reject(new Error('the picture did not load'))
          else if (map.isSourceLoaded(id)) resolve()
          else if (performance.now() > until) reject(new Error('the picture did not load in time'))
          else setTimeout(check, 150)
        }
        setTimeout(check, 150)
      })))
    } catch (e) {
      for (const s of CANOPY_YEARS) { if (map.getLayer(`canopy-${s.t}`)) map.removeLayer(`canopy-${s.t}`); if (map.getSource(`canopy-${s.t}`)) map.removeSource(`canopy-${s.t}`) }
      throw e
    } finally { map.off('error', onError) }
    return { message: 'City of Victoria only, from the City’s LiDAR surveys.' }
  }
  // Land cover: one picture whose red, green and blue are a pixel's class in 2010, 2015 and 2020. It is read once and coloured into a picture
  // per year, each its own layer, so the time control only fades between them (crossfade).
  async function loadLandcover() {
    const reply = await fetch(LANDCOVER_FILE)
    if (!reply.ok) throw new Error(`HTTP ${reply.status}`)
    const bitmap = await createImageBitmap(await reply.blob(), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' })
    const w = bitmap.width, h = bitmap.height, read = document.createElement('canvas')
    read.width = w; read.height = h
    const g = read.getContext('2d', { willReadFrequently: true })
    g.drawImage(bitmap, 0, 0)
    bitmap.close()
    const px = g.getImageData(0, 0, w, h).data, lut = landcoverLut(), n = w * h
    let cells = 0
    for (const [i, s] of LANDCOVER_YEARS.entries()) {
      const canvas = document.createElement('canvas')
      canvas.width = w; canvas.height = h
      const out = new ImageData(w, h), o = out.data
      for (let k = 0; k < n; k++) {
        const c = px[k * 4 + 3] < 128 ? 0 : px[k * 4 + i] * 4
        o[k * 4] = lut[c]; o[k * 4 + 1] = lut[c + 1]; o[k * 4 + 2] = lut[c + 2]; o[k * 4 + 3] = lut[c + 3]
        if (lut[c + 3]) cells++
      }
      canvas.getContext('2d').putImageData(out, 0, 0)
      const id = `landcover-${s.t}`
      if (!map.getSource(id)) {
        map.addSource(id, { type: 'image', coordinates: LANDCOVER_CORNERS })
        map.addLayer({ id, type: 'raster', source: id, layout: { visibility: 'none' }, paint: { 'raster-opacity': 0, 'raster-fade-duration': 0, 'raster-resampling': 'nearest' } }, pos.low)
      }
      map.getSource(id).updateImage({ image: canvas, coordinates: LANDCOVER_CORNERS })
    }
    if (!cells) throw new Error('no land cover in the picture')
    return { message: 'Land cover of Canada from satellite images, 30 m cells, in the demo box, from Natural Resources Canada.' }
  }

  // Forest loss: one picture in which each pixel's red value gives its loss year (lossYearOf). It is read once into a list of the loss pixels in
  // order of year, so the picture for a year is the first so many of them, and a step paints or clears only the pixels between two years.
  const loss = { width: 0, height: 0, years: null, order: null, upTo: null, image: null, canvas: null, shown: 0 }
  async function loadLoss() {
    const reply = await fetch(LOSS_FILE)
    if (!reply.ok) throw new Error(`HTTP ${reply.status}`)
    // No colour management and no premultiplying, so the pixels are the ones in the file (as for the seafloor tiles).
    const bitmap = await createImageBitmap(await reply.blob(), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' })
    const canvas = document.createElement('canvas')
    canvas.width = bitmap.width; canvas.height = bitmap.height
    const g = canvas.getContext('2d', { willReadFrequently: true })
    g.drawImage(bitmap, 0, 0)
    bitmap.close()
    const image = g.getImageData(0, 0, canvas.width, canvas.height), px = image.data, n = canvas.width * canvas.height
    const years = new Uint8Array(n), count = new Uint32Array(26)
    for (let k = 0; k < n; k++) { const y = lossYearOf(px[k * 4], px[k * 4 + 3]); if (y) { years[k] = y - 2000; count[y - 2000]++ } }
    const upTo = new Uint32Array(26)
    for (let i = 1; i < 26; i++) upTo[i] = upTo[i - 1] + count[i]
    if (!upTo[25]) throw new Error('no loss in the picture')
    const order = new Uint32Array(upTo[25]), next = upTo.slice(0, 25)
    for (let k = 0; k < n; k++) if (years[k]) order[next[years[k] - 1]++] = k
    px.fill(0)
    Object.assign(loss, { width: canvas.width, height: canvas.height, years, order, upTo, image, canvas, shown: 0 })
    if (!map.getSource('forestloss')) {
      map.addSource('forestloss', { type: 'image', coordinates: LOSS_CORNERS })
      map.addLayer({ id: 'forestloss', type: 'raster', source: 'forestloss', layout: { visibility: 'none' }, paint: { 'raster-opacity': 0.85, 'raster-fade-duration': 0, 'raster-resampling': 'nearest' } }, pos.mid)
    }
    return { message: 'Stands of trees removed from 2001 to 2025 in the demo box, as seen by the Landsat satellites.' }
  }
  const LOSS_RGB = Array.from({ length: 26 }, (_, i) => (i ? lossRgb(2000 + i) : [0, 0, 0]))
  function paintLoss(t) {
    if (!loss.image) return
    const want = loss.upTo[Math.max(0, Math.min(25, t - 2000))], px = loss.image.data
    for (let i = loss.shown; i < want; i++) { const k = loss.order[i], c = LOSS_RGB[loss.years[k]]; px[k * 4] = c[0]; px[k * 4 + 1] = c[1]; px[k * 4 + 2] = c[2]; px[k * 4 + 3] = 255 }
    for (let i = want; i < loss.shown; i++) px[loss.order[i] * 4 + 3] = 0
    loss.shown = want
    loss.canvas.getContext('2d').putImageData(loss.image, 0, 0)
    map.getSource('forestloss')?.updateImage({ image: loss.canvas, coordinates: LOSS_CORNERS })
    map.triggerRepaint()
  }
  // The loss year under a click, if it is shown: the pixel itself, or the nearest one around it that is shown (the cells are 28 m).
  function lossAt(lngLat) {
    const t = timeline.time()
    if (!state.forestloss.on || !loss.years || t == null) return null
    const p = lossPixel(lngLat.lng, lngLat.lat, loss.width, loss.height)
    if (!p) return null
    let best = 0, d = Infinity
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const x = p[0] + dx, y = p[1] + dy
      if (x < 0 || y < 0 || x >= loss.width || y >= loss.height) continue
      const v = loss.years[y * loss.width + x]
      if (v && 2000 + v <= t && dx * dx + dy * dy < d) { best = 2000 + v; d = dx * dx + dy * dy }
    }
    return best || null
  }

  // ---- the keys under the boxes
  const swatchRow = (colour, text) => { const r = el('div', null, 'swatch-row'); const s = el('span', null, 'swatch'); s.style.background = colour; r.append(s, el('span', text)); return r }
  $('sei-key').replaceChildren(...SEI_KEY.map(([k, text]) => swatchRow(SEI_CLASSES[k].colour, text)))
  $('landcover-key').replaceChildren(...LANDCOVER_CLASSES.map(([, colour, text]) => swatchRow(colour, text)))
  $('forestloss-bar').style.backgroundImage = lossGradient()

  // ---- map layers, added once when the basemap style is in. All start hidden.
  const pos = { low: null, mid: null }
  function addLayers({ before, low, mid }) {
    const hidden = { visibility: 'none' }
    const geo = (id, attribution) => map.addSource(id, { type: 'geojson', data: EMPTY, attribution })
    // Air photos: one source per year, so each year keeps its own tiles, and a hidden year asks for nothing.
    for (const s of AERIAL_YEARS) {
      map.addSource(`aerial-${s.t}`, { type: 'raster', tiles: [aerialTileUrl(s.t)], tileSize: 256, bounds: AERIAL_BOUNDS[s.t], maxzoom: AERIAL_MAX_ZOOM[s.t], attribution: AERIAL_ATTRIB })
      map.addLayer({ id: `aerial-${s.t}`, type: 'raster', source: `aerial-${s.t}`, layout: hidden, paint: { 'raster-fade-duration': 0 } }, low)
    }
    // Tree canopy from LiDAR: the pictures are added on the first tick (loadCanopy), because an image source fetches its picture as soon as it
    // is added, even while hidden. An image source cannot carry a credit, so an empty point source does.
    pos.low = low
    // Land cover: the pictures are added on the first tick (loadLandcover). Their credit rides on an empty point source, as for the canopy.
    geo('tl-landcover-credit', LANDCOVER_ATTRIB)
    map.addLayer({ id: 'landcover-credit', type: 'circle', source: 'tl-landcover-credit', layout: hidden, paint: { 'circle-radius': 0, 'circle-opacity': 0 } }, before)
    geo('tl-canopy-credit', CANOPY_ATTRIB)
    map.addLayer({ id: 'canopy-credit', type: 'circle', source: 'tl-canopy-credit', layout: hidden, paint: { 'circle-radius': 0, 'circle-opacity': 0 } }, before)

    // Forest loss: the picture is added on the first tick (loadLoss). Its credit rides on an empty point source, as for the tree canopy.
    pos.mid = mid
    geo('tl-forestloss-credit', LOSS_ATTRIB)
    map.addLayer({ id: 'forestloss-credit', type: 'circle', source: 'tl-forestloss-credit', layout: hidden, paint: { 'circle-radius': 0, 'circle-opacity': 0 } }, before)
    for (const v of [1994, 2002]) {
      geo(`tl-sei-${v}`, SEI_ATTRIB)
      map.addLayer({ id: `sei-${v}-fill`, type: 'fill', source: `tl-sei-${v}`, layout: hidden, paint: { 'fill-color': seiColour(), 'fill-opacity': ['match', ['get', 'class'], 'NS', 0.75, 0.5] } }, mid)
      map.addLayer({ id: `sei-${v}-line`, type: 'line', source: `tl-sei-${v}`, layout: hidden, paint: { 'line-color': seiColour(), 'line-width': 0.8 } }, mid)
    }
    // In the 2014 mapping NS means a polygon whose main ecosystem is not sensitive, not a disturbance, so it is grey there.
    geo('tl-sei-2014', SEI_ATTRIB)
    const colour2014 = ['match', ['get', 'class'], 'NS', '#9e9e9e', seiColour()]
    map.addLayer({ id: 'sei2014-fill', type: 'fill', source: 'tl-sei-2014', layout: hidden, paint: { 'fill-color': colour2014, 'fill-opacity': 0.5 } }, mid)
    map.addLayer({ id: 'sei2014-line', type: 'line', source: 'tl-sei-2014', layout: hidden, paint: { 'line-color': colour2014, 'line-width': 0.8, 'line-dasharray': [2, 1] } }, mid)

    geo('tl-herringyears', HERRING_YEARS_ATTRIB)
    // Every place with spawn in any season, as a faint ring, so a season with few circles reads as fewer, not as an empty map.
    map.addLayer({ id: 'herringyears-all', type: 'circle', source: 'tl-herringyears', layout: hidden, paint: { 'circle-radius': 3.5, 'circle-color': 'rgba(0,0,0,0)', 'circle-stroke-width': 1, 'circle-stroke-color': '#8a8f93' } }, before)
    map.addLayer({ id: 'herringyears-dot', type: 'circle', source: 'tl-herringyears', layout: hidden, filter: ['==', ['get', 'year'], -1], paint: {
      'circle-radius': herringRadius(), 'circle-color': '#e8590c', 'circle-opacity': 0.75, 'circle-stroke-width': 1.5, 'circle-stroke-color': '#ffffff' } }, before)
    ready()
  }

  // ---- popups (DOM nodes and textContent only)
  function popupFor(f, layer) {
    const p = f?.properties, box = el('div')
    let i
    if (layer === 'forestloss') i = lossInfo(f)
    else if (layer === 'herringyears-dot') i = herringYearInfo(p)
    else if (layer === 'sei-1994-fill') i = seiInfo(p, 1994)
    else if (layer === 'sei-2002-fill') i = seiInfo(p, 2002)
    else if (layer === 'sei2014-fill') i = seiInfo(p, 2014)
    else return null
    box.append(el('h3', i.title))
    if (i.tag) box.append(el('span', i.tag, 'tag'))
    for (const l of i.lines) box.append(el('p', l))
    box.append(el('p', i.source, 'src'))
    const href = { 'herringyears-dot': HERRING_RECORD, forestloss: LOSS_PAGE }[layer] || SEI_RECORD
    const a = link(href, layer === 'herringyears-dot' ? 'The data on open.canada.ca' : layer === 'forestloss' ? 'Global Forest Change' : 'The inventory in the BC Data Catalogue')
    if (a) { const d = el('p'); d.append(a); box.append(d) }
    return box
  }
  // Points first, then the small areas, then the large ones. Forest loss is a picture, so it is found by its pixel (pixelPopup), after these.
  const QUERY_LAYERS = ['herringyears-dot', 'sei-2002-fill', 'sei-1994-fill', 'sei2014-fill']
  // The popup of the forest loss under a click, or null.
  const pixelPopup = (lngLat) => { const y = lossAt(lngLat); return y ? popupFor(y, 'forestloss') : null }

  return { addLayers, popupFor, pixelPopup, queryLayers: QUERY_LAYERS, defs: DEFS, state, timeline, swipe, loss }
}
