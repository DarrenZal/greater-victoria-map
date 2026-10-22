#!/usr/bin/env node
// Browser checks for the Greater Victoria demo map, run in headless Chromium.
//
//   PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node scripts/browser-check.mjs [--shots dir]
//
// Playwright is not a dependency of this folder. Point PLAYWRIGHT_MODULE at an
// existing install, or leave it unset if `playwright` resolves from here.
// The folder is served by a small built-in static server on a free port.
// The page loads map tiles from tiles.openfreemap.org and, since Terrain shading and 3D terrain
// are on by default, elevation tiles from s3.amazonaws.com, and the desktop run ticks each live layer against its real service
// (api.weather.gc.ca, geo.weather.gc.ca, earthquake.usgs.gov, api.gbif.org), so this needs network. Sea currents are
// checked on both screen sizes, in 2D and 3D and under reduced motion, against geo.weather.gc.ca.
// The failure lines are checked separately with those four hosts blocked.
//
// The page is declared ready by window.__ready, not map.loaded() or the 'idle'
// event, because neither settles while the flow dashes animate.
import { createServer } from 'node:http'
import { readFile, mkdir } from 'node:fs/promises'
import { join, extname, dirname, normalize } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.geojson': 'application/geo+json', '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8' }
const BOWKER = [-123.3165974, 48.4309387]
// Map layers of the optional overlays that exist from the start, all hidden. The radar layer is made on first use.
const OVERLAY_LAYERS = ['radar-credit', 'currents-credit', 'ecoregions-fill', 'ecoregions-sea-mask', 'ecoregions-line', 'alerts-fill', 'alerts-line', 'industry-dot', 'life-dot', 'water-dot', 'conditions-dot', 'aqhi-dot', 'quakes-dot', 'aqhi-label', 'conditions-label', 'water-label', 'quakes-label']
// What each box asks of the network when ticked: [host, ...] and the file it loads from this site.
const OVERLAY_NET = {
  radar: { hosts: ['geo.weather.gc.ca'] }, currents: { hosts: ['geo.weather.gc.ca'] }, alerts: { hosts: ['api.weather.gc.ca'] }, aqhi: { hosts: ['api.weather.gc.ca'] },
  conditions: { hosts: ['api.weather.gc.ca'] }, water: { hosts: ['api.weather.gc.ca'] }, quakes: { hosts: ['earthquake.usgs.gov'] },
  life: { hosts: ['api.gbif.org'] }, ecoregions: { hosts: [], file: 'data/ecoregions.geojson' }, industry: { hosts: [], file: 'data/industry-waste.geojson' },
}
const LIVE_HOSTS = ['api.weather.gc.ca', 'geo.weather.gc.ca', 'earthquake.usgs.gov', 'api.gbif.org']
const ECCC_STATEMENT = 'Contains information licenced under the Data Server End-use Licence of Environment and Climate Change Canada.'
// Text the map's attribution must carry while each layer is on.
const OVERLAY_ATTRIB = {
  radar: ECCC_STATEMENT, currents: ECCC_STATEMENT, alerts: ECCC_STATEMENT, aqhi: ECCC_STATEMENT, conditions: ECCC_STATEMENT, water: ECCC_STATEMENT,
  quakes: 'U.S. Geological Survey', life: 'GBIF', ecoregions: 'Ecoregions 2017 \u00a9 Resolve', industry: 'HydroWASTE',
}

function serve() {
  const server = createServer(async (req, res) => {
    try {
      let p = decodeURIComponent(new URL(req.url, 'http://x').pathname)
      if (p.endsWith('/')) p += 'index.html'
      const abs = normalize(join(ROOT, p))
      if (!abs.startsWith(ROOT)) { res.writeHead(403).end(); return }
      const body = await readFile(abs)
      res.writeHead(200, { 'content-type': MIME[extname(abs)] || 'application/octet-stream' }).end(body)
    } catch { res.writeHead(404).end('not found') }
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` })))
}

let failures = 0
const report = (pass, name, detail = '') => { if (!pass) failures++; console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${!pass && detail ? ': ' + detail : ''}`) }

export async function runBrowserChecks() {
  failures = 0
  const shotsIdx = process.argv.indexOf('--shots')
  const shots = shotsIdx > 0 ? process.argv[shotsIdx + 1] : null
  if (shots) await mkdir(shots, { recursive: true })
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright')
  const { server, base } = await serve()
  const browser = await chromium.launch()
  try {
    for (const [name, vp] of [['desktop', { width: 1280, height: 800 }], ['phone', { width: 390, height: 780 }]]) {
      await checkViewport(browser, base, name, vp, shots)
    }
    await checkReducedMotion(browser, base)
    await checkBasemapDown(browser, base, shots)
    await checkOverlaysBlocked(browser, base)
  } finally {
    await browser.close()
    server.close()
  }
  console.log(`\n${failures === 0 ? 'All browser checks passed.' : failures + ' browser check(s) failed.'}`)
  return failures
}

async function openPage(browser, base, vp, { blockTiles = false, reducedMotion = 'no-preference' } = {}) {
  const ctx = await browser.newContext({ viewport: vp, deviceScaleFactor: 1, reducedMotion })
  const page = await ctx.newPage()
  const problems = [], warnings = [], requests = []
  page.on('request', (r) => requests.push(r.url()))
  page.on('console', (m) => { if (m.type() === 'error') problems.push('console error: ' + m.text().slice(0, 200)); else if (m.type() === 'warning') warnings.push(m.text().slice(0, 160)) })
  page.on('pageerror', (e) => problems.push('page error: ' + e.message.slice(0, 200)))
  page.on('requestfailed', (r) => {
    // MapLibre cancels elevation tiles it no longer needs, for example while the map tilts into 3D at load.
    if (/ERR_ABORTED/.test(r.failure()?.errorText || '') && new URL(r.url()).host === 's3.amazonaws.com') return
    if (!blockTiles || !r.url().includes('tiles.openfreemap.org')) problems.push(`request failed (${r.failure()?.errorText || '?'}): ` + r.url().slice(0, 120))
  })
  page.on('response', (r) => { if (r.url().startsWith(base) && r.status() >= 400) problems.push(`HTTP ${r.status()}: ${r.url().slice(0, 120)}`) })
  if (blockTiles) await page.route('https://tiles.openfreemap.org/**', (r) => r.abort())
  await page.goto(base + '/index.html?test', { waitUntil: 'load' })
  await page.waitForFunction(() => window.__ready && window.__map.areTilesLoaded(), null, { timeout: 45000 })
  await page.waitForTimeout(2000)
  return { ctx, page, problems, warnings, requests }
}

async function checkViewport(browser, base, name, vp, shots) {
  const { ctx, page, problems, warnings, requests } = await openPage(browser, base, vp)
  const t = (s) => `${name}: ${s}`
  // 3D terrain is on by default: the map tilts to 60 degrees once it is ready.
  await page.waitForFunction(() => Math.abs(window.__map.getPitch() - 60) < 1, null, { timeout: 90000 }).catch(() => {})
  const info = await page.evaluate((OVERLAY_LAYERS) => {
    const m = window.__map
    const vis = (id) => m.getLayer(id) ? (m.getLayoutProperty(id, 'visibility') ?? 'visible') : 'absent'
    const attrib = document.querySelector('.maplibregl-ctrl-attrib')
    const panel = document.getElementById('panel').getBoundingClientRect()
    const a = attrib.getBoundingClientRect()
    return {
      layers: ['hillshade', 'bec-fill', 'bec-sea-mask', 'watersheds-fill', 'watersheds-line', 'parks-local', 'parks-bc', 'parks-bc-line', 'wetlands', 'lakes', 'streams', 'streams-flow', 'muni-fill', 'muni-line', 'streams-label', 'parks-bc-label', 'muni-label', 'pins', 'pins-label', ...OVERLAY_LAYERS].filter((id) => !m.getLayer(id)),
      defaults: Object.fromEntries(['bec-fill', 'hillshade', 'watersheds-line', 'parks-local', 'parks-bc', 'streams', 'streams-flow', 'muni-line', 'pins'].map((id) => [id, vis(id)])),
      overlayDefaults: Object.fromEntries(OVERLAY_LAYERS.map((id) => [id, vis(id)])),
      view3d: { terrain: m.getTerrain(), pitch: m.getPitch(), maxPitch: m.getMaxPitch(), rotate: m.dragRotate.isEnabled(), box: document.getElementById('terrain3d').checked, sky: !!(m.getSky && m.getSky()?.['sky-color']), note: !document.getElementById('terrain3d-note').hidden },
      overlayBoxes: [...document.querySelectorAll('input[data-overlay]')].map((b) => b.checked),
      overlayRadarLayer: !!m.getLayer('radar'),
      currentsCanvas: !!document.getElementById('currents-canvas'),
      flowBox: { checked: document.getElementById('flow').checked, disabled: document.getElementById('flow').disabled },
      terrainChecked: document.querySelector('input[data-group=terrain]').checked,
      flowRunning: window.__flow.running(),
      zoom: m.getZoom(),
      attribText: attrib.innerText,
      attribCollapsed: !attrib.classList.contains('maplibregl-compact-show') && !attrib.hasAttribute('open'),
      attribCompact: attrib.classList.contains('maplibregl-compact'),
      attribHeight: a.height,
      panelOverlapsAttrib: !(panel.right <= a.left || panel.left >= a.right || panel.bottom <= a.top || panel.top >= a.bottom),
      overflowX: document.documentElement.scrollWidth > innerWidth,
      banner: document.getElementById('demo-banner').innerText,
      pinCount: document.getElementById('pins-count').textContent,
      emptyVisible: !document.getElementById('pins-empty').hidden,
      emptyText: document.getElementById('pins-empty').textContent,
    }
  }, OVERLAY_LAYERS)
  report(info.layers.length === 0, t('all map layers present'), 'missing: ' + info.layers.join(', '))
  report(JSON.stringify(info.defaults) === JSON.stringify({ 'bec-fill': 'none', hillshade: 'visible', 'watersheds-line': 'none', 'parks-local': 'visible', 'parks-bc': 'visible', streams: 'visible', 'streams-flow': 'visible', 'muni-line': 'visible', pins: 'visible' }), t('default layer visibility as specified'), JSON.stringify(info.defaults))
  report(info.flowBox.checked && !info.flowBox.disabled && info.flowRunning && info.terrainChecked, t('Flow box is on and the flow loop is running; Terrain shading box is on'), JSON.stringify({ flowBox: info.flowBox, running: info.flowRunning, terrain: info.terrainChecked, zoom: info.zoom }))
  report(Object.values(info.overlayDefaults).every((v) => v === 'none') && info.overlayBoxes.length === 10 && info.overlayBoxes.every((b) => !b) && !info.overlayRadarLayer && !info.currentsCanvas, t('every new layer exists, is hidden and unticked at load, and the sea currents canvas does not exist yet (ecoregions, industry, radar, sea currents, alerts, air quality, conditions, river gauges, earthquakes, life observations)'), JSON.stringify([info.overlayDefaults, info.overlayBoxes, info.overlayRadarLayer]))
  const v = info.view3d
  report(v.box && v.terrain?.source === 'terrain-dem' && v.terrain.exaggeration === 2 && Math.abs(v.pitch - 60) < 1 && v.maxPitch >= 60 && v.rotate && v.sky && v.note, t('3D terrain is on at load: terrain from the elevation tiles, tilted to 60 degrees, rotation unlocked, sky and note shown'), JSON.stringify(v))
  const hosts = [...new Set(requests.map((u) => new URL(u).host))].filter((h) => !h.startsWith('127.0.0.1'))
  report(hosts.includes('s3.amazonaws.com') && hosts.every((h) => h === 'tiles.openfreemap.org' || h === 's3.amazonaws.com'), t('on load the page contacts only the basemap host and the elevation tiles (no weather or other service)'), hosts.join(', '))
  report(!info.overflowX, t('no horizontal page scroll'))
  report(info.banner.includes('Demo.') && !info.banner.includes('could not be reached'), t('demo banner shown, basemap reached'), info.banner)
  report(info.pinCount === '(1)' && info.emptyVisible && info.emptyText === 'No events listed yet.', t('pins panel: 1 example place and the empty-state sentence'), info.emptyText)
  if (name === 'desktop') {
    report(info.attribText.includes('OpenFreeMap') && info.attribText.includes('OpenStreetMap') && info.attribText.includes('Open Government Licence'), t('attribution shows basemap and BC credit'), info.attribText)
    // Two lines at most: with terrain on by default, its credit joins the basemap and BC credits.
    report(info.attribHeight < 50, t('attribution strip fits on two lines'), `${info.attribHeight}px high`)
  } else {
    report(info.attribCompact && info.attribCollapsed, t('attribution is the collapsed (i) button after load'), JSON.stringify({ compact: info.attribCompact, collapsed: info.attribCollapsed }))
    report(!info.panelOverlapsAttrib, t('layers panel does not cover the attribution control'))
  }

  if (shots) await page.screenshot({ timeout: 120000, path: join(shots, `${name}-1-default.png`) })
  await checkCurrents3d(page, requests, t, shots ? (label) => page.screenshot({ timeout: 120000, path: join(shots, `${name}-${label}.png`) }) : null)

  // The checks below run on the flat map. checkTerrain3d switches 3D terrain on and off again.
  await setBox(page, '#terrain3d', false)
  await page.waitForFunction(() => window.__map.getPitch() < 0.5 && !window.__map.getTerrain(), null, { timeout: 90000 })
  await page.waitForTimeout(1500)

  // toggles
  const toggled = await page.evaluate(async () => {
    const m = window.__map
    const set = (g, v) => { const b = document.querySelector(`input[data-group=${g}]`); b.checked = v; b.dispatchEvent(new Event('change')) }
    const vis = (id) => m.getLayoutProperty(id, 'visibility') ?? 'visible'
    set('water', false); const hidden = vis('streams') === 'none' && vis('lakes') === 'none' && vis('streams-label') === 'none'
    set('water', true); const shown = vis('streams') === 'visible'
    set('bec', true); const bec = vis('bec-fill') === 'visible' && vis('bec-sea-mask') === 'visible'
    set('watersheds', true); const ws = vis('watersheds-fill') === 'visible' && vis('watersheds-line') === 'visible'
    return { hidden, shown, bec, ws }
  })
  report(toggled.hidden && toggled.shown, t('water toggle hides and restores creeks, lakes and wetlands'))
  report(toggled.bec && toggled.ws, t('BEC (with sea mask) and watershed toggles work'))
  await checkFlowToggles(page, t)
  if (name === 'desktop') await checkMarchDirection(page, t)
  await checkTerrain(page, requests, t, shots ? (label) => page.screenshot({ timeout: 120000, path: join(shots, `${name}-${label}.png`) }) : null)
  await checkTerrain3d(page, requests, t, shots ? (label) => page.screenshot({ timeout: 120000, path: join(shots, `${name}-${label}.png`) }) : null)
  if (name === 'desktop') await checkOverlays(page, requests, t, shots ? (label) => page.screenshot({ timeout: 120000, path: join(shots, `${name}-${label}.png`) }) : null)
  await checkCurrents(page, requests, t, name, shots ? (label) => page.screenshot({ timeout: 120000, path: join(shots, `${name}-${label}.png`) }) : null)
  await page.waitForTimeout(1200)
  if (shots) await page.screenshot({ timeout: 120000, path: join(shots, `${name}-2-bec-watersheds.png`) })

  // watershed popup: zoom into Bowker, click, smallest watershed wins
  await page.evaluate(([x, y]) => window.__map.jumpTo({ center: [x, y], zoom: 13.2 }), BOWKER)
  await page.waitForTimeout(2500)
  const pt = await page.evaluate(([x, y]) => { const p = window.__map.project([x, y]); return { x: p.x, y: p.y } }, BOWKER)
  // 1. pin popup
  await page.mouse.click(pt.x, pt.y)
  await page.waitForTimeout(600)
  const popup = await page.evaluate(() => document.querySelector('.maplibregl-popup-content')?.innerText || null)
  report(!!popup && popup.includes('Bowker Creek') && popup.includes('Example place, not an event') && popup.includes('3.4 km'), t('example pin popup opens with its sourced text'), String(popup).slice(0, 120))
  const titleVisible = await page.evaluate(() => {
    const h = document.querySelector('.maplibregl-popup-content h3')
    if (!h) return false
    const r = h.getBoundingClientRect()
    const top = document.elementFromPoint(r.left + Math.min(20, r.width / 2), r.top + r.height / 2)
    return !!top && !!top.closest('.maplibregl-popup-content')
  })
  report(titleVisible, t('popup title is not covered by the banner or buttons'))
  if (shots) await page.screenshot({ timeout: 120000, path: join(shots, `${name}-3-bowker-popup.png`) })
  const popupLinks = await page.evaluate(() => [...document.querySelectorAll('.maplibregl-popup-content a')].map((a) => a.href + ' ' + a.rel))
  report(popupLinks.length > 0 && popupLinks.every((l) => l.startsWith('https://') && l.includes('noopener')), t('popup links are https and rel=noopener'), popupLinks.join(' | '))

  // 2. with pins off, a click on the same spot gives a watershed or creek popup
  await page.evaluate(() => { const b = document.querySelector('input[data-group=pins]'); b.checked = false; b.dispatchEvent(new Event('change')) })
  await page.evaluate(() => document.querySelector('.maplibregl-popup')?.remove())
  await page.mouse.click(pt.x, pt.y + 40)
  await page.waitForTimeout(600)
  const popup2 = await page.evaluate(() => document.querySelector('.maplibregl-popup-content')?.innerText || null)
  report(!!popup2 && /watershed|creek|park|municipality|Oak Bay|Saanich|Victoria/i.test(popup2), t('a click away from the pin opens a feature popup'), String(popup2).slice(0, 160))
  await page.evaluate(() => { const b = document.querySelector('input[data-group=pins]'); b.checked = true; b.dispatchEvent(new Event('change')) })

  // 3. municipality popup from a click inside the boundary
  const mu = await page.evaluate(() => {
    const m = window.__map
    for (const g of ['water', 'parks', 'bec', 'watersheds', 'pins']) { const b = document.querySelector(`input[data-group=${g}]`); b.checked = false; b.dispatchEvent(new Event('change')) }
    document.querySelector('.maplibregl-popup')?.remove()
    m.jumpTo({ center: [-123.37, 48.45], zoom: 11 })
    return true
  })
  await page.waitForTimeout(1800)
  await page.mouse.click(vp.width / 2, vp.height / 2)
  await page.waitForTimeout(600)
  const popup3 = await page.evaluate(() => document.querySelector('.maplibregl-popup-content')?.innerText || null)
  report(!!popup3 && popup3.includes('municipality') && popup3.includes('adjacent water'), t('municipality popup opens from inside the boundary and mentions adjacent water'), String(popup3).slice(0, 160))
  void mu

  // credits
  await page.evaluate(() => document.querySelector('.maplibregl-popup')?.remove())
  await page.click('#credits-btn')
  const creditsOpen = await page.evaluate(() => !document.getElementById('credits').hidden)
  if (shots) await page.screenshot({ timeout: 120000, path: join(shots, `${name}-4-credits.png`) })
  await page.keyboard.press('Escape')
  const creditsClosed = await page.evaluate(() => document.getElementById('credits').hidden)
  report(creditsOpen && creditsClosed, t('credits panel opens and Escape closes it'))

  // fit button
  await page.evaluate(() => { document.getElementById('panel-details').open = true })
  await page.click('#fit')
  await page.waitForTimeout(1500)
  const center = await page.evaluate(() => window.__map.getCenter())
  report(Math.abs(center.lng - -123.43) < 0.1 && Math.abs(center.lat - 48.48) < 0.1, t('Fit to Greater Victoria returns to the home view'), JSON.stringify(center))

  // A 429 from GBIF (it refuses bursts) is reported on the page as a partial result, so it is not a page problem.
  const hardProblems = problems.filter((p) => (!/openfreemap/i.test(p) || /HTTP|page error/.test(p)) && !/status of 429/.test(p))
  report(hardProblems.length === 0, t('no page errors, console errors or failed requests'), hardProblems.slice(0, 3).join(' | '))
  if (warnings.length) console.log(`      (${warnings.length} console warnings, listed once: ${[...new Set(warnings)].slice(0, 5).join(' || ')})`)
  await ctx.close()
}

// Set a checkbox and tell the page, the way a tap would.
const setBox = (page, sel, v) => page.evaluate(([s, val]) => { const b = document.querySelector(s); b.checked = val; b.dispatchEvent(new Event('change')) }, [sel, v])

// Flow sub-toggle: on by default, and the loop runs only while the dashes can be seen.
async function checkFlowToggles(page, t) {
  const state = () => page.evaluate(() => {
    const m = window.__map, b = document.getElementById('flow')
    return { vis: m.getLayoutProperty('streams-flow', 'visibility') ?? 'visible', running: window.__flow.running(), disabled: b.disabled, checked: b.checked, dash: JSON.stringify(m.getPaintProperty('streams-flow', 'line-dasharray')) }
  })
  const on = await state()
  await page.waitForTimeout(400)
  const later = await state()
  report(on.vis === 'visible' && on.running && on.dash !== later.dash, t('Flow is on by default: layer visible, loop running, dash pattern advancing'), JSON.stringify([on, later.dash]))

  await setBox(page, '#flow', false)
  const off = await state()
  report(off.vis === 'none' && !off.running && !off.disabled, t('Flow box off: dashes hidden and the loop stopped'), JSON.stringify(off))
  await setBox(page, '#flow', true)

  await setBox(page, 'input[data-group=water]', false)
  const noWater = await state()
  report(noWater.vis === 'none' && !noWater.running && noWater.disabled, t('Creeks box off: Flow is hidden, stopped and disabled'), JSON.stringify(noWater))
  await setBox(page, 'input[data-group=water]', true)
  const back = await state()
  report(back.vis === 'visible' && back.running && !back.disabled, t('Creeks box on again: Flow returns'), JSON.stringify(back))

  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); document.dispatchEvent(new Event('visibilitychange')) })
  const hidden = await state()
  await page.evaluate(() => { delete document.hidden; document.dispatchEvent(new Event('visibilitychange')) })
  const shown = await state()
  report(!hidden.running && shown.running, t('loop stops while the tab is hidden and resumes when it is shown'), JSON.stringify({ hidden: hidden.running, shown: shown.running }))

  // The map's bounds keep it from zooming out far on a wide screen, so the zoom
  // gate can be out of reach. It is checked wherever the map can go below the flow zoom.
  const gate = await page.evaluate(() => ({ zoom: window.__map.getZoom(), flow: window.__flow.minZoom }))
  await page.evaluate((z) => window.__map.jumpTo({ zoom: z }), gate.flow - 0.1)
  await page.waitForTimeout(150)
  const reached = await page.evaluate(() => window.__map.getZoom())
  const far = await state()
  await page.evaluate((z) => window.__map.jumpTo({ zoom: z }), gate.zoom)
  await page.waitForTimeout(150)
  const near = await state()
  if (reached < gate.flow) report(!far.running && near.running, t('loop stops when zoomed out past the flow layer and resumes when zoomed back in'), JSON.stringify({ far: far.running, near: near.running }))
  else console.log(`      (${t(`zoom gate not reachable at this width: the map stops zooming out at ${reached.toFixed(2)}, above the flow zoom ${gate.flow}, so it is not checked here`)})`)
}

// The dash pattern must march along the order of a line's vertices, because
// data/streams-flow.geojson is built with the last vertex downstream. A west to
// east test line is drawn in magenta with each of the page's 14 dash steps, and
// the pattern has to move east on every step, including the wrap from the last
// step to the first.
async function checkMarchDirection(page, t) {
  const view = await page.evaluate(() => ({ center: window.__map.getCenter().toArray(), zoom: window.__map.getZoom() }))
  const line = await page.evaluate(() => {
    const m = window.__map
    const box = document.getElementById('flow'); box.checked = false; box.dispatchEvent(new Event('change'))
    m.jumpTo({ center: [-123.2, 48.45], zoom: 14 })
    const c = m.getCenter()
    const a = [c.lng - 0.012, c.lat], b = [c.lng + 0.012, c.lat]
    m.addSource('flowtest', { type: 'geojson', data: { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [a, b] } } })
    m.addLayer({ id: 'flowtest', type: 'line', source: 'flowtest', layout: { 'line-cap': 'butt' }, paint: { 'line-color': '#ff00ff', 'line-width': 8, 'line-dasharray': window.__flow.sequence[0] } })
    const pa = m.project(a), pb = m.project(b)
    return { x0: Math.round(pa.x), x1: Math.round(pb.x), y: Math.round(pa.y) }
  })
  const rows = []
  const steps = await page.evaluate(() => window.__flow.sequence.length)
  for (let i = 0; i < steps; i++) {
    await page.evaluate((i) => new Promise((resolve) => {
      const m = window.__map
      m.setPaintProperty('flowtest', 'line-dasharray', window.__flow.sequence[i])
      m.once('idle', resolve); m.triggerRepaint()
    }), i)
    const png = await page.screenshot({ clip: { x: line.x0 + 30, y: line.y - 1, width: line.x1 - line.x0 - 60, height: 3 } })
    rows.push(await page.evaluate(async (b64) => {
      const img = await createImageBitmap(await (await fetch('data:image/png;base64,' + b64)).blob())
      const c = new OffscreenCanvas(img.width, img.height), g = c.getContext('2d')
      g.drawImage(img, 0, 0)
      const d = g.getImageData(0, 1, img.width, 1).data
      let out = ''
      for (let x = 0; x < img.width; x++) out += d[x * 4] > 180 && d[x * 4 + 1] < 100 && d[x * 4 + 2] > 180 ? '1' : '0'
      return out
    }, png.toString('base64')))
  }
  await page.evaluate((v) => { const m = window.__map; m.removeLayer('flowtest'); m.removeSource('flowtest'); m.jumpTo(v); const box = document.getElementById('flow'); box.checked = true; box.dispatchEvent(new Event('change')) }, view)
  // How far the pattern moved from step i to step i + 1, in pixels (positive is east).
  const shiftOf = (p, q) => {
    let best = null
    for (let s = -12; s <= 12; s++) {
      let match = 0, n = 0
      for (let x = 20; x < p.length - 20; x++) { n++; if (q[x] === p[x - s]) match++ }
      if (!best || match / n > best.fit) best = { s, fit: match / n }
    }
    return best
  }
  const moves = rows.map((r, i) => shiftOf(r, rows[(i + 1) % rows.length]))
  const east = moves.filter((m) => m.s > 0 && m.fit > 0.95).length
  const inked = rows[0].split('').filter((c) => c === '1').length
  report(inked > rows[0].length * 0.2 && east === moves.length, t(`dash pattern marches along vertex order on all ${moves.length} steps (test line drawn west to east moves east)`), `inked ${inked}/${rows[0].length}, moves ${JSON.stringify(moves.map((m) => [m.s, +m.fit.toFixed(2)]))}`)
}

// Terrain shading: on by default, with elevation tiles from AWS and their credit on the map.
// Unticking hides it and ticking shows it again. It is left off for checkTerrain3d.
async function checkTerrain(page, requests, t, shot) {
  const s3 = () => requests.filter((u) => new URL(u).host === 's3.amazonaws.com').length
  const state = () => page.evaluate(() => ({ vis: window.__map.getLayoutProperty('hillshade', 'visibility') ?? 'visible', attrib: document.querySelector('.maplibregl-ctrl-attrib').textContent }))
  const on = await state()
  report(on.vis === 'visible' && s3() > 0, t('Terrain shading on by default: layer visible and elevation tiles requested from AWS'), `${on.vis}, ${s3()} requests`)
  report(on.attrib.includes('AWS Terrain Tiles') && on.attrib.includes('OGL') && on.attrib.includes('USGS'), t('map attribution carries the terrain credit while the layer is on'), on.attrib.slice(0, 200))
  if (shot) await shot('terrain-on')
  await setBox(page, 'input[data-group=terrain]', false)
  const off = await state()
  await setBox(page, 'input[data-group=terrain]', true)
  const again = await state()
  await setBox(page, 'input[data-group=terrain]', false)
  report(off.vis === 'none' && again.vis === 'visible', t('Terrain shading box hides the layer and shows it again'), JSON.stringify([off.vis, again.vis]))
}

// 3D terrain: on by default (checkViewport switches it off first). Ticking it sets MapLibre terrain from the elevation tiles, tilts the
// map to 60 degrees, unlocks rotation and pitch and adds a sky. The Terrain shading box stays
// independent of it. Unticking resets the pitch and bearing and removes the terrain.
async function checkTerrain3d(page, requests, t, shot) {
  const s3 = () => requests.filter((u) => new URL(u).host === 's3.amazonaws.com').length
  const st = () => page.evaluate(() => {
    const m = window.__map
    return { terrain: m.getTerrain(), pitch: m.getPitch(), maxPitch: m.getMaxPitch(), bearing: m.getBearing(), rotate: m.dragRotate.isEnabled(), hill: m.getLayoutProperty('hillshade', 'visibility'), sky: m.getSky ? m.getSky() : null,
      note: !document.getElementById('terrain3d-note').hidden, attrib: document.querySelector('.maplibregl-ctrl-attrib').textContent, hillBox: document.querySelector('input[data-group=terrain]').checked }
  })
  // A view the elevation tiles for which have not been fetched yet.
  await page.evaluate(() => window.__map.jumpTo({ center: [-123.56, 48.49], zoom: 12.6 }))
  await page.waitForTimeout(1500)
  const before = s3()
  await setBox(page, '#terrain3d', true)
  await page.waitForFunction(() => Math.abs(window.__map.getPitch() - 60) < 1, null, { timeout: 150000 })
  await page.waitForTimeout(2500)
  const on = await st()
  report(on.terrain?.source === 'terrain-dem' && on.terrain.exaggeration === 2 && Math.abs(on.pitch - 60) < 1 && on.maxPitch >= 60 && on.rotate && on.note, t('3D terrain on: terrain set from the elevation tiles, map tilted to 60 degrees, rotation and pitch unlocked'), JSON.stringify({ ...on, attrib: undefined }))
  report(on.hill === 'none' && !on.hillBox, t('3D terrain on leaves the Terrain shading box and layer alone'))
  report(!!on.sky && !!on.sky['sky-color'], t('3D terrain on: a sky is set'), JSON.stringify(on.sky))
  report(s3() > before, t('3D terrain on: elevation tiles are requested from AWS'), `${s3() - before} new requests`)
  report(on.attrib.includes('AWS Terrain Tiles') && on.attrib.includes('USGS'), t('map attribution carries the terrain credit with 3D terrain on and shading off'), on.attrib.slice(0, 160))
  await setBox(page, 'input[data-group=terrain]', true)
  const both = await st()
  await setBox(page, 'input[data-group=terrain]', false)
  const shadeOff = await st()
  report(!!both.terrain && both.hill === 'visible' && !!shadeOff.terrain && shadeOff.hill === 'none', t('Terrain shading toggles on and off while 3D terrain stays on'), JSON.stringify([both.hill, shadeOff.hill, !!shadeOff.terrain]))
  // The flat layers are drawn over the relief and can still be found there.
  const drawn = await page.evaluate(() => window.__map.queryRenderedFeatures({ layers: ['streams', 'lakes', 'parks-local', 'muni-line'] }).length)
  report(drawn > 0, t('with 3D terrain on, creeks, lakes, parks and boundaries are still drawn and can be queried over the relief'), `${drawn} features`)
  if (shot) await shot('terrain3d-on')
  await page.evaluate(() => window.__map.jumpTo({ bearing: 40 }))
  await setBox(page, '#terrain3d', false)
  await page.waitForFunction(() => window.__map.getPitch() < 0.5 && Math.abs(window.__map.getBearing()) < 0.5 && !window.__map.getTerrain(), null, { timeout: 90000 })
  await page.waitForTimeout(500)
  const off = await st()
  report(off.terrain === null && off.pitch < 0.5 && Math.abs(off.bearing) < 0.5 && off.maxPitch === 0 && !off.rotate && !off.note, t('3D terrain off again: pitch and bearing back to 0, terrain removed, rotation locked'), JSON.stringify({ ...off, attrib: undefined, sky: undefined }))
}

// ---- sea currents
const currentsStats = (page) => page.evaluate(() => window.__overlays.currents.stats())
// A number that changes when the overlay canvas changes: its alpha values, weighted by position.
const canvasSignature = (page) => page.evaluate(() => {
  const c = document.getElementById('currents-canvas')
  if (!c) return null
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data
  let sum = 0
  for (let i = 3, k = 1; i < d.length; i += 16, k++) sum = (sum + d[i] * (k % 9973)) % 1e9
  return sum
})
// This machine draws in software and a map that has just stopped moving can take a second or two to give the loop a frame,
// so a check that reads the canvas waits until something has been drawn on it.
const waitDrawn = (page) => page.waitForFunction(() => window.__overlays.currents.stats().drawn > 300, null, { timeout: 45000 }).catch(() => {})
const seaHour = (text) => text.match(/for (.+?), Environment Canada/)?.[1] || null
const SEA_STATUS = /^Modelled surface currents for [A-Z][a-z]{2} \d{1,2}, \d{1,2}\s[ap]\.m\. P[SD]T, Environment Canada’s CIOPS Salish Sea model \(experimental, not for navigation\)\.$/
// Particles are drawn, and almost none of them over land (a drawn pixel more than two field points
// from any sea point). The pixel count is a sample of every other pixel.
const drawnOverSea = (st) => st.drawn > 300 && st.land / st.drawn < 0.01

// With 3D terrain on (pitch 60) the particles still draw, over the sea only. Run while the page is as it opened.
async function checkCurrents3d(page, requests, t, shot) {
  // The creek dashes redraw the whole map and slow a headless browser to a crawl, so they are off meanwhile.
  await setBox(page, '#flow', false)
  const idle = LIVE_HOSTS.map((h) => hostCount(requests, h))
  report(idle.every((n) => n === 0), t('nothing is requested from Environment Canada, USGS or GBIF before a box is ticked'), JSON.stringify(idle))
  // The relief matters here: unproject must hit the mountains, not the flat plane.
  const relief = await page.waitForFunction(() => window.__map.queryTerrainElevation([-123.3466, 48.4906]) > 50, null, { timeout: 120000 }).then(() => true, () => false)
  await setBox(page, 'input[data-overlay=currents]', true)
  await waitStatus(page, 'currents').catch(() => {})
  await page.waitForTimeout(2500)
  await waitDrawn(page)
  const st = await currentsStats(page), view = await page.evaluate(() => ({ pitch: window.__map.getPitch(), terrain: !!window.__map.getTerrain() }))
  report(st.running && view.terrain && Math.abs(view.pitch - 60) < 1 && drawnOverSea(st), t(`currents: with 3D terrain on (pitch 60${relief ? ', relief loaded' : ', relief not loaded in time'}) particles are drawn over the sea and not over land`), JSON.stringify({ ...st, view }))
  if (shot) await shot('currents-3d')
  // At the steepest tilt the top of the screen is sky. Above the horizon unproject answers with places behind the
  // camera, so nothing may be drawn there. The horizon is found from unproject itself: going up the middle of the
  // screen, the first row where the latitude runs off past 70 N or falls by a degree (relief in the way moves it by far less).
  await page.evaluate(() => window.__map.jumpTo({ pitch: 75 }))
  await page.waitForFunction(() => !window.__map.isMoving(), null, { timeout: 20000 })
  await page.waitForTimeout(2500)
  await waitDrawn(page)
  const steep = await currentsStats(page)
  const edge = await page.evaluate(() => {
    const m = window.__map; let prev = -90, flip = 0
    for (let y = innerHeight - 1; y >= 0; y -= 2) { const q = m.unproject([innerWidth / 2, y]); if (!q || q.lat < prev - 1 || q.lat > 70) { flip = y; break } prev = q.lat }
    return { flip, formula: window.__overlays.currents.horizon() }
  })
  // The answers turn wild a little below the horizon row (the ground there is thousands of kilometres away), never above it.
  report(edge.flip >= edge.formula - 2 && edge.flip - edge.formula <= 15 && steep.top >= edge.formula && drawnOverSea(steep), t('currents: at pitch 75 the horizon row used by the layer is where unproject starts answering with places behind the camera, and nothing is drawn above it'), JSON.stringify({ edge, top: steep.top, drawn: steep.drawn, land: steep.land }))
  if (shot) await shot('currents-3d-steep')
  await setBox(page, 'input[data-overlay=currents]', false)
  await setBox(page, '#flow', true)
}

// Sea currents on the flat map: what is requested, what is drawn and where, the loop's stops and starts,
// Play, and what unticking leaves behind.
async function checkCurrents(page, requests, t, name, shot) {
  const panelWas = await page.evaluate(() => document.getElementById('panel-details').open) // open on a desktop, closed on a phone
  const panel = (open) => page.evaluate((o) => { document.getElementById('panel-details').open = o }, open)
  await page.evaluate(() => { document.querySelector('.maplibregl-popup')?.remove(); window.__map.jumpTo({ center: [-123.43, 48.48], zoom: 10.4 }) })
  await panel(true)
  await page.waitForTimeout(800)
  await setBox(page, '#flow', false)
  const wide = page.viewportSize().width >= 700
  const start = requests.length
  const wcs = () => requests.slice(start).filter((u) => u.includes('service=WCS'))
  const timesOf = (list) => [...new Set(list.map((u) => new URL(u).searchParams.get('time')))].sort()

  await setBox(page, 'input[data-overlay=currents]', true)
  await waitStatus(page, 'currents').catch(() => {})
  const st0 = await statusOf(page, 'currents')
  const first = wcs(), caps = requests.slice(start).filter((u) => u.includes('GetCapabilities') && u.includes('CIOPS-SalishSea')).length
  const ui = await page.evaluate(() => ({ controls: !document.getElementById('currents-controls').hidden, play: document.getElementById('currents-play').disabled, note: document.getElementById('currents-note').textContent, noteShown: !document.getElementById('currents-note').hidden }))
  report(st0.state === 'ok' && SEA_STATUS.test(st0.text), t('currents: the status line names the model hour in Pacific time and the model, and says experimental and not for navigation'), st0.text)
  report(caps === 1 && first.length === 2 && first.some((u) => u.includes('VelocityX_0.5m')) && first.some((u) => u.includes('VelocityY_0.5m')) && timesOf(first).length === 1, t('currents: ticking requests the hours on offer once and the two components of one hour, and nothing else'), JSON.stringify({ caps, first: first.map((u) => u.slice(70, 150)) }))
  report(ui.controls && !ui.play && ui.noteShown && /Particles move 3,000 times faster than the water/.test(ui.note), t('currents: Play is on offer and a note says how much faster than the water the particles move'), JSON.stringify(ui))

  await page.waitForTimeout(2000)
  await waitDrawn(page)
  const st = await currentsStats(page)
  const want = wide ? st.particles > 1500 && st.particles <= 4000 : st.particles > 100 && st.particles <= 1500
  report(st.on && st.running && st.attached && want && drawnOverSea(st), t(`currents: after about 2 s the canvas has particle pixels over the sea and almost none over land (${st.particles} particles, ${wide ? 'wide' : 'narrow'} screen)`), JSON.stringify(st))
  const sigA = await canvasSignature(page)
  let sigB = sigA
  for (let i = 0; i < 20 && sigB === sigA; i++) { await page.waitForTimeout(500); sigB = await canvasSignature(page) }
  report(sigA !== null && sigA !== sigB, t('currents: the picture keeps changing while it runs'))
  const dom = await page.evaluate(() => {
    const c = document.getElementById('currents-canvas'), cs = getComputedStyle(c), ratio = Math.min(devicePixelRatio, 2)
    return { events: cs.pointerEvents, z: cs.zIndex, inContainer: c.parentElement === window.__map.getCanvasContainer(), sized: c.width === Math.round(innerWidth * ratio) && c.height === Math.round(innerHeight * ratio), hidden: c.getAttribute('aria-hidden') }
  })
  report(dom.events === 'none' && dom.z === 'auto' && dom.inContainer && dom.sized && dom.hidden === 'true', t('currents: the canvas sits in the map under its popups and the panel, lets every touch through and matches the window size'), JSON.stringify(dom))
  if (shot) {
    await page.evaluate(() => document.getElementById('currents-controls').scrollIntoView({ block: 'center' }))
    await shot('currents-panel')
    if (!wide) await panel(false) // on a phone the panel would hide the map
    await shot('currents-2d')
    await panel(true)
  }
  const f0 = (await currentsStats(page)).frames
  await page.waitForTimeout(3000)
  const fps = ((await currentsStats(page)).frames - f0) / 3
  console.log(`      (${t(`headless run of the loop, Flow off: ${fps.toFixed(0)} frames a second. This machine draws in software, so it says nothing about a phone`)})`)

  // the loop stops while the tab is hidden and while the map moves, and starts again
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); document.dispatchEvent(new Event('visibilitychange')) })
  const hid = await currentsStats(page)
  await page.evaluate(() => { delete document.hidden; document.dispatchEvent(new Event('visibilitychange')) })
  await page.waitForTimeout(300)
  const shown = await currentsStats(page)
  report(!hid.running && shown.running, t('currents: the loop stops while the tab is hidden and resumes when it is shown'), JSON.stringify([hid.running, shown.running]))
  // Read at the first 'move' event, while the map is moving, so a slow machine cannot let the move finish first.
  const moving = await page.evaluate(() => new Promise((resolve) => {
    window.__map.once('move', () => resolve(window.__overlays.currents.stats()))
    window.__map.easeTo({ center: [-123.3, 48.5], duration: 1800 })
  }))
  await page.waitForFunction(() => !window.__map.isMoving(), null, { timeout: 20000 })
  await page.waitForTimeout(1500)
  await waitDrawn(page)
  const after = await currentsStats(page)
  report(!moving.running && moving.drawn === 0 && after.running && drawnOverSea(after), t('currents: while the map moves the picture is cleared and the loop paused, and both come back when it stops'), JSON.stringify({ moving: [moving.running, moving.drawn], after: [after.running, after.drawn, after.land] }))

  // Play: one hour on, the hour after it fetched ahead, nothing more, and Pause stops it
  const hours = () => page.evaluate(() => ({ at: window.__overlays.sea.at, time: window.__overlays.sea.hours[window.__overlays.sea.at], n: window.__overlays.sea.hours.length }))
  const h0 = await hours(), text0 = (await statusOf(page, 'currents')).text
  await page.click('#currents-play')
  const btn = await page.evaluate(() => ({ text: document.getElementById('currents-play').textContent, pressed: document.getElementById('currents-play').getAttribute('aria-pressed') }))
  await page.waitForFunction((t0) => document.getElementById('status-currents').textContent !== t0 && document.getElementById('status-currents').dataset.state === 'ok', text0, { timeout: 90000 })
  const h1 = await hours(), text1 = (await statusOf(page, 'currents')).text
  report(btn.text === 'Pause' && btn.pressed === 'true' && h0.n === 13 && h1.at === h0.at + 1 && Date.parse(h1.time) - Date.parse(h0.time) === 3600000 && seaHour(text1) !== seaHour(text0) && SEA_STATUS.test(text1), t('currents: Play steps one hour on and the hour label in the status line follows it'), JSON.stringify({ btn, h0, h1, label: [seaHour(text0), seaHour(text1)] }))
  await page.waitForTimeout(1500)
  await page.click('#currents-play')
  const paused = await hours(), pausedBtn = await page.evaluate(() => document.getElementById('currents-play').textContent)
  const heldAt = wcs().length
  await page.waitForTimeout(3500)
  const still = await hours()
  const asked = timesOf(wcs())
  const latest = Math.max(...asked.map(Date.parse))
  report(pausedBtn === 'Play' && still.at === paused.at && wcs().length === heldAt, t('currents: Pause stops the hours and the button says Play again, with no more requests'), JSON.stringify({ pausedBtn, paused: paused.at, still: still.at, heldAt, now: wcs().length }))
  report(asked[0] === h0.time && latest <= Date.parse(paused.time) + 3600000 && wcs().length === asked.length * 2, t('currents: each hour is two requests, and only the hour shown and the one after it were asked for'), JSON.stringify({ asked, shown: paused.time, requests: wcs().length }))

  // a click goes through the canvas, and the popup is above it (the panel is shut so it cannot be in the way on a phone)
  await panel(false)
  await page.evaluate((b) => window.__map.jumpTo({ center: b, zoom: 13.2 }), BOWKER)
  await page.waitForTimeout(2500)
  const pt = await page.evaluate(([x, y]) => { const p = window.__map.project([x, y]); return { x: p.x, y: p.y } }, BOWKER)
  await page.mouse.click(pt.x, pt.y)
  await page.waitForTimeout(600)
  const pop = await page.evaluate(() => { const c = document.querySelector('.maplibregl-popup'); return c ? { text: c.innerText.slice(0, 60), z: getComputedStyle(c).zIndex } : null })
  report(!!pop && pop.text.includes('Bowker Creek') && pop.z === '4', t('currents: with the layer on, a click reaches the map and the popup opens above the canvas'), JSON.stringify(pop))
  await page.evaluate(() => document.querySelector('.maplibregl-popup')?.remove())
  if (shot && wide) { await page.evaluate(() => window.__map.jumpTo({ center: [-123.43, 48.4], zoom: 11.2 })); await page.waitForTimeout(2500); await shot('currents-2d-zoomed') }

  // unticking stops the loop, frees the canvas and takes the credit off the map
  await setBox(page, 'input[data-overlay=currents]', false)
  await page.waitForTimeout(1200)
  const off = await page.evaluate(() => ({ stats: window.__overlays.currents.stats(), canvas: !!document.getElementById('currents-canvas'), status: !document.getElementById('status-currents').hidden, controls: !document.getElementById('currents-controls').hidden, note: !document.getElementById('currents-note').hidden, play: document.getElementById('currents-play').textContent, playing: window.__overlays.sea.playing, kept: window.__overlays.sea.cache.size, layer: window.__map.getLayoutProperty('currents-credit', 'visibility'), attrib: document.querySelector('.maplibregl-ctrl-attrib').textContent }))
  const sigOff = await canvasSignature(page)
  report(!off.stats.on && !off.stats.running && !off.canvas && sigOff === null && !off.status && !off.controls && !off.note && off.play === 'Play' && !off.playing && off.kept === 0 && off.layer === 'none' && !off.attrib.includes('Data Server End-use Licence'), t('currents: unticking stops the loop, removes the canvas and the hours kept in memory, hides the status line and controls and takes the credit off the map'), JSON.stringify({ ...off, attrib: undefined }))
  await setBox(page, '#flow', true)
  await panel(panelWas)
}

const waitStatus = (page, id, timeout = 90000) => page.waitForFunction((id) => { const p = document.getElementById('status-' + id); return !!p && !p.hidden && !!p.dataset.state && p.dataset.state !== 'loading' }, id, { timeout })
const statusOf = (page, id) => page.evaluate((id) => { const p = document.getElementById('status-' + id); return { state: p.dataset.state, text: p.textContent, hidden: p.hidden } }, id)
const hostCount = (requests, host) => requests.filter((u) => new URL(u).host === host).length
const layerStates = (page, id) => page.evaluate((id) => window.__overlays.defs[id].ids.filter((l) => window.__map.getLayer(l)).map((l) => window.__map.getLayoutProperty(l, 'visibility') ?? 'visible'), id)

// The optional layers, each against its real service. Nothing is requested before its box is
// ticked, and ticking one contacts its own host and no other. While a layer is on, the map
// attribution carries its credit.
async function checkOverlays(page, requests, t, shot) {
  await page.evaluate(() => { document.querySelector('.maplibregl-popup')?.remove(); document.getElementById('panel-details').open = true })
  // Sea currents were ticked earlier, in checkCurrents3d, which checked that nothing had been requested before that.
  const idle = LIVE_HOSTS.map((h) => requests.filter((u) => new URL(u).host === h && !u.includes('CIOPS-SalishSea')).length)
  const files = requests.filter((u) => /data\/(ecoregions|industry-waste)\.geojson/.test(u)).length
  report(idle.every((n) => n === 0) && files === 0, t('nothing is requested from Environment Canada, USGS or GBIF (apart from the sea currents ticked earlier), or for the ecoregion and industry files, until a box is ticked'), JSON.stringify([idle, files]))
  const outcome = {}
  for (const [id, net] of Object.entries(OVERLAY_NET)) {
    const before = Object.fromEntries(LIVE_HOSTS.map((h) => [h, hostCount(requests, h)]))
    const fileBefore = requests.filter((u) => net.file && u.endsWith(net.file)).length
    await setBox(page, `input[data-overlay=${id}]`, true)
    let st
    for (let attempt = 0; attempt < 2; attempt++) {
      await waitStatus(page, id).catch(() => {})
      st = await statusOf(page, id)
      if (st.state !== 'fail') break
      await page.waitForTimeout(8000) // a service may be rate limiting. Try once more.
      await setBox(page, `input[data-overlay=${id}]`, false)
      await setBox(page, `input[data-overlay=${id}]`, true)
    }
    const after = Object.fromEntries(LIVE_HOSTS.map((h) => [h, hostCount(requests, h)]))
    const own = (net.hosts || []).every((h) => after[h] > before[h])
    const others = LIVE_HOSTS.filter((h) => !(net.hosts || []).includes(h)).every((h) => after[h] === before[h])
    const file = net.file ? requests.filter((u) => u.endsWith(net.file)).length > fileBefore : true
    await page.waitForTimeout(900)
    const attrib = await page.evaluate(() => document.querySelector('.maplibregl-ctrl-attrib').textContent)
    const vis = await layerStates(page, id)
    outcome[id] = st
    report(['ok', 'empty'].includes(st.state) && own && others && file && vis.length > 0 && vis.every((v) => v === 'visible') && attrib.includes(OVERLAY_ATTRIB[id]), t(`${id}: ticking it loads from its own service only, shows its layer, a status line (${st.state}) and its credit on the map`), JSON.stringify({ st, own, others, file, vis, hasCredit: attrib.includes(OVERLAY_ATTRIB[id]) }))
    if (id === 'currents') await setBox(page, 'input[data-overlay=currents]', false) // its loop is checked on its own, below
  }
  report(outcome.ecoregions.text.includes('one ecoregion') && /18 sites/.test(outcome.industry.text), t('ecoregions and industry status lines describe what was loaded'), JSON.stringify([outcome.ecoregions.text, outcome.industry.text]))

  // radar: frames, a time label, play and pause, and a colour key fetched only when opened
  const radar = await page.evaluate(() => ({ frames: window.__overlays.radar.frames.length, time: document.getElementById('radar-time').textContent, playing: window.__overlays.radar.playing, button: document.getElementById('radar-play').textContent, layer: !!window.__map.getLayer('radar'), type: window.__map.getSource('radar')?.type, legendSrc: document.getElementById('radar-legend-img').getAttribute('src') }))
  report(radar.frames >= 2 && /^Radar, /.test(radar.time) && radar.layer && radar.type === 'image' && radar.playing && radar.button === 'Pause', t('radar: several frames, a time label, an image layer, and it plays'), JSON.stringify(radar))
  await page.click('#radar-play')
  const paused = await page.evaluate(() => ({ playing: window.__overlays.radar.playing, button: document.getElementById('radar-play').textContent, shown: window.__overlays.radar.shown }))
  await page.waitForTimeout(1500)
  const still = await page.evaluate(() => window.__overlays.radar.shown)
  report(!paused.playing && paused.button === 'Play' && still === paused.shown, t('radar: Pause stops the frames, and the button says Play'), JSON.stringify([paused, still]))
  const legendBefore = requests.filter((u) => u.includes('GetLegendGraphic')).length
  report(legendBefore === 0 && radar.legendSrc === null, t('radar: the colour key is not requested until it is opened'), String(legendBefore))
  await page.evaluate(() => { document.getElementById('radar-legend').open = true })
  await page.waitForTimeout(2500)
  report(requests.some((u) => u.includes('GetLegendGraphic')), t('radar: opening the colour key requests it'))

  // popups are built from text only, and carry each record's licence and source link
  const pop = await page.evaluate(async () => {
    const o = window.__overlays
    const life = { properties: { key: 5938027964, name: '<img src=x onerror=alert(1)>', kingdom: 'Plantae', date: '2026-06-25T10:54:16', dataset: 'iNaturalist research-grade observations', dataset_key: '50c9509d-22c7-4a22-a47d-8c48425ef4a7', licence: 'CC BY 4.0', licence_url: 'https://creativecommons.org/licenses/by/4.0/legalcode', holder: 'A. Person' } }
    const box = o.popupFor(life, 'life-dot', [life])
    const fc = await (await fetch('data/industry-waste.geojson')).json()
    const clover = fc.features.find((f) => f.properties.name === 'Clover Point Pump Station')
    const unnamed = fc.features.find((f) => !f.properties.name)
    const ind = o.popupFor({ properties: clover.properties }, 'industry-dot')
    const loc = o.popupFor({ properties: unnamed.properties }, 'industry-dot')
    return {
      lifeImg: !!box.querySelector('img'), lifeText: box.textContent, lifeLinks: [...box.querySelectorAll('a')].map((a) => a.href + ' ' + a.rel),
      ind: ind.textContent, indLinks: [...ind.querySelectorAll('a')].map((a) => a.href), loc: loc.textContent,
    }
  })
  report(!pop.lifeImg && pop.lifeText.includes('<img src=x onerror=alert(1)>') && pop.lifeText.includes('CC BY 4.0') && pop.lifeText.includes('Credit: A. Person') && pop.lifeLinks.some((l) => l.startsWith('https://www.gbif.org/occurrence/5938027964')) && pop.lifeLinks.every((l) => l.startsWith('https://') && l.includes('noopener')), t('life observation popup: text only (no markup from the record), licence, credit and source link kept, https links with rel=noopener'), JSON.stringify(pop.lifeLinks))
  report(pop.ind.includes('Treated wastewater discharged: 50,000 m3 per day') && pop.ind.includes('modelled, not counted') && pop.ind.includes('Ehalt Macedo, H.') && pop.ind.includes('CC BY 4.0') && pop.indLinks.every((l) => l.startsWith('https://')) && pop.loc.includes('No figures. This is a location only, not an empty site.') && pop.loc.includes('Open Government Licence'), t('industry popups: figures carry their basis, a site with no figures says so, and each carries its source attribution'))
  await page.evaluate(() => window.__map.jumpTo({ center: [-123.349, 48.406], zoom: 14 }))
  await page.waitForTimeout(2500)
  const vp = page.viewportSize()
  await page.mouse.click(vp.width / 2, vp.height / 2)
  await page.waitForTimeout(800)
  const clicked = await page.evaluate(() => document.querySelector('.maplibregl-popup-content')?.innerText || null)
  report(!!clicked && clicked.includes('Clover Point Pump Station') && clicked.includes('wastewater'), t('a click on an industry site opens its popup'), String(clicked).slice(0, 100))
  if (shot) await shot('overlays-on')
  await page.evaluate(() => document.querySelector('.maplibregl-popup')?.remove())

  // untick everything: layers hide, status lines hide, the credits leave the map
  for (const id of Object.keys(OVERLAY_NET)) await setBox(page, `input[data-overlay=${id}]`, false)
  await page.waitForTimeout(1500)
  const off = await page.evaluate(() => ({ attrib: document.querySelector('.maplibregl-ctrl-attrib').textContent, shown: [...document.querySelectorAll('[id^=status-]')].filter((p) => !p.hidden).length, radarControls: !document.getElementById('radar-controls').hidden, playing: window.__overlays.radar.playing }))
  const hidden = []
  for (const id of Object.keys(OVERLAY_NET)) hidden.push(...(await layerStates(page, id)))
  report(hidden.every((v) => v === 'none') && off.shown === 0 && !off.radarControls && !off.attrib.includes('Data Server End-use Licence') && !off.attrib.includes('GBIF') && !off.attrib.includes('HydroWASTE'), t('unticking every new layer hides it, its status line and its credit'), JSON.stringify({ ...off, attrib: off.attrib.slice(0, 120), hidden: [...new Set(hidden)] }))
}

// With every outside service blocked: ticking a live layer makes its own request and then shows a
// plain failure line, nothing else breaks, and an alert from a service is shown unchanged.
async function checkOverlaysBlocked(browser, base) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 })
  const page = await ctx.newPage()
  const requests = [], errors = []
  page.on('request', (r) => requests.push(r.url()))
  page.on('pageerror', (e) => errors.push(e.message.slice(0, 160)))
  for (const h of LIVE_HOSTS) await page.route(`https://${h}/**`, (r) => r.abort())
  await page.goto(base + '/index.html?test', { waitUntil: 'load' })
  await page.waitForFunction(() => window.__ready, null, { timeout: 90000 })
  await page.waitForTimeout(1500)
  await page.evaluate(() => { document.getElementById('panel-details').open = true })
  const t = (s) => `hosts blocked: ${s}`
  for (const id of ['radar', 'currents', 'alerts', 'aqhi', 'conditions', 'water', 'quakes', 'life']) {
    const before = Object.fromEntries(LIVE_HOSTS.map((h) => [h, hostCount(requests, h)]))
    await setBox(page, `input[data-overlay=${id}]`, true)
    await waitStatus(page, id, 60000).catch(() => {})
    const st = await statusOf(page, id)
    const own = OVERLAY_NET[id].hosts.every((h) => hostCount(requests, h) > before[h])
    const others = LIVE_HOSTS.filter((h) => !OVERLAY_NET[id].hosts.includes(h)).every((h) => hostCount(requests, h) === before[h])
    const empty = await page.evaluate((id) => { const src = window.__overlays.defs[id].source; return src ? window.__map.querySourceFeatures(src).length === 0 : true }, id)
    const wording = id === 'alerts' ? st.text.includes('not showing whether any are in effect') : st.text.includes('could not be loaded')
    report(st.state === 'fail' && !st.hidden && wording && own && others && empty, t(`${id}: its own request is made, then a plain failure line shows and the layer stays empty`), JSON.stringify({ st, own, others, empty }))
    if (id === 'currents') {
      const sea = await page.evaluate(() => ({ canvas: !!document.getElementById('currents-canvas'), play: document.getElementById('currents-play').disabled, stats: window.__overlays.currents.stats() }))
      report(!sea.canvas && sea.play && !sea.stats.on && !sea.stats.running && sea.stats.particles === 0, t('currents: after the failure no canvas is on the map, Play is disabled and nothing runs'), JSON.stringify(sea))
    }
  }
  report(errors.length === 0, t('no page errors from the failed requests'), errors.join(' | '))
  // an alert is passed on exactly as the service issued it
  const text = 'WIND WARNING IN EFFECT\n\nSouthwest winds 70 km/h gusting to 90.\n\nThis is a test text. It must not be reworded.'
  const fixture = { type: 'FeatureCollection', features: [{ type: 'Feature', id: 'test-1', geometry: { type: 'Polygon', coordinates: [[[-123.6, 48.35], [-123.25, 48.35], [-123.25, 48.6], [-123.6, 48.6], [-123.6, 48.35]]] }, properties: { alert_short_name_en: 'orange warning - wind', feature_name_en: 'Greater Victoria', alert_text_en: text, risk_colour_en: 'orange', publication_datetime: new Date(Date.now() - 3600000).toISOString(), expiration_datetime: new Date(Date.now() + 3600000).toISOString() } }] }
  await page.route('https://api.weather.gc.ca/collections/weather-alerts/**', (r) => r.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(fixture) }))
  await setBox(page, 'input[data-overlay=alerts]', false)
  await setBox(page, 'input[data-overlay=alerts]', true)
  await waitStatus(page, 'alerts', 30000).catch(() => {})
  await page.evaluate(() => document.querySelector('#alerts-list details')?.setAttribute('open', ''))
  const shown = await page.evaluate(() => ({ state: document.getElementById('status-alerts').dataset.state, text: document.querySelector('#alerts-list .alert-text')?.textContent, title: document.querySelector('#alerts-list summary')?.textContent, count: window.__map.getSource('ov-alerts') ? window.__map.querySourceFeatures('ov-alerts').length : 0 }))
  report(shown.state === 'ok' && shown.text === text && shown.title.includes('orange warning') && shown.count > 0, t('an alert is shown word for word as issued, with its area drawn on the map'), JSON.stringify(shown))
  // the two static layers need no outside service
  for (const id of ['ecoregions', 'industry']) {
    await setBox(page, `input[data-overlay=${id}]`, true)
    await waitStatus(page, id, 30000).catch(() => {})
    const st = await statusOf(page, id)
    report(st.state === 'ok', t(`${id} loads from this site while the outside services are blocked`), JSON.stringify(st))
  }
  await ctx.close()
}

// Reduced motion: Flow is off and disabled, nothing animates, and the page follows the setting live.
async function checkReducedMotion(browser, base) {
  const { ctx, page, problems } = await openPage(browser, base, { width: 1280, height: 800 }, { reducedMotion: 'reduce' })
  const get = () => page.evaluate(() => {
    const m = window.__map, b = document.getElementById('flow')
    return { checked: b.checked, disabled: b.disabled, vis: m.getLayoutProperty('streams-flow', 'visibility') ?? 'visible', running: window.__flow.running(), why: !document.getElementById('flow-paused').hidden, dash: JSON.stringify(m.getPaintProperty('streams-flow', 'line-dasharray')) }
  })
  // The browser reports a media setting change on its next rendered frame, so ask
  // for frames while waiting.
  const settle = async (want) => {
    for (let i = 0; i < 30; i++) {
      await page.evaluate(() => new Promise(requestAnimationFrame))
      const st = await get()
      if (want(st)) return st
      await page.waitForTimeout(100)
    }
    return get()
  }
  const a = await get()
  const tilt = await page.evaluate(() => ({ pitch: window.__map.getPitch(), terrain: !!window.__map.getTerrain() }))
  report(Math.abs(tilt.pitch - 60) < 1 && tilt.terrain, 'reduced motion: 3D terrain is on at load and the map is already tilted', JSON.stringify(tilt))
  await page.waitForTimeout(600)
  const b = await get()
  report(a.disabled && !a.checked && a.vis === 'none' && !a.running && a.why, 'reduced motion: Flow box is off and disabled, dashes hidden, loop not running, reason shown', JSON.stringify(a))
  report(a.dash === b.dash, 'reduced motion: the dash pattern never changes')
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  const c = await settle((st) => st.running)
  report(!c.disabled && c.checked && c.vis === 'visible' && c.running && !c.why, 'reduced motion switched off while the page is open: Flow starts', JSON.stringify(c))
  await page.emulateMedia({ reducedMotion: 'reduce' })
  const d = await settle((st) => !st.running)
  report(d.disabled && !d.checked && d.vis === 'none' && !d.running, 'reduced motion switched on while the page is open: Flow stops', JSON.stringify(d))
  // Sea currents: still streaks that show the direction, no loop, no Play, and the page follows the setting live.
  await page.evaluate(() => { document.getElementById('panel-details').open = true })
  await setBox(page, '#flow', false)
  await setBox(page, 'input[data-overlay=currents]', true)
  await waitStatus(page, 'currents').catch(() => {})
  await page.waitForTimeout(2000)
  const sea = () => page.evaluate(() => ({ stats: window.__overlays.currents.stats(), play: document.getElementById('currents-play').disabled, why: !document.getElementById('currents-paused').hidden, playing: window.__overlays.sea.playing }))
  const r1 = await sea(), sigR1 = await canvasSignature(page)
  await page.waitForTimeout(1500)
  const r2 = await sea(), sigR2 = await canvasSignature(page)
  report(r1.stats.on && !r1.stats.running && r1.stats.frames === 0 && r2.stats.frames === 0 && sigR1 !== null && sigR1 === sigR2 && drawnOverSea(r1.stats) && r1.play && r1.why && !r1.playing, 'reduced motion: sea currents are drawn as still streaks over the sea, the loop never runs, the picture never changes, and Play is disabled with the reason shown', JSON.stringify({ r1, sigR1, sigR2 }))
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  // The browser reports a media setting change on its next rendered frame, and waitForFunction asks for frames while it waits.
  const live = await page.waitForFunction(() => window.__overlays.currents.stats().running, null, { timeout: 15000 }).then(() => sea(), () => sea())
  report(live.stats.running && !live.play && !live.why, 'reduced motion switched off while the page is open: sea currents start moving and Play is offered', JSON.stringify(live))
  await page.emulateMedia({ reducedMotion: 'reduce' })
  const dead = await page.waitForFunction(() => !window.__overlays.currents.stats().running, null, { timeout: 15000 }).then(() => sea(), () => sea())
  report(!dead.stats.running && dead.play && dead.why && dead.stats.drawn > 0, 'reduced motion switched on while the page is open: sea currents stop and stay as still streaks, Play is disabled', JSON.stringify(dead))
  await setBox(page, 'input[data-overlay=currents]', false)
  const hard = problems.filter((p) => !/openfreemap/i.test(p) || /HTTP|page error/.test(p))
  report(hard.length === 0, 'reduced motion: no page errors', hard.slice(0, 3).join(' | '))
  await ctx.close()
}

async function checkBasemapDown(browser, base, shots) {
  const { ctx, page, problems } = await openPage(browser, base, { width: 1280, height: 800 }, { blockTiles: true })
  const info = await page.evaluate(() => ({
    banner: document.getElementById('demo-banner').innerText,
    layers: ['parks-local', 'streams', 'muni-line', 'pins'].filter((id) => !window.__map.getLayer(id)),
    labelLayers: ['streams-label', 'pins-label'].filter((id) => window.__map.getLayer(id)),
  }))
  report(info.banner.includes('could not be reached'), 'basemap blocked: banner says the basemap could not be reached', info.banner)
  report(info.layers.length === 0, 'basemap blocked: data layers still added', info.layers.join(', '))
  report(info.labelLayers.length === 0, 'basemap blocked: text layers skipped (no glyph server)')
  const hard = problems.filter((p) => /page error/.test(p))
  report(hard.length === 0, 'basemap blocked: no page errors', hard.join(' | '))
  if (shots) await page.screenshot({ timeout: 120000, path: join(shots, 'desktop-5-basemap-down.png') })
  await ctx.close()
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const bad = await runBrowserChecks()
  process.exitCode = bad ? 1 : 0
}
