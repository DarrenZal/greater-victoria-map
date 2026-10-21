#!/usr/bin/env node
// Browser checks for the Greater Victoria demo map, run in headless Chromium.
//
//   PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node scripts/browser-check.mjs [--shots dir]
//
// Playwright is not a dependency of this folder. Point PLAYWRIGHT_MODULE at an
// existing install, or leave it unset if `playwright` resolves from here.
// The folder is served by a small built-in static server on a free port.
// The page loads map tiles from tiles.openfreemap.org, and the terrain checks
// load elevation tiles from s3.amazonaws.com, so this needs network.
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
  page.on('requestfailed', (r) => { if (!blockTiles || !r.url().includes('tiles.openfreemap.org')) problems.push('request failed: ' + r.url().slice(0, 120)) })
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
  const info = await page.evaluate(() => {
    const m = window.__map
    const vis = (id) => m.getLayer(id) ? (m.getLayoutProperty(id, 'visibility') ?? 'visible') : 'absent'
    const attrib = document.querySelector('.maplibregl-ctrl-attrib')
    const panel = document.getElementById('panel').getBoundingClientRect()
    const a = attrib.getBoundingClientRect()
    return {
      layers: ['hillshade', 'bec-fill', 'bec-sea-mask', 'watersheds-fill', 'watersheds-line', 'parks-local', 'parks-bc', 'parks-bc-line', 'wetlands', 'lakes', 'streams', 'streams-flow', 'muni-fill', 'muni-line', 'streams-label', 'parks-bc-label', 'muni-label', 'pins', 'pins-label'].filter((id) => !m.getLayer(id)),
      defaults: Object.fromEntries(['bec-fill', 'hillshade', 'watersheds-line', 'parks-local', 'parks-bc', 'streams', 'streams-flow', 'muni-line', 'pins'].map((id) => [id, vis(id)])),
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
  })
  report(info.layers.length === 0, t('all map layers present'), 'missing: ' + info.layers.join(', '))
  report(JSON.stringify(info.defaults) === JSON.stringify({ 'bec-fill': 'none', hillshade: 'none', 'watersheds-line': 'none', 'parks-local': 'visible', 'parks-bc': 'visible', streams: 'visible', 'streams-flow': 'visible', 'muni-line': 'visible', pins: 'visible' }), t('default layer visibility as specified'), JSON.stringify(info.defaults))
  report(info.flowBox.checked && !info.flowBox.disabled && info.flowRunning && !info.terrainChecked, t('Flow box is on and the flow loop is running; Terrain shading box is off'), JSON.stringify({ flowBox: info.flowBox, running: info.flowRunning, terrain: info.terrainChecked, zoom: info.zoom }))
  const hosts = [...new Set(requests.map((u) => new URL(u).host))].filter((h) => !h.startsWith('127.0.0.1'))
  report(hosts.every((h) => h === 'tiles.openfreemap.org'), t('on load the page contacts only the basemap host (no terrain, weather or other service)'), hosts.join(', '))
  report(!info.overflowX, t('no horizontal page scroll'))
  report(info.banner.includes('Demo.') && !info.banner.includes('could not be reached'), t('demo banner shown, basemap reached'), info.banner)
  report(info.pinCount === '(1)' && info.emptyVisible && info.emptyText === 'No events listed yet.', t('pins panel: 1 example place and the empty-state sentence'), info.emptyText)
  if (name === 'desktop') {
    report(info.attribText.includes('OpenFreeMap') && info.attribText.includes('OpenStreetMap') && info.attribText.includes('Open Government Licence'), t('attribution shows basemap and BC credit'), info.attribText)
    report(info.attribHeight < 34, t('attribution strip fits on one line'), `${info.attribHeight}px high`)
  } else {
    report(info.attribCompact && info.attribCollapsed, t('attribution is the collapsed (i) button after load'), JSON.stringify({ compact: info.attribCompact, collapsed: info.attribCollapsed }))
    report(!info.panelOverlapsAttrib, t('layers panel does not cover the attribution control'))
  }

  if (shots) await page.screenshot({ path: join(shots, `${name}-1-default.png`) })

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
  await checkTerrain(page, requests, t, shots ? (label) => page.screenshot({ path: join(shots, `${name}-${label}.png`) }) : null)
  await page.waitForTimeout(1200)
  if (shots) await page.screenshot({ path: join(shots, `${name}-2-bec-watersheds.png`) })

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
  if (shots) await page.screenshot({ path: join(shots, `${name}-3-bowker-popup.png`) })
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
  if (shots) await page.screenshot({ path: join(shots, `${name}-4-credits.png`) })
  await page.keyboard.press('Escape')
  const creditsClosed = await page.evaluate(() => document.getElementById('credits').hidden)
  report(creditsOpen && creditsClosed, t('credits panel opens and Escape closes it'))

  // fit button
  await page.evaluate(() => { document.getElementById('panel-details').open = true })
  await page.click('#fit')
  await page.waitForTimeout(1500)
  const center = await page.evaluate(() => window.__map.getCenter())
  report(Math.abs(center.lng - -123.43) < 0.1 && Math.abs(center.lat - 48.48) < 0.1, t('Fit to Greater Victoria returns to the home view'), JSON.stringify(center))

  const hardProblems = problems.filter((p) => !/openfreemap/i.test(p) || /HTTP|page error/.test(p))
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

// Terrain shading: off by default, and no elevation tile is requested until it is ticked.
async function checkTerrain(page, requests, t, shot) {
  const s3 = () => requests.filter((u) => new URL(u).host === 's3.amazonaws.com').length
  report(s3() === 0, t('no terrain tile requested before the Terrain shading box is ticked'), `${s3()} requests`)
  await setBox(page, 'input[data-group=terrain]', true)
  await page.waitForTimeout(3500)
  const on = await page.evaluate(() => ({ vis: window.__map.getLayoutProperty('hillshade', 'visibility'), attrib: document.querySelector('.maplibregl-ctrl-attrib').textContent }))
  report(on.vis === 'visible' && s3() > 0, t('Terrain shading on: layer visible and elevation tiles requested from AWS'), `${on.vis}, ${s3()} requests`)
  report(on.attrib.includes('AWS Terrain Tiles') && on.attrib.includes('OGL') && on.attrib.includes('USGS'), t('map attribution carries the terrain credit while the layer is on'), on.attrib.slice(0, 200))
  if (shot) await shot('terrain-on')
  await setBox(page, 'input[data-group=terrain]', false)
  const off = await page.evaluate(() => window.__map.getLayoutProperty('hillshade', 'visibility'))
  report(off === 'none', t('Terrain shading off again hides the layer'))
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
  if (shots) await page.screenshot({ path: join(shots, 'desktop-5-basemap-down.png') })
  await ctx.close()
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const bad = await runBrowserChecks()
  process.exitCode = bad ? 1 : 0
}
